import type { NostrProfile, NostrSigner, Relay, ConnectionState } from "../lib/nostr";
import type { Profile } from "../lib/types";
import type { BindingCache } from "../lib/binding";
import { CHANNEL_ID } from "../lib/constants";

interface SettingsPanelProps {
  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  setEditProfile: (v: NostrProfile | null) => void;
  editProfile: NostrProfile | null;
  signer: NostrSigner | null;
  relayRef: React.RefObject<Relay | null>;
  profiles: Record<string, Profile>;
  setProfiles: React.Dispatch<React.SetStateAction<Record<string, Profile>>>;
  myPubkey: string;
  accountId: string | null;
  relayUrl: string;
  channelId: string;
  connInfo: { color: string; label: string };
  _signerType: string | null;
  connState: ConnectionState;
  handleSignOut: () => void;
  setError: (v: string) => void;
  signProfileUpdate: (signer: NostrSigner, profile: NostrProfile) => Promise<any>;
  showToast: (msg: string) => void;
}

export default function SettingsPanel({
  showSettings,
  setShowSettings,
  setEditProfile,
  editProfile,
  signer,
  relayRef,
  profiles,
  setProfiles,
  myPubkey,
  accountId,
  relayUrl,
  channelId: _channelId,
  connInfo,
  _signerType,
  connState: _connState,
  handleSignOut,
  setError,
  signProfileUpdate,
  showToast,
}: SettingsPanelProps) {
  if (!showSettings) return null;

  return (
    <div className="fixed inset-0 z-50 flex" style={{ backgroundColor: "rgba(0,0,0,0.7)" }}>
      <div className="m-auto w-full max-w-2xl mx-4 rounded-2xl overflow-hidden flex flex-col max-h-[85vh]" style={{ backgroundColor: "var(--bg)", border: "1px solid var(--border)" }}>
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "var(--border)" }}>
          <span className="font-semibold">Settings</span>
          <button onClick={() => { setShowSettings(false); setEditProfile(null); }} className="w-8 h-8 rounded-lg flex items-center justify-center text-sm" style={{ color: "var(--muted)", backgroundColor: "var(--surface)" }}>✕</button>
        </div>
        <div className="overflow-y-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 overflow-hidden">
            {/* Left: Account info */}
            <div className="p-6 space-y-4 border-b md:border-b-0 md:border-r min-w-0 overflow-hidden" style={{ borderColor: "var(--border)" }}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Account</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NEAR Account</label>
                  <div className="px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--accent)" }}>{accountId}</div>
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Nostr Public Key</label>
                  <div className="px-3 py-2 rounded-lg text-xs font-mono truncate cursor-pointer" title={myPubkey} onClick={() => { navigator.clipboard.writeText(myPubkey); showToast("Copied!"); }} style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{myPubkey}</div>
                </div>
              </div>

              <h3 className="text-[11px] font-semibold uppercase tracking-wider pt-2" style={{ color: "var(--muted)" }}>Connection</h3>
              <div className="space-y-3">
                <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: connInfo.color }} />
                  <span className="text-sm" style={{ color: "var(--text)" }}>{connInfo.label}</span>
                  <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{_signerType === "bunker" ? "NIP-46 Bunker" : _signerType === "extension" ? "Browser Extension" : _signerType === "local" ? "Local Key" : "—"}</span>
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Relay</label>
                  <div className="px-3 py-2 rounded-lg text-xs font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{relayUrl}</div>
                </div>
                <div>
                  <label className="block text-[10px] font-medium mb-1.5 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Channel</label>
                  <div className="px-3 py-2 rounded-lg text-xs font-mono truncate cursor-pointer" title={CHANNEL_ID} onClick={() => { navigator.clipboard.writeText(CHANNEL_ID); showToast("Copied!"); }} style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }}>{CHANNEL_ID}</div>
                </div>
              </div>
            </div>

            {/* Right: Profile */}
            <div className="p-6 space-y-4 min-w-0 overflow-hidden">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>Nostr Profile</h3>
                {editProfile === null && (
                  <button onClick={() => {
                    const p = profiles[myPubkey] || {};
                    setEditProfile({ name: p.name || "", about: p.about || "", picture: p.picture || "", nip05: p.nip05 || "", display_name: p.display_name || "", website: p.website || "" });
                  }} className="text-[11px] font-medium px-2.5 py-1 rounded-md" style={{ color: "var(--accent)", backgroundColor: "var(--accent-dim)" }}>Edit</button>
                )}
              </div>

              {editProfile !== null ? (
                <div className="space-y-3">
                  {/* Avatar preview */}
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                      {editProfile.picture ? (
                        <img src={editProfile.picture} className="w-full h-full object-cover" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        (editProfile.name || accountId || "?").slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div className="flex-1">
                      <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Picture URL</label>
                      <input type="url" value={editProfile.picture || ""} onChange={(e) => setEditProfile({ ...editProfile, picture: e.target.value })} placeholder="https://example.com/avatar.jpg"
                        className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Name</label>
                      <input type="text" value={editProfile.name || ""} onChange={(e) => setEditProfile({ ...editProfile, name: e.target.value })} placeholder="satoshi"
                        className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Display Name</label>
                      <input type="text" value={editProfile.display_name || ""} onChange={(e) => setEditProfile({ ...editProfile, display_name: e.target.value })} placeholder="Satoshi Nakamoto"
                        className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>About</label>
                    <textarea value={editProfile.about || ""} onChange={(e) => setEditProfile({ ...editProfile, about: e.target.value })} placeholder="Tell people about yourself..." rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm resize-none" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>NIP-05</label>
                    <input type="text" value={editProfile.nip05 || ""} onChange={(e) => setEditProfile({ ...editProfile, nip05: e.target.value })} placeholder="user@domain.com"
                      className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium mb-1 uppercase tracking-wider" style={{ color: "var(--muted)" }}>Website</label>
                    <input type="url" value={editProfile.website || ""} onChange={(e) => setEditProfile({ ...editProfile, website: e.target.value })} placeholder="https://yoursite.com"
                      className="w-full px-3 py-2 rounded-lg text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={async () => {
                      if (!signer || !relayRef.current) return;
                      try {
                        const event = await signProfileUpdate(signer, editProfile);
                        await relayRef.current.publish(event);
                        setProfiles((prev) => ({ ...prev, [myPubkey]: editProfile }));
                        setEditProfile(null);
                        showToast("Profile updated!");
                      } catch (e: any) { setError("Profile update failed: " + e.message); }
                    }} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Save Profile</button>
                    <button onClick={() => setEditProfile(null)} className="px-4 py-2.5 rounded-lg text-sm" style={{ border: "1px solid var(--border)", color: "var(--muted)" }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold" style={{ backgroundColor: "var(--accent)", color: "#000" }}>
                      {profiles[myPubkey]?.picture ? (
                        <img src={profiles[myPubkey].picture} className="w-full h-full object-cover" alt="" />
                      ) : (
                        (profiles[myPubkey]?.name || accountId || "?").slice(0, 2).toUpperCase()
                      )}
                    </div>
                    <div>
                      <p className="font-semibold text-sm">{profiles[myPubkey]?.display_name || profiles[myPubkey]?.name || "No name set"}</p>
                      <p className="text-xs" style={{ color: "var(--muted)" }}>{profiles[myPubkey]?.nip05 || "No NIP-05"}</p>
                    </div>
                  </div>
                  {profiles[myPubkey]?.about ? (
                    <p className="text-sm leading-relaxed" style={{ color: "var(--text)" }}>{profiles[myPubkey].about}</p>
                  ) : (
                    <p className="text-sm" style={{ color: "var(--muted)" }}>No bio yet. Click Edit to set up your profile.</p>
                  )}
                  {profiles[myPubkey]?.website && (
                    <a href={profiles[myPubkey].website} target="_blank" rel="noopener noreferrer" className="text-xs underline" style={{ color: "var(--accent)" }}>{profiles[myPubkey].website}</a>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer: Sign out */}
          <div className="px-6 py-4 border-t" style={{ borderColor: "var(--border)" }}>
            <button onClick={() => { setShowSettings(false); handleSignOut(); }} className="text-xs font-medium text-red-400 hover:text-red-300">Sign out</button>
          </div>
        </div>
      </div>
    </div>
  );
}
