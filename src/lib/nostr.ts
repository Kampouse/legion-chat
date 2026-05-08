import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
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

// ── Create signers ──

export function hasNostrExtension(): boolean {
  return typeof window !== "undefined" && !!window.nostr;
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

export function createNip46FromSaved(
  bunkerUri: string,
  clientNsec: string,
  onAuthChallenge?: (url: string) => void,
): Promise<NostrSigner> {
  return Nip46Signer.fromBunkerUri(bunkerUri, {
    clientNsec,
    onAuthChallenge,
  });
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

// ── Signing (unified via NostrSigner) ──

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

/**
 * Create a NIP-28 channel (kind 40). Returns the event — the event.id is the channel ID.
 */
export async function createChannel(signer: NostrSigner, name: string, about?: string): Promise<any> {
  const event = await signer.signEvent({
    kind: 40,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name, about: about || "" }),
  });
  return event;
}

/**
 * Send a NIP-28 channel message (kind 41).
 */
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

// ── Relay ──

export async function connectRelay(url: string = DEFAULT_RELAY): Promise<Relay> {
  return Relay.connect(url);
}

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

export function publishEvent(relay: Relay, event: any): void {
  const msg = JSON.stringify(["EVENT", event]);
  (relay as any).ws?.send(msg);
}
