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

export async function connectRelayAsync(
  url: string,
  onStateChange: (state: ConnectionState) => void,
): Promise<Relay> {
  onStateChange("connecting");
  try {
    const relay = await Relay.connect(url);
    relay.verifyEvent = () => true; // skip sig verification for channel messages
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
  const filter = { kinds: [42], "#e": [channelId], limit: 500 };
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