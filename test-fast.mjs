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
  params.set("perms", "get_public_key,sign_event:1,sign_event:42,ping,nip44_encrypt,nip44_decrypt");
  params.set("name", "FastTest");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("SCAN NOW — Full trust — KEEP PRIMAL OPEN");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // ONE subscription catches everything (pairing + RPC responses)
  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 30,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        
        // Check if this is pairing
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          // FIRE EVERYTHING IMMEDIATELY — no await, no delay
          fireAllRpcs();
          return;
        }
        
        // RPC response
        const r = respMap.get(parsed.id);
        if (r) {
          respMap.delete(parsed.id);
          p(`← id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,30)} error=${parsed.error||""}`);
          r(parsed);
        }
      } catch {}
    },
    oneose: () => {},
  });

  // Also poll for pairing (in case sub misses it)
  const deadline = Date.now() + 3 * 60_000;
  while (!bunkerPk && Date.now() < deadline) {
    await sleep(1000);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 30, limit: 5,
      });
      for (const e of events) {
        try {
          const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, e.pubkey);
          const payload = nip44.v2.decrypt(e.content, conv);
          const parsed = JSON.parse(payload);
          if (!bunkerPk && parsed.result === secret) {
            bunkerPk = e.pubkey;
            bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            p(`✓ PAIRED (poll)! Bunker: ${bunkerPk.slice(0,12)}`);
            fireAllRpcs();
            break;
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 3 min"); process.exit(1); }

  // Wait for all RPCs to resolve
  await sleep(60_000);
  p("Done waiting");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  // === FIRE ALL RPCs IN PARALLEL — NO WAITS ===
  async function fireAllRpcs() {
    // Fire connect + get_public_key + ping + sign_event ALL AT ONCE
    const rpcs = [
      rpc("connect", [bunkerPk, secret, "get_public_key,sign_event:1,sign_event:42,ping"]),
      rpc("get_public_key"),
      rpc("ping"),
      rpc("sign_event", [JSON.stringify({
        kind: 42, content: `test-bench ${Date.now()}`,
        tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
        created_at: Math.floor(Date.now() / 1000),
      })]),
    ];

    const labels = ["connect", "get_public_key", "ping", "sign_event:42"];
    const results = await Promise.allSettled(rpcs);
    
    let pass = 0, fail = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        p(`✓ ${labels[i]}: ${JSON.stringify(r.value.result||"").slice(0,40)} ${r.value.error ? "ERROR: " + r.value.error : ""}`);
        pass++;
      } else {
        p(`✗ ${labels[i]}: ${r.reason?.message}`);
        fail++;
      }
    }
    p(`\n═══ ${pass}/${pass+fail} passed ═══`);
  }

  function rpc(method, params = []) {
    const id = randomHex(8);
    const content = JSON.stringify({ id, method, params });
    const encrypted = nip44.v2.encrypt(content, bunkerConv);
    const evt = finalizeEvent({
      kind: KIND, content: encrypted, tags: [["p", bunkerPk]],
      created_at: Math.floor(Date.now() / 1000),
    }, clientSk);
    pool.publish(RELAYS, evt); // fire and forget publish
    p(`→ ${method} id=${id}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        respMap.delete(id);
        reject(new Error("timeout"));
      }, 15_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
