import { useState, useRef, useEffect, useCallback } from "react";
import type { Message, Profile } from "../lib/types";
import { subscribeChannel, publishWithAck, signChannelMessage, signReaction } from "../lib/nostr";
import { FEED_CHANNEL_ID } from "../lib/constants";
import { Trash2, Copy, Heart, MessageCircle, Loader2, X, Plus, ImagePlus } from "lucide-react";
import type { Relay, NostrSigner } from "../lib/nostr";
import { uploadToNostrBuild } from "../lib/nostr";
import type { BindingCache } from "../lib/types";

const REACTION_EMOJIS = ["❤️", "👍", "🔥", "😂", "😮", "😢"];

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d`;
  return new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function parseImage(content: string): { text: string; imageUrl: string | null } {
  const m = content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|avif)(\?[^\s]*)?)/i);
  if (m) return { text: content.replace(m[1], "").trim(), imageUrl: m[1] };
  const single = content.trim().match(/^(https?:\/\/[^\s]+)$/);
  if (single) return { text: "", imageUrl: single[1] };
  return { text: content, imageUrl: null };
}

function Avatar({ profile, name, size = 40 }: { profile?: Profile; name: string; size?: number }) {
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold shrink-0 overflow-hidden"
      style={{ width: size, height: size, backgroundColor: "var(--accent)", color: "#000", fontSize: size * 0.35 }}
    >
      {profile?.picture ? (
        <img src={profile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      ) : name.slice(0, 2).toUpperCase()}
    </div>
  );
}

// ── Full-screen Compose Modal ──
function ComposeModal({
  replyTo, profiles, myPubkey, myProfile, signer, relay, onClose, onPost, onReply, showToast,
}: {
  replyTo: Message | null;
  profiles: Record<string, Profile>;
  myPubkey: string;
  myProfile: Profile;
  signer: NostrSigner | null;
  relay: Relay | null;
  onClose: () => void;
  onPost: (msg: Message) => void;
  onReply: (msg: Message) => void;
  showToast: (msg: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => taRef.current?.focus(), 100); }, []);

  const isReply = replyTo !== null;
  const replyProfile = replyTo ? profiles[replyTo.pubkey] : undefined;
  const replyName = replyTo ? (replyTo.sender || replyProfile?.display_name || replyProfile?.name || replyTo.pubkey.slice(0, 12) + "...") : "";

  const charCount = text.length;
  const charLimit = 500;
  const overLimit = charCount > charLimit;

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      showToast("Only images supported");
      return;
    }
    if (!signer) return;
    setUploading(true);
    // Show local preview immediately
    const localUrl = URL.createObjectURL(file);
    setPreviewUrl(localUrl);
    try {
      const url = await uploadToNostrBuild(file, signer);
      // Append URL to text
      setText((prev) => (prev + (prev ? "\n" : "") + url).trim());
      // Replace local preview with real URL preview
      URL.revokeObjectURL(localUrl);
      setPreviewUrl(url);
      showToast("Image uploaded!");
    } catch (e: any) {
      URL.revokeObjectURL(localUrl);
      setPreviewUrl(null);
      showToast("Upload failed: " + (e.message || "unknown error"));
    }
    setUploading(false);
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleFile(file);
        return;
      }
    }
  }, [signer]);

  const handleSubmit = async () => {
    if ((!text.trim() && !previewUrl) || !signer || !relay || overLimit || uploading) return;
    setSending(true);
    try {
      const content = text.trim();
      if (isReply && replyTo) {
        const event = await signChannelMessage(signer, content, FEED_CHANNEL_ID, { id: replyTo.id });
        await publishWithAck(relay, event);
        onReply({
          id: event.id, pubkey: myPubkey, content,
          created_at: event.created_at, sender: myProfile.display_name || myProfile.name || "You",
          replyToId: replyTo.id, replyToContent: replyTo.content,
          replyToSender: replyName,
        });
        showToast("Reply sent!");
      } else {
        const event = await signChannelMessage(signer, content, FEED_CHANNEL_ID);
        await publishWithAck(relay, event);
        onPost({
          id: event.id, pubkey: myPubkey, content,
          created_at: event.created_at, sender: myProfile.display_name || myProfile.name || "You",
        });
        showToast("Posted!");
      }
      onClose();
    } catch {
      showToast(isReply ? "Failed to send reply" : "Failed to post");
    }
    setSending(false);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col"
      style={{ backgroundColor: "var(--bg)", animation: "modalIn 0.2s ease" }}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
        <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center active:opacity-60" style={{ color: "var(--text)" }}>
          <X size={20} />
        </button>
        <button
          onClick={handleSubmit}
          disabled={(!text.trim() && !previewUrl) || sending || overLimit || uploading}
          className="px-5 py-1.5 rounded-full text-sm font-bold text-black disabled:opacity-40 transition-opacity"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {sending ? <Loader2 size={14} className="animate-spin inline" /> : isReply ? "Reply" : "Post"}
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Reply context */}
        {isReply && replyTo && (
          <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <div className="flex gap-3">
              <Avatar profile={replyProfile} name={replyName} size={32} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm" style={{ color: "var(--text)" }}>{replyName}</span>
                  <span className="text-xs" style={{ color: "var(--muted)" }}>{timeAgo(replyTo.created_at)}</span>
                </div>
                <p className="text-sm mt-1 line-clamp-3" style={{ color: "var(--muted)" }}>{replyTo.content}</p>
              </div>
            </div>
            <div className="mt-2 pl-11 text-xs" style={{ color: "var(--muted)" }}>
              Replying to <span style={{ color: "var(--accent)" }}>@{replyName}</span>
            </div>
          </div>
        )}

        {/* Compose */}
        <div className="px-4 py-3">
          <div className="flex gap-3">
            <Avatar profile={myProfile} name={myProfile.display_name || myProfile.name || "Me"} size={40} />
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={handlePaste}
              placeholder={isReply ? "Post your reply" : "What's happening?"}
              className="flex-1 bg-transparent text-[17px] resize-none leading-normal outline-none"
              style={{ color: "var(--text)", minHeight: "120px" }}
            />
          </div>

          {/* Image preview */}
          {(previewUrl || uploading) && (
            <div className="mt-3 ml-[52px] relative rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)", maxWidth: "300px" }}>
              {previewUrl && <img src={previewUrl} alt="" className="w-full max-h-[200px] object-cover" />}
              {uploading && (
                <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
                  <Loader2 size={24} className="animate-spin text-white" />
                </div>
              )}
              {previewUrl && !uploading && (
                <button
                  onClick={() => setPreviewUrl(null)}
                  className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(0,0,0,0.6)", color: "white" }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />

      {/* Bottom toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-t" style={{ borderColor: "var(--border)", paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}>
        <button
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="w-9 h-9 rounded-full flex items-center justify-center active:opacity-60 disabled:opacity-40"
          style={{ color: "var(--accent)" }}
        >
          <ImagePlus size={18} />
        </button>
        {charCount > 0 && (
          <span className="text-xs" style={{ color: overLimit ? "#ef4444" : "var(--muted)" }}>
            {charCount}/{charLimit}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Post Card ──
function PostCard({
  msg, myPubkey, profiles, bindingsRef, onReact, onReply, onDelete, onCopy, replies,
}: {
  msg: Message;
  myPubkey: string;
  profiles: Record<string, Profile>;
  bindingsRef: React.RefObject<BindingCache | null>;
  onReact: (msgId: string, pubkey: string, emoji: string) => void;
  onReply: (msg: Message) => void;
  onDelete: (id: string) => void;
  onCopy: (text: string) => void;
  replies: Message[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const mine = msg.pubkey === myPubkey;
  const profile = profiles[msg.pubkey];
  const displayName = msg.sender || profile?.display_name || profile?.name || msg.pubkey.slice(0, 12) + "...";
  const { text, imageUrl } = parseImage(msg.content);
  const reactions = msg.reactions || {};
  const reactionEntries = Object.entries(reactions).filter(([, pks]) => pks.length > 0);
  const totalReactions = reactionEntries.reduce((sum, [, pks]) => sum + pks.length, 0);
  const myReaction = reactionEntries.find(([, pks]) => pks.includes(myPubkey));

  return (
    <article className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="px-4 py-3">
        <div className="flex gap-3">
          <Avatar profile={profile} name={displayName} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-[15px] truncate" style={{ color: "var(--text)" }}>{displayName}</span>
              <span className="text-[13px]" style={{ color: "var(--muted)" }}>· {timeAgo(msg.created_at)}</span>
            </div>

            {text && (
              <p className="text-[15px] mt-1 leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
                {expanded || text.length <= 400 ? text : text.slice(0, 400) + "..."}
                {text.length > 400 && !expanded && (
                  <button onClick={() => setExpanded(true)} className="ml-1 text-[15px]" style={{ color: "var(--accent)" }}>Show more</button>
                )}
              </p>
            )}

            {imageUrl && (
              <div className="mt-3 rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                <img src={imageUrl} alt="" className="w-full max-h-[500px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            )}

            {/* Action bar */}
            <div className="flex items-center justify-between mt-3 max-w-[300px]">
              <button onClick={() => onReply(msg)} className="flex items-center gap-1 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                <MessageCircle size={16} />
                {replies.length > 0 && <span>{replies.length}</span>}
              </button>
              <button onClick={() => setShowReactions(!showReactions)} className="flex items-center gap-1 text-[13px] active:opacity-60" style={{ color: myReaction ? "rgba(0,236,151,0.8)" : "var(--muted)" }}>
                <Heart size={16} fill={myReaction ? "currentColor" : "none"} />
                {totalReactions > 0 && <span>{totalReactions}</span>}
              </button>
              <button onClick={() => onCopy(msg.content)} className="flex items-center gap-1 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                <Copy size={16} />
              </button>
              {mine && (
                <button onClick={() => onDelete(msg.id)} className="flex items-center gap-1 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>

            {showReactions && (
              <div className="flex gap-2 mt-2 px-2 py-1.5 rounded-full inline-flex" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                {REACTION_EMOJIS.map((emoji) => (
                  <button key={emoji} onClick={() => { onReact(msg.id, msg.pubkey, emoji); setShowReactions(false); }} className="active:scale-90 transition-transform" style={{ fontSize: "20px", padding: "2px 4px" }}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}

            {reactionEntries.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {reactionEntries.map(([emoji, pks]) => (
                  <span key={emoji} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs" style={{
                    backgroundColor: pks.includes(myPubkey) ? "rgba(0,236,151,0.15)" : "rgba(255,255,255,0.08)",
                    border: `1px solid ${pks.includes(myPubkey) ? "var(--accent)" : "rgba(255,255,255,0.12)"}`,
                    color: "var(--text)",
                  }}>
                    {emoji} {pks.length > 1 && <span style={{ color: "var(--muted)" }}>{pks.length}</span>}
                  </span>
                ))}
              </div>
            )}

            {msg.pending && <span className="text-[10px] mt-1 inline-block" style={{ color: "var(--muted)" }}>sending...</span>}
            {msg.failed && <span className="text-[10px] mt-1 inline-block text-red-400">failed</span>}
          </div>
        </div>
      </div>

      {/* Thread */}
      {replies.length > 0 && !showThread && (
        <button onClick={() => setShowThread(true)} className="w-full px-4 pb-2 text-left text-[13px] pl-[68px]" style={{ color: "var(--accent)" }}>
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </button>
      )}
      {showThread && replies.map((reply) => {
        const rp = profiles[reply.pubkey];
        const rn = reply.sender || rp?.display_name || rp?.name || reply.pubkey.slice(0, 12) + "...";
        return (
          <div key={reply.id} className="px-4 py-2.5 border-t" style={{ borderColor: "var(--border)", paddingLeft: "68px" }}>
            <div className="flex items-center gap-1.5 mb-0.5">
              <Avatar profile={rp} name={rn} size={20} />
              <span className="font-semibold text-xs truncate" style={{ color: "var(--text)" }}>{rn}</span>
              <span className="text-[10px]" style={{ color: "var(--muted)" }}>{timeAgo(reply.created_at)}</span>
            </div>
            <p className="text-[13px] leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>{reply.content}</p>
          </div>
        );
      })}
    </article>
  );
}

// ── Main Feed View ──
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
  const [composeTarget, setComposeTarget] = useState<Message | null | "new">(null); // null = closed, "new" = new post, Message = reply
  const unsubRef = useRef<(() => void) | null>(null);

  // Subscribe to feed channel
  useEffect(() => {
    const r = relay;
    if (!r) return;
    setLoading(true);
    const collectedIds: string[] = [];
    const unsub = subscribeChannel(r, FEED_CHANNEL_ID, (event: any) => {
      const sender = bindingsRef.current?.pubkeyIndex[event.pubkey] || event.pubkey.slice(0, 12) + "...";
      const eTags = (event.tags || []).filter((t: string[]) => t[0] === "e");
      const replyTag = eTags.find((t: string[]) => t[3] === "reply");
      const msg: Message = {
        id: event.id, pubkey: event.pubkey, content: event.content,
        created_at: event.created_at, sender,
        ...(replyTag ? { replyToId: replyTag[1] } : {}),
      };
      collectedIds.push(event.id);
      setPosts((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [msg, ...prev];
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

  const topLevelPosts = posts.filter((p) => !p.replyToId);
  const repliesFor = (postId: string) => posts.filter((p) => p.replyToId === postId).sort((a, b) => a.created_at - b.created_at);

  const handlePost = useCallback((msg: Message) => {
    setPosts((prev) => [msg, ...prev]);
  }, []);

  const handleReact = useCallback(async (msgId: string, msgPubkey: string, emoji: string) => {
    if (!signer || !relay) return;
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
      const event = await signer.signEvent({ kind: 5, created_at: Math.floor(Date.now() / 1000), tags: [["e", id]], content: "" });
      relay.publish(event);
    } catch {}
  }, [signer]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => showToast("Copied!"));
  }, [showToast]);

  const myProfile = profiles[myPubkey] || {};

  return (
    <div className="flex flex-col w-full h-full relative">
      {/* Feed */}
      <div className="flex-1 overflow-y-auto">
        {loading && topLevelPosts.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin" style={{ color: "var(--muted)" }} />
          </div>
        )}
        {!loading && topLevelPosts.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-lg font-semibold" style={{ color: "var(--text)" }}>No posts yet</span>
            <span style={{ color: "var(--muted)" }} className="text-sm">Tap + to share something</span>
          </div>
        )}
        {topLevelPosts.map((msg) => (
          <PostCard
            key={msg.id}
            msg={msg}
            myPubkey={myPubkey}
            profiles={profiles}
            bindingsRef={bindingsRef}
            onReact={handleReact}
            onReply={(m) => setComposeTarget(m)}
            onDelete={handleDelete}
            onCopy={handleCopy}
            replies={repliesFor(msg.id)}
          />
        ))}
      </div>

      {/* FAB — compose button */}
      {composeTarget === null && (
        <button
          onClick={() => setComposeTarget("new")}
          className="absolute bottom-5 right-5 w-14 h-14 rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          style={{ backgroundColor: "var(--accent)", color: "#000", boxShadow: "0 4px 20px rgba(0,236,151,0.3)" }}
        >
          <Plus size={28} />
        </button>
      )}

      {/* Compose modal */}
      {composeTarget !== null && (
        <ComposeModal
          replyTo={composeTarget === "new" ? null : composeTarget}
          profiles={profiles}
          myPubkey={myPubkey}
          myProfile={myProfile}
          signer={signer}
          relay={relay}
          onClose={() => setComposeTarget(null)}
          onPost={handlePost}
          onReply={handlePost}
          showToast={showToast}
        />
      )}
    </div>
  );
}
