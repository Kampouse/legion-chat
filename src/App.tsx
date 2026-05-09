import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Settings } from "lucide-react";
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
  signDeleteEvent,
  signReaction,
  connectRelayWithReconnect,
  subscribeChannel,
  publishWithAck,
  publishTyping,
  subscribeTyping,
  type NostrSigner,
  type Relay,
  type ConnectionState,
  type ReconnectHandle,
} from "./lib/nostr";
import { DEFAULT_RELAY, CHANNEL_ID } from "./lib/constants";
import type { Message, Profile } from "./lib/types";
import MessageList from "./components/MessageList";
import MessageInput from "./components/MessageInput";
import SettingsPanel from "./components/SettingsPanel";
import Toast from "./components/Toast";
import { LoginScreen, CheckingScreen, NoSbtScreen, BindScreen, BindingScreen } from "./components/LoginScreens";

type Screen = "login" | "checking" | "no-sbt" | "bind" | "binding" | "chat";

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
  const [messagesLoading, setMessagesLoading] = useState(true);

  const relayRef = useRef<Relay | null>(null);
  const bindingsRef = useRef<BindingCache | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reconnectFnRef = useRef<(() => void) | null>(null);
  const reconnectHandleRef = useRef<ReconnectHandle | null>(null);
  const [reconnectTrigger, setReconnectTrigger] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editProfile, setEditProfile] = useState<import("./lib/nostr").NostrProfile | null>(null);
  const lastSendRef = useRef(0);
  const SEND_COOLDOWN = 1500; // ms between sends

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // Typing indicator
  const [typingPubkeys, setTypingPubkeys] = useState<string[]>([]);
  const lastTypingPublish = useRef(0);

  // Toast
  const [toastMsg, setToastMsg] = useState("");
  const [toastKey, setToastKey] = useState(0);
  const [toastVisible, setToastVisible] = useState(false);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(false);
    // Force fresh mount via new key — fixes rapid toast race condition
    requestAnimationFrame(() => {
      setToastKey((k) => k + 1);
      setToastVisible(true);
    });
  }, []);

  // Reply
  const [replyTo, setReplyTo] = useState<{ id: string; content: string; sender: string } | null>(null);

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

  // ── Chat: connect relay (with auto-reconnect), load bindings, subscribe ──
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

        // Set up reconnect-aware relay connection
        const handle = connectRelayWithReconnect(
          relayUrl,
          setConnState,
          reconnectTrigger,
          (relay) => {
            // Called each time a connection succeeds (including reconnections)
            if (closed) { try { relay.close(); } catch {} return; }
            relayRef.current = relay;

            // Clean up previous subscription
            unsub?.();

            // Fetch profiles
            const pubkeys = Object.keys(bindingsRef.current?.pubkeyIndex || {});
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
            setMessagesLoading(true);
            unsub = subscribeChannel(relay, CHANNEL_ID, (event: any) => {
              const sender = bindingsRef.current?.pubkeyIndex[event.pubkey] || event.pubkey.slice(0, 12) + "...";
              // Extract reply tag info
              const eTags = (event.tags || []).filter((t: string[]) => t[0] === "e");
              const replyTag = eTags.find((t: string[]) => t[3] === "reply");
              let replyToId: string | undefined;
              let replyToContent: string | undefined;
              let replyToSender: string | undefined;
              if (replyTag) {
                replyToId = replyTag[1];
              }
              const msg: Message = {
                id: event.id, pubkey: event.pubkey, content: event.content,
                created_at: event.created_at, sender,
                ...(replyToId ? { replyToId } : {}),
              };
              setMessages((prev) => {
                if (prev.some((m) => m.id === msg.id)) return prev;
                // Enrich reply info from existing messages
                if (replyToId) {
                  const refMsg = prev.find((m) => m.id === replyToId);
                  if (refMsg) {
                    msg.replyToContent = refMsg.content;
                    msg.replyToSender = refMsg.sender || refMsg.pubkey.slice(0, 8);
                  }
                }
                // Insertion-point instead of full sort
                const list = [...prev, msg];
                let i = list.length - 1;
                while (i > 0 && list[i].created_at < list[i - 1].created_at) {
                  [list[i], list[i - 1]] = [list[i - 1], list[i]];
                  i--;
                }
                return list;
              });
              // Backfill reply content if referenced message wasn't loaded yet
              if (replyToId && !msg.replyToContent && relay) {
                (async () => {
                  try {
                    const filter = { ids: [replyToId] };
                    const fetched: any = await new Promise((resolve, reject) => {
                      const timeout = setTimeout(() => { sub2.close(); reject(new Error("timeout")); }, 4000);
                      const sub2 = relay.subscribe([filter], {
                        onevent: (ev: any) => { clearTimeout(timeout); sub2.close(); resolve(ev); },
                        oneose: () => { clearTimeout(timeout); sub2.close(); reject(new Error("not found")); },
                      });
                    });
                    const refSender = bindingsRef.current?.pubkeyIndex[fetched.pubkey] || fetched.pubkey.slice(0, 12) + "...";
                    setMessages((prev) =>
                      prev.map((m) => m.id === msg.id ? { ...m, replyToContent: fetched.content, replyToSender: refSender } : m)
                    );
                  } catch {} // best-effort; reply preview stays minimal if fetch fails
                })();
              }
            }, () => { setMessagesLoading(false); });

            // Subscribe to typing indicators
            if (myPubkey) {
              const unsubTyping = subscribeTyping(relay, CHANNEL_ID, myPubkey, (pubkeys) => {
                // Resolve pubkeys to display names
                const names = pubkeys.map((pk) => {
                  const profile = profiles[pk]; // may be stale but good enough
                  return profile?.display_name || profile?.name || pk.slice(0, 8) + "...";
                });
                setTypingPubkeys(names);
              });
              // Chain cleanup
              const origUnsub = unsub;
              unsub = () => { origUnsub(); unsubTyping(); };
            }

            // Subscribe to reactions (NIP-25 kind 7)
            const reactionSub = relay.subscribe([{
              kinds: [7],
              "#e": Object.keys(bindingsRef.current?.pubkeyIndex || {}),
            }], {
              onevent: (evt: any) => {
                const eTag = (evt.tags || []).find((t: string[]) => t[0] === "e");
                if (!eTag) return;
                const targetId = eTag[1];
                const emoji = evt.content || "👍";
                setMessages((prev) => prev.map((m) => {
                  if (m.id !== targetId) return m;
                  const reactions = { ...m.reactions };
                  const current = reactions[emoji] || [];
                  if (current.includes(evt.pubkey)) return m;
                  reactions[emoji] = [...current, evt.pubkey];
                  return { ...m, reactions };
                }));
              },
              oneose: () => {},
            });
            // Chain cleanup
            const prevUnsub = unsub;
            unsub = () => { prevUnsub(); try { reactionSub.close(); } catch {} };
          },
        );

        reconnectHandleRef.current = handle;
        reconnectFnRef.current = () => handle.reconnect();
      } catch (e: any) {
        if (!closed) setError("Failed to connect: " + (e.message || e));
      }
    };

    init();
    return () => {
      closed = true;
      unsub?.();
      // Cleanup the reconnect handle
      const cleanup = (reconnectHandleRef.current as any)?._cleanup;
      if (cleanup) cleanup();
      reconnectHandleRef.current = null;
      reconnectFnRef.current = null;
      try { relayRef.current?.close(); } catch {}
      relayRef.current = null;
    };
  }, [screen, accountId, relayUrl, signer, myPubkey, reconnectTrigger]);

  const sendScrollRef = useRef(false);

  useEffect(() => {
    if (sendScrollRef.current) {
      sendScrollRef.current = false;
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    } else if (autoScroll && messagesEndRef.current) {
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
    const now = Date.now();
    if (now - lastSendRef.current < SEND_COOLDOWN) {
      setError("Slow down — wait a moment before sending again.");
      return;
    }
    lastSendRef.current = now;
    const relay = relayRef.current;
    if (!relay || connState !== "connected") {
      setError("Not connected to relay.");
      return;
    }
    const content = input.trim();
    setInput(""); setSending(true); setError("");
    sendScrollRef.current = true;
    const currentReplyTo = replyTo;
    setReplyTo(null);
    const optimisticId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId, pubkey: myPubkey, content,
      created_at: Math.floor(Date.now() / 1000), sender: accountId!, pending: true,
      ...(currentReplyTo ? { replyToId: currentReplyTo.id, replyToContent: currentReplyTo.content, replyToSender: currentReplyTo.sender } : {}),
    };
    setMessages((prev) => {
      const list = [...prev, optimistic];
      let i = list.length - 1;
      while (i > 0 && list[i].created_at < list[i - 1].created_at) {
        [list[i], list[i - 1]] = [list[i - 1], list[i]];
        i--;
      }
      return list;
    });
    try {
      const event = await signChannelMessage(signer, content, CHANNEL_ID, currentReplyTo);
      const result = await publishWithAck(relay, event);
      const timedOut = !result.ok && result.message.includes("timed out");
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, id: event.id, pending: false, failed: !result.ok && !timedOut } : m))
      );
      if (!result.ok && !timedOut) {
        setError("Message rejected: " + (result.message || "unknown reason"));
      }
    } catch (e: any) {
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, pending: false, failed: true } : m))
      );
      setError("Send failed: " + e.message);
    }
    setSending(false);
  };

  // Publish typing indicator (throttled to once per 3s)
  const handleInputChange = (value: string) => {
    setInput(value);
    if (!value.trim() || !signer || !relayRef.current) return;
    const now = Date.now();
    if (now - lastTypingPublish.current < 3000) return;
    lastTypingPublish.current = now;
    publishTyping(signer, relayRef.current, CHANNEL_ID);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleDeleteMessage = useCallback(async (msgId: string) => {
    // Client-side delete first — instant
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
    // Best-effort NIP-09 deletion in background
    if (!signer || !relayRef.current) return;
    try {
      const event = await signDeleteEvent(signer, msgId);
      await relayRef.current.publish(event);
    } catch {
      // Already gone from UI — NIP-09 is best-effort
    }
  }, [signer]);

  const handleReact = useCallback(async (msgId: string, msgPubkey: string, emoji: string) => {
    if (!signer || !relayRef.current) return;
    try {
      const event = await signReaction(signer, msgId, msgPubkey, emoji);
      await relayRef.current.publish(event);
      // Optimistic update
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        const reactions = { ...m.reactions };
        const current = reactions[emoji] || [];
        reactions[emoji] = [...current, myPubkey];
        return { ...m, reactions };
      }));
    } catch {}
  }, [signer, myPubkey]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    showToast("Copied!");
  }, []);

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
            <button
              onClick={() => { if (connState !== "connected") reconnectFnRef.current?.(); }}
              className="flex items-center gap-2"
              title={connInfo.label}
            >
              <span
                className={`w-2 h-2 rounded-full inline-block ${connState !== "connected" ? "animate-pulse" : ""}`}
                style={{ backgroundColor: connInfo.color }}
              />
            </button>
            <span className="font-semibold text-sm">Legion Chat</span>
            <div className="flex-1" />
            <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>{accountId}</span>
            <button
              onClick={() => { setShowSearch((v) => !v); if (showSearch) setSearchQuery(""); }}
              className="text-base px-2 py-1 rounded active:opacity-60"
              style={{ color: showSearch ? "var(--accent)" : "var(--muted)" }}
              title="Search messages"
            >
              <Search size={16} />
            </button>
            <button onClick={() => setShowSettings(true)} className="px-2 py-1 rounded" style={{ color: "var(--muted)" }}><Settings size={18} /></button>
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
            {showSearch && (
              <div className="px-4 py-2 border-b relative" style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setShowSearch(false); setSearchQuery(""); }
                      if (e.key === "Backspace" && !searchQuery) { setShowSearch(false); }
                    }}
                    placeholder="Search... type @ to filter by user"
                    autoFocus
                    className="flex-1 px-3 py-2 rounded-lg text-sm"
                    style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)", outline: "none" }}
                  />
                  {searchQuery.trim() && (() => {
                    const fm = searchQuery.trim().match(/\bfrom:(\S+)/i);
                    const ff = fm ? fm[1].toLowerCase() : null;
                    const tf = searchQuery.trim().replace(/\bfrom:\S+/i, "").trim().toLowerCase();
                    const count = messages.filter((m) => {
                      if (ff) { const s = (m.sender || m.pubkey.slice(0, 8)).toLowerCase(); if (!s.includes(ff)) return false; }
                      if (tf) { if (!m.content.toLowerCase().includes(tf)) return false; }
                      return true;
                    }).length;
                    return <span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{count} found</span>;
                  })()}
                </div>
                {/* @ user dropdown */}
                {(() => {
                  const atMatch = searchQuery.match(/@(\S*)$/);
                  if (!atMatch) return null;
                  const partial = atMatch[1].toLowerCase();
                  // Build unique user list from messages + profiles
                  const seen = new Map<string, { name: string; pubkey: string }>();
                  for (const m of messages) {
                    const name = m.sender || m.pubkey.slice(0, 8) + "...";
                    if (!seen.has(name.toLowerCase())) {
                      seen.set(name.toLowerCase(), { name, pubkey: m.pubkey });
                    }
                  }
                  const users = [...seen.values()].filter((u) =>
                    u.name.toLowerCase().includes(partial)
                  ).slice(0, 8);
                  if (users.length === 0) return null;
                  return (
                    <div
                      className="absolute left-4 right-4 top-full mt-1 rounded-lg shadow-lg z-50 overflow-hidden"
                      style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}
                    >
                      {users.map((u) => {
                        const profile = profiles[u.pubkey];
                        return (
                          <button
                            key={u.pubkey}
                            onClick={() => {
                              // Replace @partial with from:name
                              const replaced = searchQuery.replace(/@\S*$/, `from:${u.name} `);
                              setSearchQuery(replaced);
                            }}
                            className="w-full px-3 py-2 flex items-center gap-2 text-sm text-left hover:opacity-80 active:opacity-60"
                            style={{ color: "var(--text)" }}
                          >
                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold overflow-hidden shrink-0" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                              {profile?.picture ? (
                                <img src={profile.picture} className="w-full h-full object-cover" alt="" />
                              ) : (
                                u.name.slice(0, 2).toUpperCase()
                              )}
                            </div>
                            <span className="truncate">{u.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}
            <MessageList
              messages={messages}
              myPubkey={myPubkey}
              profiles={profiles}
              bindingsRef={bindingsRef}
              autoScroll={autoScroll}
              showScrollBtn={showScrollBtn}
              messagesEndRef={messagesEndRef}
              scrollRef={scrollRef}
              handleScroll={handleScroll}
              scrollToBottom={scrollToBottom}
              onReply={(msg) => setReplyTo({ id: msg.id, content: msg.content, sender: msg.sender || msg.pubkey.slice(0, 8) })}
              onDelete={handleDeleteMessage}
              onReact={handleReact}
              onCopy={handleCopy}
              loading={messagesLoading}
              searchQuery={searchQuery}
              typingUsers={typingPubkeys}
            />
            {error && <div className="px-4 py-1.5 text-xs text-red-400 text-center">{error}</div>}
            <MessageInput
              input={input}
              setInput={handleInputChange}
              sending={sending}
              connState={connState}
              handleSend={handleSend}
              handleKeyDown={handleKeyDown}
              replyTo={replyTo ? replyTo.id : null}
              setReplyTo={() => setReplyTo(null)}
              replyingTo={replyTo ? replyTo.sender : ""}
              replyingToContent={replyTo ? replyTo.content : undefined}
            />
          </div>
        )}
        <SettingsPanel
          showSettings={showSettings}
          setShowSettings={setShowSettings}
          setEditProfile={setEditProfile}
          editProfile={editProfile}
          signer={signer}
          relayRef={relayRef}
          profiles={profiles}
          setProfiles={setProfiles}
          myPubkey={myPubkey}
          accountId={accountId}
          relayUrl={relayUrl}
          channelId={CHANNEL_ID}
          connInfo={connInfo}
          _signerType={_signerType}
          connState={connState}
          handleSignOut={handleSignOut}
          setError={setError}
          signProfileUpdate={signProfileUpdate}
          showToast={showToast}
        />
      </main>
      <Toast key={toastKey} message={toastMsg} visible={toastVisible} onHide={() => setToastVisible(false)} />
    </div>
  );
}

export default function App() {
  return <NearWalletProvider><ChatApp /></NearWalletProvider>;
}
