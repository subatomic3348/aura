import { getCapabilities } from './capabilities';

/** Short, non-identifying device label shown to the broadcaster, e.g. "iPhone · Safari". */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const { platform, browser } = getCapabilities();

  const os =
    platform === 'ios'
      ? /iPad/.test(ua) || navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)
        ? 'iPad'
        : 'iPhone'
      : { android: 'Android', mac: 'Mac', windows: 'Windows', linux: 'Linux', chromeos: 'Chromebook', other: 'Device' }[
          platform
        ];

  let name: string;
  if (/Edg\//.test(ua)) name = 'Edge';
  else if (/SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (/OPR\//.test(ua)) name = 'Opera';
  else if ('brave' in navigator) name = 'Brave';
  else if (/CriOS/.test(ua)) name = 'Chrome';
  else name = { chromium: 'Chrome', firefox: 'Firefox', safari: 'Safari', other: 'Browser' }[browser];

  return `${os} · ${name}`;
}
