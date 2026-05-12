/**
 * nostr-connect-signer.ts
 *
 * Clean NIP-46 nostrconnect signer for legion-chat.
 * Replaces the patched @nostr-wot/signers dependency.
 *
 * Follows NDK's exact flow from the nostr-mail-client reference:
 *   - Pairing: nostrconnect:// URI, secret matching, ACK after EOSE
 *   - Persistent sub: authors-only filter (NO #p tag)
 *   - RPCs: pending registered BEFORE publish (race-safe)
 *   - EOSE gate: RPCs wait for subscription readiness
 */

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { nsecEncode, decode as nip19Decode } from "nostr-tools/nip19";
import { nip44 } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import type { Event, EventTemplate } from "nostr-tools";

// ── Types ─────────────────────────────────────────────────────────────

/** A fully-signed Nostr event. */
export type NostrEvent = Event;

interface PendingEntry {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Options for the nostrconnect:// pairing flow. */
export interface NostrConnectOpts {
  relays: string[];
  metadata?: { name?: string; url?: string; description?: string; image?: string };
  perms?: string;
  onAuthChallenge?: (url: string) => void;
  /** Time budget waiting for the bunker to scan + connect. Default 5 min. */
  pairTimeoutMs?: number;
  /** Max time for a single RPC response. Default 30 s. */
  requestTimeoutMs?: number;
}

/** Handle returned by startNostrConnect — render uri as QR, await ready. */
export interface NostrConnectHandle {
  /** The nostrconnect:// URI — render as QR for the bunker to scan. */
  uri: string;
  /** The ephemeral client pubkey (advertised in the URI). */
  clientPubkey: string;
  /** Cancel an in-progress pairing. */
  cancel: () => void;
  /** Resolves with the paired signer once the bunker scans and connects. */
  ready: Promise<NostrConnectSigner>;
  /** Refresh the subscription after app resumes from background. */
  refreshSubscription?: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_PAIR_TIMEOUT = 5 * 60_000;
const KIND_BUNKER = 24133;

// ── Helpers ───────────────────────────────────────────────────────────

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ── NostrConnectSigner ────────────────────────────────────────────────

export class NostrConnectSigner {
  #relays: string[];
  #clientSk: Uint8Array;
  #bunkerPk: string;
  #pool: SimplePool;
  #pending: Map<string, PendingEntry>;
  #subCloser: { close: () => void } | null = null;
  #eosePromise!: Promise<void>;
  #eoseResolve: (() => void) | null = null;
  #eoseTimer: ReturnType<typeof setTimeout> | null = null;
  #onAuthChallenge?: (url: string) => void;
  #requestTimeout: number;
  #wakeLock: { release: () => void } | null = null;
  #closed = false;
  #realPubkeyPromise: Promise<string | null> = Promise.resolve(null);

  // ── Wake Lock (keeps tab alive on mobile during RPCs) ──────────────

  /** Request a screen wake lock or start silent audio to prevent iOS/Android
   *  from suspending the tab while waiting for RPC responses. */
  async #acquireWakeLock(): Promise<void> {
    if (this.#wakeLock) return; // already held
    console.log("[NIP-46] wake-lock: acquiring...");

    // Try Screen Wake Lock API first (Chrome Android, Safari 16.4+)
    if ("wakeLock" in navigator) {
      try {
        const lock = await (navigator as any).wakeLock.request("screen");
        this.#wakeLock = {
          release: () => {
            lock.release();
            console.log("[NIP-46] wake-lock: screen wake lock released");
          },
        };
        console.log("[NIP-46] wake-lock: screen wake lock acquired");
        return;
      } catch { /* fall through to audio */ }
    }

    // Fallback: silent audio (works on iOS Safari)
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0; // silent
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      this.#wakeLock = {
        release: () => {
          osc.stop();
          ctx.close();
          console.log("[NIP-46] wake-lock: silent audio released");
        },
      };
      console.log("[NIP-46] wake-lock: silent audio acquired");
    } catch (e: any) {
      console.log("[NIP-46] wake-lock: failed:", e.message);
    }
  }

  #releaseWakeLock(): void {
    if (this.#wakeLock) {
      this.#wakeLock.release();
      this.#wakeLock = null;
    }
  }

  // ── Constructor (private — use static factories) ──────────────────

  private constructor(
    bunkerPk: string,
    clientSk: Uint8Array,
    relays: string[],
    pool: SimplePool,
    onAuthChallenge?: (url: string) => void,
    requestTimeout = DEFAULT_REQUEST_TIMEOUT,
  ) {
    this.#relays = relays;
    this.#clientSk = clientSk;
    this.#bunkerPk = bunkerPk;
    this.#pool = pool;
    this.#pending = new Map();
    this.#onAuthChallenge = onAuthChallenge;
    this.#requestTimeout = requestTimeout;

    this.#resetEoseGate();
  }

  // ── Public getters ────────────────────────────────────────────────

  /** The bunker's pubkey after pairing. */
  get bunkerPubkey(): string {
    return this.#bunkerPk;
  }

  /** The client's nsec for session persistence. */
  get clientNsec(): string {
    return nsecEncode(this.#clientSk);
  }

  /** Alias for clientNsec (backwards compat with existing App.tsx). */
  exportClientNsec(): string {
    return this.clientNsec;
  }

  // ── RPC methods ───────────────────────────────────────────────────

  /** Send get_public_key RPC to the bunker. */
  async getPublicKey(): Promise<string> {
    return this.#rpc("get_public_key", []);
  }

  /** Send connect RPC to the bunker (for re-establishing sessions). */
  async sendConnect(params: string[]): Promise<string> {
    return this.#rpc("connect", params);
  }

  /** Get the user's real Nostr pubkey. Fires during pairing's 1s window. */
  async getRealPubkey(): Promise<string | null> {
    return this.#realPubkeyPromise;
  }

  /**
   * Send sign_event RPC to the bunker.
   *
   * The event template is sent as-is (no pubkey added) — the bunker
   * knows the user's key from the pairing session.
   */
  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    console.log("[NIP-46] signEvent called, kind:", event.kind, "bunker:", this.#bunkerPk?.slice(0,12));
    const result = await this.#rpc("sign_event", [JSON.stringify(event)]);
    const signed = JSON.parse(result) as NostrEvent;
    console.log("[NIP-46] signEvent result, id:", signed.id?.slice(0,12));
    return signed;
  }

  /** Send nip44_encrypt RPC to the bunker. */
  async nip44Encrypt(targetPk: string, plaintext: string): Promise<string> {
    return this.#rpc("nip44_encrypt", [targetPk, plaintext]);
  }

  /** Send nip44_decrypt RPC to the bunker. */
  async nip44Decrypt(targetPk: string, ciphertext: string): Promise<string> {
    return this.#rpc("nip44_decrypt", [targetPk, ciphertext]);
  }

  // ── Subscription management ───────────────────────────────────────

  /** Close old sub, open fresh one (for mobile visibilitychange). */
  async refreshSubscription(): Promise<void> {
    // When resuming from background, poll for responses to pending RPCs FIRST.
    // The bunker may have responded while we were backgrounded.
    if (this.#pending.size > 0) {
      console.log("[NIP-46] refreshSubscription:", this.#pending.size, "pending RPCs — polling for responses");
      const clientPk = getPublicKey(this.#clientSk);
      await this.#pollForAllPending(clientPk);
      // If all pending resolved, continue to refresh
      if (this.#pending.size > 0) {
        console.log("[NIP-46] refreshSubscription: still", this.#pending.size, "pending — refreshing sub anyway");
      }
    }
    this.#openSubscription();
  }

  /** Tear down the subscription and reject all pending requests. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#releaseWakeLock();
    this.#subCloser?.close();
    this.#subCloser = null;
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Signer closed"));
    }
    this.#pending.clear();
  }

  // ── Static factories ──────────────────────────────────────────────

  /**
   * Start a nostrconnect:// pairing flow.
   *
   * Returns `{ uri, ready }` — render `uri` as a QR code or deep link;
   * `ready` resolves with the fully-paired signer once the bunker scans.
   *
   * Flow (from NDK bunkers.dart connectWithNostrConnect):
   *  1. Generate random client keypair
   *  2. Generate random secret (32 hex chars)
   *  3. Build nostrconnect URI
   *  4. Subscribe with { kinds: [24133], "#p": [clientPk], since: now-300 }
   *  5. Wait for event where decrypted result === secret
   *  6. Bunker pubkey = event.pubkey
   *  7. Close pairing subscription
   *  8. Open persistent subscription: { kinds: [24133], authors: [bunkerPk] }
   *     (NO #p filter — NDK only filters by authors)
   *  9. Wait for EOSE on persistent subscription
   * 10. Send ACK for the pairing event
   * 11. Done — paired, RPCs ready
   */
  static startNostrConnect(opts: NostrConnectOpts): NostrConnectHandle {
    // Step 1: Generate random client keypair
    const clientSk = generateSecretKey();
    const clientPk = getPublicKey(clientSk);
    const pool = new SimplePool();

    // Step 2: Generate random secret (32 hex chars = 16 bytes)
    const secret = randomHex(16);
    const requestTimeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT;
    const pairTimeout = opts.pairTimeoutMs ?? DEFAULT_PAIR_TIMEOUT;

    // Step 3: Build nostrconnect URI (NIP-46 spec format)
    const params = new URLSearchParams();
    for (const r of opts.relays) params.append("relay", r);
    params.set("secret", secret);
    if (opts.perms) params.set("perms", opts.perms);
    if (opts.metadata?.name) params.set("name", opts.metadata.name);
    if (opts.metadata?.url) params.set("url", opts.metadata.url);
    if (opts.metadata?.image) params.set("image", opts.metadata.image);

    const uri = `nostrconnect://${clientPk}?${params.toString()}`;
    console.log("[NIP-46] nostrconnect URI:", uri);

    // Mutable state for the pairing flow
    let cancelled = false;
    let pairResolve: ((s: NostrConnectSigner) => void) | null = null;
    let pairReject: ((e: Error) => void) | null = null;
    let signerRef: NostrConnectSigner | null = null;

    const ready = new Promise<NostrConnectSigner>((resolve, reject) => {
      pairResolve = resolve;
      pairReject = reject;
    });

    // Pairing timeout
    const timer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      pairSub?.close();
      pairReject?.(new Error("NIP-46 pairing timed out"));
    }, pairTimeout);

    // Step 4: Pairing subscription with 5-min lookback
    const now = Math.floor(Date.now() / 1000);
    const pairFilter = {
      kinds: [KIND_BUNKER],
      "#p": [clientPk],
      since: now - 300,
    };
    console.log("[NIP-46] pairing sub: relays:", opts.relays, "filter:", JSON.stringify(pairFilter));
    const pairSub = pool.subscribeMany(
      opts.relays,
      pairFilter,
      {
        onevent: async (event: Event) => {
          if (cancelled) return;

          try {
            // Decrypt — we don't know bunkerPk yet, try with event.pubkey
            const conv = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
            const payload = nip44.v2.decrypt(event.content, conv);
            const parsed = JSON.parse(payload);

            // Step 5: result === secret ?
            if (parsed.result === secret) {
              cancelled = true;
              clearTimeout(timer);

              // Step 7: Close pairing subscription
              pairSub?.close();

              // Step 6: Bunker pubkey = event.pubkey
              const bunkerPk = event.pubkey;

              try {
                // Create signer instance
                const signer = new NostrConnectSigner(
                  bunkerPk,
                  clientSk,
                  opts.relays,
                  pool,
                  opts.onAuthChallenge,
                  requestTimeout,
                );

                // Open persistent subscription FIRST — needed before RPCs can work
                signer.#openSubscription();

                // ── NIP-46 spec flow (nostrconnect://) ──
                // After pairing, client MUST:
                // 1. Send `connect` RPC → establishes session in bunker
                // 2. Send `get_public_key` → learn user's real pubkey
                // Without step 1, the bunker has no active session and drops all RPCs.

                // Step 1: connect RPC — [remote-signer-pubkey, secret, perms]
                console.log("[NIP-46] sending connect RPC to establish session...");
                const connectPromise = signer.#rpc("connect", [bunkerPk, secret, opts.perms || ""])
                  .then((result: string) => {
                    console.log("[NIP-46] connect RPC response:", result);
                    return result;
                  })
                  .catch((e: any) => {
                    console.log("[NIP-46] connect RPC failed:", e.message);
                    return null;
                  });

                // Step 2: get_public_key — fires AFTER connect resolves
                signer.#realPubkeyPromise = connectPromise.then(async (_connectResult: string | null) => {
                  console.log("[NIP-46] connect done, now sending get_public_key...");
                  try {
                    const pk = await signer.#rpc("get_public_key", []);
                    console.log("[NIP-46] get_public_key returned:", pk?.slice(0,12));
                    return pk;
                  } catch (e: any) {
                    console.log("[NIP-46] get_public_key failed:", e.message);
                    return null;
                  }
                });

                console.log("[NIP-46] connect RPC fired inside pairing handler");

                // Send ACK (non-blocking — fire and forget)
                if (parsed.id) {
                  signer.#sendAck(bunkerPk, parsed.id).catch(() => {});
                }

                // NOW resolve — App.tsx's .then() will await getRealPubkey()
                signerRef = signer;
                pairResolve?.(signer);
              } catch (err) {
                // Pairing setup failed (subscription error, etc.)
                pairReject?.(
                  err instanceof Error ? err : new Error(String(err)),
                );
              }
            }
          } catch {
            // Decryption failed or JSON parse error — not for us, ignore
          }
        },
        oneose: () => {
          // Keep listening — the bunker hasn't scanned yet
        },
      },
    );

    return {
      uri,
      clientPubkey: clientPk,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(timer);
        pairSub?.close();
        pairReject?.(new Error("NIP-46 pairing cancelled"));
      },
      get ready() {
        return ready;
      },
      get refreshSubscription():
        | (() => void)
        | undefined {
        return signerRef
          ? () => signerRef!.refreshSubscription()
          : undefined;
      },
    };
  }

  /**
   * Connect using a bunker URI (`bunker://<pubkey>?relay=...&secret=...`).
   *
   * The bunker-initiated flow: the user pastes a bunker:// URI.
   * We parse the pubkey + relays + secret, open a subscription,
   * then send a `connect` RPC to the bunker.
   */
  static async fromBunkerUri(
    uri: string,
    opts?: Partial<NostrConnectOpts> & { clientSecretKey?: Uint8Array | string },
  ): Promise<NostrConnectSigner> {
    const url = new URL(uri);
    if (url.protocol !== "bunker:") throw new Error(`Expected bunker:// URI, got ${url.protocol}`);

    const bunkerPk = url.hostname || url.pathname.replace(/^\/\//, "");
    const relayParams = url.searchParams.getAll("relay");
    const secret = url.searchParams.get("secret") || undefined;

    if (!bunkerPk) throw new Error("bunker:// URI missing pubkey");
    if (relayParams.length === 0) throw new Error("bunker:// URI missing relay param");

    const relays = relayParams;
    const clientSk = opts?.clientSecretKey
      ? (typeof opts.clientSecretKey === "string"
          ? (nip19Decode(opts.clientSecretKey).data as Uint8Array)
          : opts.clientSecretKey)
      : generateSecretKey();

    const pool = new SimplePool();
    const signer = new NostrConnectSigner(
      bunkerPk, clientSk, relays, pool,
      opts?.onAuthChallenge,
      opts?.requestTimeoutMs,
    );

    // Open persistent subscription before sending connect
    signer.#openSubscription();

    // Send connect RPC via the instance's private method
    const connectParams = [secret || ""];
    if (opts?.metadata?.name) connectParams.push(JSON.stringify(opts.metadata));

    await (signer as any).rpc("connect", connectParams);
    return signer;
  }

  /**
   * Restore a signer from a saved session (no re-pairing needed).
   *
   * The bunker already knows this client from a previous pairing.
   * Opens the persistent subscription immediately; RPCs will
   * internally wait for EOSE before firing.
   */
  static fromSavedSession(
    bunkerPk: string,
    clientNsec: string,
    relays: string[],
  ): NostrConnectSigner {
    const decoded = nip19Decode(clientNsec);
    if (decoded.type !== "nsec") {
      throw new Error(`Expected nsec, got ${decoded.type}`);
    }
    const clientSk = decoded.data as Uint8Array;

    const signer = new NostrConnectSigner(bunkerPk, clientSk, relays, new SimplePool());
    signer.#openSubscription();
    return signer;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Reset the EOSE gate (called when opening a new subscription). */
  #resetEoseGate(): void {
    if (this.#eoseTimer) {
      clearTimeout(this.#eoseTimer);
      this.#eoseTimer = null;
    }
    this.#eosePromise = new Promise<void>((resolve) => {
      this.#eoseResolve = resolve;
    });
  }

  /**
   * Open the persistent subscription.
   *
   * Filter: `{ kinds: [24133], authors: [bunkerPk] }` — NO `#p` tag.
   * This matches NDK's behavior and avoids missing events on relays
   * that don't index ephemeral events by `#p`.
   *
   * Also sets a 10 s EOSE timeout so RPCs don't hang forever if
   * a relay is unreachable.
   */
  #openSubscription(): void {
    // Close existing subscription
    this.#subCloser?.close();

    // Reset EOSE gate
    this.#resetEoseGate();

    // Safety timeout — if no EOSE arrives in 10 s, ungate RPCs anyway
    this.#eoseTimer = setTimeout(() => {
      this.#eoseResolve?.();
    }, 10_000);

    const clientPk = getPublicKey(this.#clientSk); // returns hex string
    const filter = {
      kinds: [KIND_BUNKER],
      authors: [this.#bunkerPk],
      "#p": [clientPk],
      // Match NDK exactly: authors + #p, NO since filter.
    };
    console.log("[NIP-46] #openSubscription: relays:", this.#relays, "filter:", JSON.stringify(filter));

    const closer = this.#pool.subscribeMany(
      this.#relays,
      filter,
      {
        onevent: (event: Event) => {
          console.log("[NIP-46] sub: got event from", event.pubkey.slice(0,12), "created_at:", event.created_at, "tags:", JSON.stringify(event.tags), "content_len:", event.content?.length);
          this.#onMessage(event).catch(() => {});
        },
        oneose: () => {
          console.log("[NIP-46] #openSubscription: EOSE received — subscription ready");
          if (this.#eoseTimer) {
            clearTimeout(this.#eoseTimer);
            this.#eoseTimer = null;
          }
          this.#eoseResolve?.();
        },
      },
    );

    this.#subCloser = closer;
  }

  /**
   * Handle an incoming event on the persistent subscription.
   *
   * From NDK nip46_event_signer.dart onMessage / _pendingRequests:
   *  1. Decrypt event content with nip44 using client secret key
   *  2. Parse JSON: { id, result, error }
   *  3. Look up pending by id — if no match, silently drop (stale)
   *  4. If error: reject pending
   *  5. If result: resolve pending
   */
  async #onMessage(event: Event): Promise<void> {
    // Step 1: Decrypt
    let payload: string;
    try {
      const conv = nip44.v2.utils.getConversationKey(
        this.#clientSk,
        this.#bunkerPk,
      );
      payload = nip44.v2.decrypt(event.content, conv);
    } catch {
      console.log("[NIP-46] #onMessage: decrypt failed from", event.pubkey.slice(0,12));
      return; // Can't decrypt — not for us
    }

    // Step 2: Parse
    let parsed: { id?: string; result?: string; error?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      console.log("[NIP-46] #onMessage: parse failed");
      return;
    }

    if (!parsed.id) {
      console.log("[NIP-46] #onMessage: no id, dropping");
      return;
    }

    // Step 3: Look up pending
    const pending = this.#pending.get(parsed.id);
    if (!pending) {
      console.log("[NIP-46] #onMessage: no pending for id", parsed.id.slice(0,8), "result:", parsed.result?.slice(0,20), "error:", parsed.error, "(pending:", this.#pending.size, "ids:", [...this.#pending.keys()].map(k => k.slice(0,8)).join(","), ")");
      return; // Stale — silently drop
    }

    console.log("[NIP-46] #onMessage: matched id", parsed.id.slice(0,8), "result:", parsed.result?.slice(0,30), "error:", parsed.error);

    // Auth URL challenge: surface to user, keep request pending
    if (parsed.result === "auth_url" && parsed.error) {
      try {
        this.#onAuthChallenge?.(parsed.error);
      } catch {}
      return; // Don't resolve — wait for the real response or timeout
    }

    this.#pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (this.#pending.size === 0) this.#releaseWakeLock();

    // Step 4-5: Resolve or reject
    if (parsed.error) {
      pending.reject(new Error(parsed.error));
    } else {
      pending.resolve(parsed.result ?? "");
    }
  }

  /**
   * Send an RPC request to the bunker.
   *
   * From NDK nip46_event_signer.dart remoteRequest:
   *  1. Generate random request ID (8 bytes hex)
   *  2. Build request: { method, params }
   *  3. Encrypt with nip44 to bunker's pubkey
   *  4. Create kind 24133 event with #p tag = bunkerPk
   *  5. Register pending promise BEFORE publishing (race-safe)
   *  6. Publish to all relays
   *  7. Return promise that resolves when response with matching ID arrives
   */
  async #rpc(method: string, params: string[]): Promise<string> {
    if (this.#closed) throw new Error("Signer closed");

    // EOSE gate — skip during the initial pairing window.
    // The bunker is only alive for ~1 second; waiting for EOSE burns that window.
    // The pairing subscription is already running and will deliver responses.
    if (!this.#bunkerPk) {
      // Not yet paired — must wait for pairing to complete
      await this.#eosePromise;
    }
    console.log("[NIP-46] #rpc: eose gate passed for", method);

    if (!this.#bunkerPk) {
      throw new Error("NIP-46 signer is not paired (no bunker pubkey)");
    }

    // Step 1: Random request ID
    const id = randomHex(8); // 16 hex chars

    // Step 2: Build request payload
    const payload = JSON.stringify({ id, method, params });

    // Step 3: Encrypt with nip44
    const conv = nip44.v2.utils.getConversationKey(
      this.#clientSk,
      this.#bunkerPk,
    );
    const ciphertext = nip44.v2.encrypt(payload, conv);

    // Step 4: Create kind 24133 event
    const reqEvent = finalizeEvent(
      {
        kind: KIND_BUNKER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.#bunkerPk]],
        content: ciphertext,
      },
      this.#clientSk,
    );

    // Step 5: Register pending BEFORE publish (race condition prevention)
    // Primal's bunker uses HTTP polling + push notifications — the app may be
    // backgrounded. Retry the RPC every 15s for up to 5 minutes to give the
    // push notification time to wake the app and process the request.
    // Also poll via querySync as a fallback — relays may not persist 24133
    // events, but the real-time subscription can miss events on WebSocket reconnect.
    // Acquire wake lock to keep tab alive on mobile while waiting.
    this.#acquireWakeLock();
    const INITIAL_TIMEOUT = 15_000; // 15s per attempt
    const MAX_TOTAL = 300_000;      // 5 min total (bunker may need push notification to wake app)
    const startTime = Date.now();
    let attempt = 0;
    const clientPk = getPublicKey(this.#clientSk);

    const promise = new Promise<string>((resolve, reject) => {
      const scheduleRetry = () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= MAX_TOTAL) {
          this.#pending.delete(id);
          if (this.#pending.size === 0) this.#releaseWakeLock();
          reject(
            new Error(
              `NIP-46 ${method} timed out after ${elapsed}ms (${attempt} attempts)`,
            ),
          );
          return;
        }

        attempt++;
        const remaining = MAX_TOTAL - (Date.now() - startTime);
        const timeout = Math.min(INITIAL_TIMEOUT, remaining);
        console.log(`[NIP-46] #rpc: ${method} attempt ${attempt}, waiting ${timeout}ms (elapsed: ${elapsed}ms)`);

        const timer = setTimeout(async () => {
          // Check if response arrived via polling fallback
          const polled = await this.#pollForResponse(clientPk, method, id);
          if (polled) {
            console.log(`[NIP-46] #rpc: ${method} got response via poll!`);
            this.#pending.delete(id);
            resolve(polled);
            return;
          }

          // No response yet — re-publish to relays (bunker may have missed it)
          this.#replayRpc(reqEvent, method, attempt);
          scheduleRetry();
        }, timeout);

        this.#pending.set(id, { resolve, reject, timer });
      };
      scheduleRetry();
    });

    // Step 6: Publish to all relays
    console.log("[NIP-46] #rpc: publishing", method, "id:", id, "to relays:", this.#relays, "event id:", reqEvent.id?.slice(0,12), "event pubkey:", reqEvent.pubkey?.slice(0,12), "tags:", JSON.stringify(reqEvent.tags), "pending:", this.#pending.size);
    const pubResults = await Promise.allSettled(this.#pool.publish(this.#relays, reqEvent));
    const pubSummary = pubResults.map((r, i) => {
      const relay = this.#relays[i]?.split("//")[1] || i;
      if (r.status === "fulfilled") return `${relay}:ok`;
      const msg = r.reason?.message || String(r.reason);
      return `${relay}:FAIL(${msg.slice(0,40)})`;
    });
    const okCount = pubResults.filter(r => r.status === "fulfilled").length;
    console.log(`[NIP-46] #rpc: publish: ${okCount}/${pubResults.length} ok —`, pubSummary);

    // Step 7: Return promise
    return promise;
  }

  /**
   * Poll relays via querySync for responses to ALL pending RPCs.
   * Called on page resume from background — catches responses that arrived
   * while the WebSocket subscription was dead.
   */
  async #pollForAllPending(clientPk: string): Promise<void> {
    try {
      const events = await this.#pool.querySync(this.#relays, {
        kinds: [KIND_BUNKER],
        authors: [this.#bunkerPk],
        "#p": [clientPk],
        limit: 20,
      });
      if (events.length === 0) return;

      console.log(`[NIP-46] #pollAll: found ${events.length} bunker events`);
      const conv = nip44.v2.utils.getConversationKey(this.#clientSk, this.#bunkerPk);

      for (const event of events) {
        try {
          const plaintext = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(plaintext);
          const entry = this.#pending.get(parsed.id);
          if (entry) {
            console.log(`[NIP-46] #pollAll: resolved pending ${parsed.id?.slice(0,12)} result=${parsed.result?.slice(0,20)}`);
            clearTimeout(entry.timer);
            this.#pending.delete(parsed.id);
            if (parsed.error) {
              entry.reject(new Error(`NIP-46 error: ${parsed.error}`));
            } else {
              entry.resolve(parsed.result);
            }
          }
        } catch { /* skip unparseable */ }
      }
    } catch (e: any) {
      console.log(`[NIP-46] #pollAll: error: ${e.message}`);
    }
  }

  /** Re-publish an RPC event to relays (for retry when bunker doesn't respond). */
  #replayRpc(reqEvent: Event, method: string, attempt: number) {
    console.log(`[NIP-46] #rpc: re-publishing ${method} (attempt ${attempt})`);
    Promise.allSettled(this.#pool.publish(this.#relays, reqEvent)).then(results => {
      const summary = results.map(r => r.status === "fulfilled" ? "ok" : "fail");
      console.log(`[NIP-46] #rpc: re-publish results (attempt ${attempt}):`, summary);
    });
  }

  /**
   * Poll relays via querySync for a response to an RPC.
   * Fallback for when the real-time subscription misses events.
   */
  async #pollForResponse(clientPk: string, method: string, rpcId: string): Promise<string | null> {
    try {
      const events = await this.#pool.querySync(this.#relays, {
        kinds: [KIND_BUNKER],
        authors: [this.#bunkerPk],
        "#p": [clientPk],
        limit: 5,
      });
      if (events.length === 0) return null;

      console.log(`[NIP-46] #poll: found ${events.length} events from bunker`);
      const conv = nip44.v2.utils.getConversationKey(this.#clientSk, this.#bunkerPk);

      for (const event of events) {
        try {
          const plaintext = nip44.v2.decrypt(event.content, conv);
          const parsed = JSON.parse(plaintext);
          console.log(`[NIP-46] #poll: decrypted event id=${parsed.id?.slice(0,12)} result=${parsed.result?.slice(0,20)} error=${parsed.error}`);
          if (parsed.id === rpcId && parsed.result !== undefined) {
            return parsed.result;
          }
        } catch { /* skip unparseable */ }
      }
    } catch (e: any) {
      console.log(`[NIP-46] #poll: error: ${e.message}`);
    }
    return null;
  }

  /**
   * Send an ACK response back to the bunker after pairing.
   *
   * The content is nip44-encrypted JSON: { id, result: "ack" }.
   */
  async #sendAck(bunkerPk: string, id: string): Promise<void> {
    const payload = JSON.stringify({ id, result: "ack" });
    const conv = nip44.v2.utils.getConversationKey(this.#clientSk, bunkerPk);
    const ciphertext = nip44.v2.encrypt(payload, conv);

    const ackEvent = finalizeEvent(
      {
        kind: KIND_BUNKER,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bunkerPk]],
        content: ciphertext,
      },
      this.#clientSk,
    );

    await Promise.allSettled(this.#pool.publish(this.#relays, ackEvent));
  }
}
