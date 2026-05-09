import { useState, useEffect, useCallback, useRef } from "react";
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
  connectRelayAsync,
  subscribeChannel,
  publishWithAck,
  type NostrSigner,
  type Relay,
  type ConnectionState,
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

  const relayRef = useRef<Relay | null>(null);
  const bindingsRef = useRef<BindingCache | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editProfile, setEditProfile] = useState<import("./lib/nostr").NostrProfile | null>(null);

  // Toast
  const [toastMsg, setToastMsg] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastVisible(true);
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
          // Extract reply tag info
          const eTags = (event.tags || []).filter((t: string[]) => t[0] === "e");
          const replyTag = eTags.find((t: string[]) => t[3] === "reply");
          const rootTag = eTags.find((t: string[]) => t[3] === "root");
          let replyToId: string | undefined;
          let replyToContent: string | undefined;
          let replyToSender: string | undefined;
          if (replyTag) {
            replyToId = replyTag[1];
            // Try to find the referenced message in current state for content/sender
            // This is best-effort; the message may not be loaded yet
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
    const currentReplyTo = replyTo;
    setReplyTo(null);
    const optimisticId = `pending-${Date.now()}`;
    const optimistic: Message = {
      id: optimisticId, pubkey: myPubkey, content,
      created_at: Math.floor(Date.now() / 1000), sender: accountId!, pending: true,
      ...(currentReplyTo ? { replyToId: currentReplyTo.id, replyToContent: currentReplyTo.content, replyToSender: currentReplyTo.sender } : {}),
    };
    setMessages((prev) => [...prev, optimistic].sort((a, b) => a.created_at - b.created_at));
    try {
      const event = await signChannelMessage(signer, content, CHANNEL_ID, currentReplyTo);
      const result = await publishWithAck(relay, event);
      setMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, id: event.id, pending: false, failed: !result.ok } : m))
      );
      if (!result.ok) setError("Message rejected: " + (result.message || "unknown reason"));
      else showToast("Message sent");
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

  const handleDeleteMessage = useCallback(async (msgId: string) => {
    if (!signer || !relayRef.current) return;
    try {
      const event = await signDeleteEvent(signer, msgId);
      await relayRef.current.publish(event);
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
    } catch (e: any) {
      setError("Delete failed: " + e.message);
    }
  }, [signer]);

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
            />
            {error && <div className="px-4 py-1.5 text-xs text-red-400 text-center">{error}</div>}
            <MessageInput
              input={input}
              setInput={setInput}
              sending={sending}
              connState={connState}
              handleSend={handleSend}
              handleKeyDown={handleKeyDown}
              replyTo={replyTo ? replyTo.id : null}
              setReplyTo={() => setReplyTo(null)}
              replyingTo={replyTo ? replyTo.sender : ""}
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
      <Toast message={toastMsg} visible={toastVisible} onHide={() => setToastVisible(false)} />
    </div>
  );
}

export default function App() {
  return <NearWalletProvider><ChatApp /></NearWalletProvider>;
}
