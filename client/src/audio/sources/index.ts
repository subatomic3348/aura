import { getCapabilities } from '../../lib/capabilities';
import { captureDeviceAudio, findSystemDevice } from './device';
import { captureDisplayAudio } from './display';
import { FileSource } from './file';
import { captureMicrophone } from './mic';
import type { ShareMode } from '../../lib/capabilities';
import type { AudioSource } from './types';

export type { ShareMode };

/**
 * Open a live source. ('file' sources are built from picked files instead.)
 *
 * 'system' prefers a system-sound input device (no picker, everything the
 * computer plays). On Linux we ask for microphone permission once to look for
 * it, since `npm run setup:audio` is the recommended path there; elsewhere a
 * device is only used if permission was already granted, else the share
 * picker opens (Windows: "Entire screen" + "Share system audio").
 */
export async function captureSound(mode: Exclude<ShareMode, 'file'>): Promise<AudioSource> {
  if (mode === 'mic') return captureMicrophone();
  if (mode === 'system') {
    const askPermission = getCapabilities().platform === 'linux';
    const device = await findSystemDevice(askPermission);
    if (device) return captureDeviceAudio(device);
  }
  return captureDisplayAudio();
}

export function fileSource(files: File[]): FileSource {
  return new FileSource(files);
}

export { FileSource };
