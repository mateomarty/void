// SPDX-License-Identifier: AGPL-3.0-or-later
// Sessions over tunnels.
//
// A tunnel runs through other people's devices, so its two ends prove who they are
// before anything else is exchanged, and agree on fresh keys:
//
//   requester -> responder   HS1  tag of a conversation both hold, ephemeral X448
//                                 key eI, one-use ML-KEM-1024 public key
//   responder -> requester   HS2  ephemeral X448 key eR, ML-KEM ciphertext,
//                                 sealed { uid, dev, signature }
//   requester -> responder   HS3  sealed { uid, dev, signature }
//
// The keys come from three secrets mixed together: the X448 exchange, the ML-KEM
// exchange and the conversation key. Breaking the session takes breaking both
// exchanges (the second one is designed to resist quantum computers) and, on top,
// only holders of the conversation can complete the handshake or see who the
// other side is; relays learn neither. Each signature covers the tunnel id, both
// ephemeral keys, the ML-KEM public key and ciphertext, and the signer's uid and
// device id, so it cannot be replayed elsewhere or by a relay sitting in the
// middle. From then on every frame on the tunnel is sealed with the session keys
// and counted. The one-use secrets are dropped after the handshake: recorded
// tunnel traffic cannot be decrypted later, even with every long-term key.

import { T } from './proto.js';
import { hex, rand, concat, utf8, isBytes, eq } from './bytes.js';
import * as cbor from './cbor.js';
import { dh, dhPublic, derive, hash, seal, open, sign, verify, kemKeys, kemSend, kemReceive, UID, DH, SIG, KEM_PUB, KEM_CT } from './crypto.js';

export const sessionMethods = {
  // Requester side: called when a tunnel to a listener of `tag` comes up.
  startSession(route, tag) {
    const ent = this.tags.get(hex(tag));
    if (!ent || ent.sp.left || route.hs || route.peer) return;
    const secret = rand(DH);
    route.hs = { requester: true, sp: ent.sp, spaceKey: ent.k.key, secret, eI: dhPublic(secret), kem: kemKeys() };
    this.routeSend(route, { t: T.HS1, g: tag, e: route.hs.eI, k: route.hs.kem.publicKey });
  },

  // `bind` is the hash of everything both sides sent in the clear; `pq` is the
  // ML-KEM secret. A different view of the handshake gives different keys.
  sessionKeys(route, secret, theirs, pq, spaceKey, bind) {
    const base = derive(concat(dh(secret, theirs), pq, spaceKey), 'void/v1/session', 32, route.tid, bind);
    return {
      hsI: derive(base, 'void/v1/session/hs-i'), hsR: derive(base, 'void/v1/session/hs-r'),
      dataI: derive(base, 'void/v1/session/data-i'), dataR: derive(base, 'void/v1/session/data-r'),
    };
  },

  sessionProof(route, bind, who) {
    const body = concat(route.tid, bind, this.id.uid, this.id.dev, utf8(who));
    return cbor.encode({ u: this.id.uid, d: this.id.dev, s: sign(this.id.edSk, 'void/hs', body) });
  },

  // Returns the proven identity, or null.
  sessionCheck(route, sp, sealed, key, bind, who) {
    let id;
    try {
      id = cbor.decode(open(key, sealed, route.tid));
    } catch {
      return null;
    }
    if (!id || !isBytes(id.u, UID) || !isBytes(id.d, 8) || !isBytes(id.s, SIG)) return null;
    if (eq(id.u, this.id.uid) && eq(id.d, this.id.dev)) return null;
    if (!verify(id.u, 'void/hs', concat(route.tid, bind, id.u, id.d, utf8(who)), id.s)) return null;
    return this.mayTalk(sp, hex(id.u)) ? id : null;
  },

  // Responder side.
  onHs1(route, m) {
    if (route.hs || route.peer || !isBytes(m.g, 16) || !isBytes(m.e, DH) || !isBytes(m.k, KEM_PUB)) return;
    const ent = this.tags.get(hex(m.g));
    if (!ent || ent.sp.left) return;
    const secret = rand(DH);
    const eR = dhPublic(secret);
    let keys, bind, q;
    try {
      const pq = kemSend(m.k);
      q = pq.ct;
      bind = hash(m.e, eR, m.k, q);
      keys = this.sessionKeys(route, secret, m.e, pq.secret, ent.k.key, bind);
    } catch {
      return; // a degenerate or malformed key
    }
    route.hs = { requester: false, sp: ent.sp, keys, bind };
    this.routeSend(route, { t: T.HS2, e: eR, q, b: seal(keys.hsR, this.sessionProof(route, bind, 'R'), route.tid) });
  },

  async onHs2(route, m) {
    const hs = route.hs;
    if (!hs || !hs.requester || route.peer || !isBytes(m.e, DH) || !isBytes(m.q, KEM_CT) || !isBytes(m.b)) return undefined;
    let keys, bind;
    try {
      bind = hash(hs.eI, m.e, hs.kem.publicKey, m.q);
      keys = this.sessionKeys(route, hs.secret, m.e, kemReceive(m.q, hs.kem.secretKey), hs.spaceKey, bind);
    } catch {
      return this.closeRoute(route);
    }
    const id = this.sessionCheck(route, hs.sp, m.b, keys.hsR, bind, 'R');
    if (!id) return this.closeRoute(route);
    this.routeSend(route, { t: T.HS3, b: seal(keys.hsI, this.sessionProof(route, bind, 'I'), route.tid) });
    return this.sessionUp(route, hs.sp, id, keys.dataI, keys.dataR);
  },

  async onHs3(route, m) {
    const hs = route.hs;
    if (!hs || hs.requester || route.peer || !isBytes(m.b)) return undefined;
    const id = this.sessionCheck(route, hs.sp, m.b, hs.keys.hsI, hs.bind, 'I');
    if (!id) return this.closeRoute(route);
    return this.sessionUp(route, hs.sp, id, hs.keys.dataR, hs.keys.dataI);
  },

  async sessionUp(route, sp, id, txKey, rxKey) {
    route.hs = null; // the one-use secrets go with it
    route.tx = { key: txKey, n: 0 };
    route.rx = { key: rxKey, n: 0 };
    const uidHex = hex(id.u);
    route.peer = { uidHex, devHex: uidHex + hex(id.d) };
    route.sessions.add(sp.id);
    if (sp.kind === 'dm') await this.contactSeen(uidHex);
    this.onRoutePeer(route);
  },
};
