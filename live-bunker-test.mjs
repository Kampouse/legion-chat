// Live bunker test: spin up a mock bunker that stays alive on real relays
// Then test if our code can pair + get_public_key against it
import { 
  SimplePool, generateSecretKey, getPublicKey, finalizeEvent, 
  nip44, bytesToHex, hexToBytes
} from "nostr-tools";
import { v4 as uuid } from "uuid";

const pool = new SimplePool();
const relays = ["wss://relay.primal.net", "wss://relay.nip46.com", "wss://nos.lol"];

// Generate bunker key
const bunkerSk = generateSecretKey();
const bunkerPk = getPublicKey(bunkerSk);
console.log("Bunker pubkey:", bunkerPk);

// Generate client key (simulating what the app does)
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
console.log("Client pubkey:", clientPk);

const secret = bytesToHex(generateSecretKey()).slice(0, 16);
console.log("Shared secret:", secret);

// Subscribe as bunker — listen for kind 24133 p-tagged to us
const bunkerSub = pool.subscribeMany(relays, [
  { kinds: [24133], "#p": [bunkerPk] }
], {
  onevent: async (event) => {
    if (event.pubkey === bunkerPk) return; // skip our own events
    
    console.log(`\n[BUNKER] got event from ${event.pubkey.slice(0,12)} content_len:${event.content?.length}`);
    
    try {
      // Decrypt with bunker's key
      const decrypted = await nip44.decrypt(event.pubkey, bunkerSk, event.content);
      const parsed = JSON.parse(decrypted);
      console.log("[BUNKER] decrypted RPC:", parsed.method, "id:", parsed.id?.slice(0,8), "params:", parsed.params?.length);
      
      let result = "";
      if (parsed.method === "connect") {
        result = secret; // return the secret as ack
        console.log("[BUNKER] responding to connect with secret");
      } else if (parsed.method === "get_public_key") {
        result = bunkerPk; // return our pubkey as the "user" pubkey
        console.log("[BUNKER] responding to get_public_key with", bunkerPk.slice(0,12));
      } else {
        result = "ack";
        console.log("[BUNKER] responding to", parsed.method, "with ack");
      }
      
      // Build response
      const response = JSON.stringify({ id: parsed.id, result, error: "" });
      const encrypted = await nip44.encrypt(event.pubkey, bunkerSk, response);
      
      const respEvent = finalizeEvent({
        kind: 24133,
        content: encrypted,
        tags: [["p", event.pubkey]],
        created_at: Math.floor(Date.now() / 1000),
      }, bunkerSk);
      
      const pubs = pool.publish(relays, respEvent);
      await Promise.allSettled(pubs);
      console.log("[BUNKER] response published for id:", parsed.id?.slice(0,8));
      
    } catch (e) {
      console.error("[BUNKER] error:", e.message);
    }
  },
  oneose: () => console.log("[BUNKER] subscription EOSE — listening..."),
});

console.log("\nBunker is LIVE. Waiting for client...\n");

// Now simulate the client (like our NostrConnectSigner does)
await new Promise(r => setTimeout(r, 3000)); // wait for subscription to settle

// Client subscribes for bunker responses
const clientSub = pool.subscribeMany(relays, [
  { kinds: [24133], "#p": [clientPk] }
], {
  onevent: async (event) => {
    if (event.pubkey === clientPk) return;
    console.log("[CLIENT] got response from", event.pubkey.slice(0,12));
    try {
      const decrypted = await nip44.decrypt(event.pubkey, clientSk, event.content);
      console.log("[CLIENT] response:", decrypted);
    } catch (e) {
      console.error("[CLIENT] decrypt error:", e.message);
    }
  },
  oneose: () => console.log("[CLIENT] subscription EOSE"),
});

await new Promise(r => setTimeout(r, 2000));

// Send connect RPC
console.log("\n[CLIENT] sending connect RPC...");
const connectReq = JSON.stringify({ id: uuid(), method: "connect", params: [bunkerPk, secret] });
const connectEncrypted = await nip44.encrypt(bunkerPk, clientSk, connectReq);
const connectEvent = finalizeEvent({
  kind: 24133,
  content: connectEncrypted,
  tags: [["p", bunkerPk]],
  created_at: Math.floor(Date.now() / 1000),
}, clientSk);
await Promise.allSettled(pool.publish(relays, connectEvent));
console.log("[CLIENT] connect published");

await new Promise(r => setTimeout(r, 5000));

// Send get_public_key
console.log("\n[CLIENT] sending get_public_key RPC...");
const gpkReq = JSON.stringify({ id: uuid(), method: "get_public_key", params: [] });
const gpkEncrypted = await nip44.encrypt(bunkerPk, clientSk, gpkReq);
const gpkEvent = finalizeEvent({
  kind: 24133,
  content: gpkEncrypted,
  tags: [["p", bunkerPk]],
  created_at: Math.floor(Date.now() / 1000),
}, clientSk);
await Promise.allSettled(pool.publish(relays, gpkEvent));
console.log("[CLIENT] get_public_key published");

// Wait for responses
await new Promise(r => setTimeout(r, 10000));

console.log("\nDone. Closing.");
clientSub.close();
bunkerSub.close();
pool.close(relays);
process.exit(0);
