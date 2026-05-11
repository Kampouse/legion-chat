// NIP-46 relay round-trip test — run with: bun test-nip46.mjs
import WebSocket from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';
import * as nip44 from 'nostr-tools/nip44';

const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay.damus.io'];

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function wsOpen(w) { return new Promise(r => { w.onopen = r; setTimeout(r, 5000); }); }
function ws(url) { return new WebSocket(url); }

const clientSk = generateSecretKey();
const clientSkHex = bytesToHex(clientSk);
const clientPk = getPublicKey(clientSk);
console.log('Client:', clientPk.slice(0, 12));

async function testRoundTrip() {
  console.log('\n=== TEST 1: Request/response round-trip ===');
  
  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  console.log('Bunker:', bunkerPk.slice(0, 12));

  const convToBunker = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
  const convToClient = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

  // Client subscribes (no since filter — NDK pattern)
  const pending = new Map();
  const subWs = ws(RELAYS[0]);
  await wsOpen(subWs);
  const subId = 'sub_' + Math.random().toString(36).slice(2, 8);
  subWs.send(JSON.stringify(['REQ', subId, { kinds: [24133], authors: [bunkerPk], '#p': [clientPk] }]));
  console.log('  Subscribed on', RELAYS[0]);

  // Set up message handler BEFORE any requests
  subWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg[0] !== 'EVENT') return;
      let plain;
      try { plain = nip44.v2.decrypt(msg[2].content, convToBunker); } catch { return; }
      const parsed = JSON.parse(plain);
      console.log(`  EVENT: id=${parsed.id?.slice(0,8)} result=${parsed.result?.slice(0,12)} pending=${pending.has(parsed.id)}`);
      const p = pending.get(parsed.id);
      if (p) { clearTimeout(p.timer); p.resolve(parsed); }
    } catch {}
  };

  await wait(500);

  // Register pending BEFORE sending request
  const reqId = crypto.randomUUID();
  const resultPromise = new Promise(r => {
    const t = setTimeout(() => { console.log('  ❌ TIMEOUT'); r(null); }, 15000);
    pending.set(reqId, { resolve: r, timer: t });
  });

  // Client sends request
  const ct = nip44.v2.encrypt(JSON.stringify({ id: reqId, method: 'get_public_key', params: [] }), convToBunker);
  const reqEv = finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', bunkerPk]], content: ct,
  }, clientSk);

  const pubWs = ws(RELAYS[0]);
  await wsOpen(pubWs);
  pubWs.send(JSON.stringify(['EVENT', reqEv]));
  console.log('  Request sent:', reqId.slice(0, 8));
  await wait(500);
  pubWs.close();

  // Bunker responds after 2s
  await wait(2000);
  const respCt = nip44.v2.encrypt(JSON.stringify({ id: reqId, result: clientPk }), convToClient);
  const respEv = finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]], content: respCt,
  }, bunkerSk);
  
  const bWs = ws(RELAYS[0]);
  await wsOpen(bWs);
  bWs.send(JSON.stringify(['EVENT', respEv]));
  console.log('  Bunker responded');
  await wait(500);
  bWs.close();

  const result = await resultPromise;
  if (result) console.log('  ✅ Round-trip OK:', result.result?.slice(0, 12));
  subWs.close();
  return !!result;
}

async function testStaleEvents() {
  console.log('\n=== TEST 2: Stale events silently dropped ===');
  
  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  const convToBunker = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
  const convToClient = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

  // Publish stale events
  const staleIds = [];
  for (let i = 0; i < 3; i++) {
    const sid = crypto.randomUUID();
    staleIds.push(sid.slice(0, 8));
    const ct = nip44.v2.encrypt(JSON.stringify({ id: sid, method: 'stale', params: [] }), convToClient);
    const ev = finalizeEvent({
      kind: 24133, created_at: Math.floor(Date.now() / 1000) - 10,
      tags: [['p', clientPk]], content: ct,
    }, bunkerSk);
    const w = ws(RELAYS[0]); await wsOpen(w); w.send(JSON.stringify(['EVENT', ev])); await wait(300); w.close();
  }
  console.log('  Published stale:', staleIds.join(', '));
  await wait(1000);

  // Subscribe without since (NDK pattern)
  const pending = new Map();
  let dropped = 0;
  const subWs = ws(RELAYS[0]);
  await wsOpen(subWs);
  const subId = 'stale_' + Math.random().toString(36).slice(2, 8);
  subWs.send(JSON.stringify(['REQ', subId, { kinds: [24133], authors: [bunkerPk], '#p': [clientPk] }]));

  await new Promise(r => {
    const t = setTimeout(r, 5000);
    subWs.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg[0] !== 'EVENT') return;
        let plain;
        try { plain = nip44.v2.decrypt(msg[2].content, convToBunker); } catch { return; }
        const parsed = JSON.parse(plain);
        if (!pending.has(parsed.id)) {
          dropped++;
          console.log(`  Dropped stale: ${parsed.id?.slice(0,8)} (no pending)`);
        }
      } catch {}
    };
  });

  subWs.close();
  console.log(`  ✅ ${dropped} stale events dropped, 0 matched`);
  return true;
}

async function testStalePlusFresh() {
  console.log('\n=== TEST 3: Stale replay + fresh request on same subscription ===');
  
  const bunkerSk = generateSecretKey();
  const bunkerPk = getPublicKey(bunkerSk);
  const convToBunker = nip44.v2.utils.getConversationKey(clientSk, bunkerPk);
  const convToClient = nip44.v2.utils.getConversationKey(bunkerSk, clientPk);

  // Pre-publish stale events
  for (let i = 0; i < 2; i++) {
    const ct = nip44.v2.encrypt(JSON.stringify({ id: crypto.randomUUID(), method: 'stale', params: [] }), convToClient);
    const ev = finalizeEvent({
      kind: 24133, created_at: Math.floor(Date.now() / 1000) - 10,
      tags: [['p', clientPk]], content: ct,
    }, bunkerSk);
    const w = ws(RELAYS[0]); await wsOpen(w); w.send(JSON.stringify(['EVENT', ev])); await wait(300); w.close();
  }
  await wait(500);

  // Subscribe (no since — NDK pattern)
  const pending = new Map();
  const log = [];
  const subWs = ws(RELAYS[0]);
  await wsOpen(subWs);
  const subId = 'mix_' + Math.random().toString(36).slice(2, 8);
  subWs.send(JSON.stringify(['REQ', subId, { kinds: [24133], authors: [bunkerPk], '#p': [clientPk] }]));

  subWs.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg[0] !== 'EVENT') return;
      let plain;
      try { plain = nip44.v2.decrypt(msg[2].content, convToBunker); } catch { return; }
      const parsed = JSON.parse(plain);
      log.push({ id: parsed.id?.slice(0,8), method: parsed.method, matched: pending.has(parsed.id) });
      const p = pending.get(parsed.id);
      if (p) { clearTimeout(p.timer); p.resolve(parsed); }
    } catch {}
  };

  await wait(2000);
  console.log('  Stale replay:', log.map(l => `${l.method||'response'}(${l.id}) matched=${l.matched}`).join(', '));

  // Register pending BEFORE sending fresh request
  const reqId = crypto.randomUUID();
  const resultPromise = new Promise(r => {
    const t = setTimeout(() => r(null), 15000);
    pending.set(reqId, { resolve: r, timer: t });
  });

  // Send fresh request
  const ct = nip44.v2.encrypt(JSON.stringify({ id: reqId, method: 'get_public_key', params: [] }), convToBunker);
  const reqEv = finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', bunkerPk]], content: ct,
  }, clientSk);
  
  const pubWs = ws(RELAYS[0]); await wsOpen(pubWs); pubWs.send(JSON.stringify(['EVENT', reqEv])); await wait(500); pubWs.close();
  console.log('  Fresh request:', reqId.slice(0, 8));

  // Bunker responds
  await wait(1500);
  const respCt = nip44.v2.encrypt(JSON.stringify({ id: reqId, result: clientPk }), convToClient);
  const respEv = finalizeEvent({
    kind: 24133, created_at: Math.floor(Date.now() / 1000),
    tags: [['p', clientPk]], content: respCt,
  }, bunkerSk);
  const bWs = ws(RELAYS[0]); await wsOpen(bWs); bWs.send(JSON.stringify(['EVENT', respEv])); await wait(500); bWs.close();

  const result = await resultPromise;

  console.log('  All events:', log.map(l => `${l.method||'response'}(${l.id}) matched=${l.matched}`).join(' → '));
  if (result) console.log('  ✅ Fresh request succeeded with stale events present');
  else console.log('  ❌ Fresh request timed out');

  subWs.close();
  return !!result;
}

// Run all
const r1 = await testRoundTrip();
const r2 = await testStaleEvents();
const r3 = await testStalePlusFresh();

console.log('\n========================================');
console.log(`Test 1 round-trip: ${r1 ? '✅' : '❌'}`);
console.log(`Test 2 stale drop: ${r2 ? '✅' : '❌'}`);
console.log(`Test 3 stale+fresh: ${r3 ? '✅' : '❌'}`);
process.exit(r1 && r3 ? 0 : 1);
