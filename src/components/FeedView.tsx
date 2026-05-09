import { useState, useRef, useEffect, useCallback } from "react";
import type { Message, Profile } from "../lib/types";
import { subscribeChannel, publishWithAck, signChannelMessage, signReaction } from "../lib/nostr";
import { FEED_CHANNEL_ID } from "../lib/constants";
import { Reply, Trash2, Copy, Heart, MessageCircle, Send, Loader2 } from "lucide-react";
import type { Relay, NostrSigner } from "../lib/nostr";
import type { BindingCache } from "../lib/types";

const REACTION_EMOJIS = ["❤️", "👍", "🔥", "😂", "😮", "😢"];

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function parseImage(content: string): { text: string; imageUrl: string | null } {
  const m = content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|avif)(\?[^\s]*)?)/i);
  if (m) return { text: content.replace(m[1], "").trim(), imageUrl: m[1] };
  // Try single URL as image
  const single = content.trim().match(/^(https?:\/\/[^\s]+)$/);
  if (single) return { text: "", imageUrl: single[1] };
  return { text: content, imageUrl: null };
}

function PostCard({
  msg, myPubkey, profiles, bindingsRef, onReact, onReply, onDelete, onCopy,
}: {
  msg: Message;
  myPubkey: string;
  profiles: Record<string, Profile>;
  bindingsRef: React.RefObject<BindingCache | null>;
  onReact: (msgId: string, pubkey: string, emoji: string) => void;
  onReply: (msg: Message) => void;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const mine = msg.pubkey === myPubkey;
  const profile = profiles[msg.pubkey];
  const displayName = msg.sender || profile?.display_name || profile?.name || msg.pubkey.slice(0, 12) + "...";
  const { text, imageUrl } = parseImage(msg.content);
  const reactions = msg.reactions || {};
  const reactionEntries = Object.entries(reactions).filter(([, pks]) => pks.length > 0);
  const [showReactions, setShowReactions] = useState(false);

  return (
    <article
      className="border-b"
      style={{ borderColor: "var(--border)", padding: "12px 16px" }}
    >
      {/* Header: avatar + name + time */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 overflow-hidden" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
          {profile?.picture ? (
            <img src={profile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
          ) : displayName.slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm truncate" style={{ color: "var(--text)" }}>{displayName}</span>
            <span className="text-[11px] shrink-0" style={{ color: "var(--muted)" }}>{timeAgo(msg.created_at)}</span>
          </div>
          {/* Text */}
          {text && (
            <p className="text-sm mt-1 leading-relaxed whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
              {expanded || text.length <= 300 ? text : text.slice(0, 300) + "..."}
              {text.length > 300 && !expanded && (
                <button onClick={() => setExpanded(true)} className="ml-1 text-xs" style={{ color: "var(--accent)" }}>more</button>
              )}
            </p>
          )}
          {/* Image */}
          {imageUrl && (
            <div className="mt-2 rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              <img
                src={imageUrl}
                alt=""
                className="w-full max-h-[400px] object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </div>
          )}
          {/* Action bar */}
          <div className="flex items-center gap-4 mt-2.5 -ml-2">
            <button
              onClick={() => setShowReactions(!showReactions)}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs active:opacity-60"
              style={{ color: "var(--muted)" }}
            >
              <Heart size={14} />
            </button>
            <button
              onClick={() => onReply(msg)}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs active:opacity-60"
              style={{ color: "var(--muted)" }}
            >
              <MessageCircle size={14} />
            </button>
            <button
              onClick={() => onCopy(msg.content)}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-xs active:opacity-60"
              style={{ color: "var(--muted)" }}
            >
              <Copy size={14} />
            </button>
            {mine && (
              <button
                onClick={() => onDelete(msg.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-full text-xs active:opacity-60"
                style={{ color: "var(--muted)" }}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          {/* Reaction picker */}
          {showReactions && (
            <div className="flex gap-2 mt-2 px-2 py-1.5 rounded-full" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", display: "inline-flex" }}>
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => { onReact(msg.id, msg.pubkey, emoji); setShowReactions(false); }}
                  className="active:scale-90 transition-transform"
                  style={{ fontSize: "20px", padding: "2px 4px" }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
          {/* Reaction pills */}
          {reactionEntries.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {reactionEntries.map(([emoji, pks]) => (
                <span
                  key={emoji}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs"
                  style={{
                    backgroundColor: pks.includes(myPubkey) ? "rgba(0,236,151,0.15)" : "rgba(255,255,255,0.08)",
                    border: `1px solid ${pks.includes(myPubkey) ? "var(--accent)" : "rgba(255,255,255,0.12)"}`,
                    color: "var(--text)",
                  }}
                >
                  {emoji} {pks.length > 1 && <span style={{ color: "var(--muted)" }}>{pks.length}</span>}
                </span>
              ))}
            </div>
          )}
          {msg.pending && <span className="text-[10px] mt-1 inline-block" style={{ color: "var(--muted)" }}>sending...</span>}
          {msg.failed && <span className="text-[10px] mt-1 inline-block text-red-400">failed</span>}
        </div>
      </div>
    </article>
  );
}

interface FeedViewProps {
  signer: NostrSigner | null;
  myPubkey: string;
  profiles: Record<string, Profile>;
  bindingsRef: React.RefObject<BindingCache | null>;
  relay: Relay | null;
  connState: string;
  showToast: (msg: string) => void;
}

export default function FeedView({
  signer, myPubkey, profiles, bindingsRef, relay, connState, showToast,
}: FeedViewProps) {
  const [posts, setPosts] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  // Subscribe to feed channel
  useEffect(() => {
    const r = relay;
    if (!r) return;

    setLoading(true);
    const collectedIds: string[] = [];
    const unsub = subscribeChannel(r, FEED_CHANNEL_ID, (event: any) => {
      const sender = bindingsRef.current?.pubkeyIndex[event.pubkey] || event.pubkey.slice(0, 12) + "...";
      const msg: Message = {
        id: event.id, pubkey: event.pubkey, content: event.content,
        created_at: event.created_at, sender,
      };
      collectedIds.push(event.id);
      setPosts((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        const list = [msg, ...prev];
        return list;
      });
    }, () => {
      setLoading(false);
      if (collectedIds.length > 0) {
        r.subscribe([{ kinds: [7], "#e": collectedIds }], {
          onevent: (evt: any) => {
            const eTag = (evt.tags || []).find((t: string[]) => t[0] === "e");
            if (!eTag) return;
            const targetId = eTag[1];
            const emoji = evt.content || "👍";
            setPosts((prev) => prev.map((m) => {
              if (m.id !== targetId) return m;
              const reactions = { ...(m.reactions || {}) };
              const current = reactions[emoji] || [];
              if (current.includes(evt.pubkey)) return m;
              reactions[emoji] = [...current, evt.pubkey];
              return { ...m, reactions };
            }));
          },
          oneose: () => {},
        });
      }
    });

    unsubRef.current = unsub;
    return () => { unsubRef.current?.(); };
  }, [relay]);

  const handlePost = useCallback(async () => {
    if (!input.trim() || !signer || !relay) return;
    const content = input.trim();
    setInput("");
    setSending(true);
    // Optimistic
    const tempId = "pending_" + Date.now();
    setPosts((prev) => [{
      id: tempId, pubkey: myPubkey, content, created_at: Math.floor(Date.now() / 1000),
      sender: "You", pending: true,
    }, ...prev]);
    try {
      const event = await signChannelMessage(signer, content, FEED_CHANNEL_ID);
      await publishWithAck(relay, event);
      setPosts((prev) => prev.map((m) => m.id === tempId ? { ...m, id: event.id, pending: false } : m));
      showToast("Posted!");
    } catch {
      setPosts((prev) => prev.map((m) => m.id === tempId ? { ...m, pending: false, failed: true } : m));
    }
    setSending(false);
  }, [input, signer, myPubkey, showToast]);

  const handleReact = useCallback(async (msgId: string, msgPubkey: string, emoji: string) => {
    if (!signer || !relay) return;
    // Optimistic
    setPosts((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const reactions = { ...(m.reactions || {}) };
      const current = reactions[emoji] || [];
      if (current.includes(myPubkey)) return m;
      reactions[emoji] = [...current, myPubkey];
      return { ...m, reactions };
    }));
    try {
      const event = await signReaction(signer, msgId, msgPubkey, emoji);
      await relay.publish(event);
    } catch {
      // Revert
      setPosts((prev) => prev.map((m) => {
        if (m.id !== msgId) return m;
        const reactions = { ...(m.reactions || {}) };
        const current = reactions[emoji] || [];
        reactions[emoji] = current.filter((pk) => pk !== myPubkey);
        if (reactions[emoji].length === 0) delete reactions[emoji];
        return { ...m, reactions };
      }));
    }
  }, [signer, myPubkey, relay]);

  const handleDelete = useCallback(async (id: string) => {
    if (!signer || !relay) return;
    setPosts((prev) => prev.filter((m) => m.id !== id));
    try {
      const event = await signer.signEvent({
        kind: 5, created_at: Math.floor(Date.now() / 1000),
        tags: [["e", id]], content: "",
      });
      relay.publish(event);
    } catch {}
  }, [signer]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => showToast("Copied!"));
  }, [showToast]);

  return (
    <div className="flex flex-col w-full h-full">
      {/* Post input */}
      <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What's on your mind?"
            rows={1}
            className="flex-1 px-3 py-2.5 rounded-2xl text-sm resize-none leading-relaxed overflow-y-hidden"
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
            onClick={handlePost}
            disabled={!input.trim() || sending || connState !== "connected"}
            className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold text-black disabled:opacity-40 transition-opacity"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {loading && posts.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin" style={{ color: "var(--muted)" }} />
          </div>
        )}
        {!loading && posts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <span style={{ color: "var(--muted)" }} className="text-sm">No posts yet</span>
            <span style={{ color: "var(--muted)" }} className="text-xs">Be the first to share something</span>
          </div>
        )}
        {posts.map((msg) => (
          <PostCard
            key={msg.id}
            msg={msg}
            myPubkey={myPubkey}
            profiles={profiles}
            bindingsRef={bindingsRef}
            onReact={handleReact}
            onReply={() => {}} // TODO: comments
            onDelete={handleDelete}
            onCopy={handleCopy}
          />
        ))}
      </div>
    </div>
  );
}
