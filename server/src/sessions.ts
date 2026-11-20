/**
 * Rooms and signaling rules. Transport-agnostic: a `Client` is anything with
 * `send()`, so this is unit-tested without sockets.
 *
 * Invariants:
 *  - At most MAX_MEMBERS members per room (online or within grace).
 *  - At most one sharer per room. Only the host, or the member the host
 *    approved, may become the sharer — and doing so takes over from any
 *    current sharer ("hand over now").
 *  - There is always a host while the room has members (passed to the
 *    longest-standing member when the host leaves).
 *  - Every relayed signal has the sharer on one end (media only flows
 *    sharer → listener), so members can't use the server to message each other.
 *  - A dropped member keeps their place — and the sharer role — for a grace
 *    period, since their peer-to-peer audio usually keeps flowing meanwhile.
 *  - A room is deleted when its last member is gone.
 */
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_MEMBERS,
  MEMBER_GRACE_MS,
  type ClientMessage,
  type ErrorCode,
  type IceServer,
  type RoomSnapshot,
  type ServerMessage,
  type ShareState,
  type SignalPayload,
} from '@aura/protocol';

export type Role = { kind: 'none' } | { kind: 'member'; room: Room; memberId: string };

export interface Client {
  send(msg: ServerMessage): void;
  role: Role;
}

interface MemberRec {
  id: string;
  token: string;
  device: string;
  client: Client | null;
  grace: NodeJS.Timeout | null;
}

export interface Room {
  code: string;
  members: Map<string, MemberRec>;
  hostId: string | null;
  sharerId: string | null;
  shareState: ShareState | null;
  requests: string[];
  grantId: string | null;
  createdAt: number;
  expiry: NodeJS.Timeout;
}

export interface RegistryOptions {
  iceServers: () => IceServer[];
  maxRooms?: number;
  maxRoomMs?: number;
  graceMs?: number;
}

const token = () => randomBytes(24).toString('base64url');
const memberId = () => randomBytes(9).toString('base64url');

function newCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

function sameToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Strip control chars and clamp; device labels are shown to everyone in the room. */
function cleanDevice(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
  return t || 'Unknown device';
}

export class Registry {
  readonly rooms = new Map<string, Room>();
  private readonly opts: Required<RegistryOptions>;

  constructor(opts: RegistryOptions) {
    this.opts = { maxRooms: 500, maxRoomMs: 12 * 60 * 60 * 1000, graceMs: MEMBER_GRACE_MS, ...opts };
  }

  handle(client: Client, msg: ClientMessage): void {
    switch (msg.type) {
      case 'ping':
        return;
      case 'room:create':
        return this.create(client, msg.device);
      case 'room:join':
        return this.join(client, msg.code, msg.device);
      case 'room:resume':
        return this.resume(client, msg.code, msg.memberId, msg.memberToken);
      case 'room:leave':
        return this.leave(client);
      case 'share:start':
        return this.shareStart(client, msg.state);
      case 'share:state':
        return this.shareSetState(client, msg.state);
      case 'share:stop':
        return this.shareStop(client);
      case 'share:request':
        return this.request(client);
      case 'share:cancel-request':
        return this.cancelRequest(client);
      case 'share:approve':
        return this.approve(client, msg.memberId);
      case 'share:deny':
        return this.deny(client, msg.memberId);
      case 'share:revoke':
        return this.revoke(client);
      case 'signal':
        return this.signal(client, msg.to, msg.payload);
    }
  }

  /** Socket closed: keep the member's place for the grace period. */
  disconnect(client: Client): void {
    const role = client.role;
    client.role = { kind: 'none' };
    if (role.kind !== 'member') return;
    const m = role.room.members.get(role.memberId);
    if (!m || m.client !== client) return;
    m.client = null;
    m.grace = setTimeout(() => this.remove(role.room, m.id), this.opts.graceMs);
    this.broadcast(role.room);
  }

  close(): void {
    for (const r of [...this.rooms.values()]) this.destroy(r);
  }

  /* ───────────── membership ───────────── */

  private create(client: Client, device: string) {
    if (client.role.kind !== 'none') return this.error(client, 'wrong-state', 'Already in a room.');
    if (this.rooms.size >= this.opts.maxRooms) return this.error(client, 'server-full', 'The server is at capacity.');
    let code = newCode();
    while (this.rooms.has(code)) code = newCode();
    const room: Room = {
      code,
      members: new Map(),
      hostId: null,
      sharerId: null,
      shareState: null,
      requests: [],
      grantId: null,
      createdAt: Date.now(),
      expiry: setTimeout(() => this.destroy(room), this.opts.maxRoomMs),
    };
    room.expiry.unref?.();
    this.rooms.set(code, room);
    this.addMember(client, room, device);
  }

  private join(client: Client, code: string, device: string) {
    if (client.role.kind !== 'none') return this.error(client, 'wrong-state', 'Already in a room.');
    const room = this.rooms.get(code);
    if (!room) return this.error(client, 'not-found', 'No room with this code. It may have closed.');
    if (room.members.size >= MAX_MEMBERS) {
      return this.error(client, 'full', `This room is full (${MAX_MEMBERS} devices).`);
    }
    this.addMember(client, room, device);
  }

  private addMember(client: Client, room: Room, device: string) {
    const m: MemberRec = { id: memberId(), token: token(), device: cleanDevice(device), client, grace: null };
    room.members.set(m.id, m);
    room.hostId ??= m.id;
    client.role = { kind: 'member', room, memberId: m.id };
    client.send({
      type: 'room:joined',
      memberId: m.id,
      memberToken: m.token,
      iceServers: this.opts.iceServers(),
      room: this.snapshot(room),
    });
    this.broadcast(room, m.id);
  }

  private resume(client: Client, code: string, id: string, memberToken: string) {
    if (client.role.kind !== 'none') return this.error(client, 'wrong-state', 'Already in a room.');
    const room = this.rooms.get(code);
    if (!room) return this.error(client, 'not-found', 'This room has closed.');
    const m = room.members.get(id);
    if (!m || !sameToken(m.token, memberToken)) return this.error(client, 'unauthorized', 'Your place in the room expired.');
    if (m.grace) clearTimeout(m.grace);
    m.grace = null;
    if (m.client && m.client !== client) m.client.role = { kind: 'none' };
    m.client = client;
    client.role = { kind: 'member', room, memberId: id };
    client.send({
      type: 'room:joined',
      memberId: m.id,
      memberToken: m.token,
      iceServers: this.opts.iceServers(),
      room: this.snapshot(room),
    });
    this.broadcast(room, m.id);
  }

  private leave(client: Client) {
    if (client.role.kind !== 'member') return;
    const { room, memberId: id } = client.role;
    client.role = { kind: 'none' };
    this.remove(room, id);
  }

  /* ───────────── sharing ───────────── */

  private shareStart(client: Client, state: ShareState) {
    const ctx = this.member(client);
    if (!ctx) return;
    const { room, id } = ctx;
    if (room.sharerId === id) return; // already sharing
    if (room.hostId !== id && room.grantId !== id) {
      return this.error(client, 'not-allowed', 'Ask the host for permission to share.');
    }
    // Hand over: whoever was sharing stops (their client sees sharerId change).
    room.sharerId = id;
    room.shareState = state;
    room.requests = room.requests.filter((r) => r !== id);
    if (room.grantId !== id) room.grantId = null;
    this.broadcast(room);
  }

  private request(client: Client) {
    const ctx = this.member(client);
    if (!ctx) return;
    const { room, id } = ctx;
    if (room.hostId === id || room.grantId === id || room.sharerId === id) return; // no need
    if (!room.requests.includes(id)) room.requests.push(id);
    this.broadcast(room);
  }

  private cancelRequest(client: Client) {
    const ctx = this.member(client);
    if (!ctx) return;
    const before = ctx.room.requests.length;
    ctx.room.requests = ctx.room.requests.filter((r) => r !== ctx.id);
    if (ctx.room.requests.length !== before) this.broadcast(ctx.room);
  }

  private approve(client: Client, target: string) {
    const ctx = this.hostOnly(client);
    if (!ctx) return;
    const { room } = ctx;
    if (!room.members.has(target)) return;
    room.requests = room.requests.filter((r) => r !== target);
    room.grantId = target;
    // Hand over now: stop the current sharer so the approved member can start.
    if (room.sharerId && room.sharerId !== target) {
      room.sharerId = null;
      room.shareState = null;
    }
    this.broadcast(room);
  }

  private deny(client: Client, target: string) {
    const ctx = this.hostOnly(client);
    if (!ctx) return;
    const { room } = ctx;
    room.requests = room.requests.filter((r) => r !== target);
    room.members.get(target)?.client?.send({ type: 'error', code: 'denied', message: 'The host declined your request.' });
    this.broadcast(room);
  }

  private revoke(client: Client) {
    const ctx = this.hostOnly(client);
    if (!ctx) return;
    const { room } = ctx;
    if (!room.sharerId) return;
    room.sharerId = null;
    room.shareState = null;
    room.grantId = null;
    this.broadcast(room);
  }

  private shareSetState(client: Client, state: ShareState) {
    const ctx = this.member(client);
    if (!ctx || ctx.room.sharerId !== ctx.id) return;
    ctx.room.shareState = state;
    this.broadcast(ctx.room);
  }

  private shareStop(client: Client) {
    const ctx = this.member(client);
    if (!ctx) return;
    const { room, id } = ctx;
    // Also lets an approved member give up their turn without starting.
    if (room.sharerId !== id && room.grantId !== id) return;
    if (room.sharerId === id) {
      room.sharerId = null;
      room.shareState = null;
    }
    if (room.grantId === id) room.grantId = null; // the turn is used up
    this.broadcast(room);
  }

  private signal(client: Client, to: string, payload: SignalPayload) {
    const ctx = this.member(client);
    if (!ctx) return;
    const { room, id } = ctx;
    if (to === id || (room.sharerId !== id && room.sharerId !== to)) {
      return this.error(client, 'wrong-state', 'Signals must go to or from the sharer.');
    }
    // A target that just left is not an error: messages can cross in flight.
    room.members.get(to)?.client?.send({ type: 'signal', from: id, payload });
  }

  /* ───────────── internals ───────────── */

  private hostOnly(client: Client): { room: Room; id: string } | null {
    const ctx = this.member(client);
    if (!ctx) return null;
    if (ctx.room.hostId !== ctx.id) {
      this.error(client, 'not-allowed', 'Only the host can do that.');
      return null;
    }
    return ctx;
  }

  private member(client: Client): { room: Room; id: string } | null {
    if (client.role.kind !== 'member') {
      this.error(client, 'wrong-state', 'Join a room first.');
      return null;
    }
    return { room: client.role.room, id: client.role.memberId };
  }

  private remove(room: Room, id: string) {
    const m = room.members.get(id);
    if (!m) return;
    if (m.grace) clearTimeout(m.grace);
    if (m.client) m.client.role = { kind: 'none' };
    room.members.delete(id);
    if (room.sharerId === id) {
      room.sharerId = null;
      room.shareState = null;
    }
    if (room.grantId === id) room.grantId = null;
    room.requests = room.requests.filter((r) => r !== id);
    // Pass hosting to the longest-standing member (Map keeps join order).
    if (room.hostId === id) room.hostId = room.members.keys().next().value ?? null;
    if (room.members.size === 0) this.destroy(room);
    else this.broadcast(room);
  }

  private destroy(room: Room) {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    clearTimeout(room.expiry);
    for (const m of room.members.values()) {
      if (m.grace) clearTimeout(m.grace);
      if (m.client) {
        m.client.send({ type: 'error', code: 'not-found', message: 'This room has closed.' });
        m.client.role = { kind: 'none' };
      }
    }
    room.members.clear();
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      members: [...room.members.values()].map((m) => ({ id: m.id, device: m.device, online: m.client !== null })),
      hostId: room.hostId,
      sharerId: room.sharerId,
      shareState: room.shareState,
      requests: [...room.requests],
      grantId: room.grantId,
    };
  }

  private broadcast(room: Room, except?: string) {
    const snap = this.snapshot(room);
    for (const m of room.members.values()) {
      if (m.id !== except) m.client?.send({ type: 'room:update', room: snap });
    }
  }

  private error(client: Client, code: ErrorCode, message: string) {
    client.send({ type: 'error', code, message });
  }
}
