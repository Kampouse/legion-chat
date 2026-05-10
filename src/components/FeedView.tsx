import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Message, Profile } from "../lib/types";
import { subscribeChannel, publishWithAck, signChannelMessage, signReaction } from "../lib/nostr";
import { FEED_CHANNEL_ID } from "../lib/constants";
import { Heart, MessageCircle, Loader2, X, Plus, ImagePlus, Repeat2, Share2 } from "lucide-react";
import type { Relay, NostrSigner } from "../lib/nostr";
import { uploadToNostrBuild } from "../lib/nostr";
import type { BindingCache } from "../lib/types";

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

/** Render text with @mention highlighting */
function renderContent(text: string, profiles: Record<string, Profile>, allPosts: Message[]) {
  // Match @displayName patterns or nostr:npub... patterns
  const parts: JSX.Element[] = [];
  // Build a lookup: displayName -> pubkey from all known profiles
  const nameToKey: Record<string, string> = {};
  for (const [pk, p] of Object.entries(profiles)) {
    if (p.name) nameToKey[p.name.toLowerCase()] = pk;
    if (p.display_name) nameToKey[p.display_name.toLowerCase()] = pk;
  }

  const regex = /@([\w.]+)|nostr:(npub[a-zA-Z0-9]+)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    // Push text before the match
    if (match.index > lastIdx) {
      parts.push(<span key={key++}>{text.slice(lastIdx, match.index)}</span>);
    }
    const mentionName = match[1]?.toLowerCase();
    const npub = match[2];
    if (mentionName && nameToKey[mentionName]) {
      const pk = nameToKey[mentionName];
      const p = profiles[pk];
      parts.push(
        <span key={key++} style={{ color: "var(--accent)" }}>@{p.display_name || p.name}</span>
      );
    } else if (npub) {
      parts.push(<span key={key++} style={{ color: "var(--accent)" }}>{npub.slice(0, 12)}...</span>);
    } else {
      parts.push(<span key={key++}>{match[0]}</span>);
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  }
  return parts.length > 0 ? parts : text;
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

// ── Mention Picker ──
function MentionPicker({
  query, profiles, myPubkey, onSelect,
}: {
  query: string;
  profiles: Record<string, Profile>;
  myPubkey: string;
  onSelect: (name: string) => void;
}) {
  const q = query.toLowerCase();
  const matches = Object.entries(profiles)
    .filter(([pk, p]) => pk !== myPubkey && (
      (p.display_name?.toLowerCase().includes(q)) ||
      (p.name?.toLowerCase().includes(q))
    ))
    .slice(0, 5);

  if (matches.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 rounded-xl overflow-hidden" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", maxHeight: "200px", overflowY: "auto" }}>
      {matches.map(([pk, p]) => {
        const name = p.display_name || p.name || pk.slice(0, 12);
        return (
          <button
            key={pk}
            onClick={() => onSelect(name)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left active:opacity-60"
            style={{ color: "var(--text)" }}
          >
            <Avatar profile={p} name={name} size={24} />
            <span className="text-sm truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Quoted Post Card (mini, embedded) ──
function QuotedPost({ post, profiles, onClick }: { post: Message; profiles: Record<string, Profile>; onClick?: () => void }) {
  const profile = profiles[post.pubkey];
  const name = post.sender || profile?.display_name || profile?.name || post.pubkey.slice(0, 12) + "...";
  const { text, imageUrl } = parseImage(post.content);

  return (
    <div
      onClick={onClick}
      className="mt-2 rounded-xl p-3 active:opacity-70 transition-opacity"
      style={{ border: "1px solid var(--border)", backgroundColor: "rgba(255,255,255,0.03)", cursor: onClick ? "pointer" : undefined }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Avatar profile={profile} name={name} size={16} />
        <span className="font-semibold text-[13px] truncate" style={{ color: "var(--text)" }}>{name}</span>
      </div>
      {text && (
        <p className="text-[13px] line-clamp-3 leading-normal" style={{ color: "var(--muted)" }}>
          {text.length > 200 ? text.slice(0, 200) + "..." : text}
        </p>
      )}
      {imageUrl && (
        <div className="mt-2 rounded-lg overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <img src={imageUrl} alt="" className="w-full max-h-[200px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      )}
    </div>
  );
}

// ── Full-screen Compose Modal ──
function ComposeModal({
  replyTo, quotePost, allPosts, profiles, myPubkey, myProfile, signer, relay, onClose, onPost, onReply, showToast,
}: {
  replyTo: Message | null;
  quotePost: Message | null;
  allPosts: Message[];
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
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => taRef.current?.focus(), 100); }, []);

  const isReply = replyTo !== null;
  const isQuote = quotePost !== null;
  const replyProfile = replyTo ? profiles[replyTo.pubkey] : undefined;
  const replyName = replyTo ? (replyTo.sender || replyProfile?.display_name || replyProfile?.name || replyTo.pubkey.slice(0, 12) + "...") : "";

  const charCount = text.length;
  const charLimit = 500;
  const overLimit = charCount > charLimit;

  // Extract mentioned pubkeys from text (@displayName matches)
  const getMentions = useCallback((): string[] => {
    const mentioned: string[] = [];
    for (const [pk, p] of Object.entries(profiles)) {
      const name = p.display_name || p.name;
      if (name && text.toLowerCase().includes(`@${name.toLowerCase()}`)) {
        mentioned.push(pk);
      }
    }
    return mentioned;
  }, [profiles, text]);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) { showToast("Only images supported"); return; }
    if (!signer) return;
    setUploading(true);
    const localUrl = URL.createObjectURL(file);
    setPreviewUrl(localUrl);
    try {
      const url = await uploadToNostrBuild(file, signer);
      setText((prev) => (prev + (prev ? "\n" : "") + url).trim());
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

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    // Detect @mention typing
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
    } else {
      setMentionQuery(null);
    }
  };

  const handleMentionSelect = (name: string) => {
    // Replace the @partial with @full_name
    const cursorPos = taRef.current?.selectionStart ?? text.length;
    const textBeforeCursor = text.slice(0, cursorPos);
    const textAfterCursor = text.slice(cursorPos);
    const replaced = textBeforeCursor.replace(/@\w*$/, `@${name} `) + textAfterCursor;
    setText(replaced);
    setMentionQuery(null);
    taRef.current?.focus();
  };

  const handleSubmit = async () => {
    if ((!text.trim() && !previewUrl) || !signer || !relay || overLimit || uploading) return;
    setSending(true);
    try {
      const content = text.trim();
      const mentions = getMentions();
      if (isReply && replyTo) {
        const event = await signChannelMessage(signer, content, FEED_CHANNEL_ID, { id: replyTo.id }, {
          ...(isQuote && quotePost ? { quoteId: quotePost.id } : {}),
          mentions,
        });
        await publishWithAck(relay, event);
        onReply({
          id: event.id, pubkey: myPubkey, content,
          created_at: event.created_at, sender: myProfile.display_name || myProfile.name || "You",
          replyToId: replyTo.id, replyToContent: replyTo.content,
          replyToSender: replyName,
          ...(isQuote && quotePost ? { quoteId: quotePost.id } : {}),
          mentions,
        });
        showToast("Reply sent!");
      } else {
        const event = await signChannelMessage(signer, content, FEED_CHANNEL_ID, null, {
          ...(isQuote && quotePost ? { quoteId: quotePost.id } : {}),
          mentions,
        });
        await publishWithAck(relay, event);
        onPost({
          id: event.id, pubkey: myPubkey, content,
          created_at: event.created_at, sender: myProfile.display_name || myProfile.name || "You",
          ...(isQuote && quotePost ? { quoteId: quotePost.id } : {}),
          mentions,
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} />
      <div
        className="relative flex flex-col w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", maxHeight: "80vh", animation: "modalIn 0.2s ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
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
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* Reply context — compact inline */}
          {isReply && replyTo && (
            <div className="px-4 pt-3">
              <div className="flex gap-3">
                <div className="flex flex-col items-center shrink-0">
                  <Avatar profile={replyProfile} name={replyName} size={36} />
                  <div className="flex-1 w-px mt-2 mb-1" style={{ backgroundColor: "var(--border)" }} />
                </div>
                <div className="flex-1 min-w-0 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm" style={{ color: "var(--text)" }}>{replyName}</span>
                    <span className="text-xs" style={{ color: "var(--muted)" }}>{timeAgo(replyTo.created_at)}</span>
                  </div>
                  <p className="text-sm mt-0.5 line-clamp-4 leading-normal" style={{ color: "var(--muted)" }}>{replyTo.content}</p>
                </div>
              </div>
            </div>
          )}

          {/* Quote context */}
          {isQuote && quotePost && !isReply && (
            <div className="px-4 pt-3">
              <QuotedPost post={quotePost} profiles={profiles} />
            </div>
          )}

          {/* Compose */}
          <div className="px-4 py-3">
            <div className="flex gap-3">
              <Avatar profile={myProfile} name={myProfile.display_name || myProfile.name || "Me"} size={36} />
              <div className="flex-1 relative">
                <textarea
                  ref={taRef}
                  value={text}
                  onChange={handleTextChange}
                  onPaste={handlePaste}
                  placeholder={isReply ? "Post your reply" : isQuote ? "Add a comment" : "What's happening?"}
                  className="w-full bg-transparent text-[15px] resize-none leading-normal outline-none"
                  style={{ color: "var(--text)", minHeight: "100px" }}
                />
                {mentionQuery !== null && (
                  <MentionPicker query={mentionQuery} profiles={profiles} myPubkey={myPubkey} onSelect={handleMentionSelect} />
                )}
              </div>
            </div>

            {/* Image preview */}
            {(previewUrl || uploading) && (
              <div className="mt-2 ml-12 relative rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)", maxWidth: "280px" }}>
                {previewUrl && <img src={previewUrl} alt="" className="w-full max-h-[180px] object-cover" />}
                {uploading && (
                  <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.4)" }}>
                    <Loader2 size={24} className="animate-spin text-white" />
                  </div>
                )}
                {previewUrl && !uploading && (
                  <button onClick={() => setPreviewUrl(null)} className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", color: "white" }}>
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-t shrink-0" style={{ borderColor: "var(--border)", paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="w-9 h-9 rounded-full flex items-center justify-center active:opacity-60 disabled:opacity-40" style={{ color: "var(--accent)" }}>
            <ImagePlus size={18} />
          </button>
          {charCount > 0 && (
            <span className="text-xs" style={{ color: overLimit ? "#ef4444" : "var(--muted)" }}>{charCount}/{charLimit}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Post Card ──
function PostCard({
  msg, myPubkey, profiles, allPosts, onReact, onReply, onQuote, onNavigateToPost, onShare, onOpenThread, replies,
}: {
  msg: Message;
  myPubkey: string;
  profiles: Record<string, Profile>;
  allPosts: Message[];
  onReact: (msgId: string, pubkey: string, emoji: string) => void;
  onReply: (msg: Message) => void;
  onQuote: (msg: Message) => void;
  onNavigateToPost: (id: string) => void;
  onShare: (msg: Message) => void;
  onOpenThread: (msg: Message) => void;
  replies: Message[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [showThread, setShowThread] = useState(false);
  const profile = profiles[msg.pubkey];
  const displayName = msg.sender || profile?.display_name || profile?.name || msg.pubkey.slice(0, 12) + "...";
  const { text, imageUrl } = parseImage(msg.content);
  const heartReactions = (msg.reactions || {})["❤️"] || [];
  const liked = heartReactions.includes(myPubkey);
  const totalLikes = heartReactions.length;

  // Find quoted post
  const quotedPost = msg.quoteId ? allPosts.find((p) => p.id === msg.quoteId) : null;

  return (
    <article data-post-id={msg.id} className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="px-4 py-3 cursor-pointer" onClick={() => onOpenThread(msg)}>
        <div className="flex gap-3">
          <Avatar profile={profile} name={displayName} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-[15px] truncate" style={{ color: "var(--text)" }}>{displayName}</span>
              <span className="text-[13px]" style={{ color: "var(--muted)" }}>· {timeAgo(msg.created_at)}</span>
            </div>

            {text && (
              <p className="text-[15px] mt-1 leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
                {expanded || text.length <= 400 ? renderContent(text, profiles, allPosts) : <>{text.slice(0, 400) + "..."}<button onClick={(e) => { e.stopPropagation(); setExpanded(true); }} className="ml-1 text-[15px]" style={{ color: "var(--accent)" }}>Show more</button></>}
              </p>
            )}

            {imageUrl && (
              <div className="mt-3 rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                <img src={imageUrl} alt="" className="w-full max-h-[500px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              </div>
            )}

            {/* Quoted post */}
            {quotedPost && <QuotedPost post={quotedPost} profiles={profiles} onClick={(e?: any) => { if (e) e.stopPropagation(); onNavigateToPost(quotedPost.id); }} />}

            {/* Action bar */}
            <div className="flex items-center justify-between mt-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-6">
              <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--muted)" }}>
                <button onClick={(e) => { e.stopPropagation(); onOpenThread(msg); }} className="active:opacity-60">
                  <MessageCircle size={16} />
                </button>
                {replies.length > 0 && (
                  <button
                    onClick={() => setShowThread(!showThread)}
                    className="active:opacity-60"
                    style={{ color: showThread ? "var(--accent)" : "var(--muted)" }}
                  >
                    {replies.length}
                  </button>
                )}
              </div>
              <button onClick={() => onReact(msg.id, msg.pubkey, "❤️")} className="flex items-center gap-1.5 text-[13px] active:scale-110 transition-transform" style={{ color: liked ? "#ef4444" : "var(--muted)" }}>
                <Heart size={16} fill={liked ? "currentColor" : "none"} />
                {totalLikes > 0 && <span>{totalLikes}</span>}
              </button>
              <button onClick={() => onQuote(msg)} className="flex items-center gap-1.5 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                <Repeat2 size={16} />
              </button>
              </div>
              <button onClick={(e) => { e.stopPropagation(); onShare(msg); }} className="flex items-center gap-1.5 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                <Share2 size={16} />
              </button>
            </div>

            {msg.pending && <span className="text-[10px] mt-1 inline-block" style={{ color: "var(--muted)" }}>sending...</span>}
            {msg.failed && <span className="text-[10px] mt-1 inline-block text-red-400">failed</span>}
          </div>
        </div>
      </div>

      {/* Thread */}
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

// ── Reply Tree (recursive, max depth) ──
function ReplyTree({
  parentId, replies, profiles, myPubkey, allPosts, depth, maxDepth, onReply, onReact,
}: {
  parentId: string;
  replies: Message[];
  profiles: Record<string, Profile>;
  myPubkey: string;
  allPosts: Message[];
  depth: number;
  maxDepth: number;
  onReply: (msg: Message) => void;
  onReact: (msgId: string, pubkey: string, emoji: string) => void;
}) {
  const children = replies.filter((r) => r.replyToId === parentId);
  if (children.length === 0) return null;

  return (
    <>
      {children.map((reply, idx) => {
        const rp = profiles[reply.pubkey];
        const rn = reply.sender || rp?.display_name || rp?.name || reply.pubkey.slice(0, 12) + "...";
        const heartReactions = (reply.reactions || {})["❤️"] || [];
        const liked = heartReactions.includes(myPubkey);
        const { text: replyContent } = parseImage(reply.content);
        const isLast = idx === children.length - 1;
        const hasChildren = depth + 1 < maxDepth && replies.some((r) => r.replyToId === reply.id);
        const avatarSize = depth === 0 ? 32 : 28;

        return (
          <div key={reply.id} className="flex" style={{ paddingLeft: `${depth * 28 + 8}px` }}>
            {/* Branch connector: vertical trunk + horizontal arm to avatar */}
            <div className="flex flex-col items-center shrink-0" style={{ width: `${avatarSize + 20}px` }}>
              {/* Top half of trunk (from parent down to branch point) */}
              <div className="w-px flex-1" style={{ backgroundColor: "var(--border)" }} />
              {/* Horizontal arm + avatar row */}
              <div className="shrink-0 flex items-center" style={{ backgroundColor: "var(--bg)" }}>
                {/* Horizontal stub connecting trunk to avatar */}
                <div className="h-px" style={{ width: "10px", backgroundColor: "var(--border)" }} />
                <Avatar profile={rp} name={rn} size={avatarSize} />
                {/* Right padding to match column width */}
                <div style={{ width: "10px" }} />
              </div>
              {/* Bottom half of trunk (continues to next sibling) */}
              <div className="w-px flex-1" style={{ backgroundColor: (!isLast || hasChildren) ? "var(--border)" : "transparent" }} />
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0 py-2 pr-4">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-sm truncate" style={{ color: "var(--text)" }}>{rn}</span>
                <span className="text-xs" style={{ color: "var(--muted)" }}>· {timeAgo(reply.created_at)}</span>
              </div>
              {replyContent && (
                <p className="text-[14px] mt-0.5 leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
                  {renderContent(replyContent, profiles, allPosts)}
                </p>
              )}
              <div className="flex items-center gap-5 mt-2">
                <button onClick={() => onReply(reply)} className="flex items-center gap-1.5 text-[12px] active:opacity-60" style={{ color: "var(--muted)" }}>
                  <MessageCircle size={14} />
                </button>
                <button onClick={() => onReact(reply.id, reply.pubkey, "❤️")} className="flex items-center gap-1.5 text-[12px] active:scale-110 transition-transform" style={{ color: liked ? "#ef4444" : "var(--muted)" }}>
                  <Heart size={14} fill={liked ? "currentColor" : "none"} />
                  {heartReactions.length > 0 && <span>{heartReactions.length}</span>}
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {/* Render nested children */}
      {children.map((reply) => (
        depth + 1 < maxDepth && replies.some((r) => r.replyToId === reply.id) ? (
          <ReplyTree
            key={`sub-${reply.id}`}
            parentId={reply.id}
            replies={replies}
            profiles={profiles}
            myPubkey={myPubkey}
            allPosts={allPosts}
            depth={depth + 1}
            maxDepth={maxDepth}
            onReply={onReply}
            onReact={onReact}
          />
        ) : null
      ))}
    </>
  );
}

// ── Thread Modal ──
function ThreadModal({
  rootPost, allPosts, myPubkey, profiles, myProfile, signer, relay, onClose, onReply, onReact, showToast,
}: {
  rootPost: Message;
  allPosts: Message[];
  myPubkey: string;
  profiles: Record<string, Profile>;
  myProfile: Profile;
  signer: NostrSigner | null;
  relay: Relay | null;
  onClose: () => void;
  onReply: (msg: Message) => void;
  onReact: (msgId: string, pubkey: string, emoji: string) => void;
  showToast: (msg: string) => void;
}) {
  const [replyingTo, setReplyingTo] = useState<Message>(rootPost);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevReplyCount = useRef(0);

  // Collect all replies in the thread (not just direct children)
  const threadIds = new Set<string>([rootPost.id]);
  const replies: Message[] = [];
  // Multiple passes to pick up nested replies
  const remaining = allPosts.filter((p) => p.replyToId);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (threadIds.has(remaining[i].replyToId!)) {
        threadIds.add(remaining[i].id);
        replies.push(remaining[i]);
        remaining.splice(i, 1);
        changed = true;
      }
    }
  }
  replies.sort((a, b) => a.created_at - b.created_at);

  // Auto-scroll when new replies arrive
  useEffect(() => {
    if (replies.length > prevReplyCount.current && prevReplyCount.current > 0) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
    prevReplyCount.current = replies.length;
  }, [replies.length]);

  const rootProfile = profiles[rootPost.pubkey];
  const rootName = rootPost.sender || rootProfile?.display_name || rootProfile?.name || rootPost.pubkey.slice(0, 12) + "...";
  const { text: rootText, imageUrl: rootImage } = parseImage(rootPost.content);
  const rootHeartReactions = (rootPost.reactions || {})["❤️"] || [];
  const rootLiked = rootHeartReactions.includes(myPubkey);
  const quotedPost = rootPost.quoteId ? allPosts.find((p) => p.id === rootPost.quoteId) : null;

  const replyProfile = profiles[replyingTo.pubkey];
  const replyName = replyingTo.sender || replyProfile?.display_name || replyProfile?.name || replyingTo.pubkey.slice(0, 12) + "...";

  const handleSend = async () => {
    if (!replyText.trim() || !signer || !relay) return;
    setSending(true);
    try {
      const event = await signChannelMessage(signer, replyText.trim(), FEED_CHANNEL_ID, { id: replyingTo.id });
      await publishWithAck(relay, event);
      onReply({
        id: event.id, pubkey: myPubkey, content: replyText.trim(),
        created_at: event.created_at, sender: myProfile.display_name || myProfile.name || "You",
        replyToId: replyingTo.id,
      });
      setReplyText("");
      showToast("Reply sent!");
    } catch {
      showToast("Failed to send reply");
    }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ backgroundColor: "rgba(0,0,0,0.6)" }} />
      <div
        className="relative flex flex-col w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", maxHeight: "85vh", animation: "modalIn 0.2s ease" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center active:opacity-60" style={{ color: "var(--text)" }}>
            <X size={20} />
          </button>
          <span className="font-semibold text-[15px]" style={{ color: "var(--text)" }}>Thread</span>
          <div className="w-8" />
        </div>

        {/* Scrollable content */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {/* Root post */}
          <div className="px-4 pt-3">
            <div className="flex gap-3">
              <div className="flex flex-col items-center shrink-0">
                <Avatar profile={rootProfile} name={rootName} size={40} />
                {replies.length > 0 && <div className="flex-1 w-px" style={{ backgroundColor: "var(--border)" }} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-[15px] truncate" style={{ color: "var(--text)" }}>{rootName}</span>
                  <span className="text-[13px]" style={{ color: "var(--muted)" }}>· {timeAgo(rootPost.created_at)}</span>
                </div>
                {rootText && (
                  <p className="text-[15px] mt-1 leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>
                    {renderContent(rootText, profiles, allPosts)}
                  </p>
                )}
                {rootImage && (
                  <div className="mt-3 rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                    <img src={rootImage} alt="" className="w-full max-h-[400px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  </div>
                )}
                {quotedPost && <QuotedPost post={quotedPost} profiles={profiles} />}
                {/* Root post actions */}
                <div className="flex items-center justify-between mt-3 pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-center gap-5">
                    <button onClick={() => setReplyingTo(rootPost)} className="flex items-center gap-1.5 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                      <MessageCircle size={15} />
                      {replies.length > 0 && <span>{replies.length}</span>}
                    </button>
                    <button onClick={() => onReact(rootPost.id, rootPost.pubkey, "❤️")} className="flex items-center gap-1.5 text-[13px] active:scale-110 transition-transform" style={{ color: rootLiked ? "#ef4444" : "var(--muted)" }}>
                      <Heart size={15} fill={rootLiked ? "currentColor" : "none"} />
                      {rootHeartReactions.length > 0 && <span>{rootHeartReactions.length}</span>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Replies */}
          {replies.length === 0 && (
            <div className="px-4 py-6 text-center">
              <span className="text-sm" style={{ color: "var(--muted)" }}>No replies yet</span>
            </div>
          )}
          {/* Tree-structured replies */}
          <ReplyTree
            parentId={rootPost.id}
            replies={replies}
            profiles={profiles}
            myPubkey={myPubkey}
            allPosts={allPosts}
            depth={0}
            maxDepth={3}
            onReply={(reply) => setReplyingTo(reply)}
            onReact={onReact}
          />
        </div>

        {/* Reply input */}
        <div className="shrink-0 border-t px-4 py-3" style={{ borderColor: "var(--border)", paddingBottom: "calc(12px + env(safe-area-inset-bottom, 0px))" }}>
          <div className="flex items-center gap-1 mb-2 text-xs" style={{ color: "var(--muted)" }}>
            <span>Replying to</span>
            <span style={{ color: "var(--accent)" }}>@{replyName}</span>
            {replyingTo.id !== rootPost.id && (
              <button onClick={() => setReplyingTo(rootPost)} className="ml-1 underline" style={{ color: "var(--muted)" }}>switch to root</button>
            )}
          </div>
          <div className="flex gap-3 items-end">
            <Avatar profile={myProfile} name={myProfile.display_name || myProfile.name || "Me"} size={32} />
            <div className="flex-1 flex items-end gap-2">
              <textarea
                ref={taRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder={`Reply to @${replyName}...`}
                className="flex-1 bg-transparent text-sm resize-none outline-none"
                style={{ color: "var(--text)", minHeight: "36px", maxHeight: "80px" }}
                rows={1}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              />
              <button
                onClick={handleSend}
                disabled={!replyText.trim() || sending}
                className="px-3 py-1.5 rounded-full text-xs font-bold text-black disabled:opacity-40 shrink-0"
                style={{ backgroundColor: "var(--accent)" }}
              >
                {sending ? <Loader2 size={12} className="animate-spin" /> : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
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
  scrollToPostId?: string | null;
  showToast: (msg: string) => void;
}

export default function FeedView({
  signer, myPubkey, profiles, bindingsRef, relay, connState, scrollToPostId, showToast,
}: FeedViewProps) {
  const [posts, setPosts] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  // null = closed, "new" = new post, Message = reply, { quote: Message } = quote
  const [composeTarget, setComposeTarget] = useState<{ type: "new" | "reply" | "quote"; post: Message | null } | null>(null);
  const [threadPost, setThreadPost] = useState<Message | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);

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
      const qTag = (event.tags || []).find((t: string[]) => t[0] === "q");
      const pTags = (event.tags || []).filter((t: string[]) => t[0] === "p").map((t: string[]) => t[1]);
      const msg: Message = {
        id: event.id, pubkey: event.pubkey, content: event.content,
        created_at: event.created_at, sender,
        ...(replyTag ? { replyToId: replyTag[1] } : {}),
        ...(qTag ? { quoteId: qTag[1] } : {}),
        ...(pTags.length > 0 ? { mentions: pTags } : {}),
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

  // Scroll to post from deep link once loaded
  useEffect(() => {
    if (!scrollToPostId || loading || posts.length === 0) return;
    const timer = setTimeout(() => navigateToPost(scrollToPostId), 300);
    return () => clearTimeout(timer);
  }, [scrollToPostId, loading, posts]);

  const topLevelPosts = posts.filter((p) => !p.replyToId).sort((a, b) => b.created_at - a.created_at);
  const repliesFor = (postId: string) => posts.filter((p) => p.replyToId === postId).sort((a, b) => a.created_at - b.created_at);

  const handlePost = useCallback((msg: Message) => {
    setPosts((prev) => [msg, ...prev]);
  }, []);

  const handleReact = useCallback(async (msgId: string, msgPubkey: string, emoji: string) => {
    if (!signer || !relay) return;
    // Read current state via ref-style approach: use a snapshot
    let alreadyLiked = false;
    setPosts((prev) => {
      const post = prev.find((m) => m.id === msgId);
      alreadyLiked = (post?.reactions?.[emoji] || []).includes(myPubkey);
      // If already liked, remove; otherwise add
      if (alreadyLiked) {
        return prev.map((m) => {
          if (m.id !== msgId) return m;
          const reactions = { ...(m.reactions || {}) };
          reactions[emoji] = (reactions[emoji] || []).filter((pk) => pk !== myPubkey);
          if (reactions[emoji].length === 0) delete reactions[emoji];
          return { ...m, reactions };
        });
      } else {
        return prev.map((m) => {
          if (m.id !== msgId) return m;
          const reactions = { ...(m.reactions || {}) };
          reactions[emoji] = [...(reactions[emoji] || []), myPubkey];
          return { ...m, reactions };
        });
      }
    });
    // Now publish the corresponding event
    if (alreadyLiked) {
      try {
        const event = await signer.signEvent({ kind: 7, created_at: Math.floor(Date.now() / 1000), tags: [["e", msgId], ["p", msgPubkey]], content: "-" });
        await relay.publish(event);
      } catch {
        // Revert: re-add like
        setPosts((prev) => prev.map((m) => { if (m.id !== msgId) return m; const r = { ...(m.reactions || {}) }; r[emoji] = [...(r[emoji] || []), myPubkey]; return { ...m, reactions: r }; }));
      }
    } else {
      try {
        const event = await signReaction(signer, msgId, msgPubkey, emoji);
        await relay.publish(event);
      } catch {
        // Revert: remove like
        setPosts((prev) => prev.map((m) => { if (m.id !== msgId) return m; const r = { ...(m.reactions || {}) }; r[emoji] = (r[emoji] || []).filter((pk) => pk !== myPubkey); if (r[emoji].length === 0) delete r[emoji]; return { ...m, reactions: r }; }));
      }
    }
  }, [signer, myPubkey, relay]);

  const navigateToPost = useCallback((id: string) => {
    const el = feedScrollRef.current?.querySelector(`[data-post-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background 0.3s";
      el.style.background = "rgba(0,236,151,0.12)";
      setTimeout(() => { el.style.background = ""; }, 1200);
    }
  }, []);

  const handleShare = useCallback(async (msg: Message) => {
    const url = `${window.location.origin}${window.location.pathname}?post=${msg.id}`;
    const profile = profiles[msg.pubkey];
    const name = msg.sender || profile?.display_name || profile?.name || "Someone";
    const text = `${name} on Legion: "${msg.content.slice(0, 100)}${msg.content.length > 100 ? "..." : ""}"`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Legion Post", text, url });
      } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      showToast("Link copied!");
    }
  }, [profiles, showToast]);

  const myProfile = profiles[myPubkey] || {};

  return (
    <div className="flex flex-col w-full h-full relative">
      <div ref={feedScrollRef} className="flex-1 overflow-y-auto">
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
            allPosts={posts}
            onReact={handleReact}
            onReply={(m) => setComposeTarget({ type: "reply", post: m })}
            onQuote={(m) => setComposeTarget({ type: "quote", post: m })}
            onNavigateToPost={navigateToPost}
            onShare={handleShare}
            onOpenThread={(m) => setThreadPost(m)}
            replies={repliesFor(msg.id)}
          />
        ))}
        {/* Bottom spacer so last post isn't clipped by FAB */}
        <div className="h-20" />
      </div>

      {/* FAB */}
      {composeTarget === null && (
        <button
          onClick={() => setComposeTarget({ type: "new", post: null })}
          className="absolute right-5 w-14 h-14 rounded-full flex items-center justify-center shadow-lg active:scale-95 transition-transform"
          style={{ backgroundColor: "var(--accent)", color: "#000", boxShadow: "0 4px 20px rgba(0,236,151,0.3)", bottom: "calc(80px + env(safe-area-inset-bottom, 0px))" }}
        >
          <Plus size={28} />
        </button>
      )}

      {/* Compose modal */}
      {composeTarget !== null && (
        <ComposeModal
          replyTo={composeTarget.type === "reply" ? composeTarget.post : null}
          quotePost={composeTarget.type === "quote" ? composeTarget.post : null}
          allPosts={posts}
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

      {/* Thread modal */}
      {threadPost && (
        <ThreadModal
          rootPost={threadPost}
          allPosts={posts}
          myPubkey={myPubkey}
          profiles={profiles}
          myProfile={myProfile}
          signer={signer}
          relay={relay}
          onClose={() => setThreadPost(null)}
          onReply={handlePost}
          onReact={handleReact}
          showToast={showToast}
        />
      )}
    </div>
  );
}
