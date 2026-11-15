// SPDX-License-Identifier: AGPL-3.0-or-later
// Identity, contact cards and every key or tag derivation used by the protocol.
// A user is one 32-byte seed. Everything else is derived from it.

import { concat, hex, utf8, isBytes, eq, b64u, unb64u } from './bytes.js';
import * as cbor from './cbor.js';
import { derive, edPublic, dhPublic, dh, sign, verify, hash, UID, DH, SIG } from './crypto.js';

export function identityFromSeed(seed) {
  const edSk = derive(seed, 'void/v1/id-sign', UID);
  const dhSk = derive(seed, 'void/v1/id-dh', DH);
  return {
    seed,
    edSk,
    dhSk,
    uid: edPublic(edSk),
    dhPub: dhPublic(dhSk),
    selfKey: derive(seed, 'void/v1/self'),
  };
}

// A card binds a display name and an X448 key to an Ed448 identity.
export function makeCard(id, name, ts) {
  const c = cbor.encode({ v: 1, id: id.uid, dh: id.dhPub, n: String(name).slice(0, 64), ts });
  return { c, s: sign(id.edSk, 'void/card', c) };
}

const CARDS = new Map(); // signature hex -> verified card (verification is the costly part)
const PROBE = new Uint8Array(DH).fill(7);

export function readCard(card) {
  if (!card || !isBytes(card.c) || !isBytes(card.s, SIG) || card.c.length > 1024) return null;
  const cached = CARDS.get(hex(card.s));
  if (cached) return eq(cached.card.c, card.c) ? cached : null;
  let o;
  try {
    o = cbor.decode(card.c);
  } catch {
    return null;
  }
  if (!o || o.v !== 1 || !isBytes(o.id, UID) || !isBytes(o.dh, DH) || typeof o.n !== 'string' || !Number.isSafeInteger(o.ts)) return null;
  if (!verify(o.id, 'void/card', card.c, card.s)) return null;
  try {
    dh(PROBE, o.dh); // refuses keys that make every shared secret zero
  } catch {
    return null;
  }
  const info = { uid: o.id, dh: o.dh, name: o.n.slice(0, 64), ts: o.ts, card: { c: card.c, s: card.s } };
  if (CARDS.size > 4000) CARDS.clear();
  CARDS.set(hex(card.s), info);
  return info;
}

// ---- space keys, ids and tags ----------------------------------------------
// A tag is the only thing relays and couriers see: 16 opaque bytes derived from
// a space key. Knowing a tag does not reveal the key or who is talking.

export const tagOf = (key) => derive(key, 'void/v1/tag', 16);
export const spaceIdOf = (key) => derive(key, 'void/v1/space', 16);

export function dmKey(myDhSk, peerDh, a, b) {
  const [lo, hi] = hex(a) < hex(b) ? [a, b] : [b, a];
  return derive(dh(myDhSk, peerDh), 'void/v1/dm', 32, lo, hi);
}

// Where couriers hold messages for `recipient` in a one-to-one conversation.
export const mailboxTag = (key, recipient) => derive(key, 'void/v1/mbx', 16, recipient);

// Whoever stores mail for a recipient gets the public half of this key and hands
// the mail only to someone who signs with the secret half: the two people in the
// conversation, and nobody who merely saw the mailbox tag go by.
export function mailboxSigner(key, recipient) {
  const seed = derive(key, 'void/v1/mbx-sign', UID, recipient);
  return { seed, pub: edPublic(seed) };
}

// Public, derivable by anyone who knows the user id. Used only for contact requests.
export const inboxTag = (uid) => hash(utf8('void/v1/inbox'), uid).subarray(0, 16);

// Where contact requests for a user are left on the rendezvous relays. Like the
// inbox tag it follows from the user id, and it changes every day.
export const inboxTopic = (uid, day) => hex(hash(utf8('void/v1/rdv-inbox'), uid, Uint8Array.of((day >>> 24) & 255, (day >>> 16) & 255, (day >>> 8) & 255, day & 255)).subarray(0, 16));

export const channelId = (pub) => hash(utf8('void/v1/chan'), pub).subarray(0, 16);
export const channelPublicKey = (pub) => derive(pub, 'void/v1/chan-public');

// Short number two people can compare out of band to check they hold each other's keys.
export function safetyNumber(a, b) {
  const [lo, hi] = hex(a) < hex(b) ? [a, b] : [b, a];
  const h = hash(utf8('void/v1/safety'), lo, hi);
  let out = '';
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0;
    out += (i ? ' ' : '') + String(n % 100000).padStart(5, '0');
  }
  return out;
}

// ---- shareable links --------------------------------------------------------
//   void:u:…  contact card        void:c:…  channel
//   void:g:…  open group          void:i:… / void:r:…  pairing invite and reply

export const makeLink = (kind, obj) => `void:${kind}:${b64u(cbor.encode(obj))}`;

export function readLink(str) {
  const m = /void:([a-z]):([A-Za-z0-9_-]+)/.exec(String(str || ''));
  if (!m) return null;
  try {
    return { kind: m[1], data: cbor.decode(unb64u(m[2]), 64 * 1024) };
  } catch {
    return null;
  }
}

export const feedKey = (author, dev) => hex(concat(author, dev));
