// Password vault crypto (pure; unit-tested in test/vaultCrypto.test.ts).
// tweetnacl only: box (X25519 + XSalsa20-Poly1305), secretbox, sign (Ed25519), hash (SHA-512).
// Everything that leaves the device is either public, encrypted, or signed.

import nacl from 'tweetnacl';

export const b64 = {
  enc(u8: Uint8Array) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(s: string) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};
const utf8 = { enc: (s: string) => new TextEncoder().encode(s), dec: (u: Uint8Array) => new TextDecoder().decode(u) };

/** A person's keys. Secret halves never leave their devices unencrypted. */
export interface PersonKeys {
  boxPub: Uint8Array;
  boxSec: Uint8Array;
  signPub: Uint8Array;
  signSec: Uint8Array;
}

export interface PublicPerson {
  boxPub: string;
  signPub: string;
}

export function newPersonKeys(): PersonKeys {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return { boxPub: box.publicKey, boxSec: box.secretKey, signPub: sign.publicKey, signSec: sign.secretKey };
}

export function publicOf(k: PersonKeys): PublicPerson {
  return { boxPub: b64.enc(k.boxPub), signPub: b64.enc(k.signPub) };
}

export function exportKeys(k: PersonKeys): string {
  return JSON.stringify({ v: 1, boxSec: b64.enc(k.boxSec), signSec: b64.enc(k.signSec) });
}

export function importKeys(s: string): PersonKeys {
  const o = JSON.parse(s);
  if (o?.v !== 1) throw new Error('unknown key format');
  const box = nacl.box.keyPair.fromSecretKey(b64.dec(o.boxSec));
  const sign = nacl.sign.keyPair.fromSecretKey(b64.dec(o.signSec));
  return { boxPub: box.publicKey, boxSec: box.secretKey, signPub: sign.publicKey, signSec: sign.secretKey };
}

/** Short code people can compare to be sure a key is really theirs: "K7Q4-M2XD-9PRT". */
export function safetyCode(p: PublicPerson) {
  const h = nacl.hash(utf8.enc(`mk-vault-safety|${p.boxPub}|${p.signPub}`));
  return base32(h.subarray(0, 8)).slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
function base32(u8: Uint8Array) {
  let bits = 0;
  let val = 0;
  let out = '';
  for (const b of u8) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unbase32(s: string) {
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
  let bits = 0;
  let val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not a valid code');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------- secrets ----------

export interface SecretField {
  label: string;
  value: string;
  hidden?: boolean;
}

export interface SecretContent {
  title: string;
  kind: 'login' | 'note';
  fields: SecretField[];
  url?: string;
  note?: string;
}

export interface SealedBox {
  v: 1;
  n: string;
  c: string;
}

export const newItemKey = () => nacl.randomBytes(nacl.secretbox.keyLength);

export function seal(content: SecretContent, key: Uint8Array): SealedBox {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { v: 1, n: b64.enc(n), c: b64.enc(nacl.secretbox(utf8.enc(JSON.stringify(content)), n, key)) };
}

export function open(box: SealedBox, key: Uint8Array): SecretContent {
  const out = nacl.secretbox.open(b64.dec(box.c), b64.dec(box.n), key);
  if (!out) throw new Error('this secret could not be decrypted');
  return JSON.parse(utf8.dec(out));
}

// ---------- sharing an item key with someone ----------

export interface WrappedKey {
  v: 1;
  n: string;
  w: string;
  /** Sharer's box public key (who locked it). */
  from: string;
}

export function wrapFor(itemKey: Uint8Array, recipientBoxPub: string, me: PersonKeys): WrappedKey {
  const n = nacl.randomBytes(nacl.box.nonceLength);
  return { v: 1, n: b64.enc(n), w: b64.enc(nacl.box(itemKey, n, b64.dec(recipientBoxPub), me.boxSec)), from: b64.enc(me.boxPub) };
}

export function unwrap(w: WrappedKey, me: PersonKeys): Uint8Array {
  const k = nacl.box.open(b64.dec(w.w), b64.dec(w.n), b64.dec(w.from), me.boxSec);
  if (!k) throw new Error('this key was not meant for you');
  return k;
}

// ---------- signatures (so the server can't forge items or shares) ----------

export const itemSigMessage = (id: string, projectId: string, version: number, box: SealedBox) =>
  `mk-vault-item|v1|${id}|${projectId}|${version}|${box.n}|${box.c}`;
export const accessSigMessage = (itemId: string, userId: string, w: WrappedKey) =>
  `mk-vault-access|v1|${itemId}|${userId}|${w.n}|${w.w}|${w.from}`;

export function signText(msg: string, me: PersonKeys) {
  return b64.enc(nacl.sign.detached(utf8.enc(msg), me.signSec));
}

export function verifyText(msg: string, sig: string, signPub: string) {
  try {
    return nacl.sign.detached.verify(utf8.enc(msg), b64.dec(sig), b64.dec(signPub));
  } catch {
    return false;
  }
}

// ---------- moving a person's keys to another device ----------

/** One-time key for a QR link (goes only in the link's #fragment). */
export const newTransferKey = () => base32(nacl.randomBytes(20));

export function sealForTransfer(keys: PersonKeys, transferKey: string): SealedBox {
  const k = nacl.hash(utf8.enc(`mk-vault-transfer|${transferKey}`)).subarray(0, 32);
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { v: 1, n: b64.enc(n), c: b64.enc(nacl.secretbox(utf8.enc(exportKeys(keys)), n, k)) };
}

export function openTransfer(box: SealedBox, transferKey: string): PersonKeys {
  const k = nacl.hash(utf8.enc(`mk-vault-transfer|${transferKey.trim()}`)).subarray(0, 32);
  const out = nacl.secretbox.open(b64.dec(box.c), b64.dec(box.n), k);
  if (!out) throw new Error('wrong or expired key link');
  return importKeys(utf8.dec(out));
}

/** "Allow this device": a temporary key pair on the new device; the code both screens show. */
export const newRequestKeys = () => nacl.box.keyPair();
export const requestCode = (requestPub: string) =>
  base32(nacl.hash(utf8.enc(`mk-vault-request|${requestPub}`)).subarray(0, 5)).slice(0, 8).replace(/(.{4})(?=.)/, '$1-');

export function sealForRequest(keys: PersonKeys, requestPub: string): WrappedKey & { c: string } {
  const eph = nacl.box.keyPair();
  const n = nacl.randomBytes(nacl.box.nonceLength);
  const c = nacl.box(utf8.enc(exportKeys(keys)), n, b64.dec(requestPub), eph.secretKey);
  return { v: 1, n: b64.enc(n), w: '', from: b64.enc(eph.publicKey), c: b64.enc(c) };
}

export function openRequest(box: { n: string; c: string; from: string }, requestSec: Uint8Array): PersonKeys {
  const out = nacl.box.open(b64.dec(box.c), b64.dec(box.n), b64.dec(box.from), requestSec);
  if (!out) throw new Error('could not open the key from your other device');
  return importKeys(utf8.dec(out));
}

// ---------- recovery code ----------

/** 160 random bits as "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" (32 characters). */
export function newRecoveryCode() {
  return base32(nacl.randomBytes(20)).replace(/(.{4})(?=.)/g, '$1-');
}

function recoveryKey(code: string) {
  const raw = unbase32(code);
  if (raw.length < 20) throw new Error('that recovery code is too short');
  return nacl.hash(new Uint8Array([...utf8.enc('mk-vault-recovery|'), ...raw.subarray(0, 20)])).subarray(0, 32);
}

export function sealForRecovery(keys: PersonKeys, code: string): SealedBox {
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { v: 1, n: b64.enc(n), c: b64.enc(nacl.secretbox(utf8.enc(exportKeys(keys)), n, recoveryKey(code))) };
}

export function openRecovery(box: SealedBox, code: string): PersonKeys {
  const out = nacl.secretbox.open(b64.dec(box.c), b64.dec(box.n), recoveryKey(code));
  if (!out) throw new Error('that recovery code is not right');
  return importKeys(utf8.dec(out));
}
