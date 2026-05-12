import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const RELAYS = ["wss://relay.primal.net", "wss://relay.nip46.com", "wss://relay.damus.io", "wss://nos.lol"];
const KIND = 24133;
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomHex(n) { return bytesToHex(crypto.getRandomValues(new Uint8Array(n))); }

async function main() {
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = randomHex(16);
  const perms = "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42,ping";

  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", perms);
  params.set("name", "Legion");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  // Write a simple HTML page with the URI as a clickable link
  const html = `<!DOCTYPE html><html><body style="font-family:monospace;padding:20px;word-break:break-all;">
    <h2>Scan in Primal (Full trust)</h2>
    <a href="${uri}" style="font-size:14px;">${uri}</a>
    <p>Or copy:</p>
    <textarea style="width:100%;height:80px;font-size:12px;">${uri}</textarea>
  </body></html>`;
  const { writeFileSync } = await import("fs");
  writeFileSync("/tmp/nostr-pair.html", html);
  writeFileSync("/tmp/nostr-uri.txt", uri);
  p("HTML page: file:///tmp/nostr-pair.html");
  p("Waiting for pairing...");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk], since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`[EVENT] id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 50)} error=${parsed.error || ""}`);
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED!`);
          afterPairing();
          return;
        }
        const r = respMap.get(parsed.id);
        if (r) { respMap.delete(parsed.id); clearTimeout(r.timer); r.resolve(parsed); }
      } catch {}
    },
    oneose: () => p("EOSE"),
  });

  const deadline = Date.now() + 5 * 60_000;
  while (!bunkerPk && Date.now() < deadline) { await sleep(2000); }
  if (!bunkerPk) { p("No pairing"); process.exit(1); }
  await sleep(120_000);
  process.exit(0);

  async function afterPairing() {
    p("─── Step 1: connect ───");
    const c = await rpc("connect", [bunkerPk, secret, perms]);
    p(`connect: ${c.error || String(c.result||"").slice(0,30)}`);

    p("─── Step 2: get_public_key ───");
    const g = await rpc("get_public_key", []);
    p(`gpk: ${g.error || g.result?.slice(0,20)}`);

    if (g.result) {
      p("─── Step 3: sign_event:42 ───");
      const s = await rpc("sign_event", [JSON.stringify({
        kind: 42, content: "test " + Date.now(),
        tags: [["e","a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714","","root"]],
        created_at: Math.floor(Date.now() / 1000),
      })]);
      p(`sign: ${s.error || "OK id=" + JSON.parse(s.result).id?.slice(0,16)}`);
    }
  }

  function rpc(method, params = []) {
    const id = randomHex(8);
    const content = JSON.stringify({ id, method, params });
    const encrypted = nip44.v2.encrypt(content, bunkerConv);
    const evt = finalizeEvent({ kind: KIND, content: encrypted, tags: [["p", bunkerPk]], created_at: Math.floor(Date.now()/1000) }, clientSk);
    pool.publish(RELAYS, evt);
    p(`→ ${method}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { respMap.delete(id); resolve({ result: null, error: "timeout 15s" }); }, 15_000);
      respMap.set(id, { resolve, timer });
    });
  }
}
main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
