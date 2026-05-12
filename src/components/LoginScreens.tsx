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
  const [_opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);

  // Capture [NIP-46] console logs for inline debug display
  useEffect(() => {
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const addLog = (prefix: string, args: any[]) => {
      const text = args.map((a: any) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      if (text.includes("[NIP-46") || text.includes("NDK") || text.includes("nostrconnect") || text.includes("blockUntilReady")) {
        setLogs(prev => [...prev.slice(-50), `${new Date().toLocaleTimeString().slice(0,8)} ${prefix} ${text}`]);
      }
    };
    console.log = (...args: any[]) => { origLog(...args); addLog("LOG", args); };
    console.error = (...args: any[]) => { origErr(...args); addLog("ERR", args); };
    console.warn = (...args: any[]) => { origWarn(...args); addLog("WRN", args); };
    return () => { console.log = origLog; console.error = origErr; console.warn = origWarn; };
  }, []);

  // Log the URI we received (fires on mount)
  useEffect(() => {
    // Enable NDK debug output in browser console
    try { (localStorage as any).debug = 'ndk:*'; } catch {}
    if (uri) {
      setLogs(prev => [...prev.slice(-50), `${new Date().toLocaleTimeString().slice(0,8)} UI QR mounted, URI len=${uri.length}`]);
      console.log("[NIP-46] ConnectQRScreen mounted with URI:", uri.slice(0, 80) + "...");
    }
  }, [uri]);

  // Monitor the NDK pairing promise
  useEffect(() => {
    const h = (window as any).__nip46Handle;
    if (!h) return;
    setLogs(prev => [...prev.slice(-50), `${new Date().toLocaleTimeString().slice(0,8)} UI monitoring pairing promise...`]);
    h.ready.then((s: any) => {
      setLogs(prev => [...prev.slice(-50), `${new Date().toLocaleTimeString().slice(0,8)} UI PAIRED! pubkey=${s._userPubkey?.slice(0,12)} bunker=${s.bunkerPubkey?.slice(0,12)}`]);
    }).catch((e: any) => {
      setLogs(prev => [...prev.slice(-50), `${new Date().toLocaleTimeString().slice(0,8)} UI FAILED: ${e.message}`]);
    });
  }, [uri]);

  // Timer + visibility tracking
  useEffect(() => {
    const start = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    const onVis = () => {
      const state = document.visibilityState;
      setLogs(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString().slice(0,8)} VIS visibility=${state}`]);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const openApp = () => {
    setLogs(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString().slice(0,8)} UI opening deep link...`]);
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

      <div className="space-y-3">
        <div className="bg-white p-4 rounded-xl inline-block mx-auto">
          <QRCodeSVG value={uri} size={200} />
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Scan from your signer app{elapsed > 0 ? ` (${elapsed}s)` : ""}
        </p>
        <div className="flex gap-2 justify-center">
          <button
            onClick={copyUri}
            className="px-3 py-2 rounded-lg text-xs font-medium border"
            style={{ borderColor: "var(--border)" }}
          >
            {copied ? "Copied!" : "Copy URI"}
          </button>
          {mobile && (
            <button
              onClick={openApp}
              className="px-3 py-2 rounded-lg text-xs font-medium text-black"
              style={{ backgroundColor: "var(--accent)" }}
            >
              Open Signer App
            </button>
          )}
        </div>
      </div>

      {/* Debug log */}
      {logs.length > 0 && (
        <div className="mt-3 text-left">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-bold" style={{ color: "var(--muted)" }}>Debug Log:</p>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(logs.join("\n"));
                } catch { /* fallback */ }
              }}
              className="text-[10px] px-2 py-0.5 rounded font-medium border"
              style={{ borderColor: "var(--border)", color: "var(--muted)" }}
            >
              Copy Logs
            </button>
          </div>
          <div className="max-h-40 overflow-y-auto rounded-lg p-2 text-[10px] font-mono"
               style={{ backgroundColor: "rgba(0,0,0,0.4)" }}>
            {logs.map((l, i) => (
              <div key={i} style={{ color: l.includes("ERR") ? "#f87171" : l.includes("VIS") ? "#facc15" : "#9ca3af" }}>
                {l}
              </div>
            ))}
          </div>
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
