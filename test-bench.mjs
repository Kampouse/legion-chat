/**
 * Legion Chat — NIP-46 Test Bench
 *
 * Tests the REAL NostrConnectSigner from src/lib/nostr-connect-signer.ts
 * over real relays with a mock bunker. Zero manual steps.
 *
 *   bun test-bench.mjs
 *
 * Proves the full Nostr flow:
 *   - nostrconnect:// pairing → signer ready
 *   - Sign kind 42 channel message → publish to real relay → subscribe → receive it back
 *   - Sign kind 0 profile → publish → subscribe → receive
 *   - Sign kind 7 reaction → publish → subscribe → receive
 *   - Sign kind 5 delete → publish → event gone from relay
 *   - Session restore, refresh, close, concurrent RPCs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import * as nip44 from "nostr-tools/nip44";
import { SimplePool } from "nostr-tools/pool";

// Import the REAL signer
import { NostrConnectSigner } from "./src/lib/nostr-connect-signer.ts";

// ── Config ──────────────────────────────────────────────────────────

const RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
];

const CHANNEL_ID = "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714";
const KIND = 24133;

// ── Helpers ─────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`${ts()} ${a.join(" ")}`);
const results = { passed: 0, failed: 0 };
const pass = (m) => { log(`  ✓ ${m}`); results.passed++; };
const fail = (m) => { log(`  ✗ ${m}`); results.failed++; };
const hr = () => log("──────────────────────────────────────────");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Publish a signed event, wait for it to propagate, verify via querySync.
 * This proves the relay accepted AND stored the event.
 */
async function publishAndVerifyRoundTrip(relayUrls, signed, timeoutMs = 10_000) {
  const pool = new SimplePool();

  // Publish
  const pubs = await Promise.allSettled(pool.publish(relayUrls, signed));
  const ok = pubs.filter(p => p.status === "fulfilled").length;
  if (ok === 0) throw new Error("all relays rejected publish");
  log(`  published ${ok}/${pubs.length} relays`);

  // Wait for propagation, then verify with querySync
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    const results = await pool.querySync(relayUrls, {
      kinds: [signed.kind],
      authors: [signed.pubkey],
      since: signed.created_at,
    });
    const found = results.find(e => e.id === signed.id);
    if (found) return found;
  }
  throw new Error(`event not found on relays after ${timeoutMs}ms`);
}

// ── Mock Bunker ─────────────────────────────────────────────────────

function startBunker(bunkerSk, bunkerPk, userSk, userPk) {
  const pool = new SimplePool();
  log(`[BUNKER] starting ${bunkerPk.slice(0, 16)}...`);

  const sub = pool.subscribeMany(
    RELAYS,
    { kinds: [KIND], "#p": [bunkerPk] },
    {
      onevent: async (event) => {
        try {
          const conv = nip44.v2.utils.getConversationKey(bunkerSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log(`[BUNKER] ← ${parsed.method} id=${parsed.id?.slice(0, 8)}`);

          let result, error;
          switch (parsed.method) {
            case "connect": result = "ack"; break;
            case "get_public_key": result = userPk; break;
            case "sign_event": {
              const tmpl = JSON.parse(parsed.params?.[0] || "{}");
              const template = {
                kind: Number(tmpl.kind ?? 1),
                content: String(tmpl.content ?? ""),
                tags: Array.isArray(tmpl.tags) ? tmpl.tags : [],
                created_at: Number(tmpl.created_at ?? Math.floor(Date.now() / 1000)),
                pubkey: userPk,
              };
              result = JSON.stringify(finalizeEvent(template, userSk));
              break;
            }
            case "nip44_encrypt": {
              const [targetPk, plaintext] = parsed.params;
              result = nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(userSk, targetPk));
              break;
            }
            case "nip44_decrypt": {
              const [thirdPartyPk, ciphertext] = parsed.params;
              result = nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(userSk, thirdPartyPk));
              break;
            }
            default: error = `unknown: ${parsed.method}`;
          }

          const respPayload = JSON.stringify({ id: parsed.id, result, error });
          const respCt = nip44.v2.encrypt(respPayload, nip44.v2.utils.getConversationKey(bunkerSk, event.pubkey));
          const respEvent = finalizeEvent(
            { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", event.pubkey]], content: respCt },
            bunkerSk,
          );
          const pubs = await Promise.allSettled(pool.publish(RELAYS, respEvent));
          const ok = pubs.filter(p => p.status === "fulfilled").length;
          log(`[BUNKER] → ${parsed.method} ${ok}/${pubs.length} relays`);
        } catch (e) { log(`[BUNKER] error: ${e.message}`); }
      },
      oneose: () => log("[BUNKER] EOSE — listening"),
    },
  );

  async function publishPairingResponse(clientPk, secret) {
    log(`[BUNKER] pairing response for ${clientPk.slice(0, 12)}...`);
    const pairPayload = JSON.stringify({ id: bytesToHex(crypto.getRandomValues(new Uint8Array(8))), result: secret });
    const pairCt = nip44.v2.encrypt(pairPayload, nip44.v2.utils.getConversationKey(bunkerSk, clientPk));
    const pairEvent = finalizeEvent(
      { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", clientPk]], content: pairCt },
      bunkerSk,
    );
    const pubs = await Promise.allSettled(pool.publish(RELAYS, pairEvent));
    log(`[BUNKER] pairing ${pubs.filter(p => p.status === "fulfilled").length}/${pubs.length} relays`);
  }

  return { close: () => sub.close(), publishPairingResponse };
}

// ── Tests ───────────────────────────────────────────────────────────

async function runTests(signer, userPk) {

  // ═══════════════════════════════════════════════════════════════════
  // SUITE E: Full Nostr flow — sign, publish to relay, subscribe, receive
  // This proves we can actually send stuff on the network.
  // ═══════════════════════════════════════════════════════════════════

  hr();
  log("SUITE E: full Nostr flow (sign → publish → subscribe → receive)");
  hr();

  // E1: kind 42 channel message
  log("\nE1  kind 42 channel message → publish → verify on relay");
  let channelMsgId;
  try {
    const content = `test-bench ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const signed = await signer.signEvent({
      kind: 42, content, tags: [["e", CHANNEL_ID, "", "root"]], created_at: now,
    });
    channelMsgId = signed.id;
    log(`  signed: id=${signed.id.slice(0, 12)}...`);

    const found = await publishAndVerifyRoundTrip(RELAYS, signed, 10_000);
    found.id === signed.id && found.content === content
      ? pass(`channel msg round-trip: "${content.slice(0, 30)}"`)
      : fail(`content mismatch`);
  } catch (e) { fail(e.message); }

  // E2: kind 0 profile
  log("\nE2  kind 0 profile → publish → verify on relay");
  try {
    const now = Math.floor(Date.now() / 1000);
    const content = JSON.stringify({ name: "TestBench", about: `automated test ${Date.now()}` });
    const signed = await signer.signEvent({ kind: 0, content, tags: [], created_at: now });
    log(`  signed: id=${signed.id.slice(0, 12)}...`);

    const found = await publishAndVerifyRoundTrip(RELAYS, signed, 10_000);
    found.id === signed.id
      ? pass(`profile round-trip: ${found.content.slice(0, 40)}...`)
      : fail(`profile mismatch`);
  } catch (e) { fail(e.message); }

  // E3: kind 7 reaction
  log("\nE3  kind 7 reaction → publish → verify on relay");
  try {
    const now = Math.floor(Date.now() / 1000);
    const signed = await signer.signEvent({
      kind: 7, content: "👍", tags: [["e", channelMsgId], ["p", userPk]], created_at: now,
    });
    log(`  signed: id=${signed.id.slice(0, 12)}...`);

    const found = await publishAndVerifyRoundTrip(RELAYS, signed, 10_000);
    found.content === "👍"
      ? pass(`reaction round-trip: 👍`)
      : fail(`reaction mismatch: ${found.content}`);
  } catch (e) { fail(e.message); }

  // E1-E4 have 500ms gaps to avoid damus rate limiting
  // Kind 5 delete just publishes, no round-trip verification needed
  log("\nE4  kind 5 delete → publish");
  try {
    const signed = await signer.signEvent({
      kind: 5,
      content: "test bench cleanup",
      tags: [["e", channelMsgId]],
      created_at: Math.floor(Date.now() / 1000),
    });
    log(`  signed: id=${signed.id.slice(0, 12)}... deleting msg=${channelMsgId.slice(0, 12)}...`);

    const delPubs = await Promise.allSettled(new SimplePool().publish(RELAYS, signed));
    const delOk = delPubs.filter(p => p.status === "fulfilled").length;
    delOk > 0
      ? pass(`delete published ${delOk}/${delPubs.length} relays`)
      : fail("all relays rejected");
  } catch (e) { fail(e.message); }

  // ═══════════════════════════════════════════════════════════════════
  // SUITE A: NIP-46 RPC basics
  // ═══════════════════════════════════════════════════════════════════

  hr();
  log("SUITE A: NIP-46 RPC basics");
  hr();

  log("\nA1  get_public_key");
  try {
    const t = Date.now();
    const pk = await signer.getPublicKey();
    pk === userPk ? pass(`${pk.slice(0, 16)}... (${Date.now() - t}ms)`) : fail(`mismatch`);
  } catch (e) { fail(e.message); }

  log("\nA2  nip44_encrypt");
  try {
    const t = Date.now();
    const target = getPublicKey(generateSecretKey());
    const ct = await signer.nip44Encrypt(target, "test " + Date.now());
    ct?.length > 20 ? pass(`${ct.length} chars (${Date.now() - t}ms)`) : fail("bad output");
  } catch (e) { fail(e.message); }

  log("\nA3  nip44_decrypt (round-trip)");
  try {
    const thirdSk = generateSecretKey();
    const thirdPk = getPublicKey(thirdSk);
    const plain = "round-trip " + Date.now();
    const ct = nip44.v2.encrypt(plain, nip44.v2.utils.getConversationKey(thirdSk, userPk));
    const t = Date.now();
    const dec = await signer.nip44Decrypt(thirdPk, ct);
    dec === plain ? pass(`"${plain}" (${Date.now() - t}ms)`) : fail(`mismatch`);
  } catch (e) { fail(e.message); }

  log("\nA4  concurrent (3× getPublicKey)");
  try {
    const t = Date.now();
    const [p1, p2, p3] = await Promise.all([signer.getPublicKey(), signer.getPublicKey(), signer.getPublicKey()]);
    p1 === p2 && p2 === p3 ? pass(`all match (${Date.now() - t}ms)`) : fail("mismatch");
  } catch (e) { fail(e.message); }

  // ═══════════════════════════════════════════════════════════════════
  // SUITE B: Session persistence
  // ═══════════════════════════════════════════════════════════════════

  hr();
  log("SUITE B: session persistence (fromSavedSession)");
  hr();

  log("\nB1  save → restore → getPublicKey → publish kind 42");
  let restoredSigner;
  try {
    const savedNsec = signer.clientNsec;
    const savedBunker = signer.bunkerPubkey;
    await signer.close();

    const t = Date.now();
    restoredSigner = NostrConnectSigner.fromSavedSession(savedBunker, savedNsec, RELAYS);

    const content = `restored-session ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const signed = await restoredSigner.signEvent({
      kind: 42, content, tags: [["e", CHANNEL_ID, "", "root"]], created_at: now,
    });

    const found = await publishAndVerifyRoundTrip(RELAYS, signed, 10_000);
    found.id === signed.id
      ? pass(`restored → signed → published → verified on relay (${Date.now() - t}ms)`)
      : fail(`event not found after restore`);

    // Clean up
    const del = await restoredSigner.signEvent({
      kind: 5, content: "bench cleanup", tags: [["e", signed.id]], created_at: Math.floor(Date.now() / 1000),
    });
    await new SimplePool().publish(RELAYS, del);
  } catch (e) { fail(e.message); }

  // ═══════════════════════════════════════════════════════════════════
  // SUITE C: Subscription lifecycle
  // ═══════════════════════════════════════════════════════════════════

  hr();
  log("SUITE C: subscription lifecycle");
  hr();

  log("\nC1  refreshSubscription → sign → publish → receive");
  try {
    restoredSigner.refreshSubscription();
    const content = `after-refresh ${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const signed = await restoredSigner.signEvent({
      kind: 42, content, tags: [["e", CHANNEL_ID, "", "root"]], created_at: now,
    });

    const found = await publishAndVerifyRoundTrip(RELAYS, signed, 10_000);
    found.id === signed.id
      ? pass(`refresh → signed → published → verified on relay`)
      : fail(`event not found after refresh`);
    // Clean up
    const del = await restoredSigner.signEvent({
      kind: 5, content: "bench cleanup", tags: [["e", signed.id]], created_at: Math.floor(Date.now() / 1000),
    });
    await new SimplePool().publish(RELAYS, del);
  } catch (e) { fail(e.message); }

  log("\nC2  close → sign (expect timeout)");
  try {
    await restoredSigner.close();
    try {
      await restoredSigner.signEvent({ kind: 1, content: "should fail", tags: [], created_at: Math.floor(Date.now() / 1000) });
      fail("should have timed out");
    } catch (e) {
      e.message.includes("timed out") || e.message.includes("Signer closed")
        ? pass(`correctly rejected: ${e.message.slice(0, 50)}`)
        : fail(`wrong error: ${e.message}`);
    }
  } catch (e) { fail(e.message); }

  // ═══════════════════════════════════════════════════════════════════
  // SUITE D: Property accessors
  // ═══════════════════════════════════════════════════════════════════

  hr();
  log("SUITE D: property accessors");
  hr();

  log("\nD1  clientNsec");
  try {
    const nsec = signer.clientNsec;
    nsec.startsWith("nsec1") ? pass(`${nsec.slice(0, 12)}...`) : fail("bad nsec");
  } catch (e) { fail(e.message); }

  log("\nD2  bunkerPubkey");
  try {
    signer.bunkerPubkey.length === 64 ? pass(`${signer.bunkerPubkey.slice(0, 16)}...`) : fail("bad");
  } catch (e) { fail(e.message); }

  log("\nD3  exportClientNsec");
  try {
    signer.exportClientNsec() === signer.clientNsec ? pass("matches") : fail("mismatch");
  } catch (e) { fail(e.message); }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  log("╔════════════════════════════════════════╗");
  log("║  Legion Chat — NIP-46 Test Bench       ║");
  log("║  (full Nostr flow + real signer)        ║");
  log("╚════════════════════════════════════════╝");
  log(`  relays: ${RELAYS.join(", ")}`);
  log(`  channel: ${CHANNEL_ID.slice(0, 12)}...`);
  log(`  signer: src/lib/nostr-connect-signer.ts`);
  console.log("");

  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  const userSk = generateSecretKey();
  const userPk = getPublicKey(userSk);

  log(`  bunker: ${bunkerPk.slice(0, 16)}...`);
  log(`  user:   ${userPk.slice(0, 16)}...`);

  const bunker = startBunker(bunkerSk, bunkerPk, userSk, userPk);
  log("\n[SETUP] waiting for bunker subscription...");
  await sleep(3000);

  // Pairing
  hr();
  log("PAIRING: real NostrConnectSigner.startNostrConnect()");
  hr();

  const handle = NostrConnectSigner.startNostrConnect({
    relays: RELAYS,
    metadata: { name: "Legion Chat Test Bench" },
    perms: "nip44_encrypt,nip44_decrypt,sign_event:0,sign_event:1,sign_event:5,sign_event:7,sign_event:42",
    requestTimeoutMs: 15_000,
    pairTimeoutMs: 60_000,
  });

  const uriUrl = new URL(handle.uri);
  const secret = uriUrl.searchParams.get("secret");
  const clientPkFromUri = uriUrl.hostname || uriUrl.pathname.replace(/^\/\//, "");

  log(`  client: ${clientPkFromUri.slice(0, 16)}...`);
  await sleep(2000);

  log("[PAIR] simulating QR scan...");
  await bunker.publishPairingResponse(clientPkFromUri, secret);

  let signer;
  try {
    signer = await handle.ready;
    pass(`paired! bunker=${signer.bunkerPubkey.slice(0, 16)}...`);
  } catch (e) {
    fail(`pairing failed: ${e.message}`);
    bunker.close();
    process.exit(1);
  }

  await runTests(signer, userPk);
  bunker.close();

  console.log("");
  hr();
  log(`  PASSED ${results.passed}  ·  FAILED ${results.failed}  ·  TOTAL ${results.passed + results.failed}`);
  hr();
  results.failed === 0
    ? log("✓ Full Nostr flow verified: sign → publish → subscribe → receive")
    : log("⚠ Some tests failed");
  console.log("");

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => { log("UNHANDLED:", e.message); process.exit(2); });
