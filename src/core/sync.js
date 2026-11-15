// SPDX-License-Identifier: AGPL-3.0-or-later
// Spaces, events and replication.
//
// A space is a conversation: a one-to-one chat, a group, a channel, or the private
// space that links a user's own devices. Each device appends signed events to its
// own feed inside a space. Two devices that share a space exchange "what I hold"
// vectors and send each other the missing events, over a direct link or a tunnel.

import { T } from './proto.js';
import { hex, unhex, eq, rand, isBytes } from './bytes.js';
import * as cbor from './cbor.js';
import { sign, verify, hash, seal, open, UID, SIG } from './crypto.js';
import { inboxTag, mailboxTag, feedKey } from './keys.js';

export const evKey = (spId, feed, seq) => `${spId}|${feed}|${String(seq).padStart(10, '0')}`;

const str = (v, max = 20000) => (typeof v === 'string' ? v.slice(0, max) : '');

export const syncMethods = {
  // ---- space bookkeeping ------------------------------------------------------

  blankSpace(id, kind, name, keys) {
    return { id, kind, name, keys, vec: {}, peerHas: {}, created: this.now(), lastTs: 0, lastText: '', unread: 0, rev: 0, left: false, cour: 0 };
  },

  curKey(sp) {
    return sp.keys[sp.keys.length - 1];
  },

  indexSpace(sp) {
    if (sp.left) return;
    for (const k of sp.keys) this.tags.set(hex(k.tag), { sp, k });
    if (sp.kind === 'dm') this.mbx.set(hex(mailboxTag(this.curKey(sp).key, this.id.uid)), sp);
  },

  unindexSpace(sp) {
    for (const k of sp.keys) this.tags.delete(hex(k.tag));
    if (sp.kind === 'dm') this.mbx.delete(hex(mailboxTag(this.curKey(sp).key, this.id.uid)));
    for (const r of this.routes.values()) r.sessions.delete(sp.id);
  },

  // The key to use toward a peer: its own epoch while it lags behind a rekey.
  keyFor(route, sp) {
    const cur = this.curKey(sp);
    const pe = route.epoch.get(sp.id);
    if (pe !== undefined && pe < cur.e) return sp.keys.find((k) => k.e === pe) || cur;
    return cur;
  },

  // May this user take part in the space at all?
  mayTalk(sp, uidHex) {
    switch (sp.kind) {
      case 'dm': {
        const c = this.contacts.get(sp.peer);
        return uidHex === this.uidHex || (uidHex === sp.peer && !(c && c.blocked));
      }
      case 'self': return uidHex === this.uidHex;
      case 'group': return uidHex === this.uidHex || (sp.open ? !sp.roster.banned.includes(uidHex) : !!sp.roster.members[uidHex]);
      default: return true; // channels: anyone holding the read key
    }
  },

  carrierSpace(uidHex) {
    if (uidHex === this.uidHex) return this.selfSpace;
    const c = this.contacts.get(uidHex);
    return c && !c.pending && c.dm ? this.spaces.get(c.dm) : null;
  },

  // ---- sessions ---------------------------------------------------------------

  startSessions(route) {
    const uid = route.peer.uidHex;
    const self = uid === this.uidHex;
    for (const sp of this.spaces.values()) {
      if (sp.left) continue;
      const shared = self || (sp.kind === 'dm' && sp.peer === uid) || (sp.kind === 'group' && !!sp.roster.members[uid]);
      if (!shared && !route.sessions.has(sp.id)) continue;
      route.sessions.add(sp.id);
      this.sendVec(route, sp);
    }
    if (!self) this.sendChs(route);
    this.maybeUpgrade(route);
  },

  sendSpace(route, sp, obj, key = this.keyFor(route, sp)) {
    obj.ce = this.curKey(sp).e; // my newest key epoch, so the peer knows which key I can read
    return this.routeSend(route, { t: T.SF, g: key.tag, b: seal(key.key, cbor.encode(obj), key.tag) });
  },

  sendVec(route, sp) {
    const v = [];
    for (const feed in sp.vec) v.push([unhex(feed), sp.vec[feed].max]);
    route.vecAt.set(sp.id, this.now());
    route.vecRev.set(sp.id, sp.rev);
    // A conversation with many feeds is listed in several messages, so that none
    // outgrows what relays forward.
    const size = this.cfg.vecChunk;
    const parts = Math.max(1, Math.ceil(v.length / size));
    let ok = true;
    for (let i = 0; i < parts; i++) ok = this.sendSpace(route, sp, { t: T.VEC, v: v.slice(i * size, (i + 1) * size), i, z: parts }) && ok;
    return ok;
  },

  // Debounced acknowledgement after receiving events.
  scheduleVec(route, sp) {
    if (route.closed || route.vecTimers.has(sp.id)) return;
    route.vecTimers.set(sp.id, setTimeout(() => {
      route.vecTimers.delete(sp.id);
      this.run(() => {
        if (!route.closed && !sp.left) this.sendVec(route, sp);
      });
    }, this.cfg.vecDelay));
  },

  async onSpaceFrame(route, m, viaCourier) {
    if (!isBytes(m.g, 16) || !isBytes(m.b)) return;
    const ent = this.tags.get(hex(m.g));
    if (!ent || ent.sp.left) return;
    const sp = ent.sp;
    let msg;
    try {
      msg = cbor.decode(open(ent.k.key, m.b, m.g));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (viaCourier) {
      // Held mail: only events, and every event carries its author's signature.
      if (msg.t === T.EV) await this.onEvents(null, sp, msg);
      return;
    }
    // Who is at the other end was proven when the route was set up: by the link
    // authentication, or by the session handshake of a tunnel. Nothing inside the
    // frame is trusted for that.
    if (!route.peer) return;
    const { uidHex } = route.peer;
    if (!this.mayTalk(sp, uidHex)) return;
    if (sp.kind === 'dm' && uidHex === sp.peer) await this.contactSeen(uidHex);
    route.epoch.set(sp.id, Number.isInteger(msg.ce) && msg.ce >= 0 ? msg.ce : ent.k.e);
    // The first time this device is heard in this conversation, tell it what we
    // hold. An earlier attempt may have reached it before it had the key.
    if (!route.heard.has(sp.id)) {
      route.heard.add(sp.id);
      route.sessions.add(sp.id);
      this.sendVec(route, sp);
    }
    switch (msg.t) {
      case T.VEC: return this.onVec(route, sp, msg);
      case T.EV: return this.onEvents(route, sp, msg);
      case T.SIG: return this.onSignal(route, sp, msg);
      case T.CHS: return this.onChs(route, sp, msg);
      case T.CALL: return this.onCall(route, sp, msg);
      case T.BREQ: return this.onBlobReq(route, sp, msg);
      case T.BDATA: return this.onBlobData(route, sp, msg);
      case T.BNONE: return this.onBlobNone(route, sp, msg);
      default: return;
    }
  },

  // ---- replication ------------------------------------------------------------

  async onVec(route, sp, msg) {
    if (!Array.isArray(msg.v) || msg.v.length > 2000) return;
    // A long vector arrives in parts and takes effect when the last one is in.
    const parts = Number.isInteger(msg.z) && msg.z >= 1 && msg.z <= 64 ? msg.z : 1;
    const index = Number.isInteger(msg.i) && msg.i >= 0 ? msg.i : 0;
    const pv = index === 0 ? new Map() : route.vecParts.get(sp.id);
    if (!pv) return;
    for (const e of msg.v) {
      if (Array.isArray(e) && isBytes(e[0], UID + 8) && Number.isSafeInteger(e[1]) && e[1] >= 0) pv.set(hex(e[0]), e[1]);
    }
    if (index < parts - 1) {
      route.vecParts.set(sp.id, pv);
      return;
    }
    route.vecParts.delete(sp.id);
    route.peerVec.set(sp.id, pv);
    let behind = false;
    for (const [feed, max] of pv) {
      const st = sp.vec[feed];
      if (!st || st.max < max) behind = true;
    }
    if (sp.kind === 'dm' && route.peer.uidHex === sp.peer) {
      let changed = false;
      for (const [feed, max] of pv) {
        const mine = sp.vec[feed];
        if (!feed.startsWith(this.uidHex) || !mine) continue;
        const has = Math.min(max, mine.max);
        if ((sp.peerHas[feed] || 0) < has) {
          sp.peerHas[feed] = has;
          changed = true;
        }
      }
      if (changed) {
        this.dirty.add(sp.id);
        this.emit('message', sp.id);
      }
    }
    await this.sendMissing(route, sp);
    if (behind && this.now() - (route.vecAt.get(sp.id) || 0) > 3000) this.sendVec(route, sp);
  },

  async sendMissing(route, sp) {
    const key = this.keyFor(route, sp);
    const pv = route.peerVec.get(sp.id) || new Map();
    const now = this.now();
    for (const feed in sp.vec) {
      const st = sp.vec[feed];
      const has = pv.get(feed) || 0;
      const sk = sp.id + feed;
      if (st.max <= has) {
        route.sent.delete(sk);
        continue;
      }
      let from = has + 1;
      if (has === 0 && sp.kind === 'chan') from = st.max - this.cfg.historyWindow + 1;
      from = Math.max(from, st.min || 1, 1);
      const s = route.sent.get(sk);
      let stuck = 0;
      let at = now;
      if (s) {
        // Events are in flight or the peer keeps refusing them: do not resend the
        // same range until a growing delay has passed.
        const wait = Math.min(8000 * 2 ** s.stuck, 600000);
        if (now - s.at < wait) {
          from = Math.max(from, s.to + 1);
          stuck = s.stuck;
          at = s.at;
        } else {
          stuck = s.has === has ? s.stuck + 1 : 0;
        }
      }
      if (from > st.max) continue;
      const last = await this.sendEvents(route, sp, feed, from, st.max, key);
      if (last >= from) route.sent.set(sk, { to: last, at, has, stuck });
    }
  },

  async sendEvents(route, sp, feed, from, to, key) {
    const hi = Math.min(to, from + this.cfg.syncBurst - 1);
    const rows = await this.store.between('events', evKey(sp.id, feed, from), evKey(sp.id, feed, hi));
    let batch = [];
    let size = 0;
    let last = from - 1;
    const send = () => {
      if (batch.length) this.sendSpace(route, sp, { t: T.EV, e: batch }, key);
      batch = [];
      size = 0;
    };
    for (const { value } of rows) {
      if (value.q !== last + 1 && !(sp.ttl > 0)) break;
      // A peer on an older key epoch only gets what existed before the rekey,
      // plus the rekey events that let it catch up.
      if (value.ep > key.e && value.k !== 'g.key') break;
      if (size + value.raw.length > this.cfg.batchBytes) send();
      batch.push([value.raw, value.sig]);
      size += value.raw.length + 80;
      last = value.q;
    }
    send();
    return last;
  },

  async onEvents(route, sp, msg) {
    if (!Array.isArray(msg.e) || msg.e.length > 4000) return;
    const got = [];
    const pv = route && route.peerVec.get(sp.id);
    for (const p of msg.e) {
      if (!Array.isArray(p)) continue;
      const rec = await this.acceptEvent(sp, p[0], p[1]);
      if (!rec) continue;
      got.push(rec);
      if (pv && (pv.get(rec.feed) || 0) < rec.q) pv.set(rec.feed, rec.q); // the sender obviously holds it
      if (sp.left) break;
    }
    if (!got.length) return;
    await this.gossip(sp, route, got);
    if (route && !route.closed) this.scheduleVec(route, sp);
  },

  // Pass new events on to every other connected device that shares the space.
  // A device whose holdings are known gets exactly what it lacks, in order. One
  // that has not said yet gets our vector and the new events as they are.
  async gossip(sp, except = null, recs = []) {
    for (const route of [...this.routes.values()]) {
      if (route === except || route.closed || !route.peer || !route.sessions.has(sp.id)) continue;
      if (route.peerVec.has(sp.id)) {
        await this.sendMissing(route, sp);
        continue;
      }
      const key = this.keyFor(route, sp);
      this.sendVec(route, sp);
      let batch = [];
      let size = 0;
      for (const r of recs) {
        if (r.ep > key.e && r.k !== 'g.key') continue;
        if (size + r.raw.length > this.cfg.batchBytes && batch.length) {
          this.sendSpace(route, sp, { t: T.EV, e: batch }, key);
          batch = [];
          size = 0;
        }
        batch.push([r.raw, r.sig]);
        size += r.raw.length + 80;
      }
      if (batch.length) this.sendSpace(route, sp, { t: T.EV, e: batch }, key);
    }
  },

  antiEntropy() {
    this.aeTick = (this.aeTick || 0) + 1;
    for (const r of this.routes.values()) {
      if (!r.peer || r.closed) continue;
      for (const id of r.sessions) {
        const sp = this.spaces.get(id);
        if (!sp || sp.left) continue;
        if (r.vecRev.get(id) !== sp.rev || this.aeTick % 6 === 0) this.sendVec(r, sp);
      }
      this.maybeUpgrade(r);
    }
  },

  // ---- events -----------------------------------------------------------------

  // Validates, stores and applies one signed event. Returns the stored record, or
  // null when the event is a duplicate, out of order, forged or not permitted.
  async acceptEvent(sp, raw, sig) {
    if (!isBytes(raw) || raw.length > this.cfg.maxEvent || !isBytes(sig, SIG)) return null;
    let ev;
    try {
      ev = cbor.decode(raw);
    } catch {
      return null;
    }
    if (!ev || ev.v !== 1 || !isBytes(ev.s, 16) || hex(ev.s) !== sp.id || !isBytes(ev.a, UID) || !isBytes(ev.d, 8)) return null;
    if (!Number.isSafeInteger(ev.q) || ev.q < 1 || !Number.isSafeInteger(ev.ts) || typeof ev.k !== 'string' || !ev.b || typeof ev.b !== 'object') return null;
    const feed = feedKey(ev.a, ev.d);
    const st = sp.vec[feed];
    // Where messages delete themselves, feeds have holes: a device that missed
    // messages which are gone everywhere moves on to the next one that exists.
    const holes = sp.ttl > 0;
    if (st) {
      if (ev.q <= st.max) return null;
      if (ev.q === st.max + 1 ? !isBytes(ev.p, 32) || !eq(ev.p, st.last) : !holes) return null;
    } else if (ev.q !== 1 && sp.kind !== 'chan' && !holes) {
      return null; // only channel feeds may be joined part-way
    }
    if (!verify(ev.a, 'void/ev', raw, sig)) return null;
    const author = hex(ev.a);
    if (!st) {
      // One feed per device, and a user only has so many devices: this keeps a
      // member from bloating everyone's bookkeeping with made-up feeds.
      let feeds = 0;
      for (const f in sp.vec) if (f.startsWith(author)) feeds++;
      if (feeds >= this.cfg.maxDevicesPerAuthor) return null;
    }
    if (!this.authorize(sp, ev, author)) return null;
    const idBytes = hash(raw);
    const rec = { raw, sig, id: hex(idBytes), feed, q: ev.q, ts: ev.ts, k: ev.k, ep: this.curKey(sp).e };
    await this.store.put('events', evKey(sp.id, feed, ev.q), rec);
    sp.vec[feed] = { max: ev.q, min: st ? st.min : ev.q, last: idBytes };
    sp.rev++;
    this.dirty.add(sp.id);
    await this.applyEvent(sp, ev, rec, author);
    const view = this.views.get(sp.id);
    if (view) this.viewApply(sp, view, ev, rec.id);
    this.emit('message', sp.id);
    return rec;
  },

  // Appends an event of mine to a space and pushes it to everyone reachable.
  async post(sp, kind, body) {
    if (sp.left) throw new Error('You are no longer part of this conversation');
    const asChannel = sp.kind === 'chan';
    if (asChannel && !sp.chan.seed) throw new Error('Only the channel owner can post');
    const author = asChannel ? sp.chan.pub : this.id.uid;
    const secret = asChannel ? sp.chan.seed : this.id.edSk;
    const st = sp.vec[feedKey(author, this.id.dev)];
    const ev = { v: 1, s: unhex(sp.id), a: author, d: this.id.dev, q: st ? st.max + 1 : 1, p: st ? st.last : null, ts: this.now(), k: kind, b: body };
    const raw = cbor.encode(ev);
    if (raw.length > this.cfg.maxEvent) throw new Error('Message too large');
    const rec = await this.acceptEvent(sp, raw, sign(secret, 'void/ev', raw));
    if (!rec) throw new Error('Could not store the event');
    await this.gossip(sp, null, [rec]);
    if (sp.kind === 'dm' && !this.uidOnline(sp.peer)) this.courierSend(sp, [rec], this.courierLinks(sp));
    return rec;
  },

  isMine(sp, ev) {
    if (sp.kind === 'chan') return !!sp.chan.seed;
    return hex(ev.a) === this.uidHex;
  },

  // ---- message views ----------------------------------------------------------

  async loadView(sp) {
    let view = this.views.get(sp.id);
    if (view) return view;
    view = { list: [], byId: new Map(), pend: new Map() };
    for (const { value } of await this.store.range('events', sp.id + '|')) {
      try {
        this.viewApply(sp, view, cbor.decode(value.raw), value.id);
      } catch { /* skip unreadable record */ }
    }
    this.views.set(sp.id, view);
    return view;
  },

  viewApply(sp, view, ev, id) {
    const author = hex(ev.a);
    const b = ev.b || {};
    const base = { id, ts: ev.ts, author, feed: feedKey(ev.a, ev.d), q: ev.q, mine: this.isMine(sp, ev) };
    if (ev.k === 'msg') {
      const it = { ...base, kind: 'msg', text: str(b.x), att: readAtts(b.a), re: isBytes(b.r, 32) ? hex(b.r) : null, edited: false, deleted: false };
      const waiting = view.pend.get(id);
      if (waiting) {
        for (const fn of waiting) fn(it);
        view.pend.delete(id);
      }
      return this.viewInsert(view, it);
    }
    if (ev.k === 'edit' || ev.k === 'del') {
      if (!isBytes(b.of, 32)) return;
      const target = hex(b.of);
      const admin = sp.kind === 'group' && this.isAdmin(sp, author);
      const fn = (it) => {
        if (it.author !== author && !(admin && ev.k === 'del')) return;
        if (ev.k === 'del') Object.assign(it, { deleted: true, text: '', att: [] });
        else Object.assign(it, { text: str(b.x), edited: true });
      };
      const it = view.byId.get(target);
      if (it) fn(it);
      else if (view.pend.has(target)) view.pend.get(target).push(fn);
      else view.pend.set(target, [fn]);
      return;
    }
    const text = this.systemText(sp, ev, author);
    if (text) this.viewInsert(view, { ...base, kind: 'sys', text });
  },

  viewInsert(view, it) {
    if (view.byId.has(it.id)) return;
    view.byId.set(it.id, it);
    const list = view.list;
    let i = list.length;
    while (i > 0 && (list[i - 1].ts > it.ts || (list[i - 1].ts === it.ts && list[i - 1].id > it.id))) i--;
    list.splice(i, 0, it);
  },

  // ---- public API: conversations ------------------------------------------------

  // Messages of a conversation, oldest first. `state` on my own one-to-one messages
  // is 'sent', 'held' (a contact holds it for the recipient) or 'delivered'.
  messages(spId) {
    return this.enqueue(async () => {
      const sp = this.spaces.get(spId);
      if (!sp) return [];
      const view = await this.loadView(sp);
      return view.list.map((it) => {
        if (!it.mine || sp.kind !== 'dm' || it.kind !== 'msg') return it;
        const state = (sp.peerHas[it.feed] || 0) >= it.q ? 'delivered' : it.feed === this.myFeed && (sp.cour || 0) >= it.q ? 'held' : 'sent';
        return { ...it, state };
      });
    });
  },

  sendMessage(spId, { text = '', att = [], re = null } = {}) {
    return this.enqueue(async () => {
      const sp = this.spaces.get(spId);
      if (!sp) throw new Error('Unknown conversation');
      const body = { x: str(text) };
      if (att.length) body.a = att.slice(0, 10);
      if (re) body.r = unhex(re);
      if (!body.x && !body.a) throw new Error('Empty message');
      return (await this.post(sp, 'msg', body)).id;
    });
  },

  editMessage(spId, id, text) {
    return this.enqueue(() => this.post(this.spaces.get(spId), 'edit', { of: unhex(id), x: str(text) }));
  },

  deleteMessage(spId, id) {
    return this.enqueue(() => this.post(this.spaces.get(spId), 'del', { of: unhex(id) }));
  },

  setActive(spId) {
    this.activeSpace = spId;
    const sp = spId && this.spaces.get(spId);
    if (sp && sp.unread) {
      sp.unread = 0;
      this.run(() => void this.dirty.add(sp.id));
      this.emit('spaces');
    }
  },

  // Conversation list for the sidebar, most recent first.
  chats() {
    const out = [];
    for (const sp of this.spaces.values()) {
      if (sp.kind === 'self') continue;
      let title = sp.name;
      let reach = null;
      if (sp.kind === 'dm') {
        const c = this.contacts.get(sp.peer);
        if (!c || c.pending === 'in') continue;
        title = c.alias || c.name;
        reach = this.reach(sp.peer);
      } else {
        let n = 0;
        for (const r of this.routes.values()) if (r.peer && r.sessions.has(sp.id)) n++;
        reach = { state: n ? 'online' : 'offline', peers: n };
      }
      const c = sp.kind === 'dm' ? this.contacts.get(sp.peer) : null;
      out.push({
        id: sp.id, kind: sp.kind, title, text: sp.lastText, ts: sp.lastTs || sp.created, unread: sp.unread, reach, left: sp.left,
        canPost: !sp.left && (sp.kind !== 'chan' || !!sp.chan.seed) && !(c && c.blocked), pending: !!c && c.pending === 'out',
        muted: !!sp.muted, blocked: !!(c && c.blocked), peer: c ? c.uid : null, seen: c ? c.seen || 0 : 0, ttl: sp.ttl || 0, scheduled: this.scheduledFor(sp.id).length,
      });
    }
    return out.sort((a, b) => b.ts - a.ts);
  },

  // ---- discovery loop ---------------------------------------------------------

  discover() {
    if (!this.ready || !this.links.size) return;
    const now = this.now();
    const want = [];
    for (const c of this.contacts.values()) {
      if (c.blocked || c.pending === 'in') continue;
      if (c.pending === 'out') want.push({ k: 'r' + c.uid, tags: [inboxTag(unhex(c.uid))], contact: c.uid });
      const sp = this.spaces.get(c.dm);
      if (!sp || sp.left || this.uidOnline(c.uid)) continue;
      const key = this.curKey(sp);
      want.push({ k: 'u' + c.uid, tags: [key.tag, mailboxTag(key.key, this.id.uid)] });
    }
    for (const sp of this.spaces.values()) {
      if (sp.left || sp.kind === 'dm') continue;
      if (sp.kind === 'self') {
        if (!this.uidOnline(this.uidHex)) want.push({ k: 's' + sp.id, tags: [this.curKey(sp).tag], slow: 4 });
        continue;
      }
      let live = false;
      for (const r of this.routes.values()) if (r.peer && r.sessions.has(sp.id)) live = true;
      if (!live) want.push({ k: 's' + sp.id, tags: sp.keys.slice(-2).map((k) => k.tag) });
    }
    let sent = 0;
    for (const w of want) {
      const st = this.disc.get(w.k) || { n: 0, next: 0 };
      if (now < st.next) continue;
      st.next = now + Math.min(this.cfg.rreqEvery * (w.slow || 1) * 2 ** st.n, this.cfg.rreqMax) * (0.75 + Math.random() / 2);
      st.n++;
      this.disc.set(w.k, st);
      this.sendRreq(w.tags, { contact: w.contact });
      if (++sent >= 40) break;
    }
  },

  // ---- direct-connection upgrade ------------------------------------------------
  // When a contact is only reachable through a tunnel, the two devices exchange a
  // WebRTC offer and answer through that tunnel and try to connect directly.

  maybeUpgrade(route) {
    if (!this.rtc || !this.settings.autoDirect || route.kind !== 'tunnel' || route.closed || !route.peer) return;
    const { uidHex, devHex } = route.peer;
    const carrier = this.carrierSpace(uidHex);
    const contact = this.contacts.get(uidHex);
    if (contact && contact.relayOnly) return; // this contact is only ever reached through others
    if (!carrier || this.linkByDev.has(devHex) || this.devKey > devHex) return; // the lower device dials
    const now = this.now();
    const st = this.upgrades.get(devHex) || { n: 0, next: 0, busy: false };
    if (st.busy || now < st.next) return;
    st.busy = true;
    st.next = now + Math.min(this.cfg.upgradeRetry * 2 ** st.n, 1800000);
    st.n++;
    this.upgrades.set(devHex, st);
    const sid = hex(rand(8));
    this.rtc.offer().then((o) => this.run(() => {
      if (route.closed || this.linkByDev.has(devHex)) {
        // The route went away while the offer was being prepared. This was not a
        // failed attempt: try again on whatever route reaches the device now.
        Object.assign(st, { busy: false, next: 0, n: Math.max(0, st.n - 1) });
        o.cancel();
        for (const r of this.routes.values()) if (r.peer && r.peer.devHex === devHex && !r.closed) this.maybeUpgrade(r);
        return undefined;
      }
      this.pendingSig.set(sid, { o, devHex, st, route });
      setTimeout(() => this.run(() => {
        const p = this.pendingSig.get(sid);
        if (!p) return;
        this.pendingSig.delete(sid);
        p.o.cancel();
        st.busy = false;
      }), this.cfg.upgradeTimeout);
      this.sendSpace(route, carrier, { t: T.SIG, to: unhex(devHex.slice(UID * 2)), k: 'o', i: unhex(sid), s: o.code });
      return undefined;
    }), () => {
      st.busy = false;
    });
  },

  onSignal(route, sp, msg) {
    if (!this.rtc || (sp.kind !== 'dm' && sp.kind !== 'self')) return;
    if (!isBytes(msg.to, 8) || hex(msg.to) !== this.devHex || !isBytes(msg.i, 8) || !isBytes(msg.s) || msg.s.length > 8192) return;
    const devHex = route.peer.devHex;
    if (msg.k === 'o') {
      // An offer means the other device has no working link to us, whatever we
      // believe about ours: a link we still hold to it is replaced once the new one is up.
      const contact = this.contacts.get(route.peer.uidHex);
      if (!this.settings.autoDirect || (contact && contact.relayOnly)) return;
      // Each offer costs a connection attempt: one at a time per device, a few in all.
      if (this.now() - route.sigAt < this.cfg.sigEvery || this.rdvAnswering >= 12) return;
      route.sigAt = this.now();
      this.rdvAnswering++;
      const done = () => {
        this.rdvAnswering--;
      };
      this.rtc.answer(msg.s).then((a) => {
        this.run(() => void this.sendSpace(route, sp, { t: T.SIG, to: unhex(devHex.slice(UID * 2)), k: 'a', i: msg.i, s: a.code }));
        a.link.then((raw) => this.run(() => void this.attachLink(raw)), () => {}).then(done);
      }, done);
    } else if (msg.k === 'a') {
      const sid = hex(msg.i);
      const p = this.pendingSig.get(sid);
      if (!p || p.devHex !== devHex) return;
      this.pendingSig.delete(sid);
      p.o.accept(msg.s).then((raw) => this.run(() => {
        p.st.busy = false;
        p.st.n = 0;
        this.attachLink(raw);
      }), () => {
        p.st.busy = false;
      });
    }
  },

  // ---- calls ----------------------------------------------------------------------
  // The engine only carries the signalling of a call, inside the one-to-one
  // conversation (so it is end-to-end encrypted and its sender is proven). The
  // media connection itself is made by the interface, directly between the two
  // devices.

  // Sends a call signal to every connected device of a contact, or to one of them.
  // Returns how many devices it went to.
  callSignal(uidHex, devHex, signal) {
    const c = this.contacts.get(uidHex);
    const sp = c && !c.pending && c.dm ? this.spaces.get(c.dm) : null;
    if (!sp || sp.left || !this.settings.calls) return 0;
    let sent = 0;
    for (const r of this.routes.values()) {
      if (r.closed || !r.peer || r.peer.uidHex !== uidHex || (devHex && r.peer.devHex !== devHex)) continue;
      if (this.sendSpace(r, sp, { ...signal, t: T.CALL })) sent++;
    }
    return sent;
  },

  onCall(route, sp, msg) {
    if (sp.kind !== 'dm' || route.peer.uidHex !== sp.peer) return;
    if (typeof msg.k !== 'string' || msg.k.length > 12 || !isBytes(msg.i, 8)) return;
    if (!this.settings.calls) {
      // Calls are switched off here: tell a caller so, and take nothing else.
      if (msg.k === 'ring') this.sendSpace(route, sp, { t: T.CALL, k: 'end', i: msg.i, r: 'off' });
      return;
    }
    this.emit('call', route.peer.uidHex, route.peer.devHex, msg);
  },

  // ---- finding shared channels with a contact ------------------------------------
  // Contacts exchange salted digests of their channel tags. A digest only means
  // something to a peer that already holds the same channel.

  sendChs(route) {
    const carrier = this.carrierSpace(route.peer.uidHex);
    if (!carrier) return;
    const salt = rand(8);
    const g = [];
    for (const sp of this.spaces.values()) {
      if (!sp.left && (sp.kind === 'chan' || (sp.kind === 'group' && sp.open))) g.push(hash(salt, this.curKey(sp).tag).subarray(0, 8));
    }
    if (g.length) this.sendSpace(route, carrier, { t: T.CHS, a: salt, g });
  },

  onChs(route, sp, msg) {
    if ((sp.kind !== 'dm' && sp.kind !== 'self') || !isBytes(msg.a, 8) || !Array.isArray(msg.g) || msg.g.length > 5000) return;
    const theirs = new Set();
    for (const d of msg.g) if (isBytes(d, 8)) theirs.add(hex(d));
    for (const s of this.spaces.values()) {
      if (s.left || route.sessions.has(s.id) || !(s.kind === 'chan' || (s.kind === 'group' && s.open))) continue;
      if (!theirs.has(hex(hash(msg.a, this.curKey(s).tag).subarray(0, 8)))) continue;
      route.sessions.add(s.id);
      this.sendVec(route, s);
    }
  },

  broadcastChs() {
    for (const r of this.routes.values()) if (r.peer && !r.closed && r.peer.uidHex !== this.uidHex) this.sendChs(r);
  },
};

// Attachment descriptors inside a message body.
function readAtts(a) {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const x of a.slice(0, 10)) {
    if (!x || !isBytes(x.i, 32) || !isBytes(x.k, 32) || !Number.isSafeInteger(x.z) || !Number.isSafeInteger(x.c)) continue;
    // The stated size and the number of chunks must agree, so that a small-looking
    // attachment cannot turn out to be a huge download.
    if (x.z < 0 || x.z > 256 * 1024 * 1024 || x.c !== Math.max(1, Math.ceil(x.z / 32752))) continue;
    out.push({
      id: hex(x.i), key: x.k, size: x.z, chunks: x.c,
      name: str(x.n, 200) || 'file', mime: str(x.m, 100) || 'application/octet-stream',
      kind: ['image', 'video', 'voice', 'file'].includes(x.t) ? x.t : 'file',
      thumb: isBytes(x.p) && x.p.length <= 32768 ? x.p : null,
      w: Number.isSafeInteger(x.w) ? x.w : 0, h: Number.isSafeInteger(x.h) ? x.h : 0, dur: Number.isSafeInteger(x.d) ? x.d : 0,
    });
  }
  return out;
}
