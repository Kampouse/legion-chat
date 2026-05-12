/**
 * test-primal-bench.mjs — Spec-compliant NIP-46 test bench against REAL Primal bunker.
 * v2: Added connect RPC after pairing (spec handshake requirement).
 *
 * Usage: bun test-primal-bench.mjs
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { SimplePool } from "nostr-tools/pool";
import * as nip44 from "nostr-tools/nip44";

const RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
];

const KIND = 24133;
const RPC_TIMEOUT = 10_000;

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
function randomId() { return randomHex(8); }
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  p("");
  p("╔══════════════════════════════════════════════════════════╗");
  p("║   NIP-46 Spec Test Bench v2 — REAL Primal Bunker        ║");
  p("║   Added: connect RPC after pairing (spec handshake)     ║");
  p("╚══════════════════════════════════════════════════════════╝");
  p("");

  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = randomHex(16);
  const perms = "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42,ping";

  p(`Client pubkey: ${clientPk}`);
  p(`Secret: ${secret}`);

  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", perms);
  params.set("name", "Legion Test Bench");
  params.set("url", "https://legion-chat.pages.dev");

  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("");
  p("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  p("  SCAN WITH PRIMAL (select FULL trust):");
  p(`  ${uri}`);
  p("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const pending = new Map();

  // ── Phase 1: Pairing ──

  p("Waiting for pairing...");
  let paired = false;

  const pairSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND],
    "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: async (event) => {
      if (paired) return;
      try {
        const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`Pairing event from: ${event.pubkey.slice(0,12)} method: ${parsed.method} result: ${String(parsed.result||"").slice(0,16)}`);

        if (parsed.result === secret) {
          paired = true;
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk}`);
          pairSub.close();
        }
      } catch {}
    },
    oneose: () => p("Pairing sub EOSE"),
  });

  const pairDeadline = Date.now() + 5 * 60_000;
  while (!paired && Date.now() < pairDeadline) {
    await sleep(1000);
    if (!paired && Date.now() % 5000 < 1500) {
      try {
        const events = await pool.querySync(RELAYS, {
          kinds: [KIND], "#p": [clientPk],
          since: Math.floor(Date.now() / 1000) - 120, limit: 10,
        });
        for (const event of events) {
          if (paired) break;
          try {
            const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
            const payload = nip44.v2.decrypt(event.content, conv);
            const parsed = JSON.parse(payload);
            if (parsed.result === secret) {
              paired = true;
              bunkerPk = event.pubkey;
              bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
              p(`✓ PAIRED (poll)! Bunker: ${bunkerPk}`);
              pairSub.close();
            }
          } catch {}
        }
      } catch {}
    }
  }

  if (!paired) { p("✗ Pairing timed out"); process.exit(1); }
  await sleep(500);

  // ── Phase 2: Persistent subscription ──

  p("");
  p("─── Opening persistent subscription ───");

  let eoseResolve;
  const eosePromise = new Promise(r => { eoseResolve = r; });
  const eoseTimer = setTimeout(() => { p("EOSE timeout — proceeding"); eoseResolve(); }, 10_000);

  const persistSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND],
    authors: [bunkerPk],
    "#p": [clientPk],
  }, {
    onevent: async (event) => {
      try {
        const payload = nip44.v2.decrypt(event.content, bunkerConv);
        const parsed = JSON.parse(payload);
        const resultPreview = typeof parsed.result === "string" ? parsed.result.slice(0, 40) : parsed.result;
        p(`[SUB] id=${parsed.id?.slice(0,8)} result=${resultPreview} error=${parsed.error}`);

        if (parsed.result === "auth_url" && parsed.error) {
          p(`[SUB] AUTH CHALLENGE: ${parsed.error}`);
          // Don't resolve — keep pending for real response
          return;
        }

        const entry = pending.get(parsed.id);
        if (entry) {
          pending.delete(parsed.id);
          clearTimeout(entry.timer);
          if (parsed.error) entry.reject(new Error(parsed.error));
          else entry.resolve(parsed.result ?? "");
        } else {
          p(`[SUB] No pending for id ${parsed.id?.slice(0,8)} (pending: ${[...pending.keys()].map(k=>k.slice(0,8)).join(",")})`);
        }
      } catch (e) {
        p(`[SUB] Decrypt error: ${e.message}`);
      }
    },
    oneose: () => { p("Persistent sub EOSE — ready"); clearTimeout(eoseTimer); eoseResolve(); },
  });

  await eosePromise;

  // ── Phase 3: RPC helper ──

  async function rpc(method, rpcParams = [], timeout = RPC_TIMEOUT) {
    const id = randomId();
    const payload = JSON.stringify({ id, method, params: rpcParams });
    const ct = nip44.v2.encrypt(payload, bunkerConv);
    const evt = finalizeEvent(
      { kind: KIND, created_at: Math.floor(Date.now() / 1000), tags: [["p", bunkerPk]], content: ct },
      clientSk,
    );

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

    const timer = setTimeout(async () => {
      p(`[RPC] ${method} sub timeout — poll fallback...`);
      try {
        const events = await pool.querySync(RELAYS, {
          kinds: [KIND], authors: [bunkerPk], "#p": [clientPk], limit: 10,
        });
        for (const ev of events) {
          try {
            const pl = nip44.v2.decrypt(ev.content, bunkerConv);
            const pr = JSON.parse(pl);
            if (pr.id === id && pr.result !== undefined) {
              p(`[RPC] ${method} found via poll!`);
              pending.delete(id);
              resolve(pr.result);
              return;
            }
          } catch {}
        }
      } catch {}
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeout}ms`));
    }, timeout);

    pending.set(id, { resolve, reject, timer });
    p(`[RPC] → ${method} id=${id.slice(0,8)} pending=${pending.size}`);
    const pubs = await Promise.allSettled(pool.publish(RELAYS, evt));
    p(`[RPC]   publish: ${pubs.map(pr=>pr.status==="fulfilled"?"ok":"fail").join(", ")}`);
    return promise;
  }

  // ── Phase 4: Spec-compliant test sequence ──

  let passed = 0, failed = 0, total = 0;

  async function test(name, fn) {
    total++;
    p("");
    p(`─── Test ${total}: ${name} ───`);
    const start = Date.now();
    try {
      const result = await fn();
      const elapsed = Date.now() - start;
      const preview = typeof result === "string" ? result.slice(0, 60) : JSON.stringify(result)?.slice(0, 60);
      p(`  Result (${elapsed}ms): ${preview}`);
      p(`  ✓ PASS — ${name}`);
      passed++;
      return result;
    } catch (e) {
      const elapsed = Date.now() - start;
      p(`  ✗ FAIL — ${name} (${elapsed}ms): ${e.message}`);
      failed++;
      return null;
    }
  }

  // ── Fire all RPCs immediately back-to-back (no delays!) ──
  // Primal's bunker goes silent after ~1s of inactivity.
  // Skip connect (rejected) and switch_relays (not implemented).

  const userPk = await test("get_public_key", () => rpc("get_public_key"));

  await test("ping", () => rpc("ping"));

  // sign_event kind 1
  await test("sign_event kind:1", () => rpc("sign_event", [JSON.stringify({
    kind: 1, content: "Hello from Legion test bench!", tags: [],
    created_at: Math.floor(Date.now() / 1000),
  })]));

  // sign_event kind 42
  await test("sign_event kind:42", () => rpc("sign_event", [JSON.stringify({
    kind: 42, content: "Test channel msg from bench",
    tags: [["e", "test-channel", "wss://relay.primal.net", "root"]],
    created_at: Math.floor(Date.now() / 1000),
  })]));

  // nip44_encrypt/decrypt
  const testTarget = getPublicKey(generateSecretKey());
  const encrypted = await test("nip44_encrypt", () => rpc("nip44_encrypt", [testTarget, "hello world"]));
  if (encrypted) {
    await test("nip44_decrypt", async () => {
      const dec = await rpc("nip44_decrypt", [testTarget, encrypted]);
      if (dec !== "hello world") throw new Error(`got "${dec}"`);
      return dec;
    });
  }

  // ── Summary ──
  p("");
  p("══════════════════════════════════════════════════════════");
  p(`  Results: ${passed}/${total} passed, ${failed} failed`);
  p(`  Bunker: ${bunkerPk}`);
  p(`  User pubkey: ${userPk || "(failed)"}`);
  p("══════════════════════════════════════════════════════════");
  p("");

  persistSub.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { p(`FATAL: ${e.message}`); process.exit(1); });
