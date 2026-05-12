import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const RELAYS = ["wss://relay.primal.net", "wss://nos.lol"];
const KIND = 24133;
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomHex(n) { return bytesToHex(crypto.getRandomValues(new Uint8Array(n))); }

async function main() {
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = randomHex(16);

  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", "get_public_key,sign_event:1,sign_event:42,ping");
  params.set("name", "Connect Test");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("━━━ SCAN WITH PRIMAL (FULL trust) — KEEP APP OPEN ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  let paired = false;
  const respMap = new Map();

  // Pairing subscription
  const pairSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 60,
  }, {
    onevent: async (event) => {
      if (paired) return;
      try {
        const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`=== PAIRING RESPONSE ===`);
        p(`Full JSON: ${JSON.stringify(parsed)}`);
        p(`Keys: ${Object.keys(parsed).join(", ")}`);
        if (parsed.result === secret) {
          paired = true;
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          pairSub.close();
        }
      } catch (e) { p(`pairing error: ${e.message}`); }
    },
    oneose: () => p("Pairing sub EOSE"),
  });

  // Poll for pairing too
  const deadline = Date.now() + 5 * 60_000;
  while (!paired && Date.now() < deadline) {
    await sleep(2000);
    if (paired) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 60, limit: 5,
      });
      for (const event of events) {
        if (paired) break;
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          p(`=== PAIRING RESPONSE (poll) ===`);
          p(`Full JSON: ${JSON.stringify(parsed)}`);
          if (parsed.result === secret) {
            paired = true;
            bunkerPk = event.pubkey;
            bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            p(`✓ PAIRED (poll)!`);
            pairSub.close();
          }
        } catch {}
      }
    } catch {}
  }

  if (!paired) { p("No pairing"); process.exit(1); }

  // Open persistent response sub
  const respSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "authors": [bunkerPk], "#p": [clientPk],
  }, {
    onevent: async (event) => {
      try {
        const payload = nip44.v2.decrypt(event.content, bunkerConv);
        const parsed = JSON.parse(payload);
        p(`[RESPONSE] id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,40)} error=${parsed.error||""}`);
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); r(parsed); }
      } catch (e) { p(`[RESPONSE] decrypt error: ${e.message}`); }
    },
    oneose: () => p("Response sub EOSE"),
  });

  await sleep(500);

  // RPC helper with poll fallback
  async function rpc(method, params = []) {
    const id = randomHex(8);
    const content = JSON.stringify({ id, method, params });
    const encrypted = nip44.v2.encrypt(content, bunkerConv);
    const evt = finalizeEvent({
      kind: KIND, content: encrypted, tags: [["p", bunkerPk]],
      created_at: Math.floor(Date.now() / 1000),
    }, clientSk);
    await Promise.allSettled(pool.publish(RELAYS, evt));
    p(`→ ${method} id=${id}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        p(`  ${method} sub timeout — polling...`);
        try {
          const evts = await pool.querySync(RELAYS, {
            kinds: [KIND], "authors": [bunkerPk], "#p": [clientPk],
            since: Math.floor(Date.now() / 1000) - 30, limit: 10,
          });
          for (const e of evts) {
            try {
              const pl = nip44.v2.decrypt(e.content, bunkerConv);
              const pr = JSON.parse(pl);
              if (pr.id === id) { resolve(pr); return; }
            } catch {}
          }
        } catch {}
        reject(new Error(`${method} timed out`));
      }, 10_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }

  let pass = 0, fail = 0;

  // TEST 1: connect WITHOUT secret (just bunker pubkey)
  try {
    const r = await rpc("connect", [bunkerPk]);
    p(`✓ connect: result=${JSON.stringify(r.result)} error=${r.error}`);
    pass++;
  } catch (e) { p(`✗ connect: ${e.message}`); fail++; }

  // TEST 2: get_public_key immediately after
  try {
    const r = await rpc("get_public_key");
    p(`✓ get_public_key: ${r.result?.slice(0,20)}...`);
    pass++;
  } catch (e) { p(`✗ get_public_key: ${e.message}`); fail++; }

  // TEST 3: ping
  try {
    const r = await rpc("ping");
    p(`✓ ping: ${r.result}`);
    pass++;
  } catch (e) { p(`✗ ping: ${e.message}`); fail++; }

  // TEST 4: sign_event kind 42
  try {
    const r = await rpc("sign_event", [JSON.stringify({
      kind: 42, content: `test-bench ${Date.now()}`,
      tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
      created_at: Math.floor(Date.now() / 1000),
    })]);
    if (r.result) { const s = JSON.parse(r.result); p(`✓ sign_event:42 id=${s.id?.slice(0,16)}`); pass++; }
    else { p(`✗ sign_event:42 error: ${r.error}`); fail++; }
  } catch (e) { p(`✗ sign_event:42: ${e.message}`); fail++; }

  p(`\n═══ RESULTS: ${pass} passed, ${fail} failed ═══`);
  respSub.close();
  pool.close(RELAYS);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
