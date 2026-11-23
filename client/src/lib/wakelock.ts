type Sentinel = { release(): Promise<void> };

/**
 * Keep the screen on (phones stop capturing/playing audio when it locks).
 * Resolves to a release function; a no-op where unsupported or denied.
 */
export async function keepScreenOn(): Promise<() => void> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<Sentinel> } }).wakeLock;
    const sentinel = await wl?.request('screen');
    return () => void sentinel?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
