import { useEffect, useRef, useState, useCallback } from "react";
import type { Message } from "../lib/types";
import { Reply, Trash2, Copy } from "lucide-react";

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface ContextMenuProps {
  x: number;
  y: number;
  msg: Message;
  myPubkey: string;
  isTouch: boolean;
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
  isTouch,
  onReply,
  onReact,
  onDelete,
  onCopy,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const dragStartY = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // ── Desktop: floating context menu ──
  useEffect(() => {
    if (isTouch || !ref.current) return;
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
  }, [x, y, isTouch]);

  // Close on click outside or Escape
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = isTouch ? sheetRef.current : ref.current;
      if (target && !target.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose, isTouch]);

  // ── Mobile: drag-to-dismiss ──
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.touches[0].clientY - dragStartY.current;
    if (dy > 0) {
      sheetRef.current.style.transform = `translateY(${dy}px)`;
      sheetRef.current.style.transition = "none";
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;
    const dy = e.changedTouches[0].clientY - dragStartY.current;
    sheetRef.current.style.transition = "transform 0.2s ease";
    if (dy > 80) {
      onClose();
    } else {
      sheetRef.current.style.transform = "translateY(0)";
    }
    dragStartY.current = null;
  }, [onClose]);

  const mine = msg.pubkey === myPubkey;

  const actionButtons = (
    <div className="py-1">
      <button
        onClick={() => { onReply(msg); onClose(); }}
        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left active:opacity-60"
        style={{ color: "var(--text)" }}
      >
        <Reply size={16} style={{ color: "var(--muted)" }} />
        Reply
      </button>
      <button
        onClick={() => { onCopy(msg.content); onClose(); }}
        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left active:opacity-60"
        style={{ color: "var(--text)" }}
      >
        <Copy size={16} style={{ color: "var(--muted)" }} />
        Copy Text
      </button>
      {mine && (
        <button
          onClick={() => { onDelete(msg.id); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left active:opacity-60"
          style={{ color: "#ef4444" }}
        >
          <Trash2 size={16} />
          Delete
        </button>
      )}
    </div>
  );

  const reactionRow = (
    <div
      className="flex items-center justify-around px-3 py-2.5"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onReact(msg.id, msg.pubkey, emoji); onClose(); }}
          className="flex items-center justify-center active:scale-90 transition-transform"
          style={{ width: "44px", height: "44px", borderRadius: "50%", fontSize: "24px" }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );

  // ── Mobile: bottom sheet ──
  if (isTouch) {
    return (
      <div
        className="fixed inset-0 z-[100]"
        style={{ animation: "sheetBgIn 0.2s ease" }}
      >
        <div
          className="absolute inset-0"
          style={{ background: "var(--overlay-light)" }}
          onClick={onClose}
        />
        <div
          ref={sheetRef}
          className="absolute bottom-0 left-0 right-0 rounded-t-2xl"
          style={{
            backgroundColor: "var(--bg)",
            border: "1px solid var(--border)",
            borderBottom: "none",
            animation: "sheetSlideUp 0.25s cubic-bezier(0.32, 0.72, 0, 1)",
            paddingBottom: "env(safe-area-inset-bottom, 0px)",
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1">
            <div
              className="rounded-full"
              style={{ width: "36px", height: "4px", backgroundColor: "var(--border)" }}
            />
          </div>
          {/* Reaction emoji row */}
          {reactionRow}
          {/* Actions */}
          {actionButtons}
        </div>
      </div>
    );
  }

  // ── Desktop: floating context menu ──
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
      {reactionRow}
      {actionButtons}
    </div>
  );
}
