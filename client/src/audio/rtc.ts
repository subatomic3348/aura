import type { IceServer, SignalPayload } from '@aura/protocol';

/** Protocol ICE servers → DOM type (omits absent optional fields). */
export function toRtcIceServers(list: IceServer[]): RTCIceServer[] {
  return list.map(({ urls, username, credential }) => ({
    urls,
    ...(username !== undefined && { username }),
    ...(credential !== undefined && { credential }),
  }));
}

/** Local ICE candidate → wire payload. `null` = end of candidates. */
export function candidatePayload(c: RTCIceCandidate | null): SignalPayload {
  return {
    kind: 'candidate',
    candidate: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } : null,
  };
}
