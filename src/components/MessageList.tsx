import { useMemo, Fragment, useState, useRef, useCallback, type RefObject } from "react";
import type { Message, Profile } from "../lib/types";
import type { BindingCache } from "../lib/binding";

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

function timeOnly(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dateSeparatorLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function isDifferentDay(a: number, b: number): boolean {
  return new Date(a * 1000).toDateString() !== new Date(b * 1000).toDateString();
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// ── Swipe constants ──
const SWIPE_THRESHOLD = 60;   // px to trigger action
const SWIPE_MAX = 100;        // max drag distance (clamped)

interface MessageListProps {
  messages: Message[];
  myPubkey: string;
  profiles: Record<string, Profile>;
  bindingsRef: RefObject<BindingCache | null>;
  autoScroll: boolean;
  showScrollBtn: boolean;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  scrollToBottom: () => void;
  onReply: (msg: Message) => void;
  onDelete: (msgId: string) => void;
  loading?: boolean;
  searchQuery?: string;
}

export default function MessageList({
  messages,
  myPubkey,
  profiles,
  bindingsRef: _bindingsRef,
  autoScroll: _autoScroll,
  showScrollBtn,
  messagesEndRef,
  scrollRef,
  handleScroll,
  scrollToBottom,
  onReply,
  onDelete,
  loading = false,
  searchQuery = "",
}: MessageListProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── Swipe state (per-row via refs) ──
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const touchStartTime = useRef(0);
  const draggingId = useRef<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState<Record<string, number>>({});

  const clearSwipe = useCallback(() => {
    draggingId.current = null;
    setSwipeOffset({});
  }, []);

  // Search: parse from:user + text filters
  const q = searchQuery.trim();
  const fromMatch = q.match(/\bfrom:(\S+)/i);
  const fromFilter = fromMatch ? fromMatch[1].toLowerCase() : null;
  const textFilter = q.replace(/\bfrom:\S+/i, "").trim().toLowerCase();

  const filtered = (fromFilter || textFilter)
    ? messages.filter((m) => {
        if (fromFilter) {
          const sender = (m.sender || m.pubkey.slice(0, 8)).toLowerCase();
          if (!sender.includes(fromFilter)) return false;
        }
        if (textFilter) {
          if (!m.content.toLowerCase().includes(textFilter)) return false;
        }
        return true;
      })
    : messages;

  const highlight = useCallback((text: string): React.ReactNode => {
    if (!textFilter) return text;
    const idx = text.toLowerCase().indexOf(textFilter);
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ backgroundColor: "var(--accent)", color: "#000", borderRadius: "2px", padding: "0 1px" }}>{text.slice(idx, idx + textFilter.length)}</mark>
        {highlight(text.slice(idx + textFilter.length))}
      </>
    );
  }, [textFilter]);

  return (
    <>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-1 relative z-10">
        {filtered.length === 0 && (
          <div className="text-center py-12">
            {loading ? (
              <>
                <div className="animate-pulse text-2xl mb-3">💬</div>
                <p className="text-sm" style={{ color: "var(--muted)" }}>Loading messages...</p>
              </>
            ) : q ? (
              <p className="text-sm" style={{ color: "var(--muted)" }}>No messages match "{searchQuery}"</p>
            ) : (
              <p className="text-sm" style={{ color: "var(--muted)" }}>No messages yet. Be the first to speak.</p>
            )}
          </div>
        )}
        {filtered.map((msg, i) => {
          const mine = msg.pubkey === myPubkey;
          const profile = profiles[msg.pubkey];
          const nearName = msg.sender || msg.pubkey.slice(0, 8) + "...";
          const displayName = mine ? "you" : nearName;
          const showAvatar = !mine;
          const showSender = !mine;

          const prev = i > 0 ? filtered[i - 1] : undefined;
          const sameSender = !!(prev && prev.pubkey === msg.pubkey && msg.created_at - prev.created_at < 120);
          const next = i < filtered.length - 1 ? filtered[i + 1] : undefined;
          const nextSameSender = !!(next && next.pubkey === msg.pubkey && next.created_at - msg.created_at < 120);
          const isLastInGroup = sameSender && !nextSameSender;

          const showDateSep = !prev || isDifferentDay(prev.created_at, msg.created_at);
          const isHovered = hoveredId === msg.id;
          const offset = swipeOffset[msg.id] || 0;
          const absOffset = Math.abs(offset);
          // Show hint color when past 30% of threshold
          const hinting = absOffset > SWIPE_THRESHOLD * 0.3;

          return (
            <Fragment key={msg.id}>
              {showDateSep && (
                <div className="flex items-center gap-3 py-2 my-2">
                  <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
                  <span className="text-[10px] font-mono shrink-0" style={{ color: "var(--muted)" }}>
                    {dateSeparatorLabel(msg.created_at)}
                  </span>
                  <div className="flex-1 h-px" style={{ backgroundColor: "var(--border)" }} />
                </div>
              )}
              <div
                className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : "flex-row"} ${sameSender ? "mt-0.5" : "mt-3"} group relative`}
                onMouseEnter={() => setHoveredId(msg.id)}
                onMouseLeave={() => setHoveredId(null)}
                onTouchStart={(e) => {
                  if (confirmDeleteId) return;
                  if (msg.pending) return;
                  const t = e.touches[0];
                  touchStartX.current = t.clientX;
                  touchStartY.current = t.clientY;
                  touchStartTime.current = Date.now();
                  draggingId.current = msg.id;
                }}
                onTouchMove={(e) => {
                  if (draggingId.current !== msg.id) return;
                  const t = e.touches[0];
                  const dx = t.clientX - touchStartX.current;
                  const dy = t.clientY - touchStartY.current;
                  // If scrolling vertically, cancel swipe
                  if (Math.abs(dy) > Math.abs(dx) + 5) {
                    draggingId.current = null;
                    setSwipeOffset((prev) => ({ ...prev, [msg.id]: 0 }));
                    return;
                  }
                  // Clamp: only allow swipe-right (reply) and swipe-left for own messages (delete)
                  let clamped = dx;
                  if (dx > 0) clamped = Math.min(dx, SWIPE_MAX);
                  else if (dx < 0 && mine) clamped = Math.max(dx, -SWIPE_MAX);
                  else { clamped = 0; draggingId.current = null; }
                  setSwipeOffset((prev) => ({ ...prev, [msg.id]: clamped }));
                }}
                onTouchEnd={() => {
                  if (draggingId.current !== msg.id) return;
                  const finalOffset = swipeOffset[msg.id] || 0;
                  const elapsed = Date.now() - touchStartTime.current;

                  if (finalOffset > SWIPE_THRESHOLD) {
                    onReply(msg);
                  } else if (finalOffset < -SWIPE_THRESHOLD && mine) {
                    setConfirmDeleteId(msg.id);
                  }
                  draggingId.current = null;
                  setSwipeOffset((prev) => ({ ...prev, [msg.id]: 0 }));
                }}
              >
                {!mine && (
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
                )}
                <div className={`flex flex-col ${mine ? "items-end" : "items-start"} ${mine ? "max-w-[90%] md:max-w-[80%]" : "max-w-[85%] md:max-w-[70%]"}`}>
                  {showSender && !sameSender && (
                    <span className="text-[10px] font-mono mb-0.5 px-1" style={{ color: "var(--muted)" }}>{displayName}</span>
                  )}
                  <div className="flex items-end gap-1.5">
                    {/* Desktop hover actions */}
                    {isHovered && !msg.pending && (
                      <button
                        onClick={() => onReply(msg)}
                        className="w-6 h-6 rounded flex items-center justify-center text-[11px] hidden md:flex"
                        style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--muted)" }}
                        title="Reply"
                      >
                        ↩
                      </button>
                    )}
                    <div
                      className="px-3 py-2 text-sm break-words leading-relaxed relative select-none"
                      style={{
                        backgroundColor: msg.failed ? "rgba(239,68,68,0.1)" : mine ? "rgba(0,236,151,0.15)" : "var(--surface)",
                        border: msg.failed ? "1px solid rgba(239,68,68,0.3)" : mine ? "none" : "1px solid var(--border)",
                        borderRadius: mine ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
                        opacity: msg.pending ? 0.6 : 1,
                        transform: `translateX(${offset}px)`,
                        transition: draggingId.current === msg.id ? "none" : "transform 0.2s ease",
                        // Tint background when swiping
                        boxShadow: hinting && offset > 0
                          ? `inset ${SWIPE_MAX}px 0 40px -20px rgba(0,236,151,0.15)`
                          : hinting && offset < 0
                          ? `inset -${SWIPE_MAX}px 0 40px -20px rgba(239,68,68,0.15)`
                          : "none",
                      }}
                    >
                      {/* Swipe hint icons — visible under the bubble as it slides */}
                      {offset > 15 && (
                        <div className="absolute top-1/2 -translate-y-1/2 flex items-center gap-1"
                          style={{ right: "100%", marginRight: 8, color: "var(--accent)", opacity: Math.min(absOffset / SWIPE_THRESHOLD, 1) }}>
                          <span className="text-lg">↩</span>
                          <span className="text-[10px] font-medium">Reply</span>
                        </div>
                      )}
                      {offset < -15 && mine && (
                        <div className="absolute top-1/2 -translate-y-1/2 flex items-center gap-1"
                          style={{ left: "100%", marginLeft: 8, color: "#ef4444", opacity: Math.min(absOffset / SWIPE_THRESHOLD, 1) }}>
                          <span className="text-[10px] font-medium">Delete</span>
                          <span className="text-lg">✕</span>
                        </div>
                      )}
                      {/* Reply preview */}
                      {msg.replyToId && (
                        <div
                          className="mb-1.5 px-2 py-1 rounded text-xs border-l-2"
                          style={{
                            backgroundColor: "rgba(0,236,151,0.05)",
                            borderLeftColor: "var(--accent)",
                            color: "var(--muted)",
                          }}
                        >
                          <span className="font-semibold" style={{ color: "var(--text)" }}>{msg.replyToSender || "unknown"}</span>
                          {msg.replyToContent && (
                            <span className="ml-1 truncate inline-block max-w-[200px] align-bottom" style={{ color: "var(--muted)" }}>{msg.replyToContent.length > 60 ? msg.replyToContent.slice(0, 60) + "..." : msg.replyToContent}</span>
                          )}
                        </div>
                      )}
                      {q ? <>{highlight(msg.content)}</> : <ParsedContent content={msg.content} />}
                      {msg.failed && <span className="text-[9px] text-red-400 ml-1">(failed)</span>}
                      {isLastInGroup && (
                        <div className="text-right mt-0.5">
                          <span className="text-[9px] opacity-50">
                            {timeOnly(msg.created_at)}
                            {msg.pending && " · sending..."}
                          </span>
                        </div>
                      )}
                    </div>
                    {isHovered && mine && !msg.pending && (
                      <button
                        onClick={() => setConfirmDeleteId(msg.id)}
                        className="w-6 h-6 rounded flex items-center justify-center text-[11px] hidden md:flex"
                        style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "#ef4444" }}
                        title="Delete"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {!sameSender && (
                    <span className="text-[9px] mt-0.5 px-1" style={{ color: "var(--muted)" }}>
                      {timeOnly(msg.created_at)}
                      {msg.pending && " · sending..."}
                    </span>
                  )}
                </div>
              </div>
              {confirmDeleteId === msg.id && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center"
                  onClick={() => setConfirmDeleteId(null)}
                >
                  <div className="absolute inset-0 bg-black/40" />
                  <div
                    className="relative rounded-xl shadow-2xl p-4 min-w-[280px] max-w-[90vw]"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      backgroundColor: "var(--bg)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                      Delete this message?
                    </p>
                    <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
                      Removes from your view instantly. Relay deletion is sent in the background.
                    </p>
                    <div className="flex justify-end gap-2 mt-4">
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-4 py-2 text-xs rounded-lg font-medium"
                        style={{
                          backgroundColor: "var(--surface)",
                          border: "1px solid var(--border)",
                          color: "var(--text)",
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          onDelete(msg.id);
                          setConfirmDeleteId(null);
                        }}
                        className="px-4 py-2 text-xs rounded-lg font-semibold"
                        style={{
                          backgroundColor: "#dc2626",
                          border: "1px solid #dc2626",
                          color: "#fff",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Fragment>
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
    </>
  );
}
