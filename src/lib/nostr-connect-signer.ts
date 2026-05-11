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
  metadata?: { name?: string; url?: string; description?: string };
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

  /**
   * Send sign_event RPC to the bunker.
   *
   * The event template is sent as-is (no pubkey added) — the bunker
   * knows the user's key from the pairing session.
   */
  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    const result = await this.#rpc("sign_event", [JSON.stringify(event)]);
    return JSON.parse(result) as NostrEvent;
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
  refreshSubscription(): void {
    this.#openSubscription();
  }

  /** Tear down the subscription and reject all pending requests. */
  async close(): Promise<void> {
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

    // Step 3: Build nostrconnect URI
    const params = new URLSearchParams();
    for (const r of opts.relays) params.append("relay", r);
    params.set("secret", secret);
    if (opts.perms) params.set("perms", opts.perms);
    if (opts.metadata) params.set("metadata", JSON.stringify(opts.metadata));

    const uri = `nostrconnect://${clientPk}?${params.toString()}`;

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
    const pairSub = pool.subscribeMany(
      opts.relays,
      {
        kinds: [KIND_BUNKER],
        "#p": [clientPk],
        since: now - 300,
      },
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

                // Step 8: Persistent subscription — NO #p filter
                signer.#openSubscription();

                // Step 9: Wait for EOSE
                await signer.#eosePromise;

                // Step 10: Send ACK
                if (parsed.id) {
                  await signer.#sendAck(bunkerPk, parsed.id);
                }

                // Step 11: Done
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

    const closer = this.#pool.subscribeMany(
      this.#relays,
      {
        kinds: [KIND_BUNKER],
        authors: [this.#bunkerPk],
        "#p": [getPublicKey(this.#clientSk)],
      },
      {
        onevent: (event: Event) => {
          this.#onMessage(event).catch(() => {});
        },
        oneose: () => {
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
    console.log("[NIP-46] #onMessage: from", event.pubkey.slice(0,12), "pending:", this.#pending.size);
    // Step 1: Decrypt
    let payload: string;
    try {
      const conv = nip44.v2.utils.getConversationKey(
        this.#clientSk,
        this.#bunkerPk,
      );
      payload = nip44.v2.decrypt(event.content, conv);
    } catch {
      return; // Can't decrypt — not for us
    }

    // Step 2: Parse
    let parsed: { id?: string; result?: string; error?: string };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    if (!parsed.id) return;

    // Step 3: Look up pending
    const pending = this.#pending.get(parsed.id);
    if (!pending) return; // Stale — silently drop

    // Auth URL challenge: surface to user, keep request pending
    if (parsed.result === "auth_url" && parsed.error) {
      try {
        this.#onAuthChallenge?.(parsed.error);
      } catch {}
      return; // Don't resolve — wait for the real response or timeout
    }

    this.#pending.delete(parsed.id);
    clearTimeout(pending.timer);

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
    // EOSE gate — don't send RPCs before the subscription is ready
    await this.#eosePromise;
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
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `NIP-46 ${method} timed out after ${this.#requestTimeout}ms (pending was ${this.#pending.size})`,
          ),
        );
      }, this.#requestTimeout);
      this.#pending.set(id, { resolve, reject, timer });
    });

    // Step 6: Publish to all relays
    console.log("[NIP-46] #rpc: publishing", method, "id:", id, "to relays:", this.#relays, "event id:", reqEvent.id?.slice(0,12), "pending:", this.#pending.size);
    const pubResults = await Promise.allSettled(this.#pool.publish(this.#relays, reqEvent));
    const pubSummary = pubResults.map(r => r.status === "fulfilled" ? "ok" : r.reason?.message?.slice(0,50));
    console.log("[NIP-46] #rpc: publish results:", pubSummary);

    // Step 7: Return promise
    return promise;
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
