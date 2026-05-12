import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

const RELAYS = ["wss://relay.primal.net", "wss://nos.lol"];
const KIND = 24133;
function ts() { return new Date().toISOString().slice(11, 19); }
function p(msg) { process.stdout.write(`${ts()} │ ${msg}\n`); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));

  const params = new URLSearchParams();
  for (const r of RELAYS) params.append("relay", r);
  params.set("secret", secret);
  params.set("perms", "get_public_key,sign_event:1,sign_event:42,ping,nip44_encrypt,nip44_decrypt");
  params.set("name", "Debug Bench");
  const uri = `nostrconnect://${clientPk}?${params.toString()}`;

  p("━━━ SCAN WITH PRIMAL (FULL trust) ━━━");
  p(uri);
  p("");

  const pool = new SimplePool();
  let bunkerPk = null;
  let bunkerConv = null;
  let paired = false;
  let fullPairingResponse = null;

  const pairSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "#p": [clientPk],
    since: Math.floor(Date.now() / 1000) - 60,
  }, {
    onevent: async (event) => {
      if (paired) return;
      try {
        const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        const payload = nip44.v2.decrypt(event.content, conv);
        const parsed = JSON.parse(payload);
        
        // LOG EVERYTHING about the response
        p("=== FULL PAIRING RESPONSE ===");
        p(`pubkey (bunker): ${event.pubkey}`);
        p(`event id: ${event.id}`);
        p(`event tags: ${JSON.stringify(event.tags)}`);
        p(`event created_at: ${event.created_at}`);
        p(`parsed JSON: ${JSON.stringify(parsed, null, 2)}`);
        p(`parsed keys: ${Object.keys(parsed).join(", ")}`);
        if (parsed.result) p(`result type: ${typeof parsed.result}, value: ${parsed.result}`);
        if (parsed.error) p(`error: ${parsed.error}`);
        if (parsed.id) p(`id: ${parsed.id}`);
        if (parsed.method) p(`method: ${parsed.method}`);
        if (parsed.params) p(`params: ${JSON.stringify(parsed.params)}`);
        // Check for any extra fields
        const knownKeys = ["id", "method", "params", "result", "error"];
        const extraKeys = Object.keys(parsed).filter(k => !knownKeys.includes(k));
        if (extraKeys.length) p(`EXTRA FIELDS: ${extraKeys.map(k => `${k}=${parsed[k]}`).join(", ")}`);
        p("=============================");

        if (parsed.result === secret) {
          paired = true;
          bunkerPk = event.pubkey;
          bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
          fullPairingResponse = parsed;
          p(`✓ PAIRED!`);
          pairSub.close();
        }
      } catch (e) { p(`decrypt error: ${e.message}`); }
    },
    oneose: () => p("Pairing sub EOSE"),
  });

  // Poll too
  const deadline = Date.now() + 5 * 60_000;
  while (!paired && Date.now() < deadline) {
    await sleep(2000);
    if (paired) break;
    try {
      const events = await pool.querySync(RELAYS, {
        kinds: [KIND], "#p": [clientPk],
        since: Math.floor(Date.now() / 1000) - 60, limit: 5,
      });
      for (const event of events) {
        if (paired) break;
        try {
          const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          const payload = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(payload);
          p("=== FULL PAIRING RESPONSE (poll) ===");
          p(`parsed JSON: ${JSON.stringify(parsed, null, 2)}`);
          p(`parsed keys: ${Object.keys(parsed).join(", ")}`);
          const knownKeys = ["id", "method", "params", "result", "error"];
          const extraKeys = Object.keys(parsed).filter(k => !knownKeys.includes(k));
          if (extraKeys.length) p(`EXTRA FIELDS: ${extraKeys.map(k => `${k}=${parsed[k]}`).join(", ")}`);
          p("====================================");
          if (parsed.result === secret) {
            paired = true;
            bunkerPk = event.pubkey;
            bunkerConv = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
            p("✓ PAIRED (poll)!");
            pairSub.close();
          }
        } catch {}
      }
    } catch {}
  }

  if (!paired) { p("No pairing"); process.exit(1); }

  // Now just wait — let's see if the bunker sends anything else unprompted
  p("");
  p("Watching for 30s for any unsolicited bunker events...");
  
  const watchSub = pool.subscribeMany(RELAYS, {
    kinds: [KIND], "authors": [bunkerPk], "#p": [clientPk],
  }, {
    onevent: async (event) => {
      try {
        const payload = nip44.v2.decrypt(event.content, bunkerConv);
        const parsed = JSON.parse(payload);
        p(`[UNSOLICITED] ${JSON.stringify(parsed)}`);
      } catch (e) { p(`[UNSOLICITED] decrypt error: ${e.message}`); }
    },
    oneose: () => p("Watch sub EOSE"),
  });

  await sleep(30000);
  watchSub.close();
  pool.close(RELAYS);
  p("Done.");
  process.exit(0);
}

main().catch(e => { p(`Fatal: ${e.message}`); process.exit(1); });
