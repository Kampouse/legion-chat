/**
 * NIP-46 Primal End-to-End Test
 *
 * Mimics the EXACT flow the Primal iOS app uses for NIP-46 remote signing.
 *
 * Primal iOS app flow (from source code analysis):
 * 1. Client publishes kind 24133 RPC to relays
 * 2. Primal server relay monitor picks it up → stores in monitoring_request_queue (Postgres)
 * 3. iOS app polls get_queued_events_for_nip46 via WS to wss://cache.primal.net/v1
 *    - Sends: ["REQ", subId, {"cache": ["get_queued_events_for_nip46", {"event_from_signer": <kind 1337 signed event>}]}]
 *    - Auth: kind 1337 event signed by signer key, tags: [["d", "Primal-iOS-App"]]
 * 4. iOS app processes RPC, signs response
 * 5. iOS app publishes response via broadcast_events to cache server
 *    - Sends: ["REQ", subId, {"cache": ["broadcast_events", {"events": [...], "relays": [...]}]}]
 *    - Also: import_events to cache + broadcast_events
 * 6. Primal server broadcasts response to user's relay list
 *
 * This test:
 * 1. Pairs with Primal's bunker via nostrconnect (requires QR scan)
 * 2. Sends get_public_key RPC to relays (standard NIP-46)
 * 3. Polls get_queued_events_for_nip46 to see if our RPC arrives in Primal's queue
 * 4. Simultaneously tries to catch the response via:
 *    a. Standard relay subscription
 *    b. relay.primal.net raw WS
 *    c. HTTP POST to cache2.primal.net/api/
 *
 * Usage: bun test-nip46-primal-e2e.mjs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";
import WebSocket from "ws";

// ── Config ──
const PRIMAL_CACHE_WS = "wss://cache.primal.net/v1";
const PRIMAL_CACHE_HTTP = "https://cache2.primal.net/api/";
const PRIMAL_RELAY = "wss://relay.primal.net";
const RELAYS = [
  PRIMAL_RELAY,
  "wss://relay.camelus.app",
  "wss://nostr-01.yakihonne.com",
];
const KIND = 24133;
const RPC_TIMEOUT = 45_000;

// ── Helpers ──
function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => chars[b % chars.length]).join("");
}

function ts() { return new Date().toISOString().slice(11, 19); }
function log(tag, ...args) { console.log(`${ts()} [${tag}]`, ...args); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (e) => reject(e));
    setTimeout(() => resolve(), 5000);
  });
}

/**
 * Create a kind 1337 auth event (Primal's NIP-46 auth pattern)
 * This is what the iOS app sends to authenticate with the cache server
 */
function createAuthEvent(signerSk) {
  return finalizeEvent(
    {
      kind: 1337,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", "Primal-iOS-App"]],
      content: "",
    },
    signerSk,
  );
}

// ── Main ──
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  NIP-46 Primal End-to-End Test");
  console.log("  Mimics exact iOS app flow from source code");
  console.log("═══════════════════════════════════════════════════════\n");

  // Generate client keys
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = randomSecret();

  log("INIT", "client:", clientPk.slice(0, 16));
  log("INIT", "secret:", secret);

  // ── Step 1: Build nostrconnect URI ──
  const relayParams = RELAYS.map(r => `relay=${encodeURIComponent(r)}`).join("&");
  const uri = `nostrconnect://${clientPk}?${relayParams}&secret=${secret}&perms=nip44_encrypt,nip44_decrypt,sign_event:0,sign_event:1&name=legion-test`;

  console.log("\n═══ SCAN THIS QR CODE WITH PRIMAL ═══");
  console.log(uri);
  console.log("══════════════════════════════════════\n");

  // ── Step 2: Pair with Primal bunker ──
  log("PAIR", "Opening subscription...");
  const pairPool = new SimplePool();
  const since = Math.floor(Date.now() / 1000) - 300;

  let bunkerPk = null;
  let bunkerConv = null;

  const pairSub = pairPool.subscribeMany(
    RELAYS,
    { kinds: [KIND], "#p": [clientPk], since },
    {
      onevent: async (event) => {
        if (bunkerPk) return;
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          log("PAIR", "event from:", event.pubkey.slice(0, 12), "result:", String(parsed.result || "").slice(0, 16));
          if (parsed.result === secret) {
            bunkerPk = event.pubkey;
            bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            log("PAIR", "✓ PAIRED with bunker:", bunkerPk.slice(0, 16));
          }
        } catch {}
      },
      oneose: () => log("PAIR", "EOSE — waiting for scan..."),
    },
  );

  const pairDeadline = Date.now() + 120_000;
  while (!bunkerPk && Date.now() < pairDeadline) await sleep(500);
  if (!bunkerPk) { log("PAIR", "✗ Timeout"); process.exit(1); }
  pairSub.close();
  await sleep(500);

  // ── Step 3: Build RPC event ──
  log("RPC", "Building get_public_key request...");
  const rpcId = randomId();
  const rpcPayload = JSON.stringify({ id: rpcId, method: "get_public_key", params: [] });
  const rpcCT = nip44.v2.encrypt(rpcPayload, bunkerConv);
  const rpcEvent = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunkerPk]], content: rpcCT },
    clientSk,
  );

  // ── Step 4: Publish RPC to relays ──
  const pubs = await Promise.allSettled(pairPool.publish(RELAYS, rpcEvent));
  log("RPC", "Published:", pubs.map((p, i) => `${RELAYS[i].slice(6, 30)}=${p.status}`).join(", "));

  const rpcTime = Date.now();
  log("RPC", "Waiting for response via multiple paths...\n");

  // ── Step 5: Poll get_queued_events_for_nip46 (like iOS app does) ──
  // This tests whether Primal's relay monitor actually picked up our RPC
  // and queued it in monitoring_request_queue.
  let queueResult = null;

  const pathQueue = (async () => {
    return new Promise(async (resolve) => {
      try {
        // The iOS app sends a kind 1337 signed event as auth.
        // But we're the CLIENT, not the signer. The get_queued_events_for_nip46
        // expects event_from_signer signed by the BUNKER's key.
        // We don't have the bunker's key — so this query should return empty
        // (it queries by remote_signer_pubkey = bunker's pubkey).
        //
        // HOWEVER: we CAN use our client key to see if anything is queued for us.
        // Actually, re-reading the Julia code:
        //   res = [e for (e,) in Postgres.execute(sess,
        //     "select event from monitoring_request_queue where remote_signer_pubkey = $1",
        //     [e.pubkey])]
        // It queries by the pubkey of the auth event sender.
        // The bunker sends this auth event — but we can try with OUR key
        // to see if there's a different query path.
        //
        // Actually, the iOS app IS the bunker/signer. The signer (Primal app)
        // authenticates with its own key. We're the CLIENT, so this won't work
        // for us directly. BUT we can still try the HTTP path for the response.

        // Try HTTP POST to cache2.primal.net/api/
        // Format: ["get_queued_events_for_nip46", {"event_from_signer": <event>}]
        const authEvent = createAuthEvent(clientSk);

        log("QUEUE", "Trying HTTP POST to cache2.primal.net/api/...");
        try {
          const httpBody = JSON.stringify(["get_queued_events_for_nip46", {
            event_from_signer: {
              id: authEvent.id,
              pubkey: authEvent.pubkey,
              created_at: authEvent.created_at,
              kind: authEvent.kind,
              tags: authEvent.tags,
              content: authEvent.content,
              sig: authEvent.sig,
            }
          }]);

          const resp = await fetch(PRIMAL_CACHE_HTTP, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: httpBody,
          });

          const text = await resp.text();
          log("QUEUE", `HTTP ${resp.status}:`, text.slice(0, 200));

          if (resp.ok) {
            try {
              const data = JSON.parse(text);
              if (Array.isArray(data) && data.length > 0) {
                log("QUEUE", "✓ Got queued events!", data.length);
                queueResult = data;
              }
            } catch {}
          }
        } catch (e) {
          log("QUEUE", "HTTP error:", e.message?.slice(0, 60));
        }

        // Also try WS to cache.primal.net/v1 (the iOS app's primary path)
        log("QUEUE", "Trying WS to cache.primal.net/v1...");
        try {
          const ws = new WebSocket(PRIMAL_CACHE_WS);
          await wsOpen(ws);
          log("QUEUE", "Connected to cache.primal.net/v1");

          const subId = "ios_" + randomId();
          // Exact protocol the iOS app uses:
          // ["REQ", subId, {"cache": ["get_queued_events_for_nip46", {"event_from_signer": <event>}]}]
          ws.send(JSON.stringify(["REQ", subId, {
            cache: ["get_queued_events_for_nip46", {
              event_from_signer: {
                id: authEvent.id,
                pubkey: authEvent.pubkey,
                created_at: authEvent.created_at,
                kind: authEvent.kind,
                tags: authEvent.tags,
                content: authEvent.content,
                sig: authEvent.sig,
              }
            }]
          }]));

          const timer = setTimeout(() => {
            ws.close();
            resolve();
          }, 10_000);

          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg[0] === "EVENT") {
                log("QUEUE", "WS EVENT:", JSON.stringify(msg[2]).slice(0, 120));
              } else if (msg[0] === "EOSE") {
                log("QUEUE", "WS EOSE for sub:", msg[1]?.slice(0, 16));
              } else if (msg[0] === "NOTICE") {
                log("QUEUE", "WS NOTICE:", msg[2]?.slice(0, 80));
              }
            } catch {}
          });

          ws.on("error", (e) => {
            log("QUEUE", "WS error:", e.message);
            clearTimeout(timer);
            resolve();
          });
        } catch (e) {
          log("QUEUE", "WS error:", e.message);
        }

        resolve();
      } catch (e) {
        log("QUEUE", "error:", e.message);
        resolve();
      }
    });
  })();

  // ── Step 6: Try to catch the response ──
  let result = null;
  let resultSource = null;

  async function tryDecrypt(content, fromPk) {
    try {
      const conv = nip44.v2.utils.getConversationKey(clientSk, fromPk);
      const payload = nip44.v2.decrypt(content, conv);
      const parsed = JSON.parse(payload);
      if (parsed.id === rpcId) return parsed;
      log("DECRYPT", "ID mismatch:", parsed.id?.slice(0, 8), "vs expected:", rpcId.slice(0, 8));
    } catch {}
    return null;
  }

  // Path A: Standard relay subscription
  const pathA = (async () => {
    return new Promise(async (resolve) => {
      try {
        const pool = new SimplePool();
        const sub = pool.subscribeMany(
          RELAYS,
          { authors: [bunkerPk], kinds: [KIND], "#p": [clientPk], since: Math.floor(rpcTime / 1000) - 2 },
          {
            onevent: async (event) => {
              const parsed = await tryDecrypt(event.content, bunkerPk);
              if (parsed) {
                log("PATH-A", "✓ Standard relay sub got response!");
                result = parsed;
                resultSource = "standard-relay-sub";
                sub.close();
                resolve();
              }
            },
            oneose: () => log("PATH-A", "EOSE"),
          },
        );
        setTimeout(() => { sub.close(); resolve(); }, RPC_TIMEOUT);
      } catch (e) { resolve(); }
    });
  })();

  // Path B: relay.primal.net raw WS (no authors filter)
  const pathB = (async () => {
    return new Promise(async (resolve) => {
      try {
        const ws = new WebSocket(PRIMAL_RELAY);
        await wsOpen(ws);
        const subId = "raw_" + randomId();
        ws.send(JSON.stringify(["REQ", subId, {
          kinds: [KIND], "#p": [clientPk], since: Math.floor(rpcTime / 1000) - 2
        }]));

        const timer = setTimeout(() => { ws.close(); resolve(); }, RPC_TIMEOUT);
        ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === "EVENT" && msg[2] && msg[2].kind === KIND) {
              log("PATH-B", "Event from:", msg[2].pubkey.slice(0, 12));
              const parsed = await tryDecrypt(msg[2].content, msg[2].pubkey);
              if (parsed) {
                log("PATH-B", "✓ relay.primal.net (no authors filter) got response!");
                result = result || parsed;
                resultSource = resultSource || `relay.primal.net from ${msg[2].pubkey.slice(0, 12)}`;
                clearTimeout(timer);
                ws.close();
                resolve();
              }
            }
          } catch {}
        });
        ws.on("error", () => resolve());
      } catch (e) { resolve(); }
    });
  })();

  // Path C: HTTP POST to cache2.primal.net/api/ — query events_nip46
  // After the bunker processes the RPC, it publishes via broadcast_events.
  // We can try to fetch the response event by its ID via events_nip46.
  const pathC = (async () => {
    return new Promise(async (resolve) => {
      // Poll every 3 seconds for up to RPC_TIMEOUT
      const pollInterval = 3_000;
      const maxPolls = Math.floor(RPC_TIMEOUT / pollInterval);
      let pollCount = 0;

      while (pollCount < maxPolls && !result) {
        pollCount++;
        await sleep(pollInterval);

        try {
          // Try HTTP — the response event should be findable via events function
          // The iOS app uses import_events to store the event in cache
          // then broadcast_events to push to relays.
          // We could try events_nip46 with the RPC event ID
          const httpBody = JSON.stringify(["events", {
            event_ids: [rpcEvent.id],
            limit: 10,
          }]);

          const resp = await fetch(PRIMAL_CACHE_HTTP, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: httpBody,
          });

          if (resp.ok) {
            const text = await resp.text();
            try {
              const data = JSON.parse(text);
              // Check if any returned event is kind 24133
              for (const item of (Array.isArray(data) ? data : [])) {
                if (item.kind === KIND && item.pubkey === bunkerPk) {
                  const parsed = await tryDecrypt(item.content, bunkerPk);
                  if (parsed) {
                    log("PATH-C", "✓ HTTP cache2 events query got response!");
                    result = result || parsed;
                    resultSource = resultSource || "cache2-http-events";
                    resolve();
                    return;
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
      resolve();
    });
  })();

  // Path D: nrs.primal.net — Primal's own relay
  const pathD = (async () => {
    return new Promise(async (resolve) => {
      try {
        const ws = new WebSocket("wss://nrs.primal.net");
        await wsOpen(ws);
        log("PATH-D", "Connected to nrs.primal.net");
        const subId = "nrs_" + randomId();
        ws.send(JSON.stringify(["REQ", subId, {
          kinds: [KIND], "#p": [clientPk], since: Math.floor(rpcTime / 1000) - 2
        }]));

        const timer = setTimeout(() => { ws.close(); resolve(); }, RPC_TIMEOUT);
        ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === "EVENT" && msg[2] && msg[2].kind === KIND) {
              log("PATH-D", "Event from:", msg[2].pubkey.slice(0, 12));
              const parsed = await tryDecrypt(msg[2].content, msg[2].pubkey);
              if (parsed) {
                log("PATH-D", "✓ nrs.primal.net got response!");
                result = result || parsed;
                resultSource = resultSource || `nrs.primal.net from ${msg[2].pubkey.slice(0, 12)}`;
                clearTimeout(timer);
                ws.close();
                resolve();
              }
            }
          } catch {}
        });
        ws.on("error", () => resolve());
      } catch (e) { resolve(); }
    });
  })();

  // Wait for all paths
  await Promise.all([pathQueue, pathA, pathB, pathC, pathD]);

  // ── Results ──
  console.log("\n═══════════════════════════════════════════════════════");
  const elapsed = ((Date.now() - rpcTime) / 1000).toFixed(1);

  if (result) {
    log("RESULT", `✓ SUCCESS via ${resultSource}`);
    log("RESULT", `Response: ${JSON.stringify(result).slice(0, 120)}`);
    log("RESULT", `Latency: ${elapsed}s`);
    log("RESULT", `Expected pubkey: ${clientPk.slice(0, 16)}`);
    if (result.result === clientPk) {
      log("RESULT", "✓ Pubkey matches!");
    } else {
      log("RESULT", `⚠ Pubkey mismatch. Got: ${String(result.result).slice(0, 16)}`);
    }
  } else {
    log("RESULT", "✗ ALL PATHS FAILED — no response received in ${elapsed}s");
    log("RESULT", "");
    log("RESULT", "Queue poll result:", queueResult ? `${queueResult.length} events` : "none");
    log("RESULT", "");
    log("RESULT", "This means Primal's bunker either:");
    log("RESULT", "  1. Didn't pick up our RPC from relays (relay monitor issue)");
    log("RESULT", "  2. Processed it but response didn't reach any path");
    log("RESULT", "  3. Requires push notification to trigger processMissedEvents()");
  }
  console.log("═══════════════════════════════════════════════════════");

  process.exit(result ? 0 : 1);
}

main().catch(e => { log("FATAL", e.message); process.exit(1); });
