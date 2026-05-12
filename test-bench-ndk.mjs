/**
 * Legion Chat — NDK NIP-46 Test Bench
 *
 * Uses NDKNip46Backend (mock bunker) + NDKNip46Signer (real client)
 * over REAL relays. Fully automated — no manual steps.
 *
 * Tests the patched NDK signer (fixes for nostr-dev-kit/ndk#390):
 *   - Accepts both "ack" and secret echo in nostrconnect pairing
 *   - Sends correct connect params in bunker flow
 *
 * Run:  bun test-bench-ndk.mjs
 */

import NDK, {
  NDKNip46Signer,
  NDKNip46Backend,
  NDKPrivateKeySigner,
  NDKEvent,
} from "@nostr-dev-kit/ndk";
import { SimplePool } from "nostr-tools/pool";

// ── Config ──────────────────────────────────────────────────────────

const RELAYS = ["wss://relay.primal.net", "wss://nos.lol"];

// ── Helpers ─────────────────────────────────────────────────────────

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`${ts()} ${a.join(" ")}`);
const results = { passed: 0, failed: 0 };
const pass = (m) => { log(`  ✓ ${m}`); results.passed++; };
const fail = (m) => { log(`  ✗ ${m}`); results.failed++; };
const hr = () => log("──────────────────────────────────────────");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SUITE = 0;
let TEST = 0;

function suite(name) {
  SUITE++;
  TEST = 0;
  hr();
  log(`Suite ${SUITE}: ${name}`);
  hr();
}

function test(name) {
  TEST++;
  return `S${SUITE}.T${TEST} ${name}`;
}

// ── Patch NDK signer (mirrors ndk-signer.ts patchNdkSigner) ─────────

function patchNdkSigner(signer) {
  // NDK's withTimeout is inlined/private — implement our own.
  function withTimeout(promise, operation, timeoutMs) {
    if (!timeoutMs) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`NIP-46 ${operation} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  signer.blockUntilReadyNostrConnect = async function () {
    let removeHandler;

    const promise = new Promise((resolve, reject) => {
      const connect = (response) => {
        const secret = this.nostrConnectSecret;
        const result = response.result;

        log(`  [patch] pairing response: result=${
          result === secret ? "secret-match" : result === "ack" ? "ack" : result?.slice(0, 20)
        } from=${response.event?.pubkey?.slice(0, 12)}`);

        // Accept both "ack" and secret echo — per NIP-46 spec
        const ok = result === secret || result === "ack";
        if (!ok) return;

        this.bunkerPubkey = response.event.pubkey;
        this.rpc.off("response", connect);
        removeHandler = undefined;

        this.getPublicKey()
          .then(async (pubkey) => {
            this.userPubkey = pubkey;
            this._user = this.ndk.getUser({ pubkey });
            await this.switchRelays();
            resolve(this._user);
          })
          .catch(reject);
      };

      removeHandler = () => this.rpc.off("response", connect);
      this.startListening();
      this.rpc.on("response", connect);
    });

    return withTimeout(promise, "blockUntilReady", this.timeout).finally(() => {
      removeHandler?.();
    });
  };

  signer.blockUntilReady = async function () {
    if (this.nostrConnectSecret) return this.blockUntilReadyNostrConnect();

    if (this.nip05 && !this.userPubkey) {
      const user = await NDKUser.fromNip05(this.nip05, this.ndk);
      if (user) {
        this._user = user;
        this.userPubkey = user.pubkey;
        this.relayUrls = user.nip46Urls;
        this.rpc = new (this.rpc.constructor)(
          this.ndk,
          this.localSigner,
          this.debug,
          this.relayUrls,
        );
      }
    }

    if (!this.bunkerPubkey && this.userPubkey) {
      this.bunkerPubkey = this.userPubkey;
    } else if (!this.bunkerPubkey) {
      throw new Error("Bunker pubkey not set");
    }

    await this.startListening();
    this.rpc.on("authUrl", (...props) => this.emit("authUrl", ...props));

    const self = this;
    const promise = new Promise((resolve, reject) => {
      const connectParams = [this.userPubkey || this.bunkerPubkey];
      if (this.secret) connectParams.push(this.secret);

      if (!this.bunkerPubkey) throw new Error("Bunker pubkey not set");

      this.rpc.sendRequest(
        this.bunkerPubkey,
        "connect",
        connectParams,
        24133,
        (response) => {
          const ok =
            response.result === "ack" ||
            (self.secret && response.result === self.secret);
          if (ok) {
            this.getPublicKey()
              .then(async (pubkey) => {
                this.userPubkey = pubkey;
                this._user = this.ndk.getUser({ pubkey });
                await this.switchRelays();
                resolve(this._user);
              })
              .catch(reject);
          } else {
            reject(
              new Error(
                response.error ||
                  `unexpected NIP-46 connect response: ${response.result}`,
              ),
            );
          }
        },
      );
    });

    return withTimeout(promise, "blockUntilReady", this.timeout);
  };
}

// ── Suite A: Pairing with SECRET ECHO (NDK default behavior) ────────

async function testPairingSecretEcho() {
  suite("Pairing — bunker echoes secret (standard behavior)");

  const ndkBackend = new NDK({ explicitRelayUrls: RELAYS });
  await ndkBackend.connect();
  log("  backend NDK connected");

  const backendSigner = NDKPrivateKeySigner.generate();
  const backendPubkey = backendSigner.pubkey;
  log(`  backend pubkey: ${backendPubkey.slice(0, 12)}...`);

  const backend = new NDKNip46Backend(
    ndkBackend,
    backendSigner,
    async () => true,
    RELAYS,
  );
  await backend.start();
  log("  backend started");

  const ndkClient = new NDK({ explicitRelayUrls: RELAYS });
  await ndkClient.connect();
  log("  client NDK connected");

  const clientSigner = NDKNip46Signer.nostrconnect(ndkClient, RELAYS[0], undefined, {
    name: "Legion Test",
    perms: "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42",
  });
  clientSigner.timeout = 30_000;
  patchNdkSigner(clientSigner);

  const uri = clientSigner.nostrConnectUri;
  const secretMatch = uri.match(/secret=([^&]+)/);
  const secret = secretMatch ? decodeURIComponent(secretMatch[1]) : null;
  log(`  secret: ${secret}`);

  const readyPromise = clientSigner.blockUntilReady();
  await sleep(2000);

  // Send pairing response with the SECRET (standard behavior)
  const clientPubkey = clientSigner.localSigner.pubkey;
  log("  sending pairing response with SECRET...");
  await backend.rpc.sendResponse("pair-secret", clientPubkey, secret);

  let user;
  try {
    user = await readyPromise;
    pass(test("blockUntilReady resolves (secret echo)"));
  } catch (e) {
    fail(`${test("blockUntilReady (secret)")} — ${e.message || e}`);
    return null;
  }

  if (user.pubkey === backendPubkey) {
    pass(test("pubkey matches backend"));
  } else {
    fail(`${test("pubkey match")} — got ${user.pubkey}, expected ${backendPubkey}`);
  }

  clientSigner.stop();
  return { ndkClient, clientSigner, backendPubkey, user };
}

// ── Suite B: Pairing with "ack" (Primal-style behavior) ─────────────

async function testPairingAck() {
  suite('Pairing — bunker sends "ack" (Primal-style)');

  const ndkBackend = new NDK({ explicitRelayUrls: RELAYS });
  await ndkBackend.connect();
  log("  backend NDK connected");

  const backendSigner = NDKPrivateKeySigner.generate();
  const backendPubkey = backendSigner.pubkey;
  log(`  backend pubkey: ${backendPubkey.slice(0, 12)}...`);

  const backend = new NDKNip46Backend(
    ndkBackend,
    backendSigner,
    async () => true,
    RELAYS,
  );
  await backend.start();
  log("  backend started");

  const ndkClient = new NDK({ explicitRelayUrls: RELAYS });
  await ndkClient.connect();
  log("  client NDK connected");

  const clientSigner = NDKNip46Signer.nostrconnect(ndkClient, RELAYS[0], undefined, {
    name: "Legion Test (ack)",
    perms: "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42",
  });
  clientSigner.timeout = 30_000;
  patchNdkSigner(clientSigner);

  log(`  secret: ${clientSigner.nostrConnectUri.match(/secret=([^&]+)/)?.[1]}`);

  const readyPromise = clientSigner.blockUntilReady();
  await sleep(2000);

  // Send pairing response with "ack" — THIS IS WHAT PRIMAL DOES
  const clientPubkey = clientSigner.localSigner.pubkey;
  log('  sending pairing response with "ack"...');
  await backend.rpc.sendResponse("pair-ack", clientPubkey, "ack");

  let user;
  try {
    user = await readyPromise;
    pass(test('blockUntilReady resolves with "ack" response'));
  } catch (e) {
    fail(`${test('blockUntilReady (ack)')} — ${e.message || e}`);
    return null;
  }

  if (user.pubkey === backendPubkey) {
    pass(test("pubkey matches backend"));
  } else {
    fail(`${test("pubkey match")} — got ${user.pubkey}, expected ${backendPubkey}`);
  }

  clientSigner.stop();
  return { ndkClient, clientSigner, backendPubkey, user };
}

// ── Suite C: Full signing flow ──────────────────────────────────────

async function testFullSigningFlow() {
  suite("Full signing flow (pair → sign → publish)");

  const ndkBackend = new NDK({ explicitRelayUrls: RELAYS });
  await ndkBackend.connect();
  const backendSigner = NDKPrivateKeySigner.generate();
  const backendPubkey = backendSigner.pubkey;
  log(`  backend pubkey: ${backendPubkey.slice(0, 12)}...`);

  const backend = new NDKNip46Backend(ndkBackend, backendSigner, async () => true, RELAYS);
  await backend.start();

  const ndkClient = new NDK({ explicitRelayUrls: RELAYS });
  await ndkClient.connect();

  const clientSigner = NDKNip46Signer.nostrconnect(ndkClient, RELAYS[0], undefined, {
    name: "Legion Full Flow Test",
    perms: "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:1,sign_event:4,sign_event:42",
  });
  clientSigner.timeout = 30_000;
  patchNdkSigner(clientSigner);

  const uri = clientSigner.nostrConnectUri;
  const secretMatch = uri.match(/secret=([^&]+)/);
  const secret = secretMatch ? decodeURIComponent(secretMatch[1]) : null;
  log(`  secret: ${secret}`);

  const readyPromise = clientSigner.blockUntilReady();
  await sleep(2000);

  const clientPubkey = clientSigner.localSigner.pubkey;
  // Pair with "ack" to test the Primal-style path
  await backend.rpc.sendResponse("pair-full", clientPubkey, "ack");

  let user;
  try {
    user = await readyPromise;
    pass(test("paired with ack response"));
  } catch (e) {
    fail(`${test("pairing")} — ${e.message || e}`);
    return;
  }

  // getPublicKey
  let pk;
  try {
    pk = await clientSigner.getPublicKey();
    pass(test(`getPublicKey: ${pk.slice(0, 12)}...`));
  } catch (e) {
    fail(`${test("getPublicKey")} — ${e.message || e}`);
    return;
  }

  // sign kind 42
  const channelId = "a2468118fc38ecb16d6a03b05290e2a0fa3222f87527591e27d8a17a52268714";
  const kind42 = {
    kind: 42,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["e", channelId, RELAYS[0], "root"]],
    content: `Test bench message at ${new Date().toISOString()}`,
  };

  let signed42;
  try {
    const ndkEvent = new NDKEvent(ndkClient, { ...kind42, pubkey: pk });
    await ndkEvent.sign(clientSigner);
    signed42 = ndkEvent.rawEvent();
    pass(test("kind 42 signed"));
  } catch (e) {
    fail(`${test("sign kind 42")} — ${e.message || e}`);
  }

  // publish + verify
  if (signed42) {
    const pool = new SimplePool();
    const pubs = await Promise.allSettled(pool.publish(RELAYS, signed42));
    const ok = pubs.filter((p) => p.status === "fulfilled").length;
    if (ok > 0) {
      pass(test(`published to ${ok}/${pubs.length} relays`));
    } else {
      fail(test("publish — all relays rejected"));
    }

    await sleep(3000);
    const fetched = await pool.querySync(RELAYS, { ids: [signed42.id] });
    if (fetched.length > 0) {
      pass(test("kind 42 round-trip verified"));
    } else {
      fail(test("round-trip — event not found"));
    }
  }

  // NIP-44 encrypt
  const plaintext = `Hello from test bench! ${Date.now()}`;
  try {
    const recipient = ndkClient.getUser({ pubkey: clientPubkey });
    const ciphertext = await clientSigner.encrypt(recipient, plaintext, "nip44");
    pass(test(`nip44_encrypt (${ciphertext.length} chars)`));

    // Decrypt round-trip via backend
    ndkBackend.signer = backendSigner;
    const backendNdkUser = ndkBackend.getUser({ pubkey: clientPubkey });
    const decrypted = await backendSigner.decrypt(backendNdkUser, ciphertext, "nip44");
    if (decrypted === plaintext) {
      pass(test("nip44 decrypt round-trip"));
    } else {
      fail(test("nip44 round-trip — plaintext mismatch"));
    }
  } catch (e) {
    fail(`${test("nip44")} — ${e.message || e}`);
  }

  // sign kind 0
  try {
    const ndkEvent = new NDKEvent(ndkClient, {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name: "Test Bench" }),
      pubkey: pk,
    });
    await ndkEvent.sign(clientSigner);
    const signed = ndkEvent.rawEvent();
    const pool = new SimplePool();
    const pubs = await Promise.allSettled(pool.publish(RELAYS, signed));
    const ok = pubs.filter((p) => p.status === "fulfilled").length;
    pass(test(`kind 0 signed + published to ${ok}/${pubs.length} relays`));
  } catch (e) {
    fail(`${test("kind 0")} — ${e.message || e}`);
  }

  clientSigner.stop();
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  hr();
  log("NDK NIP-46 Test Bench (with patches)");
  log(`Relays: ${RELAYS.join(", ")}`);
  hr();

  const start = Date.now();

  try {
    // Suite A: Secret echo (standard)
    await testPairingSecretEcho();

    // Suite B: "ack" response (Primal-style) — THE KEY TEST
    await testPairingAck();

    // Suite C: Full flow with ack pairing
    await testFullSigningFlow();
  } catch (e) {
    log(`\n  FATAL: ${e.message}`);
    console.error(e);
  }

  hr();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`Results: ${results.passed} passed, ${results.failed} failed (${elapsed}s)`);
  hr();

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
