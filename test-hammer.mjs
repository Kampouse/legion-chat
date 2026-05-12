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
  params.set("name", "Legion");
  params.set("url", "https://legion-chat.pages.dev");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("Client: " + clientPk.slice(0,16));
  p("");
  p("━━━ SCAN — Full trust ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`[EVENT] from=${event.pubkey.slice(0,12)} id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,30)} error=${parsed.error||""}`);
        
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          runTests();
          return;
        }
        
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); r(parsed); }
      } catch {}
    },
    oneose: () => p("Sub EOSE"),
  });

  // 5 MINUTE pairing poll
  const deadline = Date.now() + 5 * 60_000;
  while (!bunkerPk && Date.now() < deadline) {
    await sleep(2000);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 120, limit: 10,
      });
      for (const e of events) {
        if (bunkerPk) break;
        try {
          const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, e.pubkey);
          const payload = nip44.v2.decrypt(e.content, conv);
          const parsed = JSON.parse(payload);
          if (parsed.result === secret) {
            bunkerPk = e.pubkey;
            bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            p(`✓ PAIRED (poll)!`);
            runTests();
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 5 min"); process.exit(1); }

  await sleep(300_000); // 5 min for RPCs
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function runTests() {
    // Strategy: hammer get_public_key every 5s for 2 minutes
    p("Hammering get_public_key every 5s for 2 min...");
    for (let i = 0; i < 24; i++) {
      if (i > 0) await sleep(5000);
      try {
        const r = await rpc("get_public_key", [], 10_000);
        if (r.result && !r.error) {
          p(`✓✓✓ get_public_key attempt ${i+1}: ${r.result} ✓✓✓`);
          // NOW fire everything
          const tests = [
            ["ping", rpc("ping", [], 15_000)],
            ["sign_event:42", rpc("sign_event", [JSON.stringify({
              kind: 42, content: `Legion ${Date.now()}`,
              tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
              created_at: Math.floor(Date.now() / 1000),
            })], 15_000)],
          ];
          for (const [label, promise] of tests) {
            try {
              const r = await promise;
              p(`✓ ${label}: ${String(r.result||"").slice(0,40)} ${r.error||""}`);
            } catch (e) { p(`✗ ${label}: ${e.message}`); }
          }
          return;
        } else {
          p(`Attempt ${i+1}: error=${r.error}`);
        }
      } catch (e) {
        p(`Attempt ${i+1}: ${e.message}`);
      }
    }
    p("All 24 attempts failed");
  }

  function rpc(method, params = [], timeoutMs = 15_000) {
    const id = randomHex(8);
    const content = JSON.stringify({ id, method, params });
    const encrypted = nip44.v2.encrypt(content, bunkerConv);
    const evt = finalizeEvent({
      kind: KIND, content: encrypted, tags: [["p", bunkerPk]],
      created_at: Math.floor(Date.now() / 1000),
    }, clientSk);
    pool.publish(RELAYS, evt);
    p(`→ ${method} id=${id}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { respMap.delete(id); reject(new Error(`timeout ${timeoutMs/1000}s`)); }, timeoutMs);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
