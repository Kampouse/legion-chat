# Legion Chat

NEAR SBT-gated Nostr group chat. Requires an ASCENDANT or INITIATE SBT from NearLegion.

## Live

https://legion-chat.pages.dev

## Stack

- React + TypeScript + Vite
- Tailwind CSS
- Nostr (NIP-28 channels, raw WebSocket)
- NEAR Protocol (`@hot-labs/near-connect`)
- FastNear KV for on-chain bindings
- Deployed on Cloudflare Pages

## How it works

1. Connect NEAR wallet (must hold an ASCENDANT or INITIATE SBT)
2. Link a Nostr identity (NIP-46 bunker, nos2x extension, or local nsec)
3. Public key + proof of ownership stored on-chain via FastNear KV
4. Chat uses NIP-28 channels (kind 40/41) — messages don't appear on public Nostr timeline
5. Client-side filtering: only renders messages from pubkeys with valid on-chain bindings

## Architecture

```
src/
├── App.tsx              # Main chat UI (state machine, sidebar, messages, composer)
├── lib/
│   ├── constants.ts     # SBT contracts, KV accounts, relay URL, channel ID
│   ├── near.ts          # SBT check, binding transaction
│   ├── binding.ts       # Fetch bindings from FastNear KV
│   ├── nostr.ts         # Signers, NIP-28 channel creation/messaging, relay
│   ├── NearWalletContext.tsx  # React context for NEAR wallet
│   └── crypto.ts        # AES-256-GCM (unused, kept for future)
├── index.css            # Dark theme (CSS variables)
└── main.tsx             # Entry point + buffer polyfill
```

## Key details

- **Channel ID**: SHA-256 of `"legion-general"`, hardcoded — no KV write needed
- **Signer persistence**: Bunker URI / nsec saved to localStorage per NEAR account
- **Relay**: `wss://relay.damus.io`
- **Raw WebSocket**: Both publish and subscribe use direct `ws.send()` (nostr-tools `Relay` class unreliable)
- **Duplicate npub prevention**: Checks all bindings before allowing new bind

## Dev

```bash
npm install
npx tsc --noEmit
npx vite build
```

## Deploy

```bash
npx tsc --noEmit && npx vite build && npx wrangler pages deploy dist --project-name legion-chat --branch main --commit-dirty=true
```
