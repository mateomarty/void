// SPDX-License-Identifier: AGPL-3.0-or-later
// Contacts, pairing, contact requests, groups, channels, own-device sync and backups.

import { T, oldKeys } from './proto.js';
import { hex, unhex, eq, rand, concat, utf8, text, isBytes } from './bytes.js';
import * as cbor from './cbor.js';
import { sign, verify, edPublic, hpkeSeal, hpkeOpen, passSeal, passOpen, UID, DH, SIG } from './crypto.js';
import { readCard, makeCard, dmKey, tagOf, spaceIdOf, inboxTag, channelId, channelPublicKey, makeLink, readLink, safetyNumber } from './keys.js';

const INVITE_DAYS = 14;

const REQ_INFO = utf8('void/v1/request');
const GKEY_INFO = utf8('void/v1/group-key');
const BACKUP_MAGIC = utf8('VOIDBK3\n'); // 1 and 2 held identities with the earlier keys and are refused
const name80 = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const epochAad = (sp, e) => concat(unhex(sp.id), Uint8Array.of((e >>> 24) & 255, (e >>> 16) & 255, (e >>> 8) & 255, e & 255));

export const socialMethods = {
  // ---- names --------------------------------------------------------------------

  nameOf(uidHex) {
    if (uidHex === this.uidHex) return this.id.name;
    const c = this.contacts.get(uidHex);
    if (c) return c.alias || c.name;
    for (const sp of this.spaces.values()) {
      if (sp.kind === 'chan' && hex(sp.chan.pub) === uidHex) return sp.name;
      if (sp.kind !== 'group' || !sp.roster.members[uidHex]) continue;
      const info = readCard(sp.roster.members[uidHex]);
      if (info) return info.name;
    }
    return uidHex.slice(0, 8);
  },

  async setName(name) {
    return this.enqueue(async () => {
      const rec = await this.store.get('kv', 'id');
      rec.name = name80(name).slice(0, 64) || 'Anonymous';
      rec.ts = this.now();
      await this.store.put('kv', 'id', rec);
      this.id.name = rec.name;
      this.id.ts = rec.ts;
      this.card = makeCard(this.id, rec.name, rec.ts);
      await this.post(this.selfSpace, 's.name', { n: rec.name, ts: rec.ts });
      this.emit('contacts');
    });
  },

  myLink() {
    return makeLink('u', this.card);
  },

  safety(uidHex) {
    return safetyNumber(this.id.uid, unhex(uidHex));
  },

  // ---- contacts -------------------------------------------------------------------

  ensureDm(c) {
    const key = dmKey(this.id.dhSk, c.dh, this.id.uid, unhex(c.uid));
    const id = hex(spaceIdOf(key));
    let sp = this.spaces.get(id);
    if (!sp) {
      sp = this.blankSpace(id, 'dm', '', [{ e: 0, key, tag: tagOf(key) }]);
      sp.peer = c.uid;
      this.spaces.set(id, sp);
    }
    sp.left = false;
    this.indexSpace(sp);
    this.dirty.add(id);
    c.dm = id;
    return sp;
  },

  // Adds or refreshes a contact from a verified card. `pending` is 'out' for a
  // request I sent, 'in' for one I received, null for an established contact.
  async addContact(info, { pending = null, fromSelf = false } = {}) {
    const uid = hex(info.uid);
    if (uid === this.uidHex) return null;
    let c = this.contacts.get(uid);
    let announce = false;
    if (!c) {
      c = { uid, dh: info.dh, name: info.name, card: info.card, ts: info.ts, added: this.now(), pending, blocked: false, dm: null };
      this.contacts.set(uid, c);
      announce = !pending;
    } else {
      if (!eq(c.dh, info.dh)) return c; // a changed encryption key is never accepted silently
      if (info.ts > c.ts) Object.assign(c, { name: info.name, card: info.card, ts: info.ts });
      if (c.pending && pending !== c.pending) {
        c.pending = null;
        announce = true;
      }
    }
    if (c.pending !== 'in' && (!c.dm || !this.spaces.has(c.dm) || this.spaces.get(c.dm).left)) this.ensureDm(c);
    await this.store.put('contacts', uid, c);
    if (announce && !fromSelf) await this.post(this.selfSpace, 's.contact', { c: c.card.c, s: c.card.s });
    if (announce && c.dm) await this.shareProfile(this.spaces.get(c.dm)); // a new contact gets my photo and bio
    this.emit('contacts');
    this.emit('spaces');
    this.kick();
    this.rdvRefresh();
    return c;
  },

  // The peer answered on our pairwise key: a request I sent was accepted.
  async contactSeen(uidHex) {
    const c = this.contacts.get(uidHex);
    if (!c || c.pending !== 'out') return;
    c.pending = null;
    await this.store.put('contacts', uidHex, c);
    await this.post(this.selfSpace, 's.contact', { c: c.card.c, s: c.card.s });
    this.emit('contacts');
    this.emit('spaces');
  },

  contactList() {
    return [...this.contacts.values()].map((c) => ({ uid: c.uid, name: c.alias || c.name, given: c.name, pending: c.pending, blocked: c.blocked, relayOnly: !!c.relayOnly, dm: c.dm, reach: this.reach(c.uid), seen: c.seen || 0 }));
  },

  // "Relay only": never hold a direct connection to this contact, so that neither
  // side learns the other's network address. Messages then travel through contacts
  // that both can reach; if there is none, they wait.
  setRelayOnly(uidHex, on) {
    return this.enqueue(async () => {
      const c = this.contacts.get(uidHex);
      if (!c) return;
      c.relayOnly = !!on;
      await this.store.put('contacts', uidHex, c);
      if (on) for (const L of [...this.links.values()]) if (L.uidHex === uidHex) this.closeLink(L, 'relay only');
      this.rdvRefresh();
      this.kick();
      this.emit('contacts');
    });
  },

  acceptRequest(uidHex) {
    return this.enqueue(async () => {
      const c = this.contacts.get(uidHex);
      if (c && c.pending === 'in') await this.addContact(readCard(c.card));
    });
  },

  removeContact(uidHex) {
    return this.enqueue(async () => {
      const c = this.contacts.get(uidHex);
      if (!c) return;
      this.contacts.delete(uidHex);
      await this.store.del('contacts', uidHex);
      const sp = c.dm && this.spaces.get(c.dm);
      if (sp) {
        sp.left = true;
        this.unindexSpace(sp);
        this.dirty.add(sp.id);
      }
      for (const L of [...this.links.values()]) if (L.uidHex === uidHex) this.closeLink(L, 'contact removed');
      for (const r of [...this.tunnels.values()]) if (r.peer && r.peer.uidHex === uidHex) this.closeRoute(r);
      await this.post(this.selfSpace, 's.gone', { u: unhex(uidHex) });
      this.emit('contacts');
      this.emit('spaces');
    });
  },

  // ---- pairing by hand: the bootstrap ---------------------------------------------
  // Two people exchange an invite and a reply (QR codes or text). No third party is
  // involved; the exchange also makes them contacts.

  async invite() {
    if (!this.rtc) throw new Error('No transport available');
    const o = await this.rtc.offer();
    return {
      code: makeLink('i', { v: 1, s: o.code }),
      complete: async (reply) => {
        const d = readLink(reply);
        if (!d || d.kind !== 'r' || !isBytes(d.data.s)) throw new Error('This is not a reply code');
        const raw = await o.accept(d.data.s);
        await this.enqueue(() => void this.attachLink(raw, { pairing: true }));
      },
      cancel: () => o.cancel(),
    };
  },

  async join(invite) {
    if (!this.rtc) throw new Error('No transport available');
    const d = readLink(invite);
    if (!d || d.kind !== 'i' || !isBytes(d.data.s)) throw new Error('This is not an invite code');
    const a = await this.rtc.answer(d.data.s, { manual: true });
    const done = a.link.then((raw) => this.enqueue(() => void this.attachLink(raw, { pairing: true })));
    done.catch(() => {});
    return { code: makeLink('r', { v: 1, s: a.code }), done, cancel: () => a.cancel() };
  },

  // ---- contact requests through the network ----------------------------------------
  // Given someone's card (a void:u: link), the request is routed to their public
  // inbox tag and sealed to their identity key, so relays cannot read who asks.

  requestContact(link) {
    return this.enqueue(async () => {
      const d = readLink(link);
      const info = d && d.kind === 'u' ? readCard(d.data) : null;
      if (!info) throw new Error('This is not a contact link');
      if (hex(info.uid) === this.uidHex) throw new Error('This is your own contact link');
      const existing = this.contacts.get(hex(info.uid));
      // Asking someone who already asked me is the same as accepting.
      const c = await this.addContact(info, { pending: !existing || existing.pending === 'out' ? 'out' : null });
      if (c.pending === 'out' && isBytes(d.data.k, 16)) {
        c.token = d.data.k; // the link was an invite: this proves I was invited
        await this.store.put('contacts', c.uid, c);
      }
      this.rdvHi.delete('q' + c.uid);
      this.rdvAnnounce(true);
      return c;
    });
  },

  // ---- invite links ---------------------------------------------------------------
  // An invite link is my contact card plus a secret. Whoever opens it sends me a
  // request carrying that secret, and my device accepts it on its own: nobody has
  // to answer anything back, and it works whenever both devices are next online.
  // Each link admits one person and stops working after two weeks.

  createInviteLink() {
    return this.enqueue(async () => {
      const now = this.now();
      const k = rand(16);
      this.invites = this.invites.filter((x) => x.exp > now).slice(-63);
      this.invites.push({ k: hex(k), exp: now + INVITE_DAYS * 86400000 });
      await this.store.put('kv', 'invites', this.invites);
      this.rdvRefresh();
      return makeLink('u', { c: this.card.c, s: this.card.s, k });
    });
  },

  openInvites() {
    const now = this.now();
    return this.invites.filter((x) => x.exp > now).length;
  },

  cancelInvites() {
    return this.enqueue(async () => {
      this.invites = [];
      await this.store.put('kv', 'invites', this.invites);
    });
  },

  // The sealed request that tells a user I would like to be their contact.
  requestPayload(c) {
    const to = unhex(c.uid);
    const body = cbor.encode({ c: this.card.c, s: this.card.s, to, ts: this.now(), k: isBytes(c.token, 16) ? c.token : undefined });
    const tag = inboxTag(to);
    const { enc, ct } = hpkeSeal(c.dh, REQ_INFO, tag, cbor.encode({ b: body, s: sign(this.id.edSk, 'void/request', body) }));
    return { tag, enc, ct };
  },

  sendRequest(route, uidHex) {
    const c = this.contacts.get(uidHex);
    if (!c || c.pending !== 'out') return;
    const { tag, enc, ct } = this.requestPayload(c);
    this.routeSend(route, { t: T.HPKE, g: tag, e: enc, c: ct });
  },

  async onRequest(route, m) {
    if (!isBytes(m.g, 16) || hex(m.g) !== this.myInboxHex) return;
    await this.takeRequest(m.e, m.c);
    if (route.kind === 'tunnel' && !route.peer) this.closeRoute(route);
  },

  // A request reached me, through contacts or through the rendezvous relays.
  async takeRequest(enc, ct) {
    if (!isBytes(enc, DH) || !isBytes(ct) || ct.length > 4096) return;
    let o;
    let body;
    try {
      o = cbor.decode(hpkeOpen(this.id.dhSk, enc, REQ_INFO, unhex(this.myInboxHex), ct));
      body = cbor.decode(o.b);
    } catch {
      return;
    }
    const info = readCard({ c: body.c, s: body.s });
    if (!info || !isBytes(o.s, SIG) || !verify(info.uid, 'void/request', o.b, o.s)) return;
    if (!isBytes(body.to, UID) || !eq(body.to, this.id.uid) || Math.abs(this.now() - body.ts) > 2 * 86400000) return;
    const uid = hex(info.uid);
    const existing = this.contacts.get(uid);
    if (existing && (existing.blocked || !existing.pending)) return; // blocked, or already a contact
    const now = this.now();
    const invite = isBytes(body.k, 16) ? this.invites.find((x) => x.k === hex(body.k) && x.exp > now) : null;
    if (invite) {
      // They hold a link I made: we are contacts, with no further question.
      this.invites = this.invites.filter((x) => x !== invite);
      await this.store.put('kv', 'invites', this.invites);
      await this.addContact(info);
      this.emit('joined', uid);
      this.rdvHi.delete(uid);
      this.rdvAnnounce(true);
      return;
    }
    if (!this.settings.requests) return;
    if (existing && existing.pending === 'in') return;
    if (!existing && [...this.contacts.values()].filter((c) => c.pending === 'in').length >= 64) return;
    await this.addContact(info, { pending: 'in' });
    this.emit('request', uid);
    if (existing) this.rdvAnnounce(true); // we had both asked: say hello
  },

  // ---- permissions ------------------------------------------------------------------

  isAdmin(sp, uidHex) {
    return sp.kind === 'group' && (sp.roster.owner === uidHex || sp.roster.admins.includes(uidHex));
  },

  // Is this author allowed to append this kind of event to this space?
  authorize(sp, ev, author) {
    switch (sp.kind) {
      case 'dm':
        return author === sp.peer || author === this.uidHex;
      case 'self':
        return author === this.uidHex;
      case 'chan':
        return eq(ev.a, sp.chan.pub);
      case 'group': {
        const r = sp.roster;
        const member = !!r.members[author] || author === r.owner;
        switch (ev.k) {
          case 'g.join': {
            const info = readCard(ev.b);
            return sp.open && !r.banned.includes(author) && !!info && hex(info.uid) === author;
          }
          case 'g.add': return member && !!readCard(ev.b);
          case 'g.rm': return this.isAdmin(sp, author) && isBytes(ev.b.u, UID) && hex(ev.b.u) !== r.owner;
          case 'g.adm': return author === r.owner && isBytes(ev.b.u, UID);
          case 'g.meta': return this.isAdmin(sp, author);
          case 'ttl': return this.isAdmin(sp, author);
          case 'g.key': return this.isAdmin(sp, author) && Number.isInteger(ev.b.e) && Array.isArray(ev.b.k);
          default: return member;
        }
      }
      default:
        return false;
    }
  },

  // Side effects of an accepted event.
  async applyEvent(sp, ev, rec, author) {
    const b = ev.b;
    const mine = this.isMine(sp, ev);
    if (ev.k === 'msg') {
      const att = Array.isArray(b.a) && b.a[0] && typeof b.a[0] === 'object' ? b.a[0] : null;
      const preview = typeof b.x === 'string' && b.x ? b.x.replace(/void:[a-z]:[A-Za-z0-9_-]+/g, '[Void link]').slice(0, 120) : att ? ({ image: 'Photo', video: 'Video', voice: 'Voice message' }[att.t] || 'File') : '';
      if (ev.ts >= sp.lastTs) {
        sp.lastTs = ev.ts;
        sp.lastText = (sp.kind === 'group' && !mine ? this.nameOf(author) + ': ' : '') + preview;
      }
      if (!mine && this.activeSpace !== sp.id) {
        sp.unread++;
        if (!sp.muted) this.emit('notify', sp.id, this.nameOf(sp.kind === 'chan' ? hex(sp.chan.pub) : author), preview);
      }
      this.emit('spaces');
      return;
    }
    switch (ev.k) {
      case 'd.ginv': // a contact added me to a group
        if (!mine && sp.kind === 'dm') await this.importSpace(b.g, { invited: true });
        break;
      case 'g.meta':
      case 'c.meta':
        if (name80(b.n)) sp.name = name80(b.n);
        if (typeof b.about === 'string') sp.about = b.about.slice(0, 500);
        if (isBytes(b.av) && b.av.length <= 20000) sp.av = b.av.length ? b.av : null;
        break;
      case 'p.set':
        if (sp.kind === 'dm' || sp.kind === 'group') await this.onProfile(ev, author);
        break;
      case 'ttl':
        sp.ttl = Number.isSafeInteger(b.s) && b.s >= 60 ? Math.min(b.s, 366 * 86400) : 0;
        this.emit('spaces');
        break;
      case 'g.add':
      case 'g.join': {
        const info = readCard(b);
        const uid = hex(info.uid);
        if (sp.roster.banned.includes(uid)) break;
        sp.roster.members[uid] = info.card;
        this.shareWith(sp, uid);
        break;
      }
      case 'g.leave': {
        const was = !!sp.roster.members[author];
        this.dropMember(sp, author);
        // The owner gives the remaining members a fresh key. Only for a leave that
        // just happened (not while replaying history), and from one of the owner's
        // devices only, so that two devices do not renew at the same time.
        const mine = Object.keys(sp.vec).filter((f) => f.startsWith(this.uidHex)).sort();
        if (was && !sp.open && !sp.left && author !== this.uidHex && sp.roster.owner === this.uidHex && mine[0] === this.myFeed && this.now() - ev.ts < 600000) await this.rekey(sp);
        break;
      }
      case 'g.rm': {
        const uid = hex(b.u);
        // The removed member's connected devices learn about it before the space closes for them.
        for (const r of [...this.routes.values()]) {
          if (r.peer && !r.closed && r.peer.uidHex === uid && r.sessions.has(sp.id)) await this.sendMissing(r, sp);
        }
        this.dropMember(sp, uid);
        if (sp.open && !sp.roster.banned.includes(uid)) sp.roster.banned.push(uid);
        if (uid === this.uidHex) this.leaveLocally(sp);
        break;
      }
      case 'g.adm': {
        const uid = hex(b.u);
        sp.roster.admins = sp.roster.admins.filter((x) => x !== uid);
        if (b.on && sp.roster.members[uid]) sp.roster.admins.push(uid);
        break;
      }
      case 'g.key': {
        if (sp.keys.some((k) => k.e === b.e) || b.e !== this.curKey(sp).e + 1) break;
        for (const entry of b.k) {
          if (!Array.isArray(entry) || !isBytes(entry[0], UID) || !eq(entry[0], this.id.uid) || !isBytes(entry[1], DH) || !isBytes(entry[2])) continue;
          try {
            const key = hpkeOpen(this.id.dhSk, entry[1], GKEY_INFO, epochAad(sp, b.e), entry[2]);
            if (key.length !== 32) break;
            const k = { e: b.e, key, tag: tagOf(key) };
            sp.keys.push(k);
            this.tags.set(hex(k.tag), { sp, k });
          } catch { /* not sealed to my key */ }
          break;
        }
        break;
      }
      case 's.contact': {
        const info = readCard(b);
        if (info && !mineDevice(this, ev)) await this.addContact(info, { fromSelf: true });
        break;
      }
      case 's.space':
        if (!mineDevice(this, ev)) await this.importSpace(b.r, { fromSelf: true });
        break;
      case 's.gone':
        if (mineDevice(this, ev)) break;
        if (isBytes(b.i, 16)) {
          const gone = this.spaces.get(hex(b.i));
          if (gone && gone.kind !== 'dm' && gone.kind !== 'self') this.leaveLocally(gone);
        } else if (isBytes(b.u, UID) && this.contacts.has(hex(b.u))) {
          const c = this.contacts.get(hex(b.u));
          this.contacts.delete(c.uid);
          await this.store.del('contacts', c.uid);
          if (c.dm && this.spaces.has(c.dm)) this.leaveLocally(this.spaces.get(c.dm));
          this.emit('contacts');
        }
        break;
      case 's.name':
        if (!mineDevice(this, ev) && Number.isSafeInteger(b.ts) && b.ts > this.id.ts && name80(b.n)) {
          const stored = await this.store.get('kv', 'id');
          Object.assign(stored, { name: name80(b.n).slice(0, 64), ts: b.ts });
          await this.store.put('kv', 'id', stored);
          Object.assign(this.id, { name: stored.name, ts: stored.ts });
          this.card = makeCard(this.id, stored.name, stored.ts);
        }
        break;
      default:
        break;
    }
    if (ev.k.startsWith('g.') || ev.k.startsWith('c.')) this.emit('spaces');
  },

  // Start replicating a space with the connected devices of one user.
  shareWith(sp, uidHex) {
    for (const r of this.routes.values()) {
      if (!r.peer || r.closed || r.peer.uidHex !== uidHex || r.sessions.has(sp.id)) continue;
      r.sessions.add(sp.id);
      this.sendVec(r, sp);
    }
  },

  dropMember(sp, uidHex) {
    delete sp.roster.members[uidHex];
    sp.roster.admins = sp.roster.admins.filter((x) => x !== uidHex);
    for (const r of this.routes.values()) if (r.peer && r.peer.uidHex === uidHex) r.sessions.delete(sp.id);
  },

  leaveLocally(sp) {
    sp.left = true;
    this.unindexSpace(sp);
    this.dirty.add(sp.id);
    this.emit('spaces');
  },

  // One line for the conversation history, or '' when the event is not shown.
  systemText(sp, ev, author) {
    const who = author === this.uidHex ? 'You' : this.nameOf(author);
    const b = ev.b || {};
    const other = (bytes) => (isBytes(bytes, UID) ? (hex(bytes) === this.uidHex ? 'you' : this.nameOf(hex(bytes))) : 'someone');
    switch (ev.k) {
      case 'g.meta':
        if (b.w === 'photo') return `${who} changed the group photo`;
        if (b.w === 'about') return `${who} changed the description`;
        return ev.q === 1 ? `${who} created the group "${name80(b.n)}"` : `${who} renamed the group to "${name80(b.n)}"`;
      case 'c.meta':
        if (b.w === 'photo') return 'The channel photo changed';
        if (b.w === 'about') return 'The channel description changed';
        return ev.q === 1 ? `Channel "${name80(b.n)}" created` : `Channel renamed to "${name80(b.n)}"`;
      case 'ttl': {
        const s = Number.isSafeInteger(b.s) ? b.s : 0;
        const span = s >= 86400 ? `${Math.round(s / 86400)} day${s >= 172800 ? 's' : ''}` : s >= 3600 ? `${Math.round(s / 3600)} hour${s >= 7200 ? 's' : ''}` : `${Math.round(s / 60)} minute${s >= 120 ? 's' : ''}`;
        return s >= 60 ? `${who} set messages to delete themselves after ${span}` : `${who} turned off auto-delete`;
      }
      case 'g.add': {
        const info = readCard(b);
        if (!info || hex(info.uid) === author) return '';
        return `${who} added ${hex(info.uid) === this.uidHex ? 'you' : info.name}`;
      }
      case 'g.join': return `${who} joined`;
      case 'g.leave': return `${who} left`;
      case 'g.rm': return `${who} removed ${other(b.u)}`;
      case 'g.adm': return `${who} ${b.on ? 'made' : 'removed'} ${other(b.u)} ${b.on ? 'an admin' : 'as admin'}`;
      case 'g.key': return `${who} renewed the group key`;
      case 'd.ginv': return `${who} added ${author === this.uidHex ? 'them' : 'you'} to the group "${name80(b.g && b.g.n)}"`;
      case 'call': {
        const secs = Number.isSafeInteger(b.d) ? Math.round(b.d / 1000) : 0;
        const kind = b.v ? 'Video call' : 'Voice call';
        if (!secs) return author === this.uidHex ? `${kind}: no answer` : `Missed ${kind.toLowerCase()}`;
        return `${kind} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      }
      default: return '';
    }
  },

  // ---- groups -------------------------------------------------------------------

  // Portable description of a group or channel. `secret` also includes what only
  // my own devices may have (older keys, the channel signing key).
  exportSpace(sp, secret = false) {
    const cur = this.curKey(sp);
    const o = { i: unhex(sp.id), k: sp.kind, n: sp.name, y: (secret ? sp.keys : [cur]).map((k) => [k.e, k.key]) };
    if (sp.kind === 'group') {
      const r = sp.roster;
      o.o = !!sp.open;
      o.r = { o: unhex(r.owner), a: r.admins.map(unhex), m: Object.values(r.members).map((c) => [c.c, c.s]), b: r.banned.map(unhex) };
    } else {
      o.p = sp.chan.pub;
      o.u = !!sp.chan.public;
      if (secret && sp.chan.seed) o.s = sp.chan.seed;
    }
    return o;
  },

  async importSpace(o, { fromSelf = false, invited = false } = {}) {
    if (!o || !isBytes(o.i, 16) || !Array.isArray(o.y) || !o.y.length || (o.k !== 'group' && o.k !== 'chan')) return null;
    const id = hex(o.i);
    const keys = [];
    for (const y of o.y) {
      if (!Array.isArray(y) || !Number.isInteger(y[0]) || y[0] < 0 || !isBytes(y[1], 32)) return null;
      keys.push({ e: y[0], key: y[1], tag: tagOf(y[1]) });
    }
    keys.sort((a, b) => a.e - b.e);
    let sp = this.spaces.get(id);
    if (sp) {
      if (sp.kind !== o.k) return null;
      // Keys for a space I already hold are only taken from my own devices, or when
      // I had left and am invited back. A contact cannot swap the key under me.
      if (fromSelf || sp.left) {
        for (const k of keys) if (!sp.keys.some((x) => x.e === k.e)) sp.keys.push(k);
        sp.keys.sort((a, b) => a.e - b.e);
        if (o.k === 'chan' && isBytes(o.s, UID) && eq(edPublic(o.s), sp.chan.pub)) sp.chan.seed = o.s;
        if (sp.left && !fromSelf && o.k === 'group') sp.roster = readRoster(o.r) || sp.roster;
        sp.left = false;
        this.indexSpace(sp);
        this.dirty.add(id);
        this.emit('spaces');
        this.kick();
      }
      return sp;
    }
    sp = this.blankSpace(id, o.k, name80(o.n) || (o.k === 'chan' ? 'Channel' : 'Group'), keys);
    if (o.k === 'group') {
      sp.roster = readRoster(o.r);
      if (!sp.roster) return null;
      sp.open = !!o.o;
    } else {
      if (!isBytes(o.p, UID) || id !== hex(channelId(o.p))) return null;
      sp.chan = { pub: o.p, public: !!o.u, seed: isBytes(o.s, UID) && eq(edPublic(o.s), o.p) ? o.s : null };
      if (sp.chan.public && !eq(keys[0].key, channelPublicKey(o.p))) return null;
    }
    this.spaces.set(id, sp);
    this.indexSpace(sp);
    this.dirty.add(id);
    if (!fromSelf) await this.post(this.selfSpace, 's.space', { r: this.exportSpace(sp, true) });
    if (!fromSelf) await this.shareProfile(sp);
    if (invited) sp.lastTs = this.now();
    this.emit('spaces');
    this.kick();
    this.broadcastChs();
    // Devices already connected may share the new space.
    for (const r of this.routes.values()) {
      if (!r.peer || r.closed) continue;
      const uid = r.peer.uidHex;
      if (uid === this.uidHex || (sp.kind === 'group' && sp.roster.members[uid])) {
        r.sessions.add(id);
        this.sendVec(r, sp);
      }
    }
    return sp;
  },

  createGroup(name, uids = [], { open = false } = {}) {
    return this.enqueue(async () => {
      const key = rand(32);
      const o = { i: rand(16), k: 'group', n: name80(name) || 'Group', y: [[0, key]], o: open, r: { o: this.id.uid, a: [], m: [[this.card.c, this.card.s]], b: [] } };
      const sp = await this.importSpace(o, { fromSelf: true });
      await this.post(sp, 'g.meta', { n: sp.name });
      await this.post(sp, 'g.add', { c: this.card.c, s: this.card.s }); // lets later members learn the owner's card
      await this.shareProfile(sp);
      for (const uid of uids) await this.groupAddInner(sp, uid);
      await this.post(this.selfSpace, 's.space', { r: this.exportSpace(sp, true) });
      return sp.id;
    });
  },

  async groupAddInner(sp, uidHex) {
    const c = this.contacts.get(uidHex);
    if (!c || c.pending) throw new Error('Only contacts can be added');
    if (sp.roster.members[uidHex]) return;
    sp.roster.banned = sp.roster.banned.filter((x) => x !== uidHex);
    await this.post(sp, 'g.add', { c: c.card.c, s: c.card.s });
    await this.post(this.spaces.get(c.dm), 'd.ginv', { g: this.exportSpace(sp) });
  },

  groupAdd(spId, uidHex) {
    return this.enqueue(() => this.groupAddInner(this.spaces.get(spId), uidHex));
  },

  // Removes a member and, for private groups, gives everyone else a fresh key.
  groupRemove(spId, uidHex) {
    return this.enqueue(async () => {
      const sp = this.spaces.get(spId);
      if (!this.isAdmin(sp, this.uidHex)) throw new Error('Only admins can remove members');
      await this.post(sp, 'g.rm', { u: unhex(uidHex) });
      if (!sp.open) await this.rekey(sp);
    });
  },

  async rekey(sp) {
    const e = this.curKey(sp).e + 1;
    const key = rand(32);
    const aad = epochAad(sp, e);
    const uids = Object.keys(sp.roster.members).filter((u) => u !== this.uidHex);
    uids.push(this.uidHex); // my own entry goes last: I switch keys only after everyone was served
    for (let i = 0; i < uids.length; i += 300) {
      const k = [];
      for (const uid of uids.slice(i, i + 300)) {
        const info = uid === this.uidHex ? { dh: this.id.dhPub } : readCard(sp.roster.members[uid]);
        if (!info) continue;
        try {
          const { enc, ct } = hpkeSeal(info.dh, GKEY_INFO, aad, key);
          k.push([unhex(uid), enc, ct]);
        } catch { /* one unusable card must not keep everyone else on the old key */ }
      }
      await this.post(sp, 'g.key', { e, k });
    }
    await this.post(this.selfSpace, 's.space', { r: this.exportSpace(sp, true) });
  },

  groupSetAdmin(spId, uidHex, on) {
    return this.enqueue(() => this.post(this.spaces.get(spId), 'g.adm', { u: unhex(uidHex), on: !!on }));
  },

  renameSpace(spId, name) {
    return this.enqueue(() => {
      const sp = this.spaces.get(spId);
      return this.post(sp, sp.kind === 'chan' ? 'c.meta' : 'g.meta', { n: name80(name) });
    });
  },

  leaveSpace(spId) {
    return this.enqueue(async () => {
      const sp = this.spaces.get(spId);
      if (!sp || sp.kind === 'dm' || sp.kind === 'self') return;
      if (sp.kind === 'group' && !sp.left) await this.post(sp, 'g.leave', {});
      this.leaveLocally(sp);
      await this.post(this.selfSpace, 's.gone', { i: unhex(sp.id) });
    });
  },

  members(spId) {
    const sp = this.spaces.get(spId);
    if (!sp || sp.kind !== 'group') return [];
    return Object.keys(sp.roster.members).map((uid) => ({ uid, name: this.nameOf(uid), me: uid === this.uidHex, owner: uid === sp.roster.owner, admin: this.isAdmin(sp, uid), contact: this.contacts.has(uid), card: makeLink('u', sp.roster.members[uid]) }));
  },

  spaceInfo(spId) {
    const sp = this.spaces.get(spId);
    if (!sp) return null;
    const info = { id: sp.id, kind: sp.kind, name: sp.name, left: sp.left, open: !!sp.open, about: sp.about || '', muted: !!sp.muted, ttl: sp.ttl || 0 };
    if (sp.kind === 'group') Object.assign(info, { admin: this.isAdmin(sp, this.uidHex), owner: sp.roster.owner === this.uidHex, link: sp.open ? this.spaceLink(spId) : null });
    if (sp.kind === 'chan') Object.assign(info, { owner: !!sp.chan.seed, public: sp.chan.public, link: this.spaceLink(spId) });
    const c = sp.kind === 'dm' ? this.contacts.get(sp.peer) : null;
    if (c) Object.assign(info, { peer: sp.peer, name: c.alias || c.name, given: c.name, alias: c.alias || '', about: this.bioOf(sp.peer), safety: this.safety(sp.peer), link: makeLink('u', c.card), reach: this.reach(sp.peer), relayOnly: !!c.relayOnly, blocked: !!c.blocked, seen: c.seen || 0 });
    return info;
  },

  // ---- channels -----------------------------------------------------------------
  // A channel is a feed signed by its own key. Public channels use a read key that
  // anyone can derive from the channel id; private ones carry it in the invite link.

  createChannel(name, { isPublic = true } = {}) {
    return this.enqueue(async () => {
      const seed = rand(UID); // the channel's signing secret
      const pub = edPublic(seed);
      const key = isPublic ? channelPublicKey(pub) : rand(32);
      const sp = await this.importSpace({ i: channelId(pub), k: 'chan', n: name80(name) || 'Channel', y: [[0, key]], p: pub, u: isPublic, s: seed });
      await this.post(sp, 'c.meta', { n: sp.name });
      return sp.id;
    });
  },

  spaceLink(spId) {
    const sp = this.spaces.get(spId);
    if (!sp) return '';
    const cur = this.curKey(sp);
    if (sp.kind === 'chan') return makeLink('c', { p: sp.chan.pub, n: sp.name, k: sp.chan.public ? undefined : cur.key });
    if (sp.kind === 'group' && sp.open) return makeLink('g', { i: unhex(sp.id), n: sp.name, y: [cur.e, cur.key], o: unhex(sp.roster.owner), a: sp.roster.admins.map(unhex) });
    return '';
  },

  // Opens any void: link: a contact card, a channel or an open group.
  openLink(link) {
    const d = readLink(link);
    if (!d) return Promise.reject(new Error('Not a Void link'));
    if (d.kind === 'u') return this.requestContact(link).then((c) => ({ kind: 'contact', id: c.dm }));
    return this.enqueue(async () => {
      const x = d.data;
      if (d.kind === 'c') {
        if (!isBytes(x.p, UID)) throw new Error('Bad channel link');
        const isPublic = !isBytes(x.k, 32);
        const sp = await this.importSpace({ i: channelId(x.p), k: 'chan', n: x.n, y: [[0, isPublic ? channelPublicKey(x.p) : x.k]], p: x.p, u: isPublic });
        if (!sp) throw new Error('Bad channel link');
        return { kind: 'chan', id: sp.id };
      }
      if (d.kind === 'g') {
        if (!Array.isArray(x.y) || !isBytes(x.o, UID)) throw new Error('Bad group link');
        const sp = await this.importSpace({ i: x.i, k: 'group', n: x.n, y: [x.y], o: true, r: { o: x.o, a: Array.isArray(x.a) ? x.a : [], m: [], b: [] } });
        if (!sp) throw new Error('Bad group link');
        if (!sp.roster.members[this.uidHex]) await this.post(sp, 'g.join', { c: this.card.c, s: this.card.s });
        return { kind: 'group', id: sp.id };
      }
      throw new Error('Unsupported link');
    });
  },

  // ---- backup and second devices --------------------------------------------------
  // The backup holds the identity seed, contacts, groups and channels, encrypted
  // with a passphrase. Restoring it on another device makes that device a second
  // device of the same user; the two then sync through the network.

  exportBackup(passphrase) {
    const o = {
      v: 1, seed: this.id.seed, n: this.id.name, ts: this.id.ts,
      c: [...this.contacts.values()].filter((c) => !c.pending && !c.blocked).map((c) => [c.card.c, c.card.s]),
      s: [...this.spaces.values()].filter((sp) => !sp.left && (sp.kind === 'group' || sp.kind === 'chan')).map((sp) => this.exportSpace(sp, true)),
    };
    return concat(BACKUP_MAGIC, passSeal(passphrase, cbor.encode(o)));
  },

  async restoreBackup(bytes, passphrase) {
    if (this.id) throw new Error('This device already has an identity');
    const magic = isBytes(bytes) ? text(bytes.subarray(0, BACKUP_MAGIC.length)) : '';
    if (magic === 'VOIDBK1\n' || magic === 'VOIDBK2\n') throw oldKeys('backup');
    if (magic !== 'VOIDBK3\n') throw new Error('Not a Void backup');
    let o;
    try {
      o = cbor.decode(passOpen(passphrase, bytes.subarray(BACKUP_MAGIC.length)));
    } catch {
      throw new Error('Wrong passphrase or damaged backup');
    }
    if (!o || o.v !== 1 || !isBytes(o.seed, 32)) throw new Error('Unsupported backup');
    await this.create(o.n, o.seed);
    await this.enqueue(async () => {
      for (const c of o.c || []) {
        const info = Array.isArray(c) ? readCard({ c: c[0], s: c[1] }) : null;
        if (info) await this.addContact(info, { fromSelf: true });
      }
      for (const s of o.s || []) await this.importSpace(s, { fromSelf: true });
    });
  },
};

function mineDevice(node, ev) {
  return eq(ev.d, node.id.dev);
}

function readRoster(r) {
  if (!r || !isBytes(r.o, UID) || !Array.isArray(r.a) || !Array.isArray(r.m)) return null;
  const members = {};
  for (const m of r.m) {
    const info = Array.isArray(m) ? readCard({ c: m[0], s: m[1] }) : null;
    if (info) members[hex(info.uid)] = info.card;
  }
  return {
    owner: hex(r.o),
    admins: r.a.filter((x) => isBytes(x, UID)).map(hex),
    members,
    banned: Array.isArray(r.b) ? r.b.filter((x) => isBytes(x, UID)).map(hex) : [],
  };
}
