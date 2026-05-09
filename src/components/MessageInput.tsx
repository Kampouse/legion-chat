import { useState, useRef, useCallback } from "react";
import type { ConnectionState } from "../lib/nostr";
import { X, SmilePlus, ArrowUp, Loader2 } from "lucide-react";
import EmojiPicker from "./EmojiPicker";

interface MessageInputProps {
  input: string;
  setInput: (v: string) => void;
  sending: boolean;
  connState: ConnectionState;
  handleSend: () => void;
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  replyTo: string | null;
  setReplyTo: (v: string | null) => void;
  replyingTo: string;
  replyingToContent?: string;
}

export default function MessageInput({
  input,
  setInput,
  sending,
  connState,
  handleSend,
  handleKeyDown,
  replyTo,
  setReplyTo,
  replyingTo,
  replyingToContent,
}: MessageInputProps) {
  const [showEmoji, setShowEmoji] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const insertEmoji = useCallback((emoji: string) => {
    const el = taRef.current;
    if (!el) { setInput(input + emoji); return; }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const next = before + emoji + after;
    setInput(next);
    // Restore cursor after React re-render
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + emoji.length;
      el.focus();
    });
  }, [input, setInput]);

  return (
    <>
      {replyTo && (
        <div className="px-4 py-1.5 flex items-center gap-2 text-xs" style={{ backgroundColor: "var(--surface)", borderTop: "1px solid var(--border)" }}>
          <div className="flex-1 min-w-0">
            <span style={{ color: "var(--muted)" }}>Replying to <strong style={{ color: "var(--text)" }}>{replyingTo}</strong></span>
            {replyingToContent && (
              <p className="truncate mt-0.5" style={{ color: "var(--muted)", maxWidth: "300px" }}>{replyingToContent}</p>
            )}
          </div>
          <button
            onClick={() => setReplyTo(null)}
            className="ml-auto w-8 h-8 rounded-full flex items-center justify-center shrink-0 active:opacity-60"
            style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--muted)" }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="p-3 border-t flex items-end gap-2 relative" style={{ borderColor: "var(--border)" }}>
        {/* Emoji picker popup */}
        {showEmoji && (
          <EmojiPicker
            onSelect={insertEmoji}
            onClose={() => setShowEmoji(false)}
          />
        )}
        {/* Emoji toggle */}
        <button
          onClick={() => setShowEmoji((v) => !v)}
          className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center text-lg active:opacity-60 transition-opacity"
          style={{
            backgroundColor: showEmoji ? "var(--accent)" : "var(--surface)",
            border: "1px solid var(--border)",
            color: showEmoji ? "#000" : "var(--muted)",
          }}
          aria-label="Emoji picker"
        >
          <SmilePlus size={18} />
        </button>
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connState === "connected" ? "Say something..." : "Waiting for connection..."}
          rows={1}
          aria-label="Message input"
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
          onClick={handleSend}
          disabled={!input.trim() || sending || connState !== "connected"}
          aria-label="Send message"
          className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold text-black disabled:opacity-40 transition-opacity"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
        </button>
      </div>
    </>
  );
}
