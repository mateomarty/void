// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendezvous: finding contacts again after a restart, without exchanging codes.
//
// Two contacts share a secret (their pairwise key). From it they derive a topic that
// changes every day and a sealing key. Each device that is online posts a short
// "hello" under the topic of every contact it has no link to; a device that sees a
// hello answers with a WebRTC offer, the other with an answer, and the link that
// comes up is authenticated like any other. The carrier (src/net/relays.js) is
// injected, so tests run it on a fake notice board.

import { hex, unhex, rand, isBytes } from './bytes.js';
import { inboxTopic } from './keys.js';
import * as cbor from './cbor.js';
import { derive, seal, open, hash, UID } from './crypto.js';
import { PROTOCOL } from './proto.js';

const DAY = 86400000;
const NEAR_MIDNIGHT = 15 * 60000;
const HELLO = 1;
const OFFER = 2;
const ANSWER = 3;
const u32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

export const rdvMethods = {
  rdvStart() {
    if (!this.rdvNet) return;
    this.rdvNet.onmessage = (topic, bytes) => this.run(() => this.onRdv(topic, bytes));
    this.rdvNet.onup = () => this.run(() => this.rdvAnnounce(true));
    this.rdvNet.onstatus = () => this.emit('net');
    this.rdvApply();
  },

  rdvOn() {
    return !!(this.rdvNet && this.rtc && this.settings.rdv && this.ready && !this.stopped);
  },

  // Called at start and whenever the setting or the relay list changes.
  rdvApply() {
    if (!this.rdvNet) return;
    this.rdvNet.configure(this.rdvOn() ? this.settings.rdvRelays : []);
    if (this.rdvOn()) this.rdvRefresh();
  },

  // Everyone I can meet: accepted contacts through our pairwise key, and my own
  // other devices through the key only my devices hold.
  rdvPeers() {
    const out = [{ uid: this.uidHex, key: this.id.selfKey }];
    for (const c of this.contacts.values()) {
      // Someone I asked to be my contact is listened for too: their first hello
      // after they accept is how I find out.
      const sp = c.pending !== 'in' && !c.blocked && !c.relayOnly && c.dm ? this.spaces.get(c.dm) : null;
      if (sp && !sp.left) out.push({ uid: c.uid, key: this.curKey(sp).key, asked: c.pending === 'out' ? c : null });
    }
    return out;
  },

  rdvRefresh() {
    if (!this.rdvOn()) return;
    const now = this.now();
    const day = Math.floor(now / DAY);
    const days = [day]; // clocks differ a little: around midnight, listen on both sides
    if (now % DAY < NEAR_MIDNIGHT) days.push(day - 1);
    if (DAY - (now % DAY) < NEAR_MIDNIGHT) days.push(day + 1);
    const topics = new Map();
    for (const p of this.rdvPeers()) {
      const key = derive(p.key, 'void/v1/rdv-key');
      days.forEach((d, i) => topics.set(hex(derive(p.key, 'void/v1/rdv-topic', 16, u32(d))), { uid: p.uid, key, today: i === 0 }));
    }
    // My own inbox: where contact requests and answers to my invite links arrive.
    if (this.settings.requests || this.openInvites()) for (const d of days) topics.set(inboxTopic(this.id.uid, d), { inbox: true });
    this.rdvTopics = topics;
    this.rdvNet.setTopics([...topics.keys()]);
  },

  rdvSend(uid, msg) {
    for (const [topic, t] of this.rdvTopics || []) {
      if (t.uid !== uid || !t.today) continue;
      const body = cbor.encode({ ...msg, v: PROTOCOL, u: this.id.uid, d: this.id.dev, ts: this.now() });
      return this.rdvNet.publish(topic, seal(t.key, body, unhex(topic)));
    }
    return 0;
  },

  hasLinkTo(uidHex) {
    for (const L of this.links.values()) if (L.uidHex === uidHex) return true;
    return false;
  },

  // Says hello to every contact this device has no link to. `now` skips the usual
  // pause between hellos (but never repeats one within a few seconds).
  rdvAnnounce(now = false) {
    if (!this.rdvOn() || !this.rdvTopics) return;
    const t = this.now();
    for (const p of this.rdvPeers()) {
      if (this.hasLinkTo(p.uid)) continue;
      const id = p.asked ? 'q' + p.uid : p.uid;
      const last = this.rdvHi.get(id) || 0;
      if (t - last < (now ? 4000 : this.cfg.rdvEvery)) continue;
      // To a contact: hello. To someone I asked: my request, left in their inbox
      // again and again until they are online to take it.
      if (p.asked ? this.rdvRequest(p.asked) : this.rdvSend(p.uid, { t: HELLO })) this.rdvHi.set(id, t);
    }
  },

  rdvRequest(c) {
    const { enc, ct } = this.requestPayload(c);
    return this.rdvNet.publish(inboxTopic(unhex(c.uid), Math.floor(this.now() / DAY)), cbor.encode({ e: enc, c: ct }));
  },

  rdvTick() {
    if (!this.rdvOn()) return;
    this.rdvRefresh();
    this.rdvAnnounce(false);
  },

  onRdv(topic, bytes) {
    const t = this.rdvTopics && this.rdvTopics.get(topic);
    if (!t || !this.rdvOn() || !isBytes(bytes) || bytes.length > 8192) return undefined;
    if (t.inbox) {
      try {
        const note = cbor.decode(bytes);
        return this.takeRequest(note.e, note.c);
      } catch {
        return undefined;
      }
    }
    let m;
    try {
      m = cbor.decode(open(t.key, bytes, unhex(topic)));
    } catch {
      return; // not written with our key
    }
    if (!m || !isBytes(m.u, UID) || !isBytes(m.d, 8) || !Number.isSafeInteger(m.ts) || Math.abs(this.now() - m.ts) > 90000) return;
    const uid = hex(m.u);
    const dev = uid + hex(m.d);
    // On a contact's topic only that contact's devices are listened to. My own
    // other devices post there too (they share the key); those are not for me.
    if (dev === this.devKey || uid !== t.uid) return;
    const id = hex(hash(bytes).subarray(0, 12));
    if (this.rdvSeen.has(id)) return;
    this.rdvSeen.add(id);
    if (this.rdvSeen.size > 4000) this.rdvSeen = new Set([...this.rdvSeen].slice(-2000));
    if (m.v !== PROTOCOL) return void this.versionClash(uid, this.nameOf(uid), m.v); // it is there, on another build
    if (m.t === HELLO) this.rdvHello(uid, dev);
    else if (m.t === OFFER) this.rdvOffer(uid, dev, m);
    else if (m.t === ANSWER) this.rdvAnswer(dev, m);
  },

  rdvHello(uid, dev) {
    const L = this.linkByDev.get(dev);
    if (L) {
      // It says hello although I hold a link to it: that link may be dead.
      if (this.now() - L.last > 2000) this.probeLink(L);
      return;
    }
    if (this.devKey < dev) return void this.rdvDial(uid, dev); // the lower device dials
    const last = this.rdvHi.get(uid) || 0;
    if (this.now() - last > 8000 && this.rdvSend(uid, { t: HELLO })) this.rdvHi.set(uid, this.now());
  },

  rdvDial(uid, dev) {
    const now = this.now();
    const st = this.upgrades.get(dev) || { n: 0, next: 0, busy: false };
    if (st.busy || now < st.next) return;
    st.busy = true;
    st.next = now + Math.min(this.cfg.upgradeRetry * 2 ** st.n, 1800000);
    st.n++;
    this.upgrades.set(dev, st);
    const sid = hex(rand(8));
    this.rtc.offer().then((o) => this.run(() => {
      if (this.linkByDev.has(dev) || !this.rdvOn()) {
        st.busy = false;
        return o.cancel();
      }
      this.pendingSig.set(sid, { o, devHex: dev, st, route: null });
      setTimeout(() => this.run(() => {
        const p = this.pendingSig.get(sid);
        if (!p) return;
        this.pendingSig.delete(sid);
        p.o.cancel();
        st.busy = false;
      }), this.cfg.upgradeTimeout);
      this.rdvSend(uid, { t: OFFER, to: unhex(dev.slice(UID * 2)), i: unhex(sid), s: o.code });
      return undefined;
    }), () => {
      st.busy = false;
    });
  },

  rdvOffer(uid, dev, m) {
    if (!isBytes(m.to, 8) || hex(m.to) !== this.devHex || !isBytes(m.i, 8) || !isBytes(m.s) || m.s.length > 4096) return;
    if (this.rdvAnswering >= 12) return; // bound the connections being set up at once
    this.rdvAnswering++;
    const done = () => {
      this.rdvAnswering--;
    };
    this.rtc.answer(m.s).then((a) => {
      this.run(() => void this.rdvSend(uid, { t: ANSWER, to: unhex(dev.slice(UID * 2)), i: m.i, s: a.code }));
      a.link.then((raw) => this.run(() => void this.attachLink(raw)), () => {}).then(done);
    }, done);
  },

  rdvAnswer(dev, m) {
    if (!isBytes(m.to, 8) || hex(m.to) !== this.devHex || !isBytes(m.i, 8) || !isBytes(m.s) || m.s.length > 4096) return;
    const sid = hex(m.i);
    const p = this.pendingSig.get(sid);
    if (!p || p.devHex !== dev || p.route) return;
    this.pendingSig.delete(sid);
    p.o.accept(m.s).then((raw) => this.run(() => {
      p.st.busy = false;
      p.st.n = 0;
      this.attachLink(raw);
    }), () => {
      p.st.busy = false;
    });
  },
};
