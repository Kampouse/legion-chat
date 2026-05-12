/**
 * Headless NIP-46 nostrconnect test — FULLY AUTOMATED.
 * Both client and mock bunker run locally. No scanning needed.
 * 
 * Usage: bun test-nip46-headless.mjs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";

const RELAYS = [
  "wss://relay.camelus.app",
  "wss://nostr-01.yakihonne.com",
];

const KIND = 24133;
const RPC_TIMEOUT = 15_000;

// ── Helpers ──

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => chars[b % chars.length])
    .join("");
}

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...args) { console.log(`${ts()} LOG`, ...args); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  NIP-46 Headless Test (NDK Flow)");
  console.log("═══════════════════════════════════════\n");

  // Generate keys
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  const secret = randomSecret();

  log("client:", clientPk.slice(0, 16));
  log("bunker:", bunkerPk.slice(0, 16));
  log("secret:", secret);

  const clientConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
  const bunkerConv = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

  const pending = new Map(); // client pending RPCs

  // ── Phase 1: Bunker starts listening ──
  log("\n--- Phase 1: Start bunker ---");

  const bunkerPool = new SimplePool();
  const bunkerSub = bunkerPool.subscribeMany(
    RELAYS,
    { kinds: [KIND], "#p": [bunkerPk] },
    {
      onevent: async (event) => {
        log("[BUNKER] event from", event.pubkey.slice(0, 12));
        try {
          const conv = nip44.v2.utils.getConversationKey(bunkerSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log("[BUNKER] request:", parsed.method, "id:", parsed.id?.slice(0, 8));

          let result, error;
          if (parsed.method === "connect") {
            result = parsed.params?.[1] === secret ? secret : undefined;
            error = parsed.params?.[1] !== secret ? "secret mismatch" : undefined;
          } else if (parsed.method === "get_public_key") {
            result = clientPk;
          } else if (parsed.method === "sign_event") {
            const evt = JSON.parse(parsed.params?.[1] || "{}");
            const template = {
              kind: Number(evt.kind || 1),
              content: String(evt.content || ""),
              tags: Array.isArray(evt.tags) ? evt.tags : [],
              created_at: Number(evt.created_at || Math.floor(Date.now() / 1000)),
              pubkey: String(evt.pubkey || clientPk),
            };
            const signed = finalizeEvent(template, bunkerSk);
            result = JSON.stringify(signed);
          } else if (parsed.method === "nip44_encrypt") {
            const [targetPk, plaintext] = parsed.params;
            const encConv = nip44.v2.utils.getConversationKey(bunkerSk, targetPk);
            result = nip44.v2.encrypt(plaintext, encConv);
          } else if (parsed.method === "nip44_decrypt") {
            const [senderPk, ciphertext] = parsed.params;
            const decConv = nip44.v2.utils.getConversationKey(bunkerSk, senderPk);
            result = nip44.v2.decrypt(ciphertext, decConv);
          } else {
            error = `unknown method: ${parsed.method}`;
          }

          // Send response
          const respPayload = JSON.stringify({ id: parsed.id, result, error });
          const respConv = nip44.v2.utils.getConversationKey(bunkerSk, event.pubkey);
          const respCT = nip44.v2.encrypt(respPayload, respConv);
          const respEvent = finalizeEvent(
            { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", event.pubkey]], content: respCT },
            bunkerSk,
          );
          const pubs = await Promise.allSettled(bunkerPool.publish(RELAYS, respEvent));
          log("[BUNKER] response published:", pubs.map(p => p.status));
        } catch (e) {
          log("[BUNKER] error:", e.message);
        }
      },
      oneose: () => log("[BUNKER] EOSE — listening"),
    },
  );

  await sleep(2000); // let bunker sub settle

  // ── Phase 2: Client pairing subscription ──
  log("\n--- Phase 2: Client pairing subscription ---");

  const clientPool = new SimplePool();
  const since = Math.floor(Date.now() / 1000) - 300;

  let paired = false;
  const pairSub = clientPool.subscribeMany(
    RELAYS,
    { kinds: [KIND], "#p": [clientPk], since },
    {
      onevent: async (event) => {
        if (paired) return;
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log("[CLIENT] pair event:", parsed.method, "result:", String(parsed.result || "").slice(0, 16));
          // NDK: response["result"] == secret
          if (parsed.result === secret) {
            paired = true;
            log("[CLIENT] PAIRED!");
          }
        } catch {}
      },
      oneose: () => log("[CLIENT] pairing sub EOSE"),
    },
  );

  await sleep(2000); // let pair sub settle

  // ── Phase 3: Simulate Primal scanning QR ──
  log("\n--- Phase 3: Simulate Primal QR scan ---");

  // Primal publishes the pairing confirmation: { result: secret }
  // This is NOT a connect request — it's the bunker confirming the session
  const connectPayload = JSON.stringify({
    id: randomId(),
    result: secret,
  });
  const connectCT = nip44.v2.encrypt(connectPayload, bunkerConv);
  const connectEvent = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", clientPk]], content: connectCT },
    bunkerSk,
  );

  log("[PRIMAL] publishing connect response...");
  const pubs = await Promise.allSettled(new SimplePool().publish(RELAYS, connectEvent));
  log("[PRIMAL] publish:", pubs.map(p => p.status));

  // Wait for client to receive pairing
  await sleep(3000);
  if (!paired) {
    log("✗ Pairing failed — client never received connect response");
    process.exit(1);
  }

  // Close pairing subscription
  pairSub.close();

  // ── Phase 4: Open persistent subscription ──
  log("\n--- Phase 4: Persistent subscription ---");

  let eoseResolve;
  const eosePromise = new Promise(r => { eoseResolve = r; });

  const persistSub = clientPool.subscribeMany(
    RELAYS,
    { authors: [bunkerPk], kinds: [KIND], "#p": [clientPk] },
    {
      onevent: async (event) => {
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log("[CLIENT] response:", JSON.stringify({ id: parsed.id?.slice(0,8), result: typeof parsed.result === "string" ? parsed.result.slice(0,24) : parsed.result, error: parsed.error }));

          if (parsed.id && pending.has(parsed.id)) {
            const entry = pending.get(parsed.id);
            pending.delete(parsed.id);
            clearTimeout(entry.timer);
            if (parsed.error) entry.reject(new Error(parsed.error));
            else entry.resolve(parsed.result || "");
          }
        } catch (e) {
          log("[CLIENT] decrypt error:", e.message);
        }
      },
      oneose: () => { log("[CLIENT] persistent sub EOSE"); eoseResolve(); },
    },
  );

  // EOSE timeout
  const eoseTimer = setTimeout(() => { log("[CLIENT] EOSE timeout — proceeding"); eoseResolve(); }, 10_000);
  await eosePromise;
  clearTimeout(eoseTimer);

  // ── Phase 5: RPC helper ──

  async function rpc(method, params = []) {
    const id = randomId();
    const payload = JSON.stringify({ id, method, params });
    const ct = nip44.v2.encrypt(payload, clientConv);
    const evt = finalizeEvent(
      { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunkerPk]], content: ct },
      clientSk,
    );

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${RPC_TIMEOUT}ms`)); }, RPC_TIMEOUT);
    pending.set(id, { resolve, reject, timer });

    log("[CLIENT] publishing", method, "id:", id);
    await Promise.allSettled(clientPool.publish(RELAYS, evt));
    return promise;
  }

  // ── Phase 6: Tests ──

  let passed = 0, failed = 0;

  // Test 1: get_public_key
  log("\n--- Test 1: get_public_key ---");
  try {
    const pk = await rpc("get_public_key");
    if (pk === clientPk) {
      log("✓ PASS — got correct pubkey:", pk.slice(0, 16));
      passed++;
    } else {
      log("✗ FAIL — pubkey mismatch. expected:", clientPk.slice(0, 16), "got:", pk.slice(0, 16));
      failed++;
    }
  } catch (e) {
    log("✗ FAIL —", e.message);
    failed++;
  }

  // Test 2: sign_event
  log("\n--- Test 2: sign_event ---");
  try {
    const testEvent = { kind: 1, content: "hello from headless test", tags: [] };
    const signed = await rpc("sign_event", [JSON.stringify(testEvent)]);
    const parsed = JSON.parse(signed);
    if (parsed.sig && parsed.pubkey === bunkerPk) {
      log("✓ PASS — event signed by bunker:", parsed.sig.slice(0, 16));
      passed++;
    } else {
      log("✗ FAIL — unexpected sign result:", signed.slice(0, 40));
      failed++;
    }
  } catch (e) {
    log("✗ FAIL —", e.message);
    failed++;
  }

  // Test 3: nip44_encrypt
  log("\n--- Test 3: nip44_encrypt ---");
  try {
    const targetPk = getPublicKey(generateSecretKey());
    const encrypted = await rpc("nip44_encrypt", [targetPk, "secret message"]);
    if (encrypted && encrypted.length > 20) {
      log("✓ PASS — encrypted:", encrypted.slice(0, 24));
      passed++;
    } else {
      log("✗ FAIL — unexpected encrypt result:", encrypted);
      failed++;
    }
  } catch (e) {
    log("✗ FAIL —", e.message);
    failed++;
  }

  // ── Summary ──
  log("\n═══════════════════════════════════════");
  log(`  Results: ${passed} passed, ${failed} failed`);
  log("═══════════════════════════════════════");

  persistSub.close();
  bunkerSub.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { log("FATAL:", e.message); process.exit(1); });
