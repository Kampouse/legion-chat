import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { NearWalletProvider, useNearWallet } from "./lib/NearWalletContext";
import { checkSbt, sendBindingTx } from "./lib/near";
import {
  fetchBinding,
  fetchAllBindingsCached,
  fetchAllBindingsRefresh,
  type BindingCache,
} from "./lib/binding";
import {
  hasNostrExtension,
  createNip07Signer,
  createNip46Signer,
  createPrivateKeySigner,
  generateKeys,
  getPubkey,
  signChallenge,
  signChannelMessage,
  signProfileUpdate,
  type NostrProfile,
  connectRelayAsync,
  subscribeChannel,
  publishWithAck,
  type NostrSigner,
  type Relay,
  type ConnectionState,
} from "./lib/nostr";
import { DEFAULT_RELAY, CHANNEL_ID } from "./lib/constants";

type Screen = "login" | "checking" | "no-sbt" | "bind" | "binding" | "chat";

interface Message {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  sender?: string;
  pending?: boolean;
  failed?: boolean;
}

interface Profile {
  name?: string;
  picture?: string;
  display_name?: string;
  about?: string;
  nip05?: string;
}

function parseContent(content: string) {
  const segments: { type: "text" | "link"; value: string }[] = [];
  const linkRe = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(content)) !== null) {
    if (m.index > last) segments.push({ type: "text", value: content.slice(last, m.index) });
    segments.push({ type: "link", value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: "text", value: content.slice(last) });
  return segments;
}

function ParsedContent({ content }: { content: string }) {
  const segments = useMemo(() => parseContent(content), [content]);
  return (
    <>
      {segments.map((s, i) =>
        s.type === "link" ? (
          <a key={i} href={s.value} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: "var(--accent)" }}>{s.value}</a>
        ) : (
          <span key={i}>{s.value}</span>
        )
      )}
    </>
  );
}

function timeLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function connectionDot(state: ConnectionState): { color: string; label: string } {
  switch (state) {
    case "connected": return { color: "#00ec97", label: "Connected" };
    case "connecting": return { color: "#fbbf24", label: "Connecting..." };
    case "disconnected": return { color: "#ef4444", label: "Disconnected" };
    case "error": return { color: "#ef4444", label: "Connection error" };
  }
}

function ChatApp() {
  const wallet = useNearWallet();
  const [screen, setScreen] = useState<Screen>("login");
  const [error, setError] = useState<string>("");

  const [_signerType, setSignerType] = useState<string | null>(null);
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  const [myPubkey, setMyPubkey] = useState<string>("");
  const [nsec, setNsec] = useState<string>("");
  const [bunkerUri, setBunkerUri] = useState<string>("");
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [connState, setConnState] = useState<ConnectionState>("disconnected");

  const relayRef = useRef<Relay | null>(null);
  const bindingsRef = useRef<BindingCache | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editProfile, setEditProfile] = useState<NostrProfile | null>(null);

  const accountId = wallet.accountId || null;

  useEffect(() => {
    if (wallet.isConnected && accountId) setScreen("checking");
  }, [wallet.isConnected, accountId]);

  useEffect(() => {
    if (screen !== "checking" || !accountId) return;
    (async () => {
      const hasSbt = await checkSbt(accountId);
      if (!hasSbt) { setScreen("no-sbt"); return; }
      const existing = await fetchBinding(accountId);
      if (!existing) { setScreen("bind"); return; }
      setMyPubkey(existing.npub);
      setRelayUrl(existing.relay || DEFAULT_RELAY);
      const savedSigner = localStorage.getItem(`legion:signer:${accountId}`);
      if (savedSigner) {
        try {
          const parsed = JSON.parse(savedSigner);
          if (parsed.type === "bunker" && parsed.uri) {
            const s = await createNip46Signer(parsed.uri, (url) => { window.open(url, "_blank"); });
            const pk = await s.getPublicKey();
            if (pk === existing.npub) {
              setSigner(s); setSignerType("bunker"); setScreen("chat"); return;
            }
          } else if (parsed.type === "local" && parsed.nsec) {
            const s = createPrivateKeySigner(parsed.nsec);
            const pk = await s.getPublicKey();
            if (pk === existing.npub) {
              setNsec(parsed.nsec);
              setSigner(s); setSignerType("local"); setScreen("chat"); return;
            }
          }
        } catch (e: any) {
          console.warn("Failed to restore signer:", e.message);
        }
      }
      if (hasNostrExtension()) {
        try {
          const s = createNip07Signer();
          const pk = await s.getPublicKey();
          if (pk === existing.npub) {
            setSigner(s); setSignerType("extension"); setScreen("chat"); return;
          }
        } catch {}
      }
      setScreen("bind");
    })();
  }, [screen, accountId]);

  // ── Chat: connect relay, load bindings, subscribe ──
  useEffect(() => {
    if (screen !== "chat" || !accountId) return;
    let unsub: (() => void) | undefined;
    let closed = false;

    const init = async () => {
      try {
        const cache = await fetchAllBindingsCached();
        if (closed) return;
        bindingsRef.current = cache;
        fetchAllBindingsRefresh().then((fresh) => { if (!closed) bindingsRef.current = fresh; });

        const relay = await connectRelayAsync(relayUrl, setConnState);
        if (closed) { try { relay.close(); } catch {} return; }
        relayRef.current = relay;

        // Fetch profiles
        const pubkeys = Object.keys(cache.pubkeyIndex);
        if (pubkeys.length > 0) {
          const profileSub = relay.subscribe([{ kinds: [0], authors: pubkeys, limit: pubkeys.length }], {
            onevent: (evt: any) => {
              try {
                const p = JSON.parse(evt.content);
                setProfiles((prev) => ({ ...prev, [evt.pubkey]: p }));
              } catch {}
            },
            oneose: () => {},
          });
          setTimeout(() => { try { profileSub.close(); } catch {} }, 5000);
        }

        // Subscribe to channel
        unsub = subscribeChannel(relay, CHANNEL_ID, (event: any) => {
          const sender = bindingsRef.current?.pubkeyIndex[event.pubkey] || event.pubkey.slice(0, 12) + "...";
          const msg: Message = {
            id: event.id, pubkey: event.pubkey, content: event.content,
            created_at: event.created_at, sender,
          };
          setMessages((prev) => {
            if (prev.some((m) => m.id === msg.id)) return prev;
            return [...prev, msg].sort((a, b) => a.created_at - b.created_at);
          });
        });
      } catch (e: any) {
        if (!closed) setError("Failed to connect: " + (e.message || e));
      }
    };

    init();
    return () => {
      closed = true;
      unsub?.();
      try { relayRef.current?.close(); } catch {}
      relayRef.current = null;
    };
  }, [screen, accountId, relayUrl, signer, myPubkey]);

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setAutoScroll(atBottom);
    setShowScrollBtn(!atBottom);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setAutoScroll(true);
    setShowScrollBtn(false);
  };

  const handleSignIn = () => wallet.connect();

  const doBind = async (s: NostrSigner, npub: string, mode: string) => {
    if (!accountId) return;
    setScreen("binding"); setError("");
    try {
      const allBindings = (await fetchAllBindingsRefresh()).bindings;
      for (const [existingId, binding] of Object.entries(allBindings)) {
        if (binding.npub === npub && existingId !== accountId) {
          setError(`This Nostr key is already bound to ${existingId}`);
          setScreen("bind");
          return;
        }
      }
      const proof = await signChallenge(s, `legion:${accountId}`);
      await sendBindingTx(wallet.signAndSendTransaction, accountId, npub, relayUrl, proof);
      const signerData = mode === "bunker" ? { type: "bunker", uri: bunkerUri } : mode === "local" ? { type: "local", nsec } : { type: "extension" };
      localStorage.setItem(`legion:signer:${accountId}`, JSON.stringify(signerData));
      setSigner(s); setMyPubkey(npub); setSignerType(mode); setScreen("chat");
    } catch (e: any) { setError("Binding failed: " + e.message); setScreen("bind"); }
  };

  const handleBindExtension = async () => {
    try { const s = createNip07Signer(); await doBind(s, await s.getPublicKey(), "extension"); }
    catch (e: any) { setError("Failed: " + e.message); }
  };
  const handleBindBunker = async () => {
    if (!bunkerUri.trim()) return;
    try {
      const s = await createNip46Signer(bunkerUri.trim(), (url) => { window.open(url, "_blank"); });
      await doBind(s, await s.getPublicKey(), "bunker");
    } catch (e: any) { setError("Failed: " + e.message); }
  };
  const handleBindLocal = async () => {
    if (!nsec) return;
    try { const s = createPrivateKeySigner(nsec); await doBind(s, await s.getPublicKey(), "local"); }
    catch (e: any) { setError("Failed: " + e.message); }
  };
  const handleGenerate = () => {
    const keys = generateKeys(); setNsec(keys.sk); setMyPubkey(getPubkey(keys.sk));
  };

  const handleSend = async () => {
    if (!input.trim() || !signer) return;
    const relay = relayRef.current;
    if (!relay || connState !== "connected") {
      setError("Not connected to relay.");
      return;
    }
    const content = input.trim();
    setInput(""); setSending(true); setError("");
    const optimisticId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId, pubkey: myPubkey, content,
      created_at: Math.floor(Date.now() / 1000), sender: accountId!, pending: true,
    };
    setMessages((prev) => [...prev, optimistic].sort((a, b) => a.created_at - b.created_at));
    try {
      const event = await signChannelMessage(signer, content, CHANNEL_ID);
      const result = await publishWithAck(relay, event);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, id: event.id, pending: false, failed: !result.ok } : m))
      );
      if (!result.ok) setError("Message rejected: " + (result.message || "unknown reason"));
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, pending: false, failed: true } : m))
      );
      setError("Send failed: " + e.message);
    }
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSignOut = () => {
    wallet.disconnect(); signer?.close?.();
    setSigner(null); setNsec(""); setMyPubkey(""); setSignerType(null); setMessages([]);
    setProfiles({});
    if (accountId) localStorage.removeItem(`legion:signer:${accountId}`);
    setScreen("login");
  };

  const connInfo = connectionDot(connState);

  return (
    <div className="flex flex-col h-[100dvh]" style={{ backgroundColor: "var(--bg)" }}>
      {screen === "chat" && (
        <header className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}>
          <div className="flex items-center gap-2 max-w-3xl mx-auto w-full">
            <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: connInfo.color }} title={connInfo.label} />
            <span className="font-semibold text-sm">Legion Chat</span>
            <div className="flex-1" />
            <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>{accountId}</span>
            <button onClick={() => setShowSettings(true)} className="text-lg px-2 py-1 rounded" style={{ color: "var(--muted)" }}>⚙️</button>
          </div>
        </header>
      )}
      <main className="flex-1 overflow-hidden">
        {(screen === "login" || screen === "checking" || screen === "no-sbt" || screen === "bind" || screen === "binding") && (
          <div className="flex items-center justify-center h-full max-w-lg mx-auto w-full px-4">
            {screen === "login" && <LoginScreen onSignIn={handleSignIn} />}
            {screen === "checking" && <CheckingScreen />}
            {screen === "no-sbt" && <NoSbtScreen accountId={accountId!} onSignOut={handleSignOut} />}
            {screen === "bind" && (
              <BindScreen
                hasExtension={hasNostrExtension()} nsec={nsec} bunkerUri={bunkerUri}
                relayUrl={relayUrl} error={error}
                onNsecChange={(v) => { setNsec(v); if (v) setMyPubkey(getPubkey(v)); }}
                onBunkerUriChange={setBunkerUri}
                onRelayChange={setRelayUrl} onGenerate={handleGenerate}
                onBindExtension={handleBindExtension} onBindBunker={handleBindBunker}
                onBindLocal={handleBindLocal} onSignOut={handleSignOut}
              />
            )}
            {screen === "binding" && <BindingScreen />}
          </div>
        )}
        {screen === "chat" && (
          <div className="flex flex-col w-full h-full max-w-3xl mx-auto" style={{ backgroundColor: "var(--bg)" }}>
            {connState !== "connected" && (
              <div className="px-4 py-2 text-xs text-center" style={{ backgroundColor: connState === "connecting" ? "rgba(251,191,36,0.1)" : "rgba(239,68,68,0.1)", color: connState === "connecting" ? "#fbbf24" : "#ef4444" }}>
                {connState === "connecting" ? "Connecting to relay..." : "Disconnected from relay."}
              </div>
            )}
            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-1">
              {messages.length === 0 && (
                <div className="text-center py-12">
                  <p className="text-sm" style={{ color: "var(--muted)" }}>No messages yet. Be the first to speak.</p>
                </div>
              )}
              {messages.map((msg) => {
                const mine = msg.pubkey === myPubkey;
                const profile = profiles[msg.pubkey];
                const nearName = msg.sender || msg.pubkey.slice(0, 8) + "...";
                const displayName = mine ? "you" : nearName;
                const showAvatar = !mine;
                const showSender = !mine;
                const prev = messages[messages.indexOf(msg) - 1];
                const sameSender = prev?.pubkey === msg.pubkey && (msg.created_at - (prev?.created_at || 0)) < 120;
                return (
                  <div key={msg.id} className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : "flex-row"} ${sameSender ? "mt-0.5" : "mt-3"}`}>
                    <div className="w-8 shrink-0 flex items-center justify-center">
                      {showAvatar && !sameSender && (
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold overflow-hidden" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                          {profile?.picture ? (
                            <img src={profile.picture} className="w-full h-full object-cover" alt="" />
                          ) : (
                            initials(nearName)
                          )}
                        </div>
                      )}
                    </div>
                    <div className={`flex flex-col ${mine ? "items-end" : "items-start"} max-w-[85%] md:max-w-[70%]`}>
                      {showSender && !sameSender && (
                        <span className="text-[10px] font-mono mb-0.5 px-1" style={{ color: "var(--muted)" }}>{displayName}</span>
                      )}
                      <div className="flex items-end gap-1.5">
                        <div
                          className="px-3 py-2 text-sm break-words leading-relaxed relative"
                          style={{
                            backgroundColor: msg.failed ? "rgba(239,68,68,0.1)" : mine ? "rgba(0,236,151,0.15)" : "var(--surface)",
                            border: msg.failed ? "1px solid rgba(239,68,68,0.3)" : mine ? "none" : "1px solid var(--border)",
                            borderRadius: mine ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
                            opacity: msg.pending ? 0.6 : 1,
                          }}
                        >
                          <ParsedContent content={msg.content} />
                          {msg.failed && <span className="text-[9px] text-red-400 ml-1">(failed)</span>}
                        </div>
                      </div>
                      {!sameSender && (
                        <span className="text-[9px] mt-0.5 px-1" style={{ color: "var(--muted)" }}>
                          {timeLabel(msg.created_at)}
                          {msg.pending && " · sending..."}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            {showScrollBtn && (
              <button
                onClick={scrollToBottom}
                className="absolute bottom-24 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full flex items-center justify-center shadow-lg z-10"
                style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
              >
                ↓
              </button>
            )}
            {error && <div className="px-4 py-1.5 text-xs text-red-400 text-center">{error}</div>}
            <div className="p-3 border-t flex items-end gap-2" style={{ borderColor: "var(--border)" }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={connState === "connected" ? "Say something..." : "Waiting for connection..."}
                rows={1}
                className="flex-1 px-3 py-2.5 rounded-2xl text-sm resize-none leading-relaxed"
                style={{
                  backgroundColor: "var(--surface)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  minHeight: "42px",
                  maxHeight: "120px",
                }}
                onInput={(e) => {
                  const el = e.currentTarget;
                  el.style.height = "42px";
                  el.style.height = Math.min(el.scrollHeight, 120) + "px";
                }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending || connState !== "connected"}
                className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold text-black disabled:opacity-40 transition-opacity"
                style={{ backgroundColor: "var(--accent)" }}
              >
                {sending ? "..." : "↑"}
              </button>
            </div>
          </div>
        )}
        {showSettings && (
          <div className="fixed inset-0 z-50 flex" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
            <div className="m-auto w-full max-w-2xl mx-4 rounded-2xl overflow-hidden flex flex-col max-h-[85vh]" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}>
              <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
                <span className="font-semibold">Settings</span>
                <button onClick={() => { setShowSettings(false); setEditProfile(null); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-sm" style={{ color: "var(--muted)", backgroundColor: "var(--surface)" }}>✕</button>
              </div>
              <div className="overflow-y-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 overflow-hidden">
                  {/* Left: Account info */}
                  <div className="p-6 space-y-4 border-b md:border-b-0 md:border-r min-w-0 overflow-hidden" style={{ borderColor: "var(--border)" }}>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Account</h3>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NEAR Account</label>
                        <div className="px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--accent)" }}>{accountId}</div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Nostr Public Key</label>
                        <div className="px-3 py-2 rounded-lg text-xs font-mono break-all leading-relaxed overflow-hidden" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{myPubkey}</div>
                      </div>
                    </div>

                    <h3 className="text-[11px] font-semibold uppercase tracking-wider pt-2" style={{ color: "var(--muted)" }}>Connection</h3>
                    <div className="space-y-3">
                      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: connInfo.color }} />
                        <span className="text-sm" style={{ color: "var(--text)" }}>{connInfo.label}</span>
                        <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{_signerType === "bunker" ? "NIP-46 Bunker" : _signerType === "extension" ? "Browser Extension" : _signerType === "local" ? "Local Key" : "—"}</span>
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Relay</label>
                        <div className="px-3 py-2 rounded-lg text-xs font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{relayUrl}</div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Channel</label>
                        <div className="px-3 py-2 rounded-lg text-xs font-mono break-all leading-relaxed overflow-hidden" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{CHANNEL_ID}</div>
                      </div>
                    </div>
                  </div>

                  {/* Right: Profile */}
                  <div className="p-6 space-y-4 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Nostr Profile</h3>
                      {editProfile === null && (
                        <button onClick={() => {
                          const p = profiles[myPubkey] || {};
                          setEditProfile({ name: p.name || "", about: p.about || "", picture: p.picture || "", nip05: p.nip05 || "", display_name: p.display_name || "", website: p.website || "" });
                        }} className="text-[11px] font-medium px-2.5 py-1 rounded-md" style={{ color: "var(--accent)", backgroundColor: "var(--accent-dim)" }}>Edit</button>
                      )}
                    </div>

                    {editProfile !== null ? (
                      <div className="space-y-3">
                        {/* Avatar preview */}
                        <div className="flex items-center gap-4">
                          <div className="w-16 h-16 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                            {editProfile.picture ? (
                              <img src={editProfile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                            ) : (
                              (editProfile.name || accountId || "?").slice(0, 2).toUpperCase()
                            )}
                          </div>
                          <div className="flex-1">
                            <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Picture URL</label>
                            <input type="url" value={editProfile.picture || ""} onChange={(e) => setEditProfile({ ...editProfile, picture: e.target.value })} placeholder="https://example.com/avatar.jpg"
                              className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Name</label>
                            <input type="text" value={editProfile.name || ""} onChange={(e) => setEditProfile({ ...editProfile, name: e.target.value })} placeholder="satoshi"
                              className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                          </div>
                          <div>
                            <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Display Name</label>
                            <input type="text" value={editProfile.display_name || ""} onChange={(e) => setEditProfile({ ...editProfile, display_name: e.target.value })} placeholder="Satoshi Nakamoto"
                              className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>About</label>
                          <textarea value={editProfile.about || ""} onChange={(e) => setEditProfile({ ...editProfile, about: e.target.value })} placeholder="Tell people about yourself..." rows={3}
                            className="w-full px-3 py-2 rounded-lg text-sm resize-none" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NIP-05</label>
                          <input type="text" value={editProfile.nip05 || ""} onChange={(e) => setEditProfile({ ...editProfile, nip05: e.target.value })} placeholder="user@domain.com"
                            className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                        </div>
                        <div>
                          <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Website</label>
                          <input type="url" value={editProfile.website || ""} onChange={(e) => setEditProfile({ ...editProfile, website: e.target.value })} placeholder="https://yoursite.com"
                            className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button onClick={async () => {
                            if (!signer || !relayRef.current) return;
                            try {
                              const event = await signProfileUpdate(signer, editProfile);
                              await relayRef.current.publish(event);
                              setProfiles((prev) => ({ ...prev, [myPubkey]: editProfile }));
                              setEditProfile(null);
                            } catch (e: any) { setError("Profile update failed: " + e.message); }
                          }} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Save Profile</button>
                          <button onClick={() => setEditProfile(null)} className="px-4 py-2.5 rounded-lg text-sm" style={{ border: "1px solid var(--border)", color: "var(--muted)" }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center gap-4">
                          <div className="w-16 h-16 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                            {profiles[myPubkey]?.picture ? (
                              <img src={profiles[myPubkey].picture} className="w-full h-full object-cover" alt="" />
                            ) : (
                              (profiles[myPubkey]?.name || accountId || "?").slice(0, 2).toUpperCase()
                            )}
                          </div>
                          <div>
                            <p className="font-semibold text-sm">{profiles[myPubkey]?.display_name || profiles[myPubkey]?.name || "No name set"}</p>
                            <p className="text-xs" style={{ color: "var(--muted)" }}>{profiles[myPubkey]?.nip05 || "No NIP-05"}</p>
                          </div>
                        </div>
                        {profiles[myPubkey]?.about ? (
                          <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>{profiles[myPubkey].about}</p>
                        ) : (
                          <p className="text-sm" style={{ color: "var(--muted)" }}>No bio yet. Click Edit to set up your profile.</p>
                        )}
                        {profiles[myPubkey]?.website && (
                          <a href={profiles[myPubkey].website} target="_blank" rel="noopener noreferrer" className="text-xs underline" style={{ color: "var(--accent)" }}>{profiles[myPubkey].website}</a>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer: Sign out */}
                <div className="px-6 py-4 border-t" style={{ borderColor: "var(--border)" }}>
                  <button onClick={() => { setShowSettings(false); handleSignOut(); }} className="text-xs font-medium text-red-400 hover:text-red-300">Sign out</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return <NearWalletProvider><ChatApp /></NearWalletProvider>;
}

function LoginScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="text-center max-w-sm w-full px-4">
      <div className="text-4xl mb-4">⚔️</div>
      <h1 className="text-xl font-bold mb-2">Legion Chat</h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>NEAR SBT-gated group chat. Requires an ASCENDANT or INITIATE SBT from NearLegion.</p>
      <button onClick={onSignIn} className="w-full py-3 rounded-lg font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Connect NEAR Wallet</button>
    </div>
  );
}

function CheckingScreen() {
  return (
    <div className="text-center">
      <div className="text-3xl mb-3 animate-pulse">⚔️</div>
      <p className="text-sm" style={{ color: "var(--muted)" }}>Checking SBT...</p>
    </div>
  );
}

function NoSbtScreen({ accountId, onSignOut }: { accountId: string; onSignOut: () => void }) {
  return (
    <div className="text-center max-w-sm w-full px-4">
      <div className="text-4xl mb-4">🛡️</div>
      <h1 className="text-xl font-bold mb-2">SBT Required</h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}><span className="font-mono">{accountId}</span> doesn't hold an ASCENDANT or INITIATE SBT.</p>
      <button onClick={onSignOut} className="w-full py-3 rounded-lg font-semibold text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>Sign out</button>
    </div>
  );
}

function BindScreen({ hasExtension, nsec, bunkerUri, relayUrl, error, onNsecChange, onBunkerUriChange, onRelayChange, onGenerate, onBindExtension, onBindBunker, onBindLocal, onSignOut }: {
  hasExtension: boolean; nsec: string; bunkerUri: string; relayUrl: string; error: string;
  onNsecChange: (v: string) => void; onBunkerUriChange: (v: string) => void;
  onRelayChange: (v: string) => void; onGenerate: () => void;
  onBindExtension: () => void; onBindBunker: () => void; onBindLocal: () => void; onSignOut: () => void;
}) {
  const [mode, setMode] = useState<"bunker" | "extension" | "local">("bunker");
  return (
    <div className="max-w-sm w-full px-4">
      <div className="text-center mb-6">
        <div className="text-3xl mb-2">🔗</div>
        <h1 className="text-lg font-bold">Link Nostr Identity</h1>
        <p className="text-xs" style={{ color: "var(--muted)" }}>Public key stored on-chain. Private key never touches this app.</p>
      </div>
      <div className="flex gap-1 mb-4 p-1 rounded-lg" style={{ backgroundColor: "var(--surface)" }}>
        {[
          { key: "bunker" as const, label: "🔗 Bunker" },
          { key: "extension" as const, label: "🧩 Extension" },
          { key: "local" as const, label: "🔑 Key" },
        ].map((tab) => (
          <button key={tab.key} onClick={() => setMode(tab.key)} disabled={tab.key === "extension" && !hasExtension}
            className="flex-1 py-2 text-xs font-medium rounded-md transition-colors disabled:opacity-30"
            style={{ backgroundColor: mode === tab.key ? "var(--accent)" : "transparent", color: mode === tab.key ? "black" : "var(--muted)" }}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {mode === "bunker" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>bunker:// URI</label>
              <input type="text" value={bunkerUri} onChange={(e) => onBunkerUriChange(e.target.value)} placeholder="bunker://abc...?relay=wss://..."
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              <p className="text-[10px] mt-1" style={{ color: "var(--muted)" }}>Get this from Amethyst, Nsec.app, or your bunker signer app</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <button onClick={onBindBunker} disabled={!bunkerUri.trim()} className="w-full py-3 rounded-lg font-semibold text-black disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>Connect Bunker & Bind</button>
          </>
        )}
        {mode === "extension" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <button onClick={onBindExtension} className="w-full py-3 rounded-lg font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Connect nos2x & Bind</button>
          </>
        )}
        {mode === "local" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>nsec (private key — stays in browser)</label>
              <input type="password" value={nsec} onChange={(e) => onNsecChange(e.target.value)} placeholder="nsec1..."
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <div className="flex gap-2">
              <button onClick={onGenerate} className="flex-1 py-2.5 rounded-lg text-sm font-medium" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>Generate new</button>
              <button onClick={onBindLocal} disabled={!nsec} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-black disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>Bind & Enter</button>
            </div>
          </>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button onClick={onSignOut} className="w-full py-2 text-xs" style={{ color: "var(--muted)" }}>Sign out</button>
      </div>
    </div>
  );
}

function BindingScreen() {
  return (
    <div className="text-center">
      <div className="text-3xl mb-3 animate-pulse">🔗</div>
      <p className="text-sm" style={{ color: "var(--muted)" }}>Linking identity...</p>
      <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Approve in your wallet + signer</p>
    </div>
  );
}