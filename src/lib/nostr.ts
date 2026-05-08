import {
  generateSecretKey,
  getPublicKey,
  Relay,
  nip19,
} from "nostr-tools";
import {
  Nip07Signer,
  Nip46Signer,
  PrivateKeySigner,
  type NostrSigner,
} from "@nostr-wot/signers";
import { DEFAULT_RELAY } from "./constants";

export type { Relay, NostrSigner };
export { Nip07Signer, Nip46Signer, PrivateKeySigner };

// ── Connection states ──
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

// ── Create signers ──

export function hasNostrExtension(): boolean {
  return typeof window !== "undefined" && !!(window as any).nostr;
}

export function createNip07Signer(): NostrSigner {
  return new Nip07Signer();
}

export function createPrivateKeySigner(nsec: string): NostrSigner {
  const skBytes = nip19.decode(nsec).data as Uint8Array;
  return new PrivateKeySigner(skBytes);
}

export async function createNip46Signer(
  bunkerUri: string,
  onAuthChallenge?: (url: string) => void,
): Promise<NostrSigner> {
  return Nip46Signer.fromBunkerUri(bunkerUri, { onAuthChallenge });
}

// ── Generate local keypair ──

export function generateKeys(): { sk: string; pk: string } {
  const skBytes = generateSecretKey();
  const sk = nip19.nsecEncode(skBytes);
  const pk = nip19.npubEncode(getPublicKey(skBytes));
  return { sk, pk };
}

export function parseNsec(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") throw new Error(`Expected nsec, got ${decoded.type}`);
  return decoded.data as Uint8Array;
}

export function getPubkey(nsec: string): string {
  return getPublicKey(parseNsec(nsec));
}

// ── Signing ──

export async function signChallenge(signer: NostrSigner, challenge: string): Promise<string> {
  const event = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: challenge,
  });
  return JSON.stringify(event);
}

// ── NIP-28 Channel ──

export async function signChannelMessage(signer: NostrSigner, content: string, channelId: string): Promise<any> {
  return signer.signEvent({
    kind: 41,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["e", channelId, relayHint(DEFAULT_RELAY), "root"]],
    content,
  });
}

function relayHint(url: string): string {
  return url.replace(/^wss?:\/\//, "");
}

// ── Relay with reconnection ──

const RELAY_CONNECT_TIMEOUT = 10000;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;

export interface ManagedRelay {
  relay: Relay;
  getConnectionState: () => ConnectionState;
  onStateChange: (cb: (state: ConnectionState) => void) => () => void;
  close: () => void;
}

/**
 * Connect to a relay with automatic reconnection and state tracking.
 * Returns a ManagedRelay that handles reconnection with exponential backoff.
 */
export function connectManagedRelay(
  url: string,
  onStateChange?: (state: ConnectionState) => void,
): ManagedRelay {
  let state: ConnectionState = "connecting";
  let relay: Relay | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let closed = false;
  const listeners = new Set<(state: ConnectionState) => void>();

  const notify = (s: ConnectionState) => {
    state = s;
    onStateChange?.(s);
    listeners.forEach((cb) => cb(s));
  };

  const getWs = (): WebSocket | undefined => {
    try { return (relay as any)?.ws as WebSocket | undefined; }
    catch { return undefined; }
  };

  const connect = async () => {
    if (closed) return;
    notify("connecting");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RELAY_CONNECT_TIMEOUT);
      relay = await Relay.connect(url);
      clearTimeout(timeout);
      attempt = 0;
      notify("connected");

      // Watch for disconnect
      const ws = getWs();
      if (ws) {
        ws.addEventListener("close", () => {
          if (!closed) scheduleReconnect();
        });
        ws.addEventListener("error", () => {
          if (!closed) notify("error");
        });
      }
    } catch (e: any) {
      if (!closed) {
        notify("error");
        scheduleReconnect();
      }
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt), RECONNECT_MAX_DELAY);
    // Add jitter ±25%
    const jitter = delay * (0.75 + Math.random() * 0.5);
    attempt++;
    reconnectTimer = setTimeout(connect, jitter);
  };

  connect();

  return {
    get relay() { return relay!; },
    getConnectionState: () => state,
    onStateChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { relay?.close(); } catch {}
    },
  };
}

// ── Publish with confirmation ──

export interface PublishResult {
  ok: boolean;
  eventId: string;
  message: string;
}

/**
 * Publish an event and wait for the relay's OK response.
 * Returns a promise that resolves when the relay confirms (or rejects).
 */
export function publishWithAck(
  relay: Relay,
  event: any,
  timeoutMs: number = 5000,
): Promise<PublishResult> {
  return new Promise((resolve) => {
    const ws = (relay as any).ws as WebSocket | undefined;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, eventId: event.id, message: "WebSocket not connected" });
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, eventId: event.id, message: "Publish timed out" });
    }, timeoutMs);

    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        // Relay responds with ["OK", eventId, success, message]
        if (msg[0] === "OK" && msg[1] === event.id) {
          cleanup();
          resolve({ ok: msg[2], eventId: msg[1], message: msg[3] || "" });
        }
      } catch {}
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
    };

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(["EVENT", event]));
  });
}

// ── Subscribe to channel ──

export function subscribeChannel(
  relay: Relay,
  channelId: string,
  onMessage: (msg: any) => void,
): () => void {
  const ws = (relay as any).ws as WebSocket | undefined;
  if (!ws) return () => {};
  const subId = "legion-" + Math.random().toString(36).slice(2);
  const filter = JSON.stringify(["REQ", subId, { kinds: [41], "#e": [channelId], limit: 500 }]);
  ws.send(filter);

  const handler = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg[0] === "EVENT" && msg[1] === subId) {
        onMessage(msg[2]);
      }
    } catch {}
  };
  ws.addEventListener("message", handler);

  return () => {
    ws.removeEventListener("message", handler);
    try { ws.send(JSON.stringify(["CLOSE", subId])); } catch {}
  };
}

// Legacy fire-and-forget publish (kept for backwards compat)
export function publishEvent(relay: Relay, event: any): void {
  const msg = JSON.stringify(["EVENT", event]);
  (relay as any).ws?.send(msg);
}