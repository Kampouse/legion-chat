// Test: blast RPCs to ALL recommended NIP-46 relays after pairing
// Goal: find which relay the bunker actually monitors post-pairing
import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const ALL_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.nip46.com",
  "wss://nos.lol",
  "wss://relay.nostr.band",
];

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
  // Use ALL relays in the nostrconnect URI so the bunker subscribes to all of them
  for (const r of ALL_RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42,ping");
  params.set("name", "Legion");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("Client: " + clientPk.slice(0, 16));
  p("");
  p("━━━ SCAN IN PRIMAL (Full trust) — KEEP PHONE NEARBY ━━━");
  p(uri);

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;

  // Subscribe on ALL relays for pairing
  const sub = pool.subscribeMany(ALL_RELAYS, {
    kinds: [KIND], "#p": [clientPk], since: Math.floor(Date.now() / 1000) - 300,
  }, {
    onevent: (event) => {
      try {
        const conv = bunkerConv || nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        if (!bunkerPk && parsed.result === secret) {
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          p(`✓ PAIRED! Bunker: ${bunkerPk.slice(0, 12)}`);
          afterPairing();
        }
      } catch {}
    },
    oneose: () => p("Pairing sub EOSE"),
  });

  // Poll for pairing
  const deadline = Date.now() + 5 * 60_000;
  while (!bunkerPk && Date.now() < deadline) {
    await sleep(2000);
    if (bunkerPk) break;
    try {
      const events = await pool.querySync(ALL_RELAYS, {
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

  // Keep alive for monitoring
  p("Waiting 90s for delayed responses...");
  await sleep(90_000);
  p("Done");
  sub.close();
  pool.close(ALL_RELAYS);
  process.exit(0);

  async function afterPairing() {
    // Subscribe for bunker responses on ALL relays
    const respSub = pool.subscribeMany(ALL_RELAYS, {
      kinds: [KIND], authors: [bunkerPk], "#p": [clientPk],
    }, {
      onevent: (event) => {
        try {
          const payload = nip44.v2.decrypt(event.content, bunkerConv);
          const parsed = JSON.parse(payload);
          p(`[RESPONSE] method=${parsed.result ? "result" : "error"} id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 30)} error=${parsed.error || ""}`);
        } catch {}
      },
      oneose: () => p("Response sub EOSE on all relays"),
    });

    // Fire get_public_key to EACH relay individually to see which one delivers
    p("Firing get_public_key to ALL relays simultaneously...");
    const id = randomHex(8);
    const content = JSON.stringify({ id, method: "get_public_key", params: [] });
    const encrypted = nip44.v2.encrypt(content, bunkerConv);
    const evt = finalizeEvent({
      kind: KIND, content: encrypted, tags: [["p", bunkerPk]],
      created_at: Math.floor(Date.now() / 1000),
    }, clientSk);
    
    // Publish to ALL relays
    const results = await Promise.allSettled(
      ALL_RELAYS.map(async (relay) => {
        try {
          const pub = pool.publish([relay], evt);
          const r = await Promise.race([
            Promise.all(pub),
            new Promise((_, rej) => setTimeout(() => rej(new Error("pub timeout")), 5000)),
          ]);
          return `${relay}: ok`;
        } catch (e) {
          return `${relay}: fail (${e.message})`;
        }
      })
    );
    for (const r of results) {
      p(`  pub: ${r.status === "fulfilled" ? r.value : r.reason}`);
    }

    // Re-publish every 5s for 60s
    for (let attempt = 1; attempt <= 12; attempt++) {
      await sleep(5000);
      p(`Re-publishing get_public_key (attempt ${attempt})...`);
      const newId = randomHex(8);
      const newContent = JSON.stringify({ id: newId, method: "get_public_key", params: [] });
      const newEncrypted = nip44.v2.encrypt(newContent, bunkerConv);
      const newEvt = finalizeEvent({
        kind: KIND, content: newEncrypted, tags: [["p", bunkerPk]],
        created_at: Math.floor(Date.now() / 1000),
      }, clientSk);
      pool.publish(ALL_RELAYS, newEvt);
      
      // Also query for any bunker events
      const events = await pool.querySync(ALL_RELAYS, {
        kinds: [KIND], authors: [bunkerPk], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 30,
      });
      if (events.length > 0) {
        p(`  Found ${events.length} bunker events!`);
        for (const e of events) {
          try {
            const payload = nip44.v2.decrypt(e.content, bunkerConv);
            const parsed = JSON.parse(payload);
            p(`  → id=${parsed.id?.slice(0, 8)} result=${String(parsed.result || "").slice(0, 30)} error=${parsed.error || ""}`);
          } catch (err) { p(`  → decrypt failed`); }
        }
      }
    }
  }
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
