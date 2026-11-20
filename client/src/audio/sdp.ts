/**
 * Opus tuning via SDP fmtp parameters. Browsers default to mono speech-grade
 * Opus; for broadcast audio (music, video soundtracks) we want:
 *
 *  stereo=1 / sprop-stereo=1   receive / send stereo
 *  maxaveragebitrate=128000    music-grade bitrate (default ~32 kbps)
 *  useinbandfec=1              forward error correction for lossy Wi-Fi
 *  usedtx=0                    no discontinuous transmission (DTX cuts quiet passages)
 *  ptime=10                    10 ms packets instead of 20 ms: less packetisation
 *                              delay and a smaller jitter buffer (≈ +6 kbps overhead)
 *
 * Only the `a=fmtp:` line of the Opus payload type is modified.
 */
const OPUS_PARAMS: Record<string, string> = {
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: '128000',
  maxplaybackrate: '48000',
  useinbandfec: '1',
  usedtx: '0',
};

export function tuneOpus(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  const fmtpRe = new RegExp(`^a=fmtp:${pt} (.*)$`, 'm');
  const match = fmtpRe.exec(sdp);

  if (!match) {
    // No fmtp line: insert one after the rtpmap.
    const params = Object.entries(OPUS_PARAMS)
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`, 'i'), `$1a=fmtp:${pt} ${params}\r\n`);
  }

  const existing = new Map<string, string>();
  for (const part of (match[1] ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k?.trim()) existing.set(k.trim(), (v ?? '').trim());
  }
  for (const [k, v] of Object.entries(OPUS_PARAMS)) existing.set(k, v);
  const line = `a=fmtp:${pt} ${[...existing].map(([k, v]) => `${k}=${v}`).join(';')}`;
  return withPtime(sdp.replace(fmtpRe, line), line);
}

const PTIME_MS = 10;

/** Set `a=ptime` for the audio section (media-level attribute, placed after the Opus fmtp). */
function withPtime(sdp: string, fmtpLine: string): string {
  if (/^a=ptime:/m.test(sdp)) return sdp.replace(/^a=ptime:\d+/m, `a=ptime:${PTIME_MS}`);
  return sdp.replace(fmtpLine, `${fmtpLine}\r\na=ptime:${PTIME_MS}`);
}
