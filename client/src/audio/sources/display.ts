import { CaptureError, trackSource, type AudioSource, type LocalPlayback } from './types';

/**
 * Captures tab (or, on Windows/ChromeOS, entire-screen system) audio with
 * getDisplayMedia. Must be called from a user gesture.
 *
 * Chrome requires video to be requested; the video track is stopped as soon
 * as we have the audio track, so no frames are captured or encoded. Voice
 * processing is disabled: it is designed for speech and damages music.
 */
export async function captureDisplayAudio(): Promise<AudioSource> {
  if (!window.isSecureContext) {
    throw new CaptureError('insecure-context', 'Audio capture requires HTTPS.');
  }
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    throw new CaptureError('unsupported', 'This browser cannot capture tab or screen audio.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        suppressLocalAudioPlayback: false,
      },
      // Chromium-specific hints (ignored elsewhere).
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      monitorTypeSurfaces: 'include',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new CaptureError('permission-denied', 'Sharing was cancelled or blocked.');
    }
    if (name === 'NotSupportedError' || name === 'NotFoundError' || name === 'TypeError') {
      throw new CaptureError('unsupported', (err as Error).message);
    }
    throw new CaptureError('unknown', (err as Error)?.message ?? String(err));
  }

  const [audio] = stream.getAudioTracks();
  const [video] = stream.getVideoTracks();
  const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  stream.getVideoTracks().forEach((t) => t.stop());

  if (!audio) {
    throw new CaptureError(
      'no-audio-track',
      surface === 'window' ? 'Windows can’t share audio. Choose a tab instead.' : 'The selected source was shared without audio.',
    );
  }

  const isScreen = surface === 'monitor';
  // Chrome can stop playing a captured *tab* locally while still capturing it.
  const local: LocalPlayback | null = isScreen
    ? null
    : {
        on: true,
        async set(on: boolean) {
          try {
            await audio.applyConstraints({ suppressLocalAudioPlayback: !on } as MediaTrackConstraints);
            (this as { on: boolean }).on = on;
            return true;
          } catch {
            return false;
          }
        },
      };

  return trackSource(
    isScreen ? 'system' : 'tab',
    isScreen ? 'All system sound' : surface === 'window' ? 'Window audio' : 'Browser tab',
    audio,
    local,
  );
}
