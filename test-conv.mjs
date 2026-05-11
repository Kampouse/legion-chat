import * as nip44 from 'nostr-tools/nip44';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {bytesToHex} from 'nostr-tools/utils';

const a = generateSecretKey();
const b = generateSecretKey();
const aPk = getPublicKey(a);
const bPk = getPublicKey(b);

const convA = nip44.v2.utils.getConversationKey(a, bPk);
const convB = nip44.v2.utils.getConversationKey(b, aPk);

console.log('convA type:', typeof convA, convA.constructor.name);
console.log('convB type:', typeof convB, convB.constructor.name);

// B encrypts with convB
const msg = JSON.stringify({hello: 'world'});
const ct = nip44.v2.encrypt(msg, convB);

// Can A decrypt with convA?
try {
  const pt = nip44.v2.decrypt(ct, convA);
  console.log('A decrypts B:', pt);
} catch(e) {
  console.log('A cannot decrypt B:', e.message);
}

// Can A decrypt with convB (same key)?
try {
  const pt = nip44.v2.decrypt(ct, convB);
  console.log('A decrypts with convB:', pt);
} catch(e) {
  console.log('A cannot decrypt with convB:', e.message);
}
