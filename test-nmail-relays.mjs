import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

// USE NMAIL'S EXACT RELAYS
const RELAYS = ["wss://relay.camelus.app", "wss://nostr-01.yakihonne.com"];
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
  // Nmail's exact perms
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:42,ping");
  params.set("name", "Nmail");
  params.set("url", "https://app.nostrmail.org");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("Client: " + clientPk.slice(0,16));
  p("");
  p("SCAN — Full trust — USE NMAIL RELAYS");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // Pairing sub (no authors filter — matches NDK)
  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`[EVENT] from=${event.pubkey.slice(0,12)} id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,30)}`);
        
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          // Fire get_public_key right away — NDK does this immediately
          fireGetPublicKey();
          return;
        }
        
        const r = respMap.get(parsed.id);
        if (r) {
          respMap.delete(parsed.id);
          r(parsed);
        }
      } catch (e) { p(`decrypt err: ${e.message}`); }
    },
    oneose: () => p("Sub EOSE"),
  });

  // Poll for pairing
  const deadline = Date.now() + 3 * 60_000;
  while (!bunkerPk && Date.now() < deadline) {
    await sleep(1500);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 60, limit: 5,
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
            fireGetPublicKey();
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing"); process.exit(1); }

  // Keep alive for responses
  await sleep(120_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function fireGetPublicKey() {
    try {
      const r = await rpc("get_public_key");
      p(`✓✓✓ get_public_key: ${r.result} ✗✗✗`);
      p(`✓✓✓ IT WORKS! ✗✗✗`);
      
      // If that worked, try sign_event
      try {
        const r2 = await rpc("sign_event", [JSON.stringify({
          kind: 42, content: `Legion test ${Date.now()}`,
          tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
          created_at: Math.floor(Date.now() / 1000),
        })]);
        p(`✓ sign_event:42: ${r2.result ? JSON.parse(r2.result).id?.slice(0,16) : r2.error}`);
      } catch (e) { p(`✗ sign_event:42: ${e.message}`); }
      
      try {
        const r3 = await rpc("ping");
        p(`✓ ping: ${r3.result}`);
      } catch (e) { p(`✗ ping: ${e.message}`); }
      
    } catch (e) {
      p(`✗ get_public_key: ${e.message}`);
      // Try ping instead
      try {
        const r = await rpc("ping");
        p(`✓ ping worked: ${r.result}`);
      } catch (e2) { p(`✗ ping also failed: ${e2.message}`); }
    }
  }

  function rpc(method, params = []) {
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
      const timer = setTimeout(() => { respMap.delete(id); reject(new Error("timeout 30s")); }, 30_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
