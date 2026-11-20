import { KEEPALIVE_MS, serverMessage, WS_PATH, type ClientMessage, type ServerMessage } from '@aura/protocol';
import { Emitter } from '../lib/emitter';

export type SocketStatus = 'connecting' | 'open' | 'closed';

interface SignalingEvents extends Record<string, unknown> {
  message: ServerMessage;
  /** `open` fires on the first connection AND on every reconnection. */
  status: { status: SocketStatus; reconnect: boolean };
}

const BACKOFF_MS = [300, 700, 1500, 3000, 5000, 8000];

function defaultUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${WS_PATH}`;
}

/**
 * WebSocket with automatic reconnection. It knows nothing about sessions:
 * controllers decide what to send on (re)connect (create/join vs resume).
 */
export class SignalingClient extends Emitter<SignalingEvents> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private everOpened = false;
  private stopped = false;
  private retryTimer: number | undefined;
  private keepalive: number | undefined;

  constructor(private readonly url: string = defaultUrl()) {
    super();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    this.emit('status', { status: 'connecting', reconnect: this.everOpened });
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      window.clearInterval(this.keepalive);
      this.keepalive = window.setInterval(() => this.send({ type: 'ping' }), KEEPALIVE_MS);
      const reconnect = this.everOpened;
      this.everOpened = true;
      this.emit('status', { status: 'open', reconnect });
    };
    ws.onmessage = (e) => {
      let json: unknown;
      try {
        json = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const parsed = serverMessage.safeParse(json);
      if (parsed.success) this.emit('message', parsed.data);
      else console.warn('[aura] unrecognised server message', json);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      window.clearInterval(this.keepalive);
      this.ws = null;
      this.emit('status', { status: 'closed', reconnect: this.everOpened });
      if (this.stopped) return;
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
      this.attempt++;
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };
  }

  /** Number of consecutive failed attempts since the last successful open. */
  get failures(): number {
    return this.attempt;
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.keepalive);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.clearListeners();
  }
}
