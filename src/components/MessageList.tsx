import { useMemo, Fragment, useState, type RefObject } from "react";
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
}: MessageListProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const clearSelection = () => setSelectedId(null);

  /** Action button bar shared between desktop hover and mobile tap-to-select */
  const actionButtons = (msg: Message, isMine: boolean, variant: "inline" | "floating") => {
    const baseBtn = "w-7 h-7 rounded flex items-center justify-center text-xs";
    const btnStyle = (color: string) => ({
      backgroundColor: "var(--surface)",
      border: "1px solid var(--border)",
      color,
    });
    if (variant === "floating") {
      return (
        <div
          className="flex items-center gap-1 px-2 py-1 rounded-full shadow-lg"
          style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onReply(msg); clearSelection(); }}
            className={baseBtn}
            style={btnStyle("var(--muted)")}
            title="Reply"
          >
            ↩
          </button>
          {isMine && (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(msg.id); clearSelection(); }}
              className={baseBtn}
              style={btnStyle("#ef4444")}
              title="Delete"
            >
              ✕
            </button>
          )}
        </div>
      );
    }
    return (
      <div className={`flex items-center gap-0.5 ${isMine ? "order-first" : "order-last"}`}>
        <button
          onClick={() => onReply(msg)}
          className="w-6 h-6 rounded flex items-center justify-center text-[11px]"
          style={btnStyle("var(--muted)")}
          title="Reply"
        >
          ↩
        </button>
        {isMine && (
          <button
            onClick={() => setConfirmDeleteId(msg.id)}
            className="w-6 h-6 rounded flex items-center justify-center text-[11px]"
            style={btnStyle("#ef4444")}
            title="Delete"
          >
            ✕
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Backdrop to dismiss selection on tap-away (mobile) */}
      {selectedId && (
        <div
          className="fixed inset-0 z-20"
          onTouchEnd={(e) => { e.preventDefault(); clearSelection(); }}
          onClick={clearSelection}
        />
      )}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-1 relative z-10">
        {messages.length === 0 && (
          <div className="text-center py-12">
            {loading ? (
              <>
                <div className="animate-pulse text-2xl mb-3">💬</div>
                <p className="text-sm" style={{ color: "var(--muted)" }}>Loading messages...</p>
              </>
            ) : (
              <p className="text-sm" style={{ color: "var(--muted)" }}>No messages yet. Be the first to speak.</p>
            )}
          </div>
        )}
        {messages.map((msg, i) => {
          const mine = msg.pubkey === myPubkey;
          const profile = profiles[msg.pubkey];
          const nearName = msg.sender || msg.pubkey.slice(0, 8) + "...";
          const displayName = mine ? "you" : nearName;
          const showAvatar = !mine;
          const showSender = !mine;

          const prev = i > 0 ? messages[i - 1] : undefined;
          const next = i < messages.length - 1 ? messages[i + 1] : undefined;

          const sameSender = !!(prev && prev.pubkey === msg.pubkey && msg.created_at - prev.created_at < 120);
          const nextSameSender = !!(next && next.pubkey === msg.pubkey && next.created_at - msg.created_at < 120);
          const isLastInGroup = sameSender && !nextSameSender;

          const showDateSep = !prev || isDifferentDay(prev.created_at, msg.created_at);
          const isHovered = hoveredId === msg.id;
          const isSelected = selectedId === msg.id;
          const showActions = (isHovered || isSelected) && !msg.pending;

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
                onTouchEnd={(e) => {
                  if (confirmDeleteId) return; // don't interfere with delete dialog
                  e.preventDefault();
                  setSelectedId((prev) => (prev === msg.id ? null : msg.id));
                }}
              >
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
                    {/* Desktop inline action buttons (hover or tap-selected) */}
                    {showActions && actionButtons(msg, mine, "inline")}
                    <div
                      className="px-3 py-2 text-sm break-words leading-relaxed relative"
                      style={{
                        backgroundColor: msg.failed ? "rgba(239,68,68,0.1)" : mine ? "rgba(0,236,151,0.15)" : "var(--surface)",
                        border: msg.failed ? "1px solid rgba(239,68,68,0.3)" : mine ? "none" : "1px solid var(--border)",
                        borderRadius: mine ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
                        opacity: msg.pending ? 0.6 : 1,
                        outline: isSelected ? "2px solid var(--accent)" : undefined,
                        outlineOffset: 1,
                      }}
                    >
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
                      <ParsedContent content={msg.content} />
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
                  </div>
                  {/* Mobile floating action bar — appears below bubble on tap-select */}
                  {isSelected && !msg.pending && (
                    <div className="mt-1 md:hidden" style={{ pointerEvents: "auto" }}>
                      {actionButtons(msg, mine, "floating")}
                    </div>
                  )}
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
                  className="absolute z-50"
                  style={{
                    top: "100%",
                    right: 0,
                    marginTop: 4,
                  }}
                >
                  <div
                    className="rounded-lg shadow-xl p-3 min-w-[260px]"
                    style={{
                      backgroundColor: "var(--bg)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
                      Delete this message?
                    </p>
                    <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--muted)" }}>
                      This asks the relay to remove it. Other relays may still have a copy.
                    </p>
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-3 py-1 text-xs rounded"
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
                        className="px-3 py-1 text-xs rounded font-semibold"
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
