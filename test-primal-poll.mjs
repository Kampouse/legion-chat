/**
 * Headless NIP-46 test using Primal's HTTP cache API.
 * 
 * Discovery: Primal's nostrconnect bunker doesn't use relay subscriptions
 * for RPC round-trips. It uses HTTP polling:
 * - Bunker polls: POST https://cache2.primal.net/api/ ["get_queued_events_for_nip46", {...}]
 * - Bunker responds: POST https://cache2.primal.net/api/ ["broadcast_events", {...}]
 * 
 * So the client needs to either:
 * 1. Poll relay.primal.net for the response event
 * 2. Use Primal's cache API to find the response
 * 
 * This test tries approach: poll relay with fresh REQ queries
 * AND query Primal's cache API directly.
 * 
 * Usage: bun test-primal-poll.mjs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";

const PRIMAL_CACHE = "https://cache2.primal.net/api/";
const RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://relay.camelus.app",
  "wss://nos.lol",
];
const KIND = 24133;

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function ts() { return new Date().toISOString().slice(11, 19); }
function log(...args) { console.log(`${ts()} LOG`, ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Query Primal's cache API for kind 24133 events from bunker to client
async function queryPrimalCache(bunkerPk, clientPk, since) {
  const body = JSON.stringify([
    "get_events",
    {
      "filter": {
        "kinds": [KIND],
        "authors": [bunkerPk],
        "#p": [clientPk],
        "since": since,
        "limit": 10,
      }
    }
  ]);

  try {
    const resp = await fetch(PRIMAL_CACHE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const data = await resp.json();
    return data;
  } catch (e) {
    log("Primal cache error:", e.message);
    return null;
  }
}

// Poll relay with fresh REQ queries (not subscription)
async function pollRelayForResponse(pool, bunkerPk, clientPk, since) {
  const events = [];
  const sub = pool.subscribeMany(
    RELAYS,
    { kinds: [KIND], authors: [bunkerPk], "#p": [clientPk], since, limit: 10 },
    {
      onevent: (event) => { events.push(event); },
      oneose: () => {},
    },
  );
  await sleep(2000); // wait for results
  sub.close();
  return events;
}

async function main() {
  console.log("═══════════════════════════════════════");
  console.log("  Primal NIP-46 Polling Test");
  console.log("═══════════════════════════════════════\n");

  const pool = new SimplePool();
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = randomSecret();

  log("client:", clientPk.slice(0, 16));
  log("secret:", secret);

  // Build nostrconnect URI
  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:0,sign_event:1,sign_event:4,sign_event:7,sign_event:9734,sign_event:9735,sign_event:30023");
  params.set("name", "LegionChat-Test");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Scan with Primal:");
  console.log(uri);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Phase 1: Pair ──
  log("Waiting for pairing...");
  const since = Math.floor(Date.now() / 1000) - 300;

  let bunkerPk = null;
  let pairResolve;
  const pairPromise = new Promise(r => { pairResolve = r; });
  const pairTimer = setTimeout(() => { pairReject(new Error("Pairing timeout")); }, 300_000);

  const pairSub = pool.subscribeMany(
    RELAYS,
    { kinds: [KIND], "#p": [clientPk], since },
    {
      onevent: async (event) => {
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          if (parsed.result === secret) {
            bunkerPk = event.pubkey;
            clearTimeout(pairTimer);
            pairSub.close();
            log("PAIRED! bunker:", bunkerPk.slice(0, 16));
            pairResolve();
          }
        } catch {}
      },
      oneose: () => log("pairing sub EOSE"),
    },
  );

  await pairPromise;

  // ── Phase 2: Send get_public_key ──
  const rpcTime = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const requestPayload = JSON.stringify({ id, method: "get_public_key", params: [] });
  const conv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
  const ciphertext = nip44.v2.encrypt(requestPayload, conv);

  const reqEvent = finalizeEvent(
    { kind: KIND, created_at: rpcTime, tags: [["p", bunkerPk]], content: ciphertext },
    clientSk,
  );

  log("publishing get_public_key, id:", id.slice(0, 8));
  const pubs = await Promise.allSettled(pool.publish(RELAYS, reqEvent));
  log("publish:", pubs.map(p => p.status));

  // ── Phase 3: Poll for response ──
  log("\n--- Polling for response ---");

  for (let attempt = 1; attempt <= 15; attempt++) {
    log(`poll ${attempt}/15...`);
    await sleep(2000);

    // Method 1: Poll relay with fresh subscription
    const relayEvents = await pollRelayForResponse(pool, bunkerPk, clientPk, rpcTime);
    if (relayEvents.length > 0) {
      log(`RELAY: found ${relayEvents.length} events!`);
      for (const event of relayEvents) {
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log("RELAY response:", JSON.stringify({
            id: parsed.id?.slice(0, 8),
            result: typeof parsed.result === "string" ? parsed.result.slice(0, 24) : parsed.result,
            error: parsed.error,
          }));
          if (parsed.id === id) {
            log("✓ MATCH! get_public_key =", parsed.result);
            process.exit(0);
          }
        } catch (e) {
          log("RELAY decrypt failed:", e.message);
        }
      }
    }

    // Method 2: Query Primal's HTTP cache API
    const cacheResult = await queryPrimalCache(bunkerPk, clientPk, rpcTime);
    if (cacheResult && Array.isArray(cacheResult)) {
      for (const item of cacheResult) {
        if (item.kind === KIND || (item.content && item.pubkey)) {
          log("CACHE: found event from", (item.pubkey || "").slice(0, 12));
          try {
            const conv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            const payload = nip44.v2.decrypt(item.content, conv);
            const parsed = JSON.parse(payload);
            log("CACHE response:", JSON.stringify({
              id: parsed.id?.slice(0, 8),
              result: typeof parsed.result === "string" ? parsed.result.slice(0, 24) : parsed.result,
            }));
            if (parsed.id === id) {
              log("✓ CACHE MATCH! get_public_key =", parsed.result);
              process.exit(0);
            }
          } catch {}
        }
      }
    }

    // Also try a different Primal API format
    try {
      const resp = await fetch(PRIMAL_CACHE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["events_nip46", { "event_ids": [reqEvent.id] }]),
      });
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        log("CACHE events_nip46: found", data.length, "results");
      }
    } catch {}
  }

  log("\n✗ No response found after 30s of polling");
  log("The RPC was published and Primal should have queued it,");
  log("but no response appeared on relays or cache API.");
  log("This confirms Primal's bunker is HTTP-only and the response");
  log("may only be published to the nostrconnect URI's relay list.");
  process.exit(1);
}

main().catch(e => { log("FATAL:", e.message); process.exit(1); });
