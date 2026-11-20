import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MEMBERS, type ServerMessage } from '@aura/protocol';
import { Registry, type Client } from '../src/sessions.ts';

type TestClient = Client & {
  inbox: ServerMessage[];
  last<T extends ServerMessage['type']>(t: T): Extract<ServerMessage, { type: T }>;
};

function client(): TestClient {
  const inbox: ServerMessage[] = [];
  return {
    role: { kind: 'none' },
    inbox,
    send: (m) => inbox.push(m),
    last(t) {
      const m = [...inbox].reverse().find((x) => x.type === t);
      if (!m) throw new Error(`no ${t} in ${JSON.stringify(inbox.map((x) => x.type))}`);
      return m as never;
    },
  };
}

const offer = { kind: 'description' as const, type: 'offer' as const, sdp: 'v=0' };
const on = { muted: false, paused: false };

describe('Registry (rooms)', () => {
  let reg: Registry;
  beforeEach(() => {
    vi.useFakeTimers();
    reg = new Registry({ iceServers: () => [], graceMs: 500 });
  });
  afterEach(() => {
    reg.close();
    vi.useRealTimers();
  });

  function room() {
    const a = client();
    reg.handle(a, { type: 'room:create', device: 'Linux · Brave' });
    const joined = a.last('room:joined');
    return { a, code: joined.room.code, aId: joined.memberId, aToken: joined.memberToken };
  }

  function join(code: string, device = 'Pixel · Chrome') {
    const c = client();
    reg.handle(c, { type: 'room:join', code, device });
    return { c, id: c.last('room:joined').memberId };
  }

  it('creates a room with a valid code and the creator as a member', () => {
    const { a, code } = room();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(a.last('room:joined').room.members).toHaveLength(1);
  });

  it('tells existing members when someone joins, with their device name', () => {
    const { a, code } = room();
    join(code, 'iPhone · Safari');
    const devices = a.last('room:update').room.members.map((m) => m.device);
    expect(devices).toEqual(['Linux · Brave', 'iPhone · Safari']);
  });

  it('rejects unknown codes', () => {
    const c = client();
    reg.handle(c, { type: 'room:join', code: 'ZZZZZZZZ', device: 'x' });
    expect(c.last('error').code).toBe('not-found');
  });

  it(`caps rooms at ${MAX_MEMBERS} devices`, () => {
    const { code } = room();
    for (let i = 1; i < MAX_MEMBERS; i++) join(code);
    const extra = client();
    reg.handle(extra, { type: 'room:join', code, device: 'x' });
    expect(extra.last('error').code).toBe('full');
  });

  it('makes the creator the host; only the host may share without asking', () => {
    const { a, code, aId } = room();
    const { c } = join(code);
    expect(a.last('room:update').room.hostId).toBe(aId);
    reg.handle(c, { type: 'share:start', state: on });
    expect(c.last('error').code).toBe('not-allowed');
    reg.handle(a, { type: 'share:start', state: on });
    expect(c.last('room:update').room.sharerId).toBe(aId);
  });

  it('request → approve hands over from the current sharer', () => {
    const { a, code, aId } = room();
    const { c, id: cId } = join(code);
    reg.handle(a, { type: 'share:start', state: on });
    reg.handle(c, { type: 'share:request' });
    expect(a.last('room:update').room.requests).toEqual([cId]);

    reg.handle(a, { type: 'share:approve', memberId: cId });
    let snap = c.last('room:update').room;
    expect(snap).toMatchObject({ grantId: cId, sharerId: null, requests: [] }); // A was stopped
    reg.handle(c, { type: 'share:start', state: on });
    snap = a.last('room:update').room;
    expect(snap.sharerId).toBe(cId);

    // Turn is used up once they stop.
    reg.handle(c, { type: 'share:stop' });
    expect(a.last('room:update').room).toMatchObject({ sharerId: null, grantId: null });
    reg.handle(c, { type: 'share:start', state: on });
    expect(c.last('error').code).toBe('not-allowed');
    void aId;
  });

  it('the host can take over from an approved sharer', () => {
    const { a, code, aId } = room();
    const { c, id: cId } = join(code);
    reg.handle(c, { type: 'share:request' });
    reg.handle(a, { type: 'share:approve', memberId: cId });
    reg.handle(c, { type: 'share:start', state: on });
    reg.handle(a, { type: 'share:start', state: on });
    expect(c.last('room:update').room.sharerId).toBe(aId);
  });

  it('deny tells the requester; only the host can approve, deny or revoke', () => {
    const { a, code } = room();
    const { c, id: cId } = join(code);
    const { c: d } = join(code);
    reg.handle(c, { type: 'share:request' });
    reg.handle(d, { type: 'share:approve', memberId: cId });
    expect(d.last('error').code).toBe('not-allowed');
    reg.handle(a, { type: 'share:deny', memberId: cId });
    expect(c.last('error').code).toBe('denied');
    expect(c.last('room:update').room.requests).toEqual([]);
  });

  it('the host can stop whoever is sharing', () => {
    const { a, code } = room();
    const { c, id: cId } = join(code);
    reg.handle(c, { type: 'share:request' });
    reg.handle(a, { type: 'share:approve', memberId: cId });
    reg.handle(c, { type: 'share:start', state: on });
    reg.handle(a, { type: 'share:revoke' });
    expect(c.last('room:update').room).toMatchObject({ sharerId: null, grantId: null });
  });

  it('passes hosting to the longest-standing member when the host leaves', () => {
    const { a, code } = room();
    const { c, id: cId } = join(code);
    join(code);
    reg.handle(a, { type: 'room:leave' });
    expect(c.last('room:update').room.hostId).toBe(cId);
  });

  it('relays signals only to or from the sharer', () => {
    const { a, code, aId } = room();
    const { c, id: cId } = join(code);
    const { c: d, id: dId } = join(code);

    // Nobody sharing: listeners cannot message each other.
    reg.handle(c, { type: 'signal', to: dId, payload: offer });
    expect(c.last('error').code).toBe('wrong-state');

    reg.handle(a, { type: 'share:start', state: on });
    reg.handle(a, { type: 'signal', to: cId, payload: offer });
    expect(c.last('signal')).toEqual({ type: 'signal', from: aId, payload: offer });
    reg.handle(c, { type: 'signal', to: aId, payload: offer });
    expect(a.last('signal').from).toBe(cId);
    // Still no listener ↔ listener relay while someone shares.
    d.inbox.length = 0;
    reg.handle(c, { type: 'signal', to: dId, payload: offer });
    expect(d.inbox.some((m) => m.type === 'signal')).toBe(false);
  });

  it('broadcasts mute/pause from the sharer only', () => {
    const { a, code } = room();
    const { c } = join(code);
    reg.handle(a, { type: 'share:start', state: on });
    reg.handle(a, { type: 'share:state', state: { muted: true, paused: false } });
    expect(c.last('room:update').room.shareState).toEqual({ muted: true, paused: false });
    reg.handle(c, { type: 'share:state', state: { muted: false, paused: true } });
    expect(c.last('room:update').room.shareState?.paused).toBe(false);
  });

  it('marks a dropped member offline, lets them resume, and keeps their sharer role', () => {
    const { a, code, aId, aToken } = room();
    const { c } = join(code);
    reg.handle(a, { type: 'share:start', state: on });

    reg.disconnect(a);
    expect(c.last('room:update').room.members.find((m) => m.id === aId)?.online).toBe(false);

    const back = client();
    reg.handle(back, { type: 'room:resume', code, memberId: aId, memberToken: aToken });
    expect(back.last('room:joined').room.sharerId).toBe(aId);
    expect(c.last('room:update').room.members.find((m) => m.id === aId)?.online).toBe(true);
  });

  it('removes a dropped sharer after the grace period, freeing the role', () => {
    const { a, code } = room();
    const { c } = join(code);
    reg.handle(a, { type: 'share:start', state: on });
    reg.disconnect(a);
    vi.advanceTimersByTime(501);
    const snap = c.last('room:update').room;
    expect(snap.sharerId).toBeNull();
    expect(snap.members).toHaveLength(1);
  });

  it('rejects resume with a wrong token', () => {
    const { a, code, aId } = room();
    reg.disconnect(a);
    const impostor = client();
    reg.handle(impostor, { type: 'room:resume', code, memberId: aId, memberToken: 'x'.repeat(32) });
    expect(impostor.last('error').code).toBe('unauthorized');
  });

  it('keeps the room when the creator leaves, deletes it when the last member leaves', () => {
    const { a, code } = room();
    const { c } = join(code);
    reg.handle(a, { type: 'room:leave' });
    expect(reg.rooms.has(code)).toBe(true);
    expect(c.last('room:update').room.members).toHaveLength(1);
    reg.handle(c, { type: 'room:leave' });
    expect(reg.rooms.has(code)).toBe(false);
  });
});
