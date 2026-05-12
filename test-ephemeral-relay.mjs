/**
 * Quick test: does relay.primal.net serve kind 24133 ephemeral events?
 * 
 * Publishes a test kind 24133 event, then subscribes to see if it comes back.
 * If it doesn't, relay.primal.net drops ephemeral events (NIP-16).
 */
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";

const RELAYS = ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];

const sk = generateSecretKey();
const pk = getPublicKey(sk);

console.log("pubkey:", pk.slice(0, 16));

// Create a kind 24133 test event (NIP-46 format)
const conv = nip44.v2.utils.getConversationKey(sk, pk); // self-encrypt for test
const ct = nip44.v2.encrypt(JSON.stringify({ id: "test123", method: "test", params: [] }), conv);
const event = finalizeEvent({
  kind: 24133,
  created_at: Math.floor(Date.now() / 1000),
  tags: [["p", pk]],
  content: ct,
}, sk);

console.log("event id:", event.id?.slice(0, 16));

const pool = new SimplePool();

// Subscribe BEFORE publishing to catch it
let found = false;
const sub = pool.subscribeMany(
  RELAYS,
  { kinds: [24133], authors: [pk], since: Math.floor(Date.now() / 1000) - 60 },
  {
    onevent: (e) => {
      if (e.id === event.id) {
        console.log("✓ FOUND own event on:", RELAYS.join(", "));
        found = true;
      }
    },
    oneose: async () => {
      console.log("EOSE — publishing test event...");
      
      // Publish
      const pubs = await Promise.allSettled(pool.publish(RELAYS, event));
      console.log("publish results:", pubs.map((p, i) => `${RELAYS[i]}=${p.status}`).join(", "));
      
      // Wait 10s for it to come back
      await new Promise(r => setTimeout(r, 10_000));
      
      if (!found) {
        console.log("✗ DID NOT find own kind 24133 event via subscription");
        console.log("  → relay.primal.net likely drops ephemeral events");
      }
      
      sub.close();
      process.exit(found ? 0 : 1);
    },
  },
);

setTimeout(() => {
  console.log("✗ Timeout (15s)");
  sub.close();
  process.exit(1);
}, 15_000);
