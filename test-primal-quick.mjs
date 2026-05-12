import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { writeFileSync } from "fs";

const RELAYS = ["wss://relay.primal.net", "wss://nos.lol"];
const KIND = 24133;
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomHex(n) { return bytesToHex(crypto.getRandomValues(new Uint8Array(n))); }

// Persist client key so we can reuse across runs
const KEY_FILE = "/tmp/test-client-key.txt";

async function main() {
  let clientSk, clientPk;
  
  // Generate new key
  clientSk = generateSecretKey();
  clientPk = getPublicKey(clientSk);
  writeFileSync(KEY_FILE, bytesToHex(clientSk));
  
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
  p("━━━ CLEAR OLD SESSIONS IN PRIMAL FIRST ━━━");
  p("━━━ THEN SCAN — Full trust — KEEP PRIMAL IN FOREGROUND ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  const respMap = new Map();

  // Single sub catches everything
  const sub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 30,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0,12)}`);
          // Don't fire immediately — give bunker time to subscribe
          waitForBunker();
          return;
        }
        
        const r = respMap.get(parsed.id);
        if (r) {
          respMap.delete(parsed.id);
          p(`← id=${parsed.id?.slice(0,8)} result=${String(parsed.result||"").slice(0,40)} error=${parsed.error||""}`);
          r(parsed);
        }
      } catch {}
    },
    oneose: () => {},
  });

  // Poll for pairing too
  const pairDeadline = Date.now() + 3 * 60_000;
  while (!bunkerPk && Date.now() < pairDeadline) {
    await sleep(1500);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 30, limit: 5,
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
            waitForBunker();
          }
        } catch {}
      }
    } catch {}
  }

  if (!bunkerPk) { p("No pairing after 3 min"); process.exit(1); }

  // Wait for all RPCs
  await sleep(120_000);
  p("Done");
  sub.close();
  pool.close(RELAYS);
  process.exit(0);

  async function waitForBunker() {
    // Give bunker 5s to establish relay subscription
    p("Waiting 5s for bunker to subscribe to relays...");
    await sleep(5_000);
    
    // Send a ping first to verify bunker is listening
    p("Sending ping to verify bunker is live...");
    try {
      const pingResult = await rpc("ping");
      if (pingResult.result === "pong" || pingResult.result) {
        p("✓ Bunker is LIVE! Firing all tests...");
        fireTests();
      } else {
        p(`Got ping response but unexpected: ${JSON.stringify(pingResult)}`);
        fireTests();
      }
    } catch (e) {
      p(`Ping failed: ${e.message} — retrying in 5s...`);
      await sleep(5_000);
      try {
        await rpc("ping");
        p("✓ Bunker is LIVE (retry)! Firing all tests...");
        fireTests();
      } catch (e2) {
        p(`Ping still failing: ${e2.message} — firing tests anyway`);
        fireTests();
      }
    }
  }

  async function fireTests() {
    const tests = [];
    const labels = [];

    tests.push(rpc("get_public_key"));
    labels.push("get_public_key");

    tests.push(rpc("sign_event", [JSON.stringify({
      kind: 42, content: `Legion test bench ${Date.now()}`,
      tags: [["e", "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714", "wss://relay.primal.net", "root"]],
      created_at: Math.floor(Date.now() / 1000),
    })]));
    labels.push("sign_event:42");

    tests.push(rpc("sign_event", [JSON.stringify({
      kind: 1, content: `Legion bench ${Date.now()}`, tags: [],
      created_at: Math.floor(Date.now() / 1000),
    })]));
    labels.push("sign_event:1");

    const testTarget = getPublicKey(generateSecretKey());
    tests.push(rpc("nip44_encrypt", [testTarget, "hello world"]));
    labels.push("nip44_encrypt");

    const results = await Promise.allSettled(tests);
    let pass = 0, fail = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") {
        const val = r.value;
        if (val.error) {
          p(`✗ ${labels[i]}: error=${val.error}`);
          fail++;
        } else {
          p(`✓ ${labels[i]}: ${JSON.stringify(val.result||"").slice(0,50)}`);
          pass++;
        }
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
    pool.publish(RELAYS, evt);
    p(`→ ${method} id=${id}`);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        respMap.delete(id);
        reject(new Error("timeout 15s"));
      }, 15_000);
      respMap.set(id, (parsed) => { clearTimeout(timer); resolve(parsed); });
    });
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
