import React, { useEffect, useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { SimplePool } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";
import { FEED_CHANNEL_ID, DEFAULT_RELAY, FALLBACK_RELAYS } from "./lib/constants";
import type { Profile } from "./lib/types";
import { Loader2, ArrowLeft, Copy, Check, ExternalLink } from "lucide-react";

// ── Relay config ──
const RELAYS = [DEFAULT_RELAY, ...FALLBACK_RELAYS];

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

function decodeNpub(npub: string): string | null {
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type === "npub") return decoded.data as string;
    return null;
  } catch {
    return null;
  }
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
                  backgroundColor: "rgba(255,255,255,0.03)",
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

// ── Main PublicProfile component ──

export default function PublicProfile() {
  const { npub } = useParams<{ npub: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [posts, setPosts] = useState<NostrEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedNpub, setCopiedNpub] = useState(false);

  // Decode npub → hex pubkey
  const pubkey = useMemo(() => {
    if (!npub) return null;
    return decodeNpub(npub);
  }, [npub]);

  // Re-encode npub for display / copy (use the URL param directly since it's already valid)
  const displayNpub = npub || "";

  const displayName =
    profile?.display_name || profile?.name || "Anon";
  const handle = profile?.name || "anon";

  useEffect(() => {
    if (!pubkey) {
      setError("Invalid npub");
      setLoading(false);
      return;
    }

    let cancelled = false;
    const pool = new SimplePool();

    async function fetchProfileAndPosts() {
      try {
        // Fetch kind 0 profile metadata for this pubkey
        const profileEvents = await pool.querySync(RELAYS, {
          kinds: [0],
          authors: [pubkey!],
        });

        if (cancelled) return;

        // Use the latest kind 0 event
        const latest = [...profileEvents].sort(
          (a, b) => b.created_at - a.created_at
        )[0];

        if (latest) {
          try {
            const parsed = JSON.parse(latest.content);
            setProfile({
              name: parsed.name,
              picture: parsed.picture,
              display_name: parsed.display_name,
              about: parsed.about,
              nip05: parsed.nip05,
              website: parsed.website,
            });
          } catch {
            setProfile(null);
          }
        }

        // Fetch kind 42 events from feed channel authored by this pubkey
        const channelEvents = await pool.querySync(RELAYS, {
          kinds: [42],
          authors: [pubkey!],
          "#e": [FEED_CHANNEL_ID],
          limit: 200,
        });

        if (cancelled) return;

        // Sort newest first
        const sorted = [...channelEvents].sort(
          (a, b) => b.created_at - a.created_at
        );
        setPosts(sorted);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || "Failed to load profile");
          setLoading(false);
        }
      }
    }

    fetchProfileAndPosts();

    return () => {
      cancelled = true;
      try {
        pool.close(RELAYS);
      } catch {
        // ignore cleanup errors
      }
    };
  }, [pubkey]);

  const copyNpub = () => {
    navigator.clipboard.writeText(displayNpub);
    setCopiedNpub(true);
    setTimeout(() => setCopiedNpub(false), 2000);
  };

  // ── Error: invalid npub ──
  if (error) {
    return (
      <div
        className="min-h-screen flex flex-col"
        style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}
      >
        {/* Header */}
        <header
          className="sticky top-0 z-50 flex items-center gap-3 px-4 py-3 border-b shrink-0"
          style={{
            backgroundColor: "var(--bg)",
            borderColor: "var(--border)",
            backdropFilter: "blur(12px)",
          }}
        >
          <Link
            to="/"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "var(--surface)", color: "var(--text)" }}
          >
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
              style={{ backgroundColor: "var(--accent)", color: "#000" }}
            >
              L
            </div>
            <span className="font-bold text-lg tracking-tight">
              Legion Chat
            </span>
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="text-4xl">⚠️</div>
          <p className="text-sm" style={{ color: "#ef4444" }}>
            {error}
          </p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            The profile link appears to be invalid.
          </p>
          <Link
            to="/"
            className="px-4 py-2 rounded-full text-sm font-bold text-black"
            style={{ backgroundColor: "var(--accent)" }}
          >
            Go Home
          </Link>
        </div>
      </div>
    );
  }

  // ── Loading state ──
  if (loading) {
    return (
      <div
        className="min-h-screen flex flex-col"
        style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}
      >
        {/* Header */}
        <header
          className="sticky top-0 z-50 flex items-center gap-3 px-4 py-3 border-b shrink-0"
          style={{
            backgroundColor: "var(--bg)",
            borderColor: "var(--border)",
            backdropFilter: "blur(12px)",
          }}
        >
          <Link
            to="/"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "var(--surface)", color: "var(--text)" }}
          >
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
              style={{ backgroundColor: "var(--accent)", color: "#000" }}
            >
              L
            </div>
            <span className="font-bold text-lg tracking-tight">
              Legion Chat
            </span>
          </div>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Loader2
            size={28}
            className="animate-spin"
            style={{ color: "var(--accent)" }}
          />
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            Loading profile...
          </span>
        </div>
      </div>
    );
  }

  // ── Loaded state ──
  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ backgroundColor: "var(--bg)", color: "var(--text)" }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center gap-3 px-4 py-3 border-b shrink-0"
        style={{
          backgroundColor: "var(--bg)",
          borderColor: "var(--border)",
          backdropFilter: "blur(12px)",
        }}
      >
        <Link
          to="/"
          className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ backgroundColor: "var(--surface)", color: "var(--text)" }}
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm"
            style={{ backgroundColor: "var(--accent)", color: "#000" }}
          >
            L
          </div>
          <span className="font-bold text-lg tracking-tight">Legion Chat</span>
        </div>
      </header>

      {/* Profile Content */}
      <main className="flex-1">
        {/* Banner */}
        <div
          className="h-32 relative"
          style={{
            background:
              "linear-gradient(135deg, #00ec97 0%, #0a3d2a 50%, #1a1a2e 100%)",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, transparent 60%, var(--bg))",
            }}
          />
        </div>

        {/* Avatar row — overlaps banner */}
        <div className="px-4 -mt-12 relative z-10">
          <div
            className="w-24 h-24 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-2xl font-bold border-4"
            style={{
              backgroundColor: "var(--accent)",
              color: "#000",
              borderColor: "var(--bg)",
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
              displayName.slice(0, 2).toUpperCase()
            )}
          </div>
        </div>

        {/* Profile info */}
        <div className="px-4 pt-3 pb-2">
          <h1 className="text-xl font-bold">{displayName}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-sm" style={{ color: "var(--muted)" }}>
              @{handle}
            </span>
          </div>

          {profile?.nip05 && (
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                ✓ {profile.nip05}
              </span>
            </div>
          )}

          {profile?.about && (
            <p
              className="text-sm leading-relaxed mt-2"
              style={{ color: "var(--text)" }}
            >
              {profile.about}
            </p>
          )}

          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {profile?.website && (
              <a
                href={profile.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs underline flex items-center gap-1"
                style={{ color: "var(--accent)" }}
              >
                <ExternalLink size={10} />
                {profile.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            <button
              onClick={copyNpub}
              className="text-xs font-mono flex items-center gap-1 cursor-pointer"
              style={{
                color: copiedNpub ? "var(--accent)" : "var(--muted)",
                background: "none",
                border: "none",
                padding: 0,
              }}
            >
              {copiedNpub ? <Check size={10} /> : <Copy size={10} />}
              {displayNpub.slice(0, 12)}...{displayNpub.slice(-4)}
            </button>
          </div>

          {/* Stats */}
          <div
            className="flex gap-5 mt-3 pt-3"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <div>
              <span className="font-bold text-sm">{posts.length}</span>
              <span
                className="text-sm ml-1"
                style={{ color: "var(--muted)" }}
              >
                Posts
              </span>
            </div>
          </div>
        </div>

        {/* Posts section */}
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {posts.length === 0 ? (
            <div className="py-16 text-center">
              <div className="text-3xl mb-2">✍️</div>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                No posts yet.
              </p>
            </div>
          ) : (
            posts.map((ev) => (
              <PostCard key={ev.id} event={ev} profile={profile} />
            ))
          )}
        </div>

        {/* Bottom spacing */}
        <div className="h-8" />
      </main>

      {/* Footer */}
      <footer
        className="text-center py-4 text-xs border-t"
        style={{ borderColor: "var(--border)", color: "var(--muted)" }}
      >
        Powered by Nostr · Legion Chat
      </footer>
    </div>
  );
}
