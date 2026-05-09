import type { ConnectionState } from "../lib/nostr";

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
}: MessageInputProps) {
  return (
    <>
      {replyTo && (
        <div className="px-4 py-1.5 flex items-center gap-2 text-xs" style={{ backgroundColor: "var(--surface)", borderTop: "1px solid var(--border)" }}>
          <span style={{ color: "var(--muted)" }}>Replying to <strong>{replyingTo}</strong></span>
          <button
            onClick={() => setReplyTo(null)}
            className="ml-auto w-8 h-8 rounded-full flex items-center justify-center shrink-0 active:opacity-60"
            style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--muted)" }}
          >
            ✕
          </button>
        </div>
      )}
      <div className="p-3 border-t flex items-end gap-2" style={{ borderColor: "var(--border)" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connState === "connected" ? "Say something..." : "Waiting for connection..."}
          rows={1}
          aria-label="Message input"
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
          aria-label="Send message"
          className="w-10 h-10 rounded-full shrink-0 flex items-center justify-center font-bold text-black disabled:opacity-40 transition-opacity"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {sending ? "..." : "↑"}
        </button>
      </div>
    </>
  );
}
