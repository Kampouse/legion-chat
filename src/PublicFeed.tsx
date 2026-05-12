import React, { useEffect, useState, useMemo } from "react";
import { SimplePool } from "nostr-tools/pool";
import { FEED_CHANNEL_ID } from "./lib/constants";
import type { Profile } from "./lib/types";
import { Loader2, Sun, Moon } from "lucide-react";
import { useTheme } from "./hooks/useTheme";

// ── Relay config ──
const RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://relay.damus.io", "wss://relay.camelus.app"];

// ── Lightweight event type (nostr-tools v2) ──
interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

// ── Helpers ──

function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d`;
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function parseImage(content: string): {
  text: string;
  imageUrl: string | null;
} {
  const m = content.match(
    /(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|avif)(\?[^\s]*)?)/i
  );
  if (m) return { text: content.replace(m[1], "").trim(), imageUrl: m[1] };
  const single = content.trim().match(/^(https?:\/\/[^\s]+)$/);
  if (single) return { text: "", imageUrl: single[1] };
  return { text: content, imageUrl: null };
}

// ── Avatar ──

function Avatar({
  profile,
  name,
  size = 40,
}: {
  profile?: Profile;
  name: string;
  size?: number;
}) {
  return (
    <div
      className="rounded-full flex items-center justify-center font-bold shrink-0 overflow-hidden"
      style={{
        width: size,
        height: size,
        backgroundColor: "var(--accent)",
        color: "#000",
        fontSize: size * 0.35,
      }}
    >
      {profile?.picture ? (
        <img
          src={profile.picture}
          className="w-full h-full object-cover"
          alt=""
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        name.slice(0, 2).toUpperCase()
      )}
    </div>
  );
}

// ── Post Card (read-only) ──

function PostCard({
  event,
  profile,
}: {
  event: NostrEvent;
  profile?: Profile;
}) {
  const displayName =
    profile?.display_name || profile?.name || event.pubkey.slice(0, 12) + "...";
  const { text, imageUrl } = parseImage(event.content);

  // Extract quoted event ID from tags
  const quoteTag = event.tags.find((t) => t[0] === "q");
  const quoteId = quoteTag?.[1] || null;

  return (
    <article className="border-b" style={{ borderColor: "var(--border)" }}>
      <div className="px-4 py-3">
        <div className="flex gap-3">
          <Avatar profile={profile} name={displayName} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span
                className="font-bold text-[15px] truncate"
                style={{ color: "var(--text)" }}
              >
                {displayName}
              </span>
              <span className="text-[13px]" style={{ color: "var(--muted)" }}>
                · {timeAgo(event.created_at)}
              </span>
            </div>

            {text && (
              <p
                className="text-[15px] mt-1 leading-normal whitespace-pre-wrap break-words"
                style={{ color: "var(--text)" }}
              >
                {text}
              </p>
            )}

            {imageUrl && (
              <div
                className="mt-3 rounded-2xl overflow-hidden"
                style={{ border: "1px solid var(--border)" }}
              >
                <img
                  src={imageUrl}
                  alt=""
                  className="w-full max-h-[500px] object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              </div>
            )}

            {quoteId && (
              <div
                className="mt-2 rounded-xl p-3"
                style={{
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--quote-bg)",
                }}
              >
                <span
                  className="text-[13px]"
                  style={{ color: "var(--muted)" }}
                >
                  Quoted post: {quoteId.slice(0, 16)}...
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ── Main PublicFeed component ──

export default function PublicFeed() {
  const { theme, toggle: toggleTheme } = useTheme();
  const [events, setEvents] = useState<NostrEvent[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pool = new SimplePool();

    async function fetchFeed() {
      try {
        // Fetch kind 42 (channel message) events from the feed channel
        const channelEvents = await pool.querySync(RELAYS, {
          kinds: [42],
          "#e": [FEED_CHANNEL_ID],
          limit: 100,
        });

        if (cancelled) return;

        // Sort by created_at descending (newest first)
        const sorted = [...channelEvents].sort(
          (a, b) => b.created_at - a.created_at
        );
        setEvents(sorted);

        // Collect unique pubkeys
        const pubkeys = [...new Set(sorted.map((e) => e.pubkey))];

        if (pubkeys.length === 0) {
          setLoading(false);
          return;
        }

        // Fetch kind 0 (profile metadata) for each author
        const profileEvents = await pool.querySync(RELAYS, {
          kinds: [0],
          authors: pubkeys,
        });

        if (cancelled) return;

        // Parse profile metadata — keep the latest per pubkey
        const profileMap: Record<string, Profile> = {};
        for (const ev of profileEvents) {
          const existing = profileMap[ev.pubkey];
          if (!existing || ev.created_at > (existing as any)._ts) {
            try {
              const parsed = JSON.parse(ev.content);
              profileMap[ev.pubkey] = {
                name: parsed.name,
                picture: parsed.picture,
                display_name: parsed.display_name,
                about: parsed.about,
                nip05: parsed.nip05,
                website: parsed.website,
                _ts: ev.created_at,
              } as Profile & { _ts: number };
            } catch {
              // skip unparseable metadata
            }
          }
        }

        // Strip internal _ts before storing
        for (const key of Object.keys(profileMap)) {
          delete (profileMap[key] as any)._ts;
        }

        setProfiles(profileMap);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Failed to load feed");
          setLoading(false);
        }
      }
    }

    fetchFeed();

    return () => {
      cancelled = true;
      // Clean up pool connections
      try {
        pool.close(RELAYS);
      } catch {
        // ignore cleanup errors
      }
    };
  }, []);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => b.created_at - a.created_at),
    [events]
  );

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{
          backgroundColor: "var(--bg)",
          borderColor: "var(--border)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center gap-2">
          <a href="/" className="flex items-center gap-2" style={{ textDecoration: "none", color: "inherit" }}>
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
              style={{ backgroundColor: "var(--accent)", color: "#000" }}
            >
              L
            </div>
            <span className="font-bold text-lg tracking-tight">Legion Chat</span>
          </a>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={toggleTheme} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ color: "var(--muted)" }}>
            {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a
            href="/chat"
            className="px-4 py-1.5 rounded-full text-sm font-bold text-black"
            style={{ backgroundColor: "var(--accent)" }}
          >
            Login
          </a>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2
              size={28}
              className="animate-spin"
              style={{ color: "var(--accent)" }}
            />
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              Loading feed...
            </span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 px-6 text-center">
            <span className="text-sm" style={{ color: "#ef4444" }}>
              {error}
            </span>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-full text-sm font-bold text-black"
              style={{ backgroundColor: "var(--accent)" }}
            >
              Retry
            </button>
          </div>
        ) : sortedEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              No posts yet.
            </span>
          </div>
        ) : (
          sortedEvents.map((ev) => (
            <PostCard
              key={ev.id}
              event={ev}
              profile={profiles[ev.pubkey]}
            />
          ))
        )}
      </main>

      {/* Footer */}
      <footer
        className="text-center py-4 text-xs border-t"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
      >
        Powered by Nostr · Public Feed
      </footer>
    </div>
  );
}
