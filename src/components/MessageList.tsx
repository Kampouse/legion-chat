import { useMemo, Fragment, useState, useRef, useCallback, useEffect, type RefObject } from "react";
import type { Message, Profile } from "../lib/types";
import type { BindingCache } from "../lib/binding";
import { Reply, Trash2, X, ChevronDown } from "lucide-react";
import ContextMenu from "./ContextMenu";

// ── Content parsing with image embeds ──

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?$/i;
const IMAGE_HOSTS = [
  /i\.imgur\.com/i,
  /cdn\.discordapp\.com\/attachments/i,
  /pbs\.twimg\.com\/media/i,
  /media\.tenor\.com/i,
  /i\.redd\.it/i,
  /preview\.redd\.it/i,
  /b\.catgirls\.party/i,
  /files\.catbox\.moe/i,
  /ipfs\.near\.social/i,
  /5rz7vjvewwhjk4pr62p473cslcpuihanwcl7pjyshl6vhqbjy2ya\.arweave\.net/i,
];
// URLs that look like image pages (no extension but serve images)
const IMAGE_PATH_HINTS = /\/(image|img|media|photo|pic|thumb|preview|attachment)\//i;

function isImageUrl(url: string): boolean {
  if (IMAGE_EXTS.test(url)) return true;
  try {
    const u = new URL(url);
    for (const re of IMAGE_HOSTS) {
      if (re.test(u.host)) return true;
    }
    // Check for format=jpg etc in query params
    if (/[?&]format=(jpg|jpeg|png|gif|webp|avif)/i.test(u.search)) return true;
  } catch {}
  return false;
}

function parseContent(content: string) {
  const trimmed = content.trim();
  // If the entire message is a single URL, always try rendering as image first
  const isOnlyUrl = /^https?:\/\/[^\s]+$/.test(trimmed);
  if (isOnlyUrl) return [{ type: "image" as const, value: trimmed }];

  const segments: { type: "text" | "link" | "image"; value: string }[] = [];
  const linkRe = /(https?:\/\/[^\s]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(content)) !== null) {
    if (m.index > last) segments.push({ type: "text", value: content.slice(last, m.index) });
    const url = m[1];
    segments.push({ type: isImageUrl(url) ? "image" : "link", value: url });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: "text", value: content.slice(last) });
  return segments;
}

function ImagePreview({ url }: { url: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [error, setError] = useState(false);
  if (error) return <a href={url} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: "var(--accent)" }}>{url}</a>;

  return (
    <>
      <div className="mt-1 max-w-[280px]">
        <img
          src={url}
          alt=""
          onClick={() => setLightbox(true)}
          onError={() => setError(true)}
          className="rounded-lg cursor-pointer object-cover"
          style={{ maxHeight: "160px", width: "100%", border: "1px solid var(--border)" }}
        />
      </div>
      {lightbox && (
        <div
          onClick={() => setLightbox(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.92)", display: "flex",
            alignItems: "center", justifyContent: "center",
            padding: "16px", cursor: "zoom-out",
            animation: "lbFadeIn 0.15s ease",
          }}
        >
          <img
            src={url}
            alt=""
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "100%", maxHeight: "100%",
              objectFit: "contain", borderRadius: "8px",
              cursor: "default",
            }}
          />
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "absolute", bottom: "20px", right: "20px",
              background: "rgba(255,255,255,0.15)", padding: "8px 14px",
              borderRadius: "8px", color: "#fff", fontSize: "13px",
              textDecoration: "none", display: "flex", alignItems: "center", gap: "6px",
            }}
          >
            Open ↗
          </a>
        </div>
      )}
    </>
  );
}

function ParsedContent({ content }: { content: string }) {
  const segments = useMemo(() => parseContent(content), [content]);
  return (
    <>
      {segments.map((s, i) =>
        s.type === "image" ? (
          <ImagePreview key={i} url={s.value} />
        ) : s.type === "link" ? (
          <a key={i} href={s.value} target="_blank" rel="noopener noreferrer" className="underline break-all" style={{ color: "var(--accent)" }}>{s.value}</a>
        ) : (
          <span key={i}>{s.value}</span>
        )
      )}
    </>
  );
}

// ── Reaction display ──

function ReactionBar({ reactions, myPubkey }: { reactions?: Record<string, string[]>; myPubkey: string }) {
  if (!reactions) return null;
  const entries = Object.entries(reactions).filter(([, pks]) => pks.length > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {entries.map(([emoji, pks]) => (
        <span
          key={emoji}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[11px]"
          style={{
            backgroundColor: pks.includes(myPubkey) ? "rgba(0,236,151,0.15)" : "var(--surface)",
            border: `1px solid ${pks.includes(myPubkey) ? "var(--accent)" : "var(--border)"}`,
            color: "var(--text)",
          }}
        >
          {emoji} {pks.length > 1 && <span style={{ color: "var(--muted)" }}>{pks.length}</span>}
        </span>
      ))}
    </div>
  );
}

// ── Helpers ──

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

// ── Long-press detection ──
const LONG_PRESS_MS = 400;
const LONG_PRESS_MOVE_THRESHOLD = 10;

// ── Props ──

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
  onReact: (msgId: string, msgPubkey: string, emoji: string) => void;
  onCopy: (text: string) => void;
  loading?: boolean;
  searchQuery?: string;
  typingUsers?: string[];
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
  onReact,
  onCopy,
  loading = false,
  searchQuery = "",
  typingUsers = [],
}: MessageListProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // ── Context menu state ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: Message } | null>(null);

  // ── Long-press refs (mobile context menu) ──
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);

  // ── Message animation: track which IDs are "new" ──
  const prevIdSet = useRef<Set<string>>(new Set());
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(messages.map((m) => m.id));
    const fresh = new Set<string>();
    for (const id of currentIds) {
      if (!prevIdSet.current.has(id)) fresh.add(id);
    }
    prevIdSet.current = currentIds;
    if (fresh.size > 0) setNewIds(fresh);
    const t = setTimeout(() => setNewIds(new Set()), 400);
    return () => clearTimeout(t);
  }, [messages]);

  // ── Search ──
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

  // ── Context menu handlers ──
  const openContextMenu = useCallback((e: React.MouseEvent, msg: Message) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, msg });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent, msg: Message) => {
    if (confirmDeleteId) return;
    if (msg.pending) return;
    const t = e.touches[0];
    longPressStart.current = { x: t.clientX, y: t.clientY };
    longPressTimer.current = setTimeout(() => {
      setCtxMenu({ x: t.clientX, y: t.clientY - 60, msg });
      longPressStart.current = null;
    }, LONG_PRESS_MS);
  }, [confirmDeleteId]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!longPressStart.current || !longPressTimer.current) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - longPressStart.current.x);
    const dy = Math.abs(t.clientY - longPressStart.current.y);
    if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
      longPressStart.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }, []);

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

          const prev = i > 0 ? filtered[i - 1] : undefined;
          const sameSender = !!(prev && prev.pubkey === msg.pubkey && msg.created_at - prev.created_at < 120);
          const next = i < filtered.length - 1 ? filtered[i + 1] : undefined;
          const nextSameSender = !!(next && next.pubkey === msg.pubkey && next.created_at - msg.created_at < 120);
          const isLastInGroup = sameSender && !nextSameSender;

          const showDateSep = !prev || isDifferentDay(prev.created_at, msg.created_at);
          const isNew = newIds.has(msg.id) && !msg.pending;

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
                className={`flex items-end gap-2 ${mine ? "flex-row-reverse" : "flex-row"} ${sameSender ? "mt-0.5" : "mt-3"} relative ${isNew ? "msg-slide-in" : ""}`}
                onContextMenu={(e) => { if (!msg.pending) openContextMenu(e, msg); }}
                onTouchStart={(e) => handleTouchStart(e, msg)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
              >
                {!mine && (
                  <div className="w-8 shrink-0 flex items-center justify-center">
                    {!sameSender && (
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
                  {!mine && !sameSender && (
                    <span className="text-[10px] font-mono mb-0.5 px-1" style={{ color: "var(--muted)" }}>{displayName}</span>
                  )}
                  <div
                    className="px-3 py-2 text-sm break-words leading-relaxed relative select-none"
                    style={{
                      backgroundColor: msg.failed ? "rgba(239,68,68,0.1)" : mine ? "rgba(0,236,151,0.15)" : "var(--surface)",
                      border: msg.failed ? "1px solid rgba(239,68,68,0.3)" : mine ? "none" : "1px solid var(--border)",
                      borderRadius: mine ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
                      opacity: msg.pending ? 0.6 : 1,
                    }}
                  >
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
                        {msg.replyToContent && (() => {
                          const imgMatch = msg.replyToContent.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg|avif)(\?.*)?)\s*$/i);
                          if (imgMatch) {
                            const textContent = msg.replyToContent.replace(imgMatch[0], "").trim();
                            return (
                              <span className="ml-1">
                                {textContent && <span className="truncate inline-block max-w-[120px] align-bottom">{textContent.length > 40 ? textContent.slice(0, 40) + "..." : textContent} </span>}
                                <img src={imgMatch[1]} alt="" className="inline-block max-h-[40px] max-w-[60px] rounded object-cover align-middle ml-1" style={{ border: "1px solid var(--border)" }} onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                              </span>
                            );
                          }
                          return <span className="ml-1 truncate inline-block max-w-[200px] align-bottom" style={{ color: "var(--muted)" }}>{msg.replyToContent.length > 60 ? msg.replyToContent.slice(0, 60) + "..." : msg.replyToContent}</span>;
                        })()}
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
                  {/* Reactions */}
                  <ReactionBar reactions={msg.reactions} myPubkey={myPubkey} />
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

        {/* Typing indicator */}
        {typingUsers.length > 0 && (
          <div className="flex items-center gap-2 px-1 py-1 mt-1">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: "var(--muted)", animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: "var(--muted)", animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ backgroundColor: "var(--muted)", animationDelay: "300ms" }} />
            </div>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              {typingUsers.join(", ")} {typingUsers.length === 1 ? "is" : "are"} typing...
            </span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 w-10 h-10 rounded-full flex items-center justify-center shadow-lg z-10"
          style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
        >
          <ChevronDown size={18} />
        </button>
      )}
      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          msg={ctxMenu.msg}
          myPubkey={myPubkey}
          onReply={onReply}
          onReact={onReact}
          onDelete={(id) => setConfirmDeleteId(id)}
          onCopy={onCopy}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}
