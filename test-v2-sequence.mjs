// Replicate primal-bench-v2 exact sequence: pair → connect → get_public_key → sign_event
// The connect RPC (even if errored) may keep the bunker processing long enough for get_public_key
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

  p("Client: " + clientPk.slice(0, 16));
  p("");
  p("━━━ SCAN — Full trust ━━━");
  p(uri);

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // Subscribe for ALL responses
  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk], since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        p(`[EVENT] from=${event.pubkey.slice(0, 12)} id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 50)} error=${parsed.error || ""}`);

        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0, 12)}`);
          // DO NOT await — fire immediately
          afterPairing();
          return;
        }

        // Resolve any pending RPC
        const r = respMap.get(parsed.id);
        if (r) {
          respMap.delete(parsed.id);
          p(`← RESOLVED id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 50)} error=${parsed.error || ""}`);
          r.resolve(parsed);
        }
      } catch (e) { p(`decrypt err: ${e.message}`); }
    },
    oneose: () => p("Sub EOSE"),
  });

  // Pairing poll
  const deadline = Date.now() + 5 * 60_000;
  while (!bunkerPk && Date.now() < deadline) {
    await sleep(2000);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk], since: Math.floor(Date.now() / 1000) - 120, limit: 10,
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
    // EXACT primal-bench-v2 sequence:
    // 1. connect RPC (triggers session creation, even if error)
    // 2. get_public_key (should succeed while bunker still processing)
    // 3. sign_event (if 1 and 2 worked)

    p("─── Firing connect RPC (like primal-bench-v2) ───");
    const connectResult = await rpc("connect", [bunkerPk, secret, perms]);
    p(`connect: result=${String(connectResult.result || "").slice(0, 30)} error=${connectResult.error || ""}`);

    p("─── Firing get_public_key ───");
    const gpkResult = await rpc("get_public_key", []);
    p(`get_public_key: result=${String(gpkResult.result || "").slice(0, 30)} error=${gpkResult.error || ""}`);

    if (gpkResult.result) {
      p("─── BUNKER IS ALIVE! Firing sign_event:42 ───");
      const signResult = await rpc("sign_event", [JSON.stringify({
        kind: 42, content: `Legion test ${Date.now()}`,
        tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "", "root"]],
        created_at: Math.floor(Date.now() / 1000),
      })]);
      if (signResult.result) {
        const signed = JSON.parse(signResult.result);
        p(`✓✓✓ sign_event:42 id=${signed.id?.slice(0, 16)} ✓✓✓`);
      } else {
        p(`sign_event error: ${signResult.error}`);
      }
    } else {
      p("─── get_public_key failed — bunker is deaf ───");
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

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        respMap.delete(id);
        p(`✗ ${method} TIMEOUT (15s)`);
        resolve({ id, result: null, error: "timeout" });
      }, 15_000);
      respMap.set(id, { resolve, timer });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
