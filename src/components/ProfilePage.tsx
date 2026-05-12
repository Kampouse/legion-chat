import { useState } from "react";
import type { NostrProfile, NostrSigner, Relay, ConnectionState } from "../lib/nostr";
import type { Profile } from "../lib/types";
import { fetchNearSocialProfile, signProfileUpdate } from "../lib/nostr";
import { nip19 } from "nostr-tools";
import { ArrowLeft, Pencil, Download, LogOut, Check, Copy, ExternalLink } from "lucide-react";

interface ProfilePageProps {
  signer: NostrSigner | null;
  relayRef: React.RefObject<Relay | null>;
  profiles: Record<string, Profile>;
  setProfiles: React.Dispatch<React.SetStateAction<Record<string, Profile>>>;
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

export default function ProfilePage({
  signer,
  relayRef,
  profiles,
  setProfiles,
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

  const profile = profiles[myPubkey];
  const displayName = profile?.display_name || profile?.name || accountId || "Anon";
  const npub = myPubkey ? nip19.npubEncode(myPubkey) : "";

  const connLabel = connState === "connected" ? "Connected" : connState === "connecting" ? "Connecting..." : connState === "error" ? "Error" : "Disconnected";
  const connColor = connState === "connected" ? "#00ec97" : connState === "connecting" ? "#fbbf24" : "#ef4444";
  const signerLabel = signerType === "bunker" ? "NIP-46 Bunker" : signerType === "extension" ? "Browser Extension" : signerType === "local" ? "Local Key" : "—";

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
      <header className="flex items-center gap-3 px-4 py-3 border-b shrink-0" style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}>
        <button onClick={onBack} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: "var(--text)" }}>
          <ArrowLeft size={18} />
        </button>
        <span className="font-semibold text-sm flex-1">Profile</span>
        {!editing && (
          <button onClick={startEditing} className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ color: "var(--accent)", backgroundColor: "var(--accent-dim)" }}>
            <Pencil size={14} />
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        {editing ? (
          /* ── Edit mode ── */
          <div className="p-6 space-y-4">
            {/* Avatar + picture URL */}
            <div className="flex items-center gap-4">
              <div className="w-20 h-20 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-xl font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                {editProfile?.picture ? (
                  <img src={editProfile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  displayName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Picture URL</label>
                <input type="url" value={editProfile?.picture || ""} onChange={(e) => setEditProfile({ ...editProfile!, picture: e.target.value })} placeholder="https://example.com/avatar.jpg"
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Name</label>
                <input type="text" value={editProfile?.name || ""} onChange={(e) => setEditProfile({ ...editProfile!, name: e.target.value })} placeholder="satoshi"
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
              <div>
                <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Display Name</label>
                <input type="text" value={editProfile?.display_name || ""} onChange={(e) => setEditProfile({ ...editProfile!, display_name: e.target.value })} placeholder="Satoshi Nakamoto"
                  className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>About</label>
              <textarea value={editProfile?.about || ""} onChange={(e) => setEditProfile({ ...editProfile!, about: e.target.value })} placeholder="Tell people about yourself..." rows={3}
                className="w-full px-3 py-2 rounded-lg text-sm resize-none" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NIP-05</label>
              <input type="text" value={editProfile?.nip05 || ""} onChange={(e) => setEditProfile({ ...editProfile!, nip05: e.target.value })} placeholder="user@domain.com"
                className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div>
              <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Website</label>
              <input type="url" value={editProfile?.website || ""} onChange={(e) => setEditProfile({ ...editProfile!, website: e.target.value })} placeholder="https://yoursite.com"
                className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={handleSave} disabled={saving} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-black flex items-center justify-center gap-2" style={{ backgroundColor: "var(--accent)", opacity: saving ? 0.6 : 1 }}>
                {saving ? "Saving..." : <><Check size={14} /> Save Profile</>}
              </button>
              <button onClick={() => { setEditing(false); setEditProfile(null); }} className="px-4 py-2.5 rounded-lg text-sm" style={{ border: "1px solid var(--border)", color: "var(--muted)" }}>Cancel</button>
            </div>

            {accountId && (
              <button onClick={handleImportNearSocial} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-medium" style={{ border: "1px solid var(--border)", color: "var(--muted)", backgroundColor: "var(--surface)" }}>
                <Download size={13} />
                Sync from NEAR Social
              </button>
            )}
          </div>
        ) : (
          /* ── View mode ── */
          <div className="p-6 space-y-6">
            {/* Hero section */}
            <div className="flex flex-col items-center text-center gap-3 pt-2">
              <div className="w-24 h-24 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-2xl font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                {profile?.picture ? (
                  <img src={profile.picture} className="w-full h-full object-cover" alt="" />
                ) : (
                  displayName.slice(0, 2).toUpperCase()
                )}
              </div>
              <div>
                <h1 className="text-lg font-bold">{displayName}</h1>
                {profile?.name && profile.display_name && profile.name !== profile.display_name && (
                  <p className="text-sm" style={{ color: "var(--muted)" }}>@{profile.name}</p>
                )}
                {profile?.nip05 && (
                  <p className="text-xs mt-0.5" style={{ color: "var(--accent)" }}>✓ {profile.nip05}</p>
                )}
              </div>
              {profile?.about && (
                <p className="text-sm leading-relaxed max-w-sm" style={{ color: "var(--text)" }}>{profile.about}</p>
              )}
              {profile?.website && (
                <a href={profile.website} target="_blank" rel="noopener noreferrer" className="text-xs underline flex items-center gap-1" style={{ color: "var(--accent)" }}>
                  <ExternalLink size={10} />
                  {profile.website.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>

            {/* Nostr identity */}
            <div className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Nostr Identity</h3>
              <div
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer"
                style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
                onClick={copyNpub}
              >
                <span className="text-xs font-mono flex-1 truncate" style={{ color: "var(--text)" }}>{npub.slice(0, 20)}...{npub.slice(-8)}</span>
                {copiedNpub ? <Check size={14} style={{ color: "var(--accent)" }} /> : <Copy size={14} style={{ color: "var(--muted)" }} />}
              </div>
            </div>

            {/* Connection */}
            <div className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Connection</h3>
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: connColor }} />
                <span className="text-sm" style={{ color: "var(--text)" }}>{connLabel}</span>
                <span className="text-xs ml-auto px-2 py-0.5 rounded-md" style={{ color: "var(--muted)", backgroundColor: "var(--bg)" }}>{signerLabel}</span>
              </div>
              <div className="px-3 py-2 rounded-lg" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                <span className="text-[10px] uppercase tracking-wider font-medium" style={{ color: "var(--muted)" }}>Relay </span>
                <span className="text-xs font-mono" style={{ color: "var(--text)" }}>{relayUrl}</span>
              </div>
            </div>

            {/* NEAR account */}
            <div className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>NEAR Account</h3>
              <div className="px-3 py-2.5 rounded-lg" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                <span className="text-sm font-mono" style={{ color: "var(--accent)" }}>{accountId}</span>
              </div>
            </div>

            {/* Sign out */}
            <button
              onClick={onSignOut}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium text-red-400 mt-4"
              style={{ border: "1px solid rgba(239,68,68,0.3)", backgroundColor: "rgba(239,68,68,0.05)" }}
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
