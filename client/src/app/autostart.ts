import { AudioOutput } from '../audio/playback';

/**
 * Hand-off from a tap on the landing page to the room page.
 *
 * Audio playback must be unlocked *inside* a user gesture (strictly so on
 * iOS), so the landing page creates the AudioOutput in its click handler and
 * the room page picks it up after navigation.
 */
let pending: AudioOutput | null = null;

export function prepareEntry(): void {
  pending?.close();
  pending = new AudioOutput();
}

export function takeEntry(): AudioOutput | null {
  const p = pending;
  pending = null;
  return p;
}
