import { CaptureError, trackSource, type AudioSource } from './types';

/**
 * Whole-system sound via a virtual input device, opened like a microphone.
 * No tab/screen picker: the browser asks for microphone permission once and
 * remembers it for this site.
 *
 * Recognised devices:
 *  - "System sound (Aura)"  Linux, created by `npm run setup:audio` (PipeWire loopback)
 *  - "Monitor of …"         Linux PulseAudio monitor sources, where exposed
 *  - "Stereo Mix"           Windows, when enabled in Sound settings
 *  - "CABLE Output"         Windows, VB-Audio Virtual Cable
 *  - "BlackHole"            macOS virtual driver
 */
const SYSTEM_DEVICE = /System sound \(Aura\)|^Monitor of |Stereo Mix|CABLE Output|BlackHole/i;

async function audioInputs(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

/**
 * Find a system-sound input. Device names are hidden until the site has
 * microphone permission; with `askPermission`, request it once to reveal them.
 */
export async function findSystemDevice(askPermission: boolean): Promise<MediaDeviceInfo | null> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return null;
  let inputs = await audioInputs();
  const labelled = inputs.some((d) => d.label);

  if (!labelled) {
    if (!askPermission) return null;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') {
        throw new CaptureError('permission-denied', 'Microphone access is needed to reach “System sound”.');
      }
      return null;
    }
    inputs = await audioInputs();
  }
  return inputs.find((d) => SYSTEM_DEVICE.test(d.label)) ?? null;
}

export async function captureDeviceAudio(device: MediaDeviceInfo): Promise<AudioSource> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: device.deviceId },
        // Speech processing would damage music; keep the signal untouched and stereo.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48_000,
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === 'NotAllowedError') throw new CaptureError('permission-denied', 'Microphone access was blocked.');
    throw new CaptureError('unknown', `Couldn’t open “${device.label}”: ${(err as Error)?.message ?? err}`);
  }

  const track = stream.getAudioTracks()[0];
  if (!track) throw new CaptureError('no-audio-track', `“${device.label}” produced no audio.`);
  // Local playback is the computer's own volume/mute: muting it does not
  // affect what this device captures (verified with PipeWire's loopback).
  return trackSource('system', 'All system sound', track, null);
}
