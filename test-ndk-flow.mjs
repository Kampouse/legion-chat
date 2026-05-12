import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

// Use nmail's exact relays
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

  // STEP 1: Build nostrconnect URI — exact same as NDK
  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:42,ping");
  params.set("name", "Nmail");
  params.set("url", "https://app.nostrmail.org");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("Client: " + clientPk.slice(0,16));
  p("Relays: " + RELAYS.join(", "));
  p("");
  p("━━━ SCAN WITH PRIMAL — Full trust ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // STEP 2: Pairing subscription — EXACT NDK: no authors filter
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
          afterPairing(parsed.id);
          return;
        }
        
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); p(`← RESOLVED id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,30)} error=${parsed.error||""}`); r(parsed); }
      } catch (e) { p(`decrypt err: ${e.message}`); }
    },
    oneose: () => p("Pairing sub EOSE"),
  });

  // 5 min pairing poll
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
            p(`✓ PAIRED (poll)! Bunker: ${bunkerPk.slice(0,12)}`);
            afterPairing(parsed.id);
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 5 min"); process.exit(1); }

  // Wait for everything
  await sleep(300_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  // STEP 3: After pairing — mimic NDK EXACTLY
  async function afterPairing(pairingId) {
    // NDK connectWithNostrConnect does NOT send connect RPC for nostrconnect:// flow
    // It just waits for the secret match and returns BunkerConnection
    // Then loginWithBunkerConnection creates Nip46EventSigner which calls listenRelays()
    // Then getPublicKeyAsync() sends get_public_key
    
    // So: just send get_public_key immediately, like NDK does
    p("NDK flow: sending get_public_key immediately (no connect RPC)...");
    try {
      const r = await rpc("get_public_key");
      p(`✓✓✓ get_public_key: ${r.result} ✓✓✓`);
      p("BUNKER IS ALIVE!");
      
      // Try more
      try {
        const r2 = await rpc("ping");
        p(`✓ ping: ${r2.result}`);
      } catch (e) { p(`✗ ping: ${e.message}`); }
      
      try {
        const r3 = await rpc("sign_event", [JSON.stringify({
          kind: 1, content: `test ${Date.now()}`, tags: [],
          created_at: Math.floor(Date.now() / 1000),
        })]);
        p(`✓ sign_event:1: ${r3.result ? "signed" : r3.error}`);
      } catch (e) { p(`✗ sign_event: ${e.message}`); }
      
    } catch (e) {
      p(`✗ get_public_key: ${e.message}`);
      p("Trying connect RPC instead...");
      
      // Try bunker:// flow — send connect [bunkerPk, secret]
      try {
        const r = await rpc("connect", [bunkerPk, secret, "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:42,ping"]);
        p(`connect result: ${r.result} error: ${r.error}`);
        
        if (r.result === "ack") {
          // Now try get_public_key
          try {
            const r2 = await rpc("get_public_key");
            p(`✓ get_public_key after connect: ${r2.result}`);
          } catch (e2) { p(`✗ get_public_key after connect: ${e2.message}`); }
        }
      } catch (e2) { p(`✗ connect: ${e2.message}`); }
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
      const timer = setTimeout(() => { respMap.delete(id); reject(new Error(`timeout 30s`)); }, 30_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
