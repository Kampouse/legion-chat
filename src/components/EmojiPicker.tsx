import { useState, useRef, useEffect } from "react";

// Compact but useful emoji set — no heavy library needed
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: "Smileys",
    emojis: ["😀","😂","🤣","😊","😍","🥰","😘","😜","🤪","😎","🤩","🥳","😤","😡","🤯","😱","😢","🥺","😴","🤔","🤫","🤭","😏","😈","👻","💀","🤖","👽","💩","🤡"],
  },
  {
    label: "Gestures",
    emojis: ["👍","👎","👏","🙌","🤝","✌️","🤞","🤟","🤘","👋","✋","🖐️","👌","🤙","💪","🙏","☝️","👆","👇","👉","👈"],
  },
  {
    label: "Hearts",
    emojis: ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❤️‍🔥","💕","💞","💓","💗","💖","💘","💝","💟"],
  },
  {
    label: "Objects",
    emojis: ["🔥","⭐","💫","✨","🎉","🎊","💥","💯","🏆","🥇","🎯","🚀","💡","⚡","💎","🔑","🗝️","🔒","🔓","🎵","🎶","🎸","🎮","🎲","🧩"],
  },
  {
    label: "Nature",
    emojis: ["🌞","🌙","⭐","🌈","☁️","⛈️","❄️","🌊","🔥","🌸","🌺","🌻","🍀","🌴","🍁","🦋","🐝","🐙","🦊","🐺","🐱","🐶","🐸","🦄","🐉"],
  },
  {
    label: "Flags & Symbols",
    emojis: ["✅","❌","⚠️","♻️","🔴","🟢","🔵","🟡","⚫","⚪","▶️","⏸️","⏹️","🔔","🔕","💬","💭","👁️"," 🫶","🫡"],
  },
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const [cat, setCat] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // Delay so the opening click doesn't close it
    const id = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => { clearTimeout(id); document.removeEventListener("mousedown", handler); };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 rounded-xl shadow-2xl z-50 overflow-hidden"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
        width: "min(320px, 85vw)",
      }}
    >
      {/* Category tabs */}
      <div className="flex overflow-x-auto gap-1 p-2 pb-1" style={{ scrollbarWidth: "none" }}>
        {EMOJI_CATEGORIES.map((c, i) => (
          <button
            key={c.label}
            onClick={() => setCat(i)}
            className="px-2 py-1 rounded text-[10px] whitespace-nowrap shrink-0 font-medium transition-colors"
            style={{
              backgroundColor: cat === i ? "var(--accent)" : "transparent",
              color: cat === i ? "#000" : "var(--muted)",
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/* Emoji grid */}
      <div className="grid grid-cols-8 gap-0.5 p-2 pt-1" style={{ maxHeight: "200px", overflowY: "auto" }}>
        {EMOJI_CATEGORIES[cat].emojis.map((emoji, i) => (
          <button
            key={i}
            onClick={() => { onSelect(emoji); onClose(); }}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-lg hover:scale-110 active:scale-95 transition-transform"
            style={{ backgroundColor: "transparent" }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
