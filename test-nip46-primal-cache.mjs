/**
 * NIP-46 Primal Cache API Test
 *
 * Tests whether Primal's HTTP cache server (cache2.primal.net) can be used
 * to retrieve NIP-46 bunker responses, instead of relying on relay subscriptions.
 *
 * Background:
 * - Primal's bunker publishes responses via broadcast_events to cache2.primal.net/api/
 * - cache2.primal.net does NOT support standard relay filters (kinds, authors)
 * - It uses a custom protocol: ["REQ", subid, {"cache": ["function_name", {kwargs}]}]
 * - Standard relay subscriptions on external relays never see Primal's responses
 *
 * This test:
 * 1. Pairs with Primal's real bunker via nostrconnect (requires QR scan)
 * 2. Sends get_public_key RPC to relays
 * 3. Tries multiple response retrieval paths in parallel:
 *    a. Standard relay subscription (baseline — expected to fail)
 *    b. relay.primal.net raw WebSocket subscription
 *    c. cache2.primal.net API query
 *
 * Usage: bun test-nip46-primal-cache.mjs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";
import WebSocket from "ws";

const PRIMAL_RELAY = "wss://relay.primal.net";
const PRIMAL_CACHE = "wss://cache2.primal.net";
const RELAYS = [
  PRIMAL_RELAY,
  "wss://relay.camelus.app",
  "wss://nostr-01.yakihonne.com",
];

const KIND = 24133;
const RPC_TIMEOUT = 30_000; // 30s — give Primal bunker more time

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
function log(tag, ...args) { console.log(`${ts()} [${tag}]`, ...args); }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function wsOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (e) => reject(e));
    setTimeout(() => resolve(), 5000);
  });
}

// ── Main ──

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  NIP-46 Primal Cache API Test");
  console.log("═══════════════════════════════════════════════\n");

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

  // ── Step 2: Open pairing subscription ──
  log("PAIR", "Opening subscription for pairing response...");

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

  // Wait for pairing
  const pairDeadline = Date.now() + 120_000; // 2 min to scan
  while (!bunkerPk && Date.now() < pairDeadline) {
    await sleep(500);
  }

  if (!bunkerPk) {
    log("PAIR", "✗ Timeout waiting for pairing");
    process.exit(1);
  }

  // Close pairing subscription
  pairSub.close();
  await sleep(500);

  // ── Step 3: Send get_public_key RPC ──
  log("RPC", "Sending get_public_key...");
  const rpcId = randomId();
  const rpcPayload = JSON.stringify({ id: rpcId, method: "get_public_key", params: [] });
  const rpcCT = nip44.v2.encrypt(rpcPayload, bunkerConv);
  const rpcEvent = finalizeEvent(
    { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunkerPk]], content: rpcCT },
    clientSk,
  );

  // Publish to all relays
  const pubs = await Promise.allSettled(pairPool.publish(RELAYS, rpcEvent));
  log("RPC", "Published:", pubs.map((p, i) => `${RELAYS[i].slice(6, 25)}=${p.status}`).join(", "));

  const rpcTime = Date.now();
  const sinceTs = Math.floor(rpcTime / 1000) - 2;

  // ── Step 4: Try multiple response paths in parallel ──
  log("WAIT", "Trying multiple response retrieval paths...");

  let result = null;
  let resultSource = null;

  async function tryDecrypt(content, fromPk) {
    try {
      const conv = nip44.v2.utils.getConversationKey(clientSk, fromPk);
      const payload = nip44.v2.decrypt(content, conv);
      const parsed = JSON.parse(payload);
      if (parsed.id === rpcId) return parsed;
      log("DECRYPT", "ID mismatch:", parsed.id?.slice(0, 8), "expected:", rpcId.slice(0, 8));
    } catch (e) {
      // log("DECRYPT", "failed:", e.message?.slice(0, 40));
    }
    return null;
  }

  // ── Path A: Standard relay subscription (baseline — expected to fail) ──
  const pathA = (async () => {
    return new Promise(async (resolve) => {
      try {
        const pool = new SimplePool();
        const sub = pool.subscribeMany(
          RELAYS,
          { authors: [bunkerPk], kinds: [KIND], "#p": [clientPk], since: sinceTs },
          {
            onevent: async (event) => {
              const parsed = await tryDecrypt(event.content, bunkerPk);
              if (parsed) {
                log("PATH-A", "✓ Got response via standard relay subscription!");
                result = parsed;
                resultSource = "relay-subscription (standard)";
                sub.close();
                resolve();
              }
            },
            oneose: () => log("PATH-A", "EOSE"),
          },
        );
        // Timeout
        setTimeout(() => { sub.close(); resolve(); }, RPC_TIMEOUT);
      } catch (e) {
        log("PATH-A", "error:", e.message);
        resolve();
      }
    });
  })();

  // ── Path B: relay.primal.net raw WebSocket ──
  const pathB = (async () => {
    return new Promise(async (resolve) => {
      try {
        const ws = new WebSocket(PRIMAL_RELAY);
        await wsOpen(ws);

        const subId = "primal_raw_" + randomId();
        ws.send(JSON.stringify(["REQ", subId, {
          kinds: [KIND], authors: [bunkerPk], "#p": [clientPk], since: sinceTs
        }]));

        const timer = setTimeout(() => {
          ws.close();
          resolve();
        }, RPC_TIMEOUT);

        ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === "EVENT" && msg[2]) {
              const parsed = await tryDecrypt(msg[2].content, bunkerPk);
              if (parsed) {
                log("PATH-B", "✓ Got response via relay.primal.net raw WS!");
                result = result || parsed;
                resultSource = resultSource || "relay.primal.net raw WS";
                clearTimeout(timer);
                ws.close();
                resolve();
              }
            }
          } catch {}
        });

        ws.on("error", (e) => {
          log("PATH-B", "WS error:", e.message);
          resolve();
        });
      } catch (e) {
        log("PATH-B", "error:", e.message);
        resolve();
      }
    });
  })();

  // ── Path C: cache2.primal.net API query ──
  // The cache server doesn't support kinds/authors filters.
  // Instead, use the "events" cache function with a time range,
  // then filter client-side for kind 24133.
  const pathC = (async () => {
    return new Promise(async (resolve) => {
      try {
        const ws = new WebSocket(PRIMAL_CACHE);
        await wsOpen(ws);
        log("PATH-C", "Connected to cache2.primal.net");

        // Try the cache API — query recent events
        // Protocol: ["REQ", subid, {"cache": ["function_name", {kwargs}]}]
        const subId = "cache_events_" + randomId();

        // Strategy 1: Query "events" with time range, filter client-side
        ws.send(JSON.stringify(["REQ", subId, {
          cache: ["events", {
            since: sinceTs,
            until: Math.floor(Date.now() / 1000) + 30,
            limit: 500,
          }]
        }]));

        let attempts = 0;
        const maxAttempts = 15; // Poll for 15 seconds (1s intervals)

        const pollInterval = setInterval(async () => {
          attempts++;
          if (attempts > maxAttempts || result) {
            clearInterval(pollInterval);
            ws.close();
            resolve();
            return;
          }

          // Re-query with updated time range
          const newSubId = "cache_poll_" + attempts;
          ws.send(JSON.stringify(["REQ", newSubId, {
            cache: ["events", {
              since: Math.floor(Date.now() / 1000) - 3,
              until: Math.floor(Date.now() / 1000) + 5,
              limit: 200,
            }]
          }]));

          // Auto-close this sub after a moment
          setTimeout(() => {
            try { ws.send(JSON.stringify(["CLOSE", newSubId])); } catch {}
          }, 2000);
        }, 2000);

        ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());

            if (msg[0] === "NOTICE") {
              log("PATH-C", "NOTICE:", msg[2]?.slice(0, 80));
              return;
            }

            if (msg[0] === "EVENT" || msg[0] === "EVENTS") {
              // EVENTS = zlib-compressed batch (array of events)
              const events = msg[0] === "EVENTS" ? msg[2] : [msg[2]];

              for (const event of events) {
                if (!event || event.kind !== KIND) continue;
                if (event.pubkey !== bunkerPk) continue;

                const parsed = await tryDecrypt(event.content, bunkerPk);
                if (parsed) {
                  log("PATH-C", "✓ Got response via cache2.primal.net API!");
                  result = result || parsed;
                  resultSource = resultSource || "cache2.primal.net API";
                  clearInterval(pollInterval);
                  ws.close();
                  resolve();
                  return;
                }
              }
            }
          } catch (e) {
            log("PATH-C", "parse error:", e.message?.slice(0, 40));
          }
        });

        ws.on("error", (e) => {
          log("PATH-C", "WS error:", e.message);
          clearInterval(pollInterval);
          resolve();
        });

        ws.on("close", () => {
          clearInterval(pollInterval);
          resolve();
        });
      } catch (e) {
        log("PATH-C", "error:", e.message);
        resolve();
      }
    });
  })();

  // ── Path D: relay.primal.net with NO authors filter ──
  // Maybe the bunker publishes with a different key or the authors filter is too restrictive
  const pathD = (async () => {
    return new Promise(async (resolve) => {
      try {
        const ws = new WebSocket(PRIMAL_RELAY);
        await wsOpen(ws);

        const subId = "primal_noauth_" + randomId();
        // No authors filter — just kind 24133 + #p tag
        ws.send(JSON.stringify(["REQ", subId, {
          kinds: [KIND], "#p": [clientPk], since: sinceTs
        }]));

        const timer = setTimeout(() => {
          ws.close();
          resolve();
        }, RPC_TIMEOUT);

        ws.on("message", async (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg[0] === "EVENT" && msg[2] && msg[2].kind === KIND) {
              log("PATH-D", "Event from:", msg[2].pubkey.slice(0, 12));

              const parsed = await tryDecrypt(msg[2].content, msg[2].pubkey);
              if (parsed) {
                log("PATH-D", "✓ Got response via relay.primal.net (no authors filter)!");
                log("PATH-D", "  From pubkey:", msg[2].pubkey);
                result = result || parsed;
                resultSource = resultSource || `relay.primal.net (no authors) from ${msg[2].pubkey.slice(0, 12)}`;
                clearTimeout(timer);
                ws.close();
                resolve();
              }
            }
          } catch {}
        });

        ws.on("error", () => resolve());
      } catch (e) {
        resolve();
      }
    });
  })();

  // Wait for all paths
  await Promise.all([pathA, pathB, pathC, pathD]);

  // ── Results ──
  console.log("\n═══════════════════════════════════════════════");
  const elapsed = ((Date.now() - rpcTime) / 1000).toFixed(1);

  if (result) {
    log("RESULT", `✓ SUCCESS via ${resultSource}`);
    log("RESULT", `Response: ${JSON.stringify(result).slice(0, 100)}`);
    log("RESULT", `Latency: ${elapsed}s`);
    log("RESULT", `Expected pubkey: ${clientPk.slice(0, 16)}`);
    if (result.result === clientPk) {
      log("RESULT", "✓ Pubkey matches — correct!");
    } else {
      log("RESULT", `✗ Pubkey mismatch! Got: ${String(result.result).slice(0, 16)}`);
    }
  } else {
    log("RESULT", "✗ ALL PATHS FAILED — no response received");
    log("RESULT", `Waited ${elapsed}s`);
    log("RESULT", "This confirms Primal's bunker response is not accessible");
    log("RESULT", "via standard relay subscriptions OR cache2 API queries");
  }
  console.log("═══════════════════════════════════════════════");

  process.exit(result ? 0 : 1);
}

main().catch(e => { log("FATAL", e.message); process.exit(1); });
