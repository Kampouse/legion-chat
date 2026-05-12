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
  p("━━━ SCAN — Full trust — KEEP PRIMAL OPEN AFTER APPROVING ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // Response sub — persistent, catches everything
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
          p(`✓ PAIRED!`);
          p("Waiting 30s for Primal foreground service to start...");
          setTimeout(fireRpcsWithRetry, 30_000);
          return;
        }
        
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); r(parsed); }
      } catch {}
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
            p("Waiting 30s for Primal foreground service...");
            setTimeout(fireRpcsWithRetry, 30_000);
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing"); process.exit(1); }

  // Wait for everything
  await sleep(180_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function fireRpcsWithRetry() {
    p("30s elapsed — sending get_public_key...");
    
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await rpc("get_public_key");
        if (r.error) {
          p(`Attempt ${attempt+1}: error=${r.error}`);
        } else {
          p(`✓✓✓ get_public_key: ${r.result} ✓✓✓`);
          // IT WORKS — fire the rest
          await fireAllTests();
          return;
        }
      } catch (e) {
        p(`Attempt ${attempt+1}: ${e.message}`);
      }
      p(`Waiting 15s before retry...`);
      await sleep(15_000);
    }
    p("All attempts failed");
  }

  async function fireAllTests() {
    const tests = [
      rpc("ping"),
      rpc("sign_event", [JSON.stringify({
        kind: 42, content: `Legion test ${Date.now()}`,
        tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
        created_at: Math.floor(Date.now() / 1000),
      })]),
    ];
    const labels = ["ping", "sign_event:42"];
    const results = await Promise.allSettled(tests);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        p(`✓ ${labels[i]}: ${String(r.value.result||"").slice(0,40)} ${r.value.error||""}`);
      } else {
        p(`✗ ${labels[i]}: ${r.reason?.message}`);
      }
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
      const timer = setTimeout(() => { respMap.delete(id); reject(new Error("timeout 15s")); }, 15_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
