import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

// PRIMAL'S OWN RELAY — the one their web app uses
const RELAYS = ["wss://nrs.primal.net"];
const KIND = 24133;
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomHex(n) { return bytesToHex(crypto.getRandomValues(new Uint8Array(n))); }

async function main() {
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = `sec-${randomHex(16)}`;  // Primal uses sec- prefix

  const params = new URLSearchParams();
  params.append("relay", RELAYS[0]);
  params.set("secret", secret);
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:42,ping");
  params.set("name", "Legion");
  params.set("url", "https://legion-chat.pages.dev");
  const uri = `nostrconnect://${clientPk}?${params.toString()}&nwc=1`;

  p("Client: " + clientPk.slice(0,16));
  p("Relay: " + RELAYS[0]);
  p("");
  p("━━━ PRIMAL'S OWN CONFIG — SCAN WITH PRIMAL — Full trust ━━━");
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
        p(`[EVENT] from=${event.pubkey.slice(0,12)} id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,40)}`);
        
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          // Primal's web app does NOT send connect for nostrconnect
          // It just calls getPublicKey after fromURI
          fireTests();
          return;
        }
        
        // Check if result is a JSON array [secret, nwcUrl] — Primal's fromURI parses this
        if (!bunkerPk) {
          try {
            const arr = JSON.parse(parsed.result);
            if (Array.isArray(arr) && arr[0] === secret) {
              bunkerPk = event.pubkey;
              bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
              p(`✓ PAIRED (array format)! Bunker: ${bunkerPk.slice(0,12)} NWC: ${arr[1] || 'none'}`);
              fireTests();
              return;
            }
          } catch {}
        }
        
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); p(`← RESOLVED id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,40)} error=${parsed.error||""}`); r(parsed); }
      } catch (e) { p(`decrypt err: ${e.message}`); }
    },
    oneose: () => p("Sub EOSE"),
  });

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
            fireTests();
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 5 min"); process.exit(1); }
  await sleep(180_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function fireTests() {
    try {
      const r = await rpc("get_public_key");
      p(`✓✓✓ get_public_key: ${r.result} ✓✓✓`);
    } catch (e) {
      p(`✗ get_public_key: ${e.message}`);
      // Try connect
      try {
        const r = await rpc("connect", [bunkerPk, secret]);
        p(`connect: result=${r.result} error=${r.error}`);
        if (r.result === "ack") {
          const r2 = await rpc("get_public_key");
          p(`✓ get_public_key after connect: ${r2.result}`);
        }
      } catch (e2) { p(`✗ connect: ${e2.message}`); }
    }
    
    try {
      const r = await rpc("ping");
      p(`✓ ping: ${r.result}`);
    } catch (e) { p(`✗ ping: ${e.message}`); }
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
      const timer = setTimeout(() => { respMap.delete(id); reject(new Error(`timeout 30s`)); }, 30_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
