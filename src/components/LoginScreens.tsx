import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { isMobile } from "../lib/nostr";

export function LoginScreen({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="text-center max-w-sm w-full px-4">
      <div className="text-4xl mb-4">⚔️</div>
      <h1 className="text-xl font-bold mb-2">Legion Chat</h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>NEAR SBT-gated group chat. Requires an ASCENDANT or INITIATE SBT from NearLegion.</p>
      <button onClick={onSignIn} className="w-full py-3 rounded-lg font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Connect NEAR Wallet</button>
    </div>
  );
}

export function CheckingScreen() {
  return (
    <div className="text-center">
      <div className="text-3xl mb-3 animate-pulse">⚔️</div>
      <p className="text-sm" style={{ color: "var(--muted)" }}>Checking SBT...</p>
    </div>
  );
}

export function NoSbtScreen({ accountId, onSignOut }: { accountId: string; onSignOut: () => void }) {
  return (
    <div className="text-center max-w-sm w-full px-4">
      <div className="text-4xl mb-4">🛡️</div>
      <h1 className="text-xl font-bold mb-2">SBT Required</h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}><span className="font-mono">{accountId}</span> doesn't hold an ASCENDANT or INITIATE SBT.</p>
      <button onClick={onSignOut} className="w-full py-3 rounded-lg font-semibold text-sm" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>Sign out</button>
    </div>
  );
}

export function BindScreen({ hasExtension, nsec, bunkerUri, relayUrl, error, onNsecChange, onBunkerUriChange, onRelayChange, onGenerate, onBindExtension, onBindBunker, onBindLocal, onStartConnect, onSignOut }: {
  hasExtension: boolean; nsec: string; bunkerUri: string; relayUrl: string; error: string;
  onNsecChange: (v: string) => void; onBunkerUriChange: (v: string) => void;
  onRelayChange: (v: string) => void; onGenerate: () => void;
  onBindExtension: () => void; onBindBunker: () => void; onBindLocal: () => void;
  onStartConnect: () => void;
  onSignOut: () => void;
}) {
  const [mode, setMode] = useState<"connect" | "bunker" | "extension" | "local">("connect");
  return (
    <div className="max-w-sm w-full px-4">
      <div className="text-center mb-6">
        <div className="text-3xl mb-2">🔗</div>
        <h1 className="text-lg font-bold">Link Nostr Identity</h1>
        <p className="text-xs" style={{ color: "var(--muted)" }}>Public key stored on-chain. Private key never touches this app.</p>
      </div>
      <div className="flex gap-1 mb-4 p-1 rounded-lg" style={{ backgroundColor: "var(--surface)" }}>
        {[
          { key: "connect" as const, label: "📱 App" },
          { key: "bunker" as const, label: "🔗 Bunker" },
          { key: "extension" as const, label: "🧩 Ext" },
          { key: "local" as const, label: "🔑 Key" },
        ].map((tab) => (
          <button key={tab.key} onClick={() => setMode(tab.key)} disabled={tab.key === "extension" && !hasExtension}
            className="flex-1 py-2 text-xs font-medium rounded-md transition-colors disabled:opacity-30"
            style={{ backgroundColor: mode === tab.key ? "var(--accent)" : "transparent", color: mode === tab.key ? "black" : "var(--muted)" }}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        {mode === "connect" && (
          <ConnectTab onStartConnect={onStartConnect} />
        )}
        {mode === "bunker" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>bunker:// URI</label>
              <input type="text" value={bunkerUri} onChange={(e) => onBunkerUriChange(e.target.value)} placeholder="bunker://abc...?relay=wss://..."
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              <details className="mt-1">
                <summary className="text-[10px] cursor-pointer" style={{ color: "var(--accent)" }}>How to get your bunker URI</summary>
                <div className="text-[10px] mt-1 space-y-1" style={{ color: "var(--muted)" }}>
                  <p><strong>Primal:</strong> Settings → Wallet Connect → Copy bunker URI</p>
                  <p><strong>Nsec.app:</strong> Settings → Remote Signer → Copy URI</p>
                  <p><strong>Amber:</strong> Settings → Nostr Connect → Show bunker URI</p>
                </div>
              </details>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <button onClick={onBindBunker} disabled={!bunkerUri.trim()} className="w-full py-3 rounded-lg font-semibold text-black disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>Connect Bunker & Bind</button>
          </>
        )}
        {mode === "extension" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <button onClick={onBindExtension} className="w-full py-3 rounded-lg font-semibold text-black" style={{ backgroundColor: "var(--accent)" }}>Connect nos2x & Bind</button>
          </>
        )}
        {mode === "local" && (
          <>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>nsec (private key — stored in browser localStorage)</label>
              <input type="password" value={nsec} onChange={(e) => onNsecChange(e.target.value)} placeholder="nsec1..."
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
              {nsec && (
                <p className="text-[10px] mt-1 text-amber-400">⚠ Your private key will be stored in localStorage. Anyone with access to this browser can read it. Use a bunker or extension for better security.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Relay</label>
              <input type="text" value={relayUrl} onChange={(e) => onRelayChange(e.target.value)}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)" }} />
            </div>
            <div className="flex gap-2">
              <button onClick={onGenerate} className="flex-1 py-2.5 rounded-lg text-sm font-medium" style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>Generate new</button>
              <button onClick={onBindLocal} disabled={!nsec} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-black disabled:opacity-40" style={{ backgroundColor: "var(--accent)" }}>Bind & Enter</button>
            </div>
          </>
        )}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button onClick={onSignOut} className="w-full py-2 text-xs" style={{ color: "var(--muted)" }}>Sign out</button>
      </div>
    </div>
  );
}

// ── Connect tab: QR code + Open in App button ──

function ConnectTab({ onStartConnect }: { onStartConnect: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const mobile = isMobile();

  const handleStart = () => {
    setWaiting(true);
    onStartConnect();
  };

  return (
    <div className="text-center space-y-3">
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Scan QR with Nsec.app or Amber. Your keys stay on your device.
      </p>
      {mobile ? (
        <button
          onClick={handleStart}
          disabled={waiting}
          className="w-full py-3 rounded-lg font-semibold text-black disabled:opacity-40"
          style={{ backgroundColor: "var(--accent)" }}
        >
          {waiting ? "Waiting for approval..." : "Open Signer App"}
        </button>
      ) : (
        <>
          <button
            onClick={handleStart}
            disabled={waiting}
            className="w-full py-3 rounded-lg font-semibold text-black disabled:opacity-40"
            style={{ backgroundColor: "var(--accent)" }}
          >
            {waiting ? "Waiting for scan..." : "Generate QR Code"}
          </button>
        </>
      )}
      <p className="text-[10px]" style={{ color: "var(--muted)" }}>
        Nsec.app &amp; Amber supported &bull; Primal users: use the Bunker tab
      </p>
    </div>
  );
}

// ── Connect QR overlay: shown after user triggers the flow ──
export function ConnectQRScreen({
  uri,
  onCancel,
}: {
  uri: string;
  onCancel: () => void;
}) {
  const mobile = isMobile();
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Timer to show how long we've been waiting
  useEffect(() => {
    const start = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  const openApp = () => {
    window.location.href = uri;
    setOpened(true);
  };

  const copyUri = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* fallback */ }
  };

  return (
    <div className="max-w-sm w-full px-4 text-center">
      <div className="text-3xl mb-3 animate-pulse">📱</div>
      <h1 className="text-lg font-bold mb-2">Connect Signer</h1>

      {mobile ? (
        <div className="space-y-3">
          {!opened ? (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Tap below to open your signer app
              </p>
              <button
                onClick={openApp}
                className="w-full py-3 rounded-lg font-semibold text-black"
                style={{ backgroundColor: "var(--accent)" }}
              >
                Open Signer App
              </button>
            </>
          ) : (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Approve the connection in your signer app...
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Scan this QR code with Primal, Nsec.app, or Amber on your phone
          </p>
          <div className="inline-block p-3 rounded-lg" style={{ backgroundColor: "white" }}>
            <QRCodeSVG value={uri} size={200} />
          </div>
          <p className="text-xs font-mono" style={{ color: "var(--muted)" }}>
            Waiting for signer... {elapsed}s
          </p>
          <button
            onClick={copyUri}
            className="w-full py-2 rounded-lg text-xs font-medium"
            style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
          >
            {copied ? "Copied!" : "Copy nostrconnect URI"}
          </button>
          <p className="text-[10px]" style={{ color: "var(--muted)" }}>
            Paste the URI in Primal's browser or send it to your phone
          </p>
        </div>
      )}

      <button onClick={onCancel} className="mt-4 w-full py-2 text-xs" style={{ color: "var(--muted)" }}>
        Cancel
      </button>
    </div>
  );
}

export function BindingScreen() {
  return (
    <div className="text-center">
      <div className="text-3xl mb-3 animate-pulse">🔗</div>
      <p className="text-sm" style={{ color: "var(--muted)" }}>Linking identity...</p>
      <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Approve in your wallet + signer</p>
    </div>
  );
}
