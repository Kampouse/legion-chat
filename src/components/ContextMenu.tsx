import { useEffect, useRef, useState } from "react";
import type { Message } from "../lib/types";
import { Reply, Trash2, Copy } from "lucide-react";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface ContextMenuProps {
  x: number;
  y: number;
  msg: Message;
  myPubkey: string;
  onReply: (msg: Message) => void;
  onReact: (msgId: string, msgPubkey: string, emoji: string) => void;
  onDelete: (msgId: string) => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}

export default function ContextMenu({
  x,
  y,
  msg,
  myPubkey,
  onReply,
  onReact,
  onDelete,
  onCopy,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [showReactions, setShowReactions] = useState(false);

  // Adjust position so menu stays in viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (x + rect.width > vw - 8) nx = vw - rect.width - 8;
    if (ny + rect.height > vh - 8) ny = vh - rect.height - 8;
    if (nx < 8) nx = 8;
    if (ny < 8) ny = 8;
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Close on click outside or Escape
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const mine = msg.pubkey === myPubkey;

  return (
    <div
      ref={ref}
      className="fixed z-[100] rounded-xl overflow-hidden shadow-2xl"
      style={{
        left: pos.x,
        top: pos.y,
        backgroundColor: "var(--bg)",
        border: "1px solid var(--border)",
        minWidth: "180px",
        animation: "ctxFadeIn 0.12s ease-out",
      }}
    >
      {/* Reaction emoji row */}
      <div
        className="flex items-center justify-around px-2 py-2"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => { onReact(msg.id, msg.pubkey, emoji); onClose(); }}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-lg active:scale-90 transition-transform"
            style={{ backgroundColor: "transparent" }}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Action items */}
      <div className="py-1">
        <button
          onClick={() => { onReply(msg); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left active:opacity-60"
          style={{ color: "var(--text)" }}
        >
          <Reply size={15} style={{ color: "var(--muted)" }} />
          Reply
        </button>
        <button
          onClick={() => { onCopy(msg.content); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left active:opacity-60"
          style={{ color: "var(--text)" }}
        >
          <Copy size={15} style={{ color: "var(--muted)" }} />
          Copy Text
        </button>
        {mine && (
          <button
            onClick={() => { onDelete(msg.id); onClose(); }}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left active:opacity-60"
            style={{ color: "#ef4444" }}
          >
            <Trash2 size={15} />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
