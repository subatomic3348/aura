import { CaptureError, trackSource, type AudioSource } from './types';

/**
 * The device's microphone. Unlike system sound, voice processing stays ON:
 * echo cancellation and noise suppression make speech clearer, and this
 * device never plays its own microphone back (that would feed back).
 */
export async function captureMicrophone(): Promise<AudioSource> {
  if (!window.isSecureContext) throw new CaptureError('insecure-context', 'The microphone requires HTTPS.');
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new CaptureError('unsupported', 'This browser has no microphone access.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError') throw new CaptureError('permission-denied', 'Microphone access was blocked.');
    if (name === 'NotFoundError') throw new CaptureError('unsupported', 'No microphone found.');
    throw new CaptureError('unknown', (err as Error)?.message ?? String(err));
  }
  const track = stream.getAudioTracks()[0];
  if (!track) throw new CaptureError('no-audio-track', 'The microphone produced no audio.');
  return trackSource('mic', 'Microphone', track, null);
}
