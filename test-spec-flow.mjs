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
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42,ping");
  params.set("name", "Legion");
  params.set("url", "https://legion-chat.pages.dev");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("Client: " + clientPk.slice(0, 16));
  p("");
  p("━━━ SCAN — Full trust — KEEP PRIMAL OPEN ━━━");
  p(uri);

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
        p(`[EVENT] from=${event.pubkey.slice(0, 12)} id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 40)}`);

        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0, 12)}`);
          afterPairing();
          return;
        }

        const r = respMap.get(parsed.id);
        if (r) {
          respMap.delete(parsed.id);
          p(`← RESOLVED id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 50)} error=${parsed.error || ""}`);
          r(parsed);
        }
      } catch (e) { p(`decrypt err: ${e.message}`); }
    },
    oneose: () => p("Sub EOSE"),
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
            p(`✓ PAIRED (poll)!`);
            afterPairing();
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 5 min"); process.exit(1); }
  await sleep(120_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function afterPairing() {
    // Per NIP-46 spec: send connect request, then get_public_key
    // Fire ALL THREE simultaneously to hit the 1-second window
    p("Firing connect + get_public_key + ping simultaneously...");
    
    const results = await Promise.allSettled([
      rpc("connect", [bunkerPk, secret, "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42,ping"]),
      rpc("get_public_key"),
      rpc("ping"),
    ]);

    const labels = ["connect", "get_public_key", "ping"];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        p(`✓ ${labels[i]}: result=${String(r.value.result || "").slice(0, 40)} error=${r.value.error || ""}`);
      } else {
        p(`✗ ${labels[i]}: ${r.reason?.message}`);
      }
    }

    // If any succeeded, try sign_event
    const succeeded = results.some(r => r.status === "fulfilled" && !r.value?.error);
    if (succeeded) {
      p("Bunker is alive! Trying sign_event:42...");
      try {
        const r = await rpc("sign_event", [JSON.stringify({
          kind: 42, content: `Legion test ${Date.now()}`,
          tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
          created_at: Math.floor(Date.now() / 1000),
        })]);
        if (r.result) {
          const signed = JSON.parse(r.result);
          p(`✓✓✓ sign_event:42 id=${signed.id?.slice(0, 16)} ✓✓✓`);
        } else {
          p(`✗ sign_event error: ${r.error}`);
        }
      } catch (e) { p(`✗ sign_event: ${e.message}`); }
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
