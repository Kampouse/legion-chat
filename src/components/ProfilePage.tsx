import { useState, useMemo } from "react";
import type { NostrProfile, NostrSigner, Relay, ConnectionState } from "../lib/nostr";
import type { Message, Profile } from "../lib/types";
import { fetchNearSocialProfile, signProfileUpdate } from "../lib/nostr";
import { nip19 } from "nostr-tools";
import { ArrowLeft, Pencil, Download, LogOut, Check, Copy, ExternalLink, X, Heart, MessageCircle, Repeat2, Share2, Settings } from "lucide-react";
import SettingsPanel from "./SettingsPanel";

interface ProfilePageProps {
  signer: NostrSigner | null;
  relayRef: React.RefObject<Relay | null>;
  profiles: Record<string, Profile>;
  setProfiles: React.Dispatch<React.SetStateAction<Record<string, Profile>>>;
  messages: Message[];
  myPubkey: string;
  accountId: string | null;
  relayUrl: string;
  signerType: string | null;
  connState: ConnectionState;
  onBack: () => void;
  onSignOut: () => void;
  setError: (v: string) => void;
  showToast: (msg: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ProfilePage({
  signer,
  relayRef,
  profiles,
  setProfiles,
  messages,
  myPubkey,
  accountId,
  relayUrl,
  signerType,
  connState,
  onBack,
  onSignOut,
  setError,
  showToast,
}: ProfilePageProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editProfile, setEditProfile] = useState<NostrProfile | null>(null);
  const [copiedNpub, setCopiedNpub] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const profile = profiles[myPubkey];
  const displayName = profile?.display_name || profile?.name || accountId || "Anon";
  const handle = profile?.name || accountId || "anon";
  const npub = myPubkey ? nip19.npubEncode(myPubkey) : "";

  const myMessages = useMemo(
    () => messages.filter((m) => m.pubkey === myPubkey && !m.pending).sort((a, b) => b.created_at - a.created_at),
    [messages, myPubkey],
  );

  const connColor = connState === "connected" ? "#00ec97" : connState === "connecting" ? "#fbbf24" : "#ef4444";

  const startEditing = () => {
    const p = profile || {};
    setEditProfile({
      name: p.name || "",
      about: p.about || "",
      picture: p.picture || "",
      nip05: p.nip05 || "",
      display_name: p.display_name || "",
      website: p.website || "",
    });
    setEditing(true);
  };

  const handleSave = async () => {
    if (!signer || !relayRef.current || !editProfile) return;
    setSaving(true);
    try {
      const event = await signProfileUpdate(signer, editProfile);
      await relayRef.current.publish(event);
      setProfiles((prev) => ({ ...prev, [myPubkey]: editProfile }));
      setEditing(false);
      setEditProfile(null);
      showToast("Profile updated!");
    } catch (e: any) {
      setError("Profile update failed: " + e.message);
    }
    setSaving(false);
  };

  const handleImportNearSocial = async () => {
    if (!accountId) return;
    showToast("Fetching NEAR Social...");
    const social = await fetchNearSocialProfile(accountId);
    if (!social) { showToast("No NEAR Social profile found"); return; }
    setEditProfile((prev) => prev ? {
      ...prev,
      name: social.name || prev.name || "",
      picture: social.image || prev.picture || "",
      about: social.description || prev.about || "",
    } : {
      name: social.name || "",
      picture: social.image || "",
      about: social.description || "",
    });
    showToast("Imported from NEAR Social");
  };

  const copyNpub = () => {
    navigator.clipboard.writeText(npub);
    setCopiedNpub(true);
    setTimeout(() => setCopiedNpub(false), 2000);
    showToast("Copied npub!");
  };

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: "var(--bg)" }}>
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 shrink-0 absolute top-0 left-0 right-0 z-20" style={{ backgroundColor: "transparent" }}>
        <button onClick={onBack} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.5)", color: "#fff" }}>
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1" />
        <button onClick={() => setShowSettings(true)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.5)", color: "#fff" }}>
          <Settings size={15} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Banner */}
        <div className="h-32 relative" style={{ background: "linear-gradient(135deg, #00ec97 0%, #0a3d2a 50%, #1a1a2e 100%)" }}>
          <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 60%, var(--bg))" }} />
        </div>

        {/* Avatar row — overlaps banner */}
        <div className="px-4 -mt-12 relative z-10">
          <div className="flex items-end justify-between">
            <div className="w-24 h-24 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-2xl font-bold border-4" style={{ backgroundColor: "var(--accent)", color: "#000", borderColor: "var(--bg)" }}>
              {profile?.picture ? (
                <img src={profile.picture} className="w-full h-full object-cover" alt="" />
              ) : (
                displayName.slice(0, 2).toUpperCase()
              )}
            </div>
            {!editing && (
              <button onClick={startEditing} className="px-4 py-1.5 rounded-full text-sm font-semibold mt-4" style={{ border: "1px solid var(--border)", color: "var(--text)" }}>
                Edit Profile
              </button>
            )}
          </div>
        </div>

        {/* Profile info */}
        <div className="px-4 pt-3 pb-2">
          <h1 className="text-xl font-bold">{displayName}</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-sm" style={{ color: "var(--muted)" }}>@{handle}</span>
            {connState === "connected" && (
              <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: connColor }} />
            )}
          </div>
          {profile?.nip05 && (
            <div className="flex items-center gap-1 mt-1">
              <span className="text-xs" style={{ color: "var(--muted)" }}>✓ {profile.nip05}</span>
            </div>
          )}
          {profile?.about && (
            <p className="text-sm leading-relaxed mt-2" style={{ color: "var(--text)" }}>{profile.about}</p>
          )}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {profile?.website && (
              <a href={profile.website} target="_blank" rel="noopener noreferrer" className="text-xs underline flex items-center gap-1" style={{ color: "var(--accent)" }}>
                <ExternalLink size={10} />
                {profile.website.replace(/^https?:\/\//, "")}
              </a>
            )}
            <button onClick={copyNpub} className="text-xs font-mono flex items-center gap-1" style={{ color: copiedNpub ? "var(--accent)" : "var(--muted)" }}>
              {copiedNpub ? <Check size={10} /> : <Copy size={10} />}
              {npub.slice(0, 12)}...{npub.slice(-4)}
            </button>
          </div>

          {/* Stats */}
          <div className="flex gap-5 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
            <div>
              <span className="font-bold text-sm">{myMessages.length}</span>
              <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>Posts</span>
            </div>
            <div>
              <span className="font-bold text-sm">{signerType === "bunker" ? "NIP-46" : signerType === "local" ? "Local" : "Ext"}</span>
              <span className="text-sm ml-1" style={{ color: "var(--muted)" }}>Signer</span>
            </div>
          </div>
        </div>

        {/* Edit form (inline) */}
        {editing && editProfile && (
          <div className="mx-4 mb-2 p-4 rounded-xl space-y-3" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm">Edit Profile</span>
              <button onClick={() => { setEditing(false); setEditProfile(null); }} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ color: "var(--muted)", backgroundColor: "var(--bg)" }}><X size={14} /></button>
            </div>

            <div className="flex items-center gap-3">
              <div className="w-14 h-14 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                {editProfile.picture ? (
                  <img src={editProfile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  displayName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Avatar URL</label>
                <input type="url" value={editProfile.picture || ""} onChange={(e) => setEditProfile({ ...editProfile, picture: e.target.value })} placeholder="https://..."
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Name</label>
                <input type="text" value={editProfile.name || ""} onChange={(e) => setEditProfile({ ...editProfile, name: e.target.value })} placeholder="satoshi"
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
              <div>
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Display Name</label>
                <input type="text" value={editProfile.display_name || ""} onChange={(e) => setEditProfile({ ...editProfile, display_name: e.target.value })} placeholder="Satoshi Nakamoto"
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>About</label>
              <textarea value={editProfile.about || ""} onChange={(e) => setEditProfile({ ...editProfile, about: e.target.value })} placeholder="Tell people about yourself..." rows={2}
                className="w-full px-3 py-2 rounded-lg text-sm resize-none" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NIP-05</label>
              <input type="text" value={editProfile.nip05 || ""} onChange={(e) => setEditProfile({ ...editProfile, nip05: e.target.value })} placeholder="user@domain.com"
                className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Website</label>
              <input type="url" value={editProfile.website || ""} onChange={(e) => setEditProfile({ ...editProfile, website: e.target.value })} placeholder="https://yoursite.com"
                className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div className="flex gap-2">
              <button onClick={handleSave} disabled={saving} className="flex-1 py-2 rounded-lg text-sm font-semibold text-black flex items-center justify-center gap-2" style={{ backgroundColor: "var(--accent)", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving..." : <><Check size={14} /> Save</>}
              </button>
              <button onClick={() => { setEditing(false); setEditProfile(null); }} className="px-4 py-2 rounded-lg text-sm" style={{ border: "1px solid var(--border)", color: "var(--muted)" }}>Cancel</button>
            </div>

            {accountId && (
              <button onClick={handleImportNearSocial} className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium" style={{ border: "1px solid var(--border)", color: "var(--muted)", backgroundColor: "var(--bg)" }}>
                <Download size={13} />
                Import from NEAR Social
              </button>
            )}
          </div>
        )}

        {/* Posts — feed-style cards */}
        <div style={{ borderTop: "1px solid var(--border)" }}>
          {myMessages.length === 0 ? (
            <div className="py-16 text-center">
              <div className="text-3xl mb-2">✍️</div>
              <p className="text-sm" style={{ color: "var(--muted)" }}>No posts yet. Send a message in chat to see it here.</p>
            </div>
          ) : (
            myMessages.map((msg) => {
              const imageUrl = msg.content.match(/(https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|avif)(\?[^\s]*)?)/i)?.[1];
              const text = imageUrl ? msg.content.replace(imageUrl, "").trim() : msg.content;
              const heartReactions = (msg.reactions || {})["❤️"] || [];
              const totalLikes = heartReactions.length;
              return (
                <article key={msg.id} className="border-b" style={{ borderColor: "var(--border)" }}>
                  <div className="px-4 py-3">
                    <div className="flex gap-3">
                      <div className="w-10 h-10 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-xs font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                        {profile?.picture ? (
                          <img src={profile.picture} className="w-full h-full object-cover" alt="" />
                        ) : (
                          displayName.slice(0, 2).toUpperCase()
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-[15px] truncate" style={{ color: "var(--text)" }}>{displayName}</span>
                          <span className="text-[13px]" style={{ color: "var(--muted)" }}>· {formatTime(msg.created_at)}</span>
                        </div>
                        {msg.replyToId && msg.replyToContent && (
                          <div className="mt-1 px-2 py-1 rounded text-xs border-l-2" style={{ backgroundColor: "rgba(0,236,151,0.05)", borderLeftColor: "var(--accent)", color: "var(--muted)" }}>
                            <span className="font-semibold" style={{ color: "var(--text)" }}>{msg.replyToSender || "unknown"}</span>
                            <span className="ml-1">{msg.replyToContent.length > 60 ? msg.replyToContent.slice(0, 60) + "..." : msg.replyToContent}</span>
                          </div>
                        )}
                        {text && (
                          <p className="text-[15px] mt-1 leading-normal whitespace-pre-wrap break-words" style={{ color: "var(--text)" }}>{text}</p>
                        )}
                        {imageUrl && (
                          <div className="mt-3 rounded-2xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                            <img src={imageUrl} alt="" className="w-full max-h-[500px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          </div>
                        )}
                        <div className="flex items-center justify-between mt-3">
                          <div className="flex items-center gap-6">
                            <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--muted)" }}>
                              <MessageCircle size={16} />
                            </div>
                            <div className="flex items-center gap-1.5 text-[13px]" style={{ color: totalLikes > 0 ? "#ef4444" : "var(--muted)" }}>
                              <Heart size={16} fill={totalLikes > 0 ? "currentColor" : "none"} />
                              {totalLikes > 0 && <span>{totalLikes}</span>}
                            </div>
                            <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--muted)" }}>
                              <Repeat2 size={16} />
                            </div>
                          </div>
                          <button onClick={() => { navigator.clipboard.writeText(msg.content.slice(0, 100)); showToast("Copied!"); }} className="flex items-center gap-1.5 text-[13px] active:opacity-60" style={{ color: "var(--muted)" }}>
                            <Share2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {/* Bottom spacing */}
        <div className="h-8" />
      </div>

      {/* Settings overlay (reused from main app) */}
      <SettingsPanel
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        setEditProfile={(p) => { if (p) { setEditProfile(p); setEditing(true); } }}
        editProfile={editing ? editProfile : null}
        signer={signer}
        relayRef={relayRef}
        profiles={profiles}
        setProfiles={setProfiles}
        myPubkey={myPubkey}
        accountId={accountId}
        relayUrl={relayUrl}
        channelId={""}
        connInfo={{ color: connColor, label: "" }}
        _signerType={signerType}
        connState={connState}
        handleSignOut={() => { setShowSettings(false); onSignOut(); }}
        setError={setError}
        signProfileUpdate={signProfileUpdate}
        showToast={showToast}
      />
    </div>
  );
}
