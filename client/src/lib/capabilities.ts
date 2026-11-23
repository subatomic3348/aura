/**
 * What this browser can do as a sender. Detection is deliberately conservative:
 * it is better to tell a user up-front that broadcasting won't work than to let
 * them pick a source and silently get no audio.
 */

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'other';
export type Platform = 'windows' | 'mac' | 'linux' | 'chromeos' | 'android' | 'ios' | 'other';

/**
 * What this device can share:
 *  - system  all sound the computer plays (desktop Chromium)
 *  - tab     one browser tab (desktop Chromium)
 *  - file    music files from this device (every modern browser, incl. phones)
 *
 * Phone browsers cannot capture other apps' sound — no web API exists for it —
 * so phones share files. Microphones aren't a share mode: they're two-way
 * voice (`voice`), which several members can use at once alongside sharing.
 */
export type ShareMode = 'system' | 'tab' | 'file';

export interface Capabilities {
  browser: BrowserFamily;
  platform: Platform;
  mobile: boolean;
  secureContext: boolean;
  shareModes: ShareMode[];
  /** This device can talk (microphone access on a secure page). */
  voice: boolean;
  /** Why system/tab sharing is unavailable here, written for the user. */
  captureReason: string | null;
}

function detectPlatform(ua: string): Platform {
  if (/Android/i.test(ua)) return 'android';
  // iPadOS reports as Mac; touch support distinguishes it.
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/CrOS/i.test(ua)) return 'chromeos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function detectBrowser(ua: string): BrowserFamily {
  if (/Firefox\//i.test(ua) || /FxiOS/i.test(ua)) return 'firefox';
  // Chrome/Edge/Brave/Opera all include "Chrome/"; iOS browsers are all WebKit.
  if (/Chrome\//i.test(ua) && !/iPhone|iPad/i.test(ua)) return 'chromium';
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

let cached: Capabilities | null = null;

export function getCapabilities(): Capabilities {
  if (cached) return cached;

  const ua = navigator.userAgent;
  const platform = detectPlatform(ua);
  const browser = detectBrowser(ua);
  const mobile = platform === 'android' || platform === 'ios';
  const secureContext = window.isSecureContext;
  const hasDisplay = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const hasMic = typeof navigator.mediaDevices?.getUserMedia === 'function';

  const shareModes: ShareMode[] = [];
  let captureReason: string | null = null;
  if (!mobile && secureContext && hasDisplay && browser === 'chromium') shareModes.push('system', 'tab');
  shareModes.push('file');
  const voice = secureContext && hasMic;

  if (mobile) captureReason = 'Phone browsers can’t capture other apps’ sound, so share music files from this phone.';
  else if (!secureContext) captureReason = 'Open this page with https:// to share this computer’s sound.';
  else if (browser !== 'chromium') captureReason = 'To share all this computer’s sound, use Chrome, Edge or Brave.';

  cached = { browser, platform, mobile, secureContext, shareModes, voice, captureReason };
  return cached;
}
