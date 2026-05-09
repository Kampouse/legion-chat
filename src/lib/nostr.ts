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
import { DEFAULT_RELAY, NEAR_RPC, NEAR_SOCIAL_CONTRACT } from "./constants";

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

export async function signChannelMessage(
  signer: NostrSigner,
  content: string,
  channelId: string,
  replyTo?: { id: string } | null,
): Promise<any> {
  const tags: string[][] = [["e", channelId, relayHint(DEFAULT_RELAY), "root"]];
  if (replyTo) {
    tags.push(["e", replyTo.id, relayHint(DEFAULT_RELAY), "reply"]);
  }
  return signer.signEvent({
    kind: 42,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  });
}

export async function signDeleteEvent(
  signer: NostrSigner,
  eventId: string,
): Promise<any> {
  return signer.signEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["e", eventId]],
    content: "deleted by author",
  });
}

function relayHint(url: string): string {
  return url.replace(/^wss?:\/\//, "");
}

// ── NIP-01 Profile (kind 0) ──

export interface NostrProfile {
  name?: string;
  about?: string;
  picture?: string;
  nip05?: string;
  display_name?: string;
  website?: string;
  lud16?: string;
}

export async function signProfileUpdate(signer: NostrSigner, profile: NostrProfile): Promise<any> {
  return signer.signEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(profile),
  });
}

// ── NIP-25 Reactions (kind 7) ──

export async function signReaction(
  signer: NostrSigner,
  eventId: string,
  eventPubkey: string,
  emoji: string,
): Promise<any> {
  return signer.signEvent({
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", eventId],
      ["p", eventPubkey],
    ],
    content: emoji,
  });
}

export async function signReactionDelete(
  signer: NostrSigner,
  reactionEventId: string,
): Promise<any> {
  return signer.signEvent({
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["e", reactionEventId]],
    content: "delete reaction",
  });
}

// ── NEAR Social profile fetch ──

export interface NearSocialProfile {
  name?: string;
  image?: string; // ipfs_cid or url
  description?: string;
  backgroundImage?: string;
}

export async function fetchNearSocialProfile(accountId: string): Promise<NearSocialProfile | null> {
  try {
    const res = await fetch(NEAR_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "social",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: NEAR_SOCIAL_CONTRACT,
          method_name: "get",
          args_base64: btoa(JSON.stringify({ keys: [`${accountId}/profile/**`] })),
        },
      }),
    });
    const json = await res.json();
    if (json.error) return null;
    // Result is bytes array — parse it
    const bytes = json.result?.result;
    if (!bytes) return null;
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
    const profile = parsed?.[accountId]?.profile;
    if (!profile) return null;

    // Build image URL — NEAR Social image can be: string (ipfs_cid), { ipfs_cid }, or { url }
    let imageUrl: string | undefined;
    if (profile.image) {
      if (typeof profile.image === "string") {
        imageUrl = profile.image.startsWith("http")
          ? profile.image
          : `https://ipfs.near.social/ipfs/${profile.image}`;
      } else if (typeof profile.image === "object") {
        if (profile.image.url) {
          imageUrl = profile.image.url;
        } else if (profile.image.ipfs_cid) {
          imageUrl = `https://ipfs.near.social/ipfs/${profile.image.ipfs_cid}`;
        }
      }
    }

    return {
      name: profile.name || undefined,
      image: imageUrl,
      description: profile.description || undefined,
      backgroundImage: profile.backgroundImage || undefined,
    };
  } catch {
    return null;
  }
}

export async function connectRelayAsync(
  url: string,
  onStateChange: (state: ConnectionState) => void,
): Promise<Relay> {
  onStateChange("connecting");
  try {
    const relay = await Relay.connect(url);
    onStateChange("connected");
    relay.onclose = () => {
      onStateChange("disconnected");
    };
    return relay;
  } catch (e) {
    onStateChange("error");
    throw e;
  }
}

export interface ReconnectHandle {
  /** Trigger a fresh reconnection attempt right now (resets backoff). */
  reconnect: () => void;
}

/**
 * Connect to a relay with automatic reconnection using exponential backoff.
 *
 * @param url               Relay websocket URL
 * @param onStateChange     Callback that receives the current ConnectionState
 * @param reconnectTrigger  A number that the parent increments to force a reconnect
 *                          (e.g. from a counter state). When it changes, a fresh
 *                          connection attempt is started.
 * @param onConnect         Optional callback invoked with the Relay instance each
 *                          time a connection succeeds.
 * @returns                 A handle whose `.reconnect()` can be called manually.
 */
export function connectRelayWithReconnect(
  url: string,
  onStateChange: (state: ConnectionState) => void,
  reconnectTrigger: number,
  onConnect?: (relay: Relay) => void,
): ReconnectHandle {
  const MAX_BACKOFF = 30_000; // 30 s
  const BASE_DELAY = 1_000;  // 1 s

  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let alive = true;
  let currentRelay: Relay | null = null;

  // Cancel any pending reconnect timer and close existing relay
  function cleanup() {
    alive = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (currentRelay) {
      try { currentRelay.close(); } catch { /* best-effort */ }
      currentRelay = null;
    }
  }

  function connect() {
    if (!alive) return;

    onStateChange("connecting");

    Relay.connect(url)
      .then((relay) => {
        if (!alive) {
          try { relay.close(); } catch {}
          return;
        }
        currentRelay = relay;
        attempt = 0; // reset backoff on successful connect
        onStateChange("connected");
        onConnect?.(relay);

        // When the relay closes, schedule an automatic reconnection
        relay.onclose = () => {
          if (!alive) return;
          currentRelay = null;
          onStateChange("disconnected");
          scheduleReconnect();
        };
      })
      .catch(() => {
        if (!alive) return;
        currentRelay = null;
        onStateChange("error");
        scheduleReconnect();
      });
  }

  function scheduleReconnect() {
    if (!alive) return;
    const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_BACKOFF);
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  // Public handle – allows manual reconnect
  const handle: ReconnectHandle = {
    reconnect() {
      // Cancel pending timer
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Close existing relay
      if (currentRelay) {
        try { currentRelay.close(); } catch {}
        currentRelay = null;
      }
      // Reset backoff and try again
      attempt = 0;
      connect();
    },
  };

  // Kick off the initial connection
  connect();

  // The caller should call cleanup when the component unmounts.
  // We stash it on the handle so the caller can access it.
  (handle as any)._cleanup = cleanup;

  return handle;
}

// ── Publish ──

export interface PublishResult {
  ok: boolean;
  eventId: string;
  message: string;
}

export async function publishWithAck(
  relay: Relay,
  event: any,
): Promise<PublishResult> {
  const PUBLISH_TIMEOUT = 5000;
  try {
    await Promise.race([
      relay.publish(event),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("publish timed out")), PUBLISH_TIMEOUT)
      ),
    ]);
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
  onDone?: () => void,
): () => void {
  const filter = { kinds: [42], "#e": [channelId], limit: 500 };
  const sub = relay.subscribe([filter], {
    onevent: (event: any) => {
      onMessage(event);
    },
    oneose: () => { onDone?.(); },
  });
  return () => {
    try { sub.close(); } catch {}
  };
}

// ── Typing indicator (ephemeral kind 21114) ──
// Ephemeral events aren't stored by relays — real-time only

const TYPING_KIND = 21114;
const TYPING_TTL = 4000; // ms before "typing" expires

export async function publishTyping(signer: any, relay: Relay, channelId: string): Promise<void> {
  try {
    const event = await signer.signEvent({
      kind: TYPING_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", channelId]],
      content: "typing",
    });
    relay.publish(event);
  } catch {}
}

export function subscribeTyping(
  relay: Relay,
  channelId: string,
  myPubkey: string,
  onTypingUpdate: (typingPubkeys: string[]) => void,
): () => void {
  const typingMap = new Map<string, number>(); // pubkey -> timestamp
  let alive = true;

  const checkExpiry = () => {
    if (!alive) return;
    const now = Date.now();
    let changed = false;
    for (const pk of Array.from(typingMap.keys())) {
      const ts = typingMap.get(pk)!;
      if (now - ts > TYPING_TTL) { typingMap.delete(pk); changed = true; }
    }
    if (changed) onTypingUpdate(Array.from(typingMap.keys()));
    if (typingMap.size > 0) setTimeout(checkExpiry, 1000);
  };

  const filter = { kinds: [TYPING_KIND], "#e": [channelId], since: Math.floor(Date.now() / 1000) - 10 };
  const sub = relay.subscribe([filter], {
    onevent: (event: any) => {
      if (event.pubkey === myPubkey) return;
      const wasEmpty = typingMap.size === 0;
      typingMap.set(event.pubkey, Date.now());
      onTypingUpdate(Array.from(typingMap.keys()));
      if (wasEmpty) checkExpiry();
    },
  });

  return () => {
    alive = false;
    try { sub.close(); } catch {}
  };
}