// SPDX-License-Identifier: AGPL-3.0-or-later
// All cryptography goes through this file. Primitives come from the noble
// libraries (pure JavaScript, so they also work where WebCrypto is unavailable,
// such as pages served over plain http on a local network).
//
//   signatures       Ed448                         about 224 bits of security
//   key agreement    X448                          about 224 bits
//   post-quantum     ML-KEM-1024 (FIPS 203), always combined with X448, never alone
//   AEAD             XChaCha20-Poly1305 and ChaCha20-Poly1305, 256-bit keys
//   KDF              HKDF-SHA512
//   public-key encryption  HPKE base mode (RFC 9180):
//                    DHKEM(X448, HKDF-SHA512) / HKDF-SHA512 / ChaCha20-Poly1305
//   identifiers      SHA-256 (256-bit preimage resistance)
//   passphrase KDF   scrypt
//
// The ML-KEM implementation has not been independently audited. It is only ever
// used together with X448: if it failed, security would fall back to X448's.

import { ed448, x448 } from '@noble/curves/ed448.js';
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hkdf, extract, expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
import { xchacha20poly1305, chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8, concat, rand } from './bytes.js';

// Sizes in bytes of what travels on the wire.
export const UID = 57; // a user id is an Ed448 public key
export const DH = 56; // an X448 public key
export const SIG = 114; // an Ed448 signature
export const KEM_PUB = 1568; // an ML-KEM-1024 public key
export const KEM_CT = 1568; // an ML-KEM-1024 ciphertext

export const hash = (...parts) => sha256(concat(...parts));
export const mac = (key, bytes) => hmac(sha256, key, bytes);
export const hasher = () => sha256.create();

// HKDF with a text label and optional context bytes as the info string.
export function derive(key, label, len = 32, ...context) {
  return hkdf(sha512, key, undefined, concat(utf8(label), ...context), len);
}

// ---- signatures -----------------------------------------------------------

export const edPublic = (secret) => ed448.getPublicKey(secret);

export function sign(secret, label, bytes) {
  return ed448.sign(concat(utf8(label), bytes), secret);
}

export function verify(pub, label, bytes, sig) {
  try {
    return ed448.verify(sig, concat(utf8(label), bytes), pub);
  } catch {
    return false;
  }
}

// ---- key agreement --------------------------------------------------------

export const dhPublic = (secret) => x448.getPublicKey(secret);
export const dh = (secret, pub) => x448.getSharedSecret(secret, pub);

// ---- post-quantum key encapsulation ------------------------------------------
// One side makes a key pair and sends the public key; the other encapsulates to it
// and sends back the ciphertext; both end up with the same 32-byte secret.

export const kemKeys = () => ml_kem1024.keygen();
export function kemSend(publicKey) {
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(publicKey);
  return { ct: cipherText, secret: sharedSecret };
}
export const kemReceive = (ct, secretKey) => ml_kem1024.decapsulate(ct, secretKey);

// ---- symmetric AEAD -------------------------------------------------------

// Returns nonce || ciphertext || tag.
export function seal(key, plaintext, aad) {
  const nonce = rand(24);
  return concat(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

// Throws when the box is malformed or was not produced with this key and aad.
export function open(key, box, aad) {
  if (box.length < 24 + 16) throw new Error('box too short');
  return xchacha20poly1305(key, box.subarray(0, 24), aad).decrypt(box.subarray(24));
}

// Counter-nonce variant for sessions: each direction has its own key and counts
// its frames, so a frame that is replayed or reordered does not open.
function seqNonce(n) {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, Math.floor(n / 0x100000000));
  view.setUint32(8, n >>> 0);
  return nonce;
}

export const sealSeq = (key, n, plaintext, aad) => chacha20poly1305(key, seqNonce(n), aad).encrypt(plaintext);
export const openSeq = (key, n, ciphertext, aad) => chacha20poly1305(key, seqNonce(n), aad).decrypt(ciphertext);

// Deterministic-nonce variant for file chunks: the key is unique per file and the
// chunk index is the nonce, so chunks can be decrypted and verified independently.
export function sealChunk(key, index, plaintext) {
  return xchacha20poly1305(key, chunkNonce(index)).encrypt(plaintext);
}

export function openChunk(key, index, ciphertext) {
  return xchacha20poly1305(key, chunkNonce(index)).decrypt(ciphertext);
}

function chunkNonce(index) {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setUint32(20, index);
  return n;
}

// ---- HPKE base mode, single shot (RFC 9180) --------------------------------

const KEM_ID = 0x0021; // DHKEM(X448, HKDF-SHA512)
const KDF_ID = 0x0003; // HKDF-SHA512
const AEAD_ID = 0x0003; // ChaCha20-Poly1305
const i2osp2 = (n) => Uint8Array.of(n >> 8, n & 255);
const SUITE_KEM = concat(utf8('KEM'), i2osp2(KEM_ID));
const SUITE_HPKE = concat(utf8('HPKE'), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID));
const HPKE_V1 = utf8('HPKE-v1');
const EMPTY = new Uint8Array(0);

function labeledExtract(suite, salt, label, ikm) {
  return extract(sha512, concat(HPKE_V1, suite, utf8(label), ikm), salt);
}

function labeledExpand(suite, prk, label, info, len) {
  return expand(sha512, prk, concat(i2osp2(len), HPKE_V1, suite, utf8(label), info), len);
}

function kemSharedSecret(dhValue, enc, pkR) {
  const prk = labeledExtract(SUITE_KEM, undefined, 'eae_prk', dhValue);
  return labeledExpand(SUITE_KEM, prk, 'shared_secret', concat(enc, pkR), 64);
}

function keySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(SUITE_HPKE, undefined, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(SUITE_HPKE, undefined, 'info_hash', info);
  const context = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(SUITE_HPKE, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(SUITE_HPKE, secret, 'key', context, 32),
    nonce: labeledExpand(SUITE_HPKE, secret, 'base_nonce', context, 12),
  };
}

// Encrypts to a recipient's X448 public key. Returns { enc, ct }.
export function hpkeSeal(recipientPub, info, aad, plaintext, ephemeralSecret = rand(DH)) {
  const enc = x448.getPublicKey(ephemeralSecret);
  const shared = kemSharedSecret(x448.getSharedSecret(ephemeralSecret, recipientPub), enc, recipientPub);
  const { key, nonce } = keySchedule(shared, info);
  return { enc, ct: chacha20poly1305(key, nonce, aad).encrypt(plaintext) };
}

export function hpkeOpen(recipientSecret, enc, info, aad, ct) {
  const pkR = x448.getPublicKey(recipientSecret);
  const shared = kemSharedSecret(x448.getSharedSecret(recipientSecret, enc), enc, pkR);
  const { key, nonce } = keySchedule(shared, info);
  return chacha20poly1305(key, nonce, aad).decrypt(ct);
}

// ---- password to key (local storage lock) -----------------------------------

// Slow on purpose: every guess at the password costs this much work and memory.
// Runs in slices so the page stays responsive.
export function passKey(password, salt, { N = 2 ** 16, r = 8, p = 1 } = {}) {
  if (!Number.isInteger(N) || N < 2 ** 14 || N > 2 ** 20 || (N & (N - 1)) || r < 1 || r > 16 || p < 1 || p > 4) throw new Error('Unsupported key derivation settings');
  return scryptAsync(utf8(password.normalize('NFKC')), salt, { N, r, p, dkLen: 32, asyncTick: 20 });
}

// ---- passphrase-based encryption (backups) ---------------------------------

// `logN` is the scrypt cost: 17 means 128 MiB of memory per guess.
export function passSeal(passphrase, plaintext, logN = 17) {
  const salt = rand(16);
  const key = scrypt(utf8(passphrase.normalize('NFKC')), salt, { N: 2 ** logN, r: 8, p: 1, dkLen: 32 });
  return concat(salt, seal(key, plaintext, salt));
}

export function passOpen(passphrase, blob, logN = 17) {
  const salt = blob.subarray(0, 16);
  const key = scrypt(utf8(passphrase.normalize('NFKC')), salt, { N: 2 ** logN, r: 8, p: 1, dkLen: 32 });
  return open(key, blob.subarray(16), salt);
}
