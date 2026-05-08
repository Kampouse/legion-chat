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

export interface ManagedRelay {
  getRelay: () => Relay | null;
  getConnectionState: () => ConnectionState;
  onStateChange: (cb: (state: ConnectionState) => void) => () => void;
  onReconnect: (cb: (relay: Relay) => void) => () => void;
  close: () => void;
}

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;

/**
 * Connect to a relay with automatic reconnection.
 * Notifies via onReconnect() when a new connection is established
 * so consumers can re-subscribe.
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
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const reconnectListeners = new Set<(relay: Relay) => void>();

  const notifyState = (s: ConnectionState) => {
    state = s;
    onStateChange?.(s);
    stateListeners.forEach((cb) => cb(s));
  };

  const notifyReconnect = (r: Relay) => {
    reconnectListeners.forEach((cb) => cb(r));
  };

  const connect = async () => {
    if (closed) return;
    notifyState("connecting");
    try {
      relay = await Relay.connect(url);
      attempt = 0;
      notifyState("connected");
      notifyReconnect(relay);

      // Watch for disconnect
      const ws = (relay as any)?.ws as WebSocket | undefined;
      if (ws) {
        ws.addEventListener("close", () => {
          if (!closed) scheduleReconnect();
        });
        ws.addEventListener("error", () => {
          if (!closed) notifyState("error");
        });
      }
    } catch (e: any) {
      if (!closed) {
        notifyState("error");
        scheduleReconnect();
      }
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, attempt), RECONNECT_MAX_DELAY);
    const jitter = delay * (0.75 + Math.random() * 0.5);
    attempt++;
    reconnectTimer = setTimeout(connect, jitter);
  };

  connect();

  return {
    getRelay: () => relay,
    getConnectionState: () => state,
    onStateChange: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onReconnect: (cb) => {
      reconnectListeners.add(cb);
      return () => reconnectListeners.delete(cb);
    },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { relay?.close(); } catch {}
    },
  };
}

// ── Publish with best-effort ack ──

export interface PublishResult {
  ok: boolean;
  eventId: string;
  message: string;
}

/**
 * Publish an event using nostr-tools relay.publish().
 * Returns ok=true on success, ok=false on failure.
 */
export async function publishWithAck(
  relay: Relay,
  event: any,
  _timeoutMs: number = 3000,
): Promise<PublishResult> {
  try {
    await relay.publish(event);
    return { ok: true, eventId: event.id, message: "" };
  } catch (e: any) {
    return { ok: false, eventId: event.id, message: e.message || "publish failed" };
  }
}

// ── Subscribe to channel ──

export function subscribeChannel(
  relay: Relay,
  channelId: string,
  onMessage: (msg: any) => void,
): () => void {
  const filter = { kinds: [41], "#e": [channelId], limit: 500 };
  const sub = relay.subscribe([filter], {
    onevent: (event: any) => {
      onMessage(event);
    },
    oneose: () => {},
  });
  return () => {
    try { sub.close(); } catch {}
  };
}

// Legacy fire-and-forget publish
export function publishEvent(relay: Relay, event: any): void {
  const msg = JSON.stringify(["EVENT", event]);
  (relay as any).ws?.send(msg);
}