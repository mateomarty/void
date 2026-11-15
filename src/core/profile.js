// SPDX-License-Identifier: AGPL-3.0-or-later
// Profiles and conversation conveniences: photos and bios, local names, mute,
// block, last seen, scheduled messages, self-deleting messages, shared media and
// export. None of this adds a new kind of trust: photos and bios are ordinary
// signed events in the conversations a user takes part in.

import { hex, unhex, rand, isBytes } from './bytes.js';
import { mailboxTag, inboxTag } from './keys.js';
import { UID } from './crypto.js';
import * as cbor from './cbor.js';

const MAX_PHOTO = 20000; // bytes of a profile, group or channel photo (a small JPEG)
const PURGED = new Set(['msg', 'edit', 'del', 'call']); // what auto-delete removes; membership and keys stay
const URL_RE = /https?:\/\/[^\s<>"']+/g;
const bio300 = (v) => (typeof v === 'string' ? v.trim().slice(0, 300) : '');
const photo = (v) => (isBytes(v) && v.length > 0 && v.length <= MAX_PHOTO ? v : null);

export const profileMethods = {
  async loadProfiles() {
    this.profile = (await this.store.get('kv', 'me')) || { av: null, bio: '', ts: 0 };
    this.profiles = new Map(); // uid hex -> { uid, av, bio, ts } as last announced by that user
    for (const { value } of await this.store.range('kv', 'profile|')) if (value && value.uid) this.profiles.set(value.uid, value);
    this.scheduled = (await this.store.get('kv', 'scheduled')) || [];
    this.invites = (await this.store.get('kv', 'invites')) || []; // invite links I made that nobody used yet
  },

  // ---- photos and bios ----------------------------------------------------------

  // Sets my photo and bio and tells every contact and every group I am in.
  setProfile({ av, bio } = {}) {
    return this.enqueue(async () => {
      this.profile = { av: av === undefined ? this.profile.av : photo(av), bio: bio === undefined ? this.profile.bio : bio300(bio), ts: this.now() };
      await this.store.put('kv', 'me', this.profile);
      for (const sp of [...this.spaces.values()]) await this.shareProfile(sp);
      this.emit('contacts');
    });
  },

  // Posts my profile into one conversation, if I have one and belong there as myself.
  async shareProfile(sp) {
    if (!sp || sp.left || !this.profile || !this.profile.ts) return;
    if (sp.kind === 'dm') {
      const c = this.contacts.get(sp.peer);
      if (!c || c.pending || c.blocked) return;
    } else if (sp.kind !== 'group' || !sp.roster.members[this.uidHex]) {
      return;
    }
    await this.post(sp, 'p.set', { av: this.profile.av, bio: this.profile.bio, ts: this.profile.ts });
  },

  async onProfile(ev, author) {
    const b = ev.b;
    if (!Number.isSafeInteger(b.ts) || (b.av !== null && b.av !== undefined && !photo(b.av))) return;
    const rec = { uid: author, av: photo(b.av), bio: bio300(b.bio), ts: b.ts };
    if (author === this.uidHex) {
      // Announced by another of my devices.
      if (rec.ts <= this.profile.ts) return;
      this.profile = { av: rec.av, bio: rec.bio, ts: rec.ts };
      await this.store.put('kv', 'me', this.profile);
    } else {
      const cur = this.profiles.get(author);
      if (cur && cur.ts >= rec.ts) return;
      this.profiles.set(author, rec);
      await this.store.put('kv', 'profile|' + author, rec);
    }
    this.emit('contacts');
  },

  // Photo of a user (by uid) or of a conversation (by space id), or null.
  avatarOf(id) {
    if (id === this.uidHex) return this.profile.av;
    const p = this.profiles.get(id);
    if (p) return p.av;
    const sp = this.spaces.get(id);
    if (!sp) return null;
    if (sp.kind === 'dm') return (this.profiles.get(sp.peer) || {}).av || null;
    return sp.av || null;
  },

  bioOf(uidHex) {
    return uidHex === this.uidHex ? this.profile.bio : (this.profiles.get(uidHex) || {}).bio || '';
  },

  // Name, description or photo of a group (admins) or a channel (owner).
  setSpaceMeta(spId, { name, about, av } = {}) {
    return this.enqueue(async () => {
      const sp = this.spaces.get(spId);
      const kind = sp.kind === 'chan' ? 'c.meta' : 'g.meta';
      if (name !== undefined && name.trim() && name.trim() !== sp.name) await this.post(sp, kind, { n: name.trim().slice(0, 80), w: 'name' });
      if (about !== undefined && about.trim().slice(0, 500) !== (sp.about || '')) await this.post(sp, kind, { about: about.trim().slice(0, 500), w: 'about' });
      if (av !== undefined) await this.post(sp, kind, { av: photo(av) || new Uint8Array(0), w: 'photo' });
    });
  },

  // ---- per-contact and per-conversation choices that stay on this device ----------

  setAlias(uidHex, alias) {
    return this.enqueue(async () => {
      const c = this.contacts.get(uidHex);
      if (!c) return;
      c.alias = String(alias || '').trim().slice(0, 64);
      await this.store.put('contacts', uidHex, c);
      this.emit('contacts');
      this.emit('spaces');
    });
  },

  // A blocked contact cannot link to this device, reach it through others, or call.
  setBlocked(uidHex, on) {
    return this.enqueue(async () => {
      const c = this.contacts.get(uidHex);
      if (!c) return;
      c.blocked = !!on;
      await this.store.put('contacts', uidHex, c);
      if (on) {
        for (const L of [...this.links.values()]) if (L.uidHex === uidHex) this.closeLink(L, 'blocked');
        for (const r of [...this.tunnels.values()]) if (r.peer && r.peer.uidHex === uidHex) this.closeRoute(r);
      }
      this.rdvRefresh();
      this.kick();
      this.emit('contacts');
      this.emit('spaces');
    });
  },

  setMuted(spId, on) {
    return this.enqueue(() => {
      const sp = this.spaces.get(spId);
      if (!sp) return;
      sp.muted = !!on;
      this.dirty.add(spId);
      this.emit('spaces');
    });
  },

  commonGroups(uidHex) {
    return [...this.spaces.values()].filter((sp) => sp.kind === 'group' && !sp.left && sp.roster.members[uidHex]).map((sp) => ({ id: sp.id, name: sp.name }));
  },

  // ---- scheduled messages -----------------------------------------------------------
  // Kept on this device and posted when their time comes, if the application is
  // open then; otherwise the next time it opens. There is no server to do it.

  scheduleMessage(spId, text, at) {
    return this.enqueue(async () => {
      const body = String(text || '').trim().slice(0, 20000);
      if (!this.spaces.has(spId) || !body) throw new Error('Nothing to schedule');
      if (!Number.isSafeInteger(at) || at <= this.now()) throw new Error('Choose a time in the future');
      const item = { id: hex(rand(8)), sp: spId, text: body, at };
      this.scheduled.push(item);
      await this.store.put('kv', 'scheduled', this.scheduled);
      this.emit('message', spId);
      return item.id;
    });
  },

  cancelScheduled(id) {
    return this.enqueue(async () => {
      const item = this.scheduled.find((x) => x.id === id);
      this.scheduled = this.scheduled.filter((x) => x.id !== id);
      await this.store.put('kv', 'scheduled', this.scheduled);
      if (item) this.emit('message', item.sp);
    });
  },

  scheduledFor(spId) {
    return this.scheduled.filter((x) => x.sp === spId).sort((a, b) => a.at - b.at);
  },

  async sendDue() {
    const now = this.now();
    const due = this.scheduled.filter((x) => x.at <= now);
    if (!due.length) return;
    this.scheduled = this.scheduled.filter((x) => x.at > now);
    await this.store.put('kv', 'scheduled', this.scheduled);
    for (const item of due.sort((a, b) => a.at - b.at)) {
      const sp = this.spaces.get(item.sp);
      try {
        if (sp && !sp.left) await this.post(sp, 'msg', { x: item.text });
      } catch { /* the conversation no longer accepts it */ }
      this.emit('message', item.sp);
    }
  },

  // ---- messages that delete themselves ---------------------------------------------
  // A conversation can carry a timer. Every device that honours it removes messages
  // older than the timer from its own storage, attachments included. It is an
  // agreement between devices, not something one side can force on the other.

  setAutoDelete(spId, seconds) {
    return this.enqueue(() => this.post(this.spaces.get(spId), 'ttl', { s: seconds > 0 ? Math.max(60, Math.floor(seconds)) : 0 }));
  },

  async purgeExpired() {
    for (const sp of [...this.spaces.values()]) {
      if (!(sp.ttl > 0)) continue;
      const cutoff = this.now() - sp.ttl * 1000;
      let removed = 0;
      for (const { value } of await this.store.range('events', sp.id + '|')) {
        if (value.ts >= cutoff || !PURGED.has(value.k)) continue;
        if (value.k === 'msg') {
          try {
            for (const a of cbor.decode(value.raw).b.a || []) {
              if (!a || !isBytes(a.i, 32)) continue;
              await this.store.delRange('blobs', `c|${hex(a.i)}|`);
              await this.store.del('blobs', `m|${hex(a.i)}`);
            }
          } catch { /* unreadable record: remove it anyway */ }
        }
        await this.store.del('events', `${sp.id}|${value.feed}|${String(value.q).padStart(10, '0')}`);
        removed++;
      }
      if (!removed) continue;
      this.views.delete(sp.id);
      if (sp.lastTs < cutoff) sp.lastText = '';
      this.dirty.add(sp.id);
      this.emit('message', sp.id);
      this.emit('spaces');
    }
  },

  // ---- transparency -------------------------------------------------------------------
  // Everything this device knows about a conversation and the devices behind it:
  // identifiers, public keys, routing tags, network paths and addresses. These are
  // the things that cannot be hidden from this device because it needs them to
  // deliver messages. Secret keys and message contents are not listed.
  async details(spId) {
    const sp = this.spaces.get(spId);
    if (!sp) return [];
    const cur = this.curKey(sp);
    const when = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'never');
    const out = [];
    const kind = { dm: 'one-to-one conversation', self: 'own devices', group: sp.open ? 'open group' : 'private group', chan: sp.chan && sp.chan.public ? 'public channel' : 'private channel' }[sp.kind];
    out.push(['Conversation', [
      ['Kind', kind],
      ['Conversation id', sp.id],
      ['Routing tag (what relays see in a route request)', hex(cur.tag)],
      ['Key generation', String(cur.e)],
      ['Feeds (devices that have written here)', String(Object.keys(sp.vec).length)],
      ['Events received', String(Object.values(sp.vec).reduce((n, st) => n + st.max, 0))],
      ['Auto-delete', sp.ttl ? `after ${sp.ttl} seconds` : 'off'],
      ['First seen on this device', when(sp.created)],
    ]]);
    const c = sp.kind === 'dm' ? this.contacts.get(sp.peer) : null;
    if (c) {
      const p = this.profiles.get(c.uid);
      const topic = [...(this.rdvTopics || [])].find(([, t]) => t.uid === c.uid && t.today);
      out.push(['Identity', [
        ['User id (signing public key, Ed448)', c.uid],
        ['Key agreement public key (X448)', hex(c.dh)],
        ['Name on their card', c.name],
        ['Name you gave them', c.alias || 'none'],
        ['Card issued', when(c.ts)],
        ['Contact since', when(c.added)],
        ['Safety number', this.safety(c.uid)],
        ['Photo and bio last changed', p ? when(p.ts) : 'never announced'],
        ['Last connected to this device', this.uidOnline(c.uid) ? 'connected now' : when(c.seen)],
        ['Settings on this device', [c.blocked && 'blocked', c.relayOnly && 'never connect directly', c.pending && `request ${c.pending === 'out' ? 'sent' : 'received'}`].filter(Boolean).join(', ') || 'none'],
      ]]);
      out.push(['How you find each other', [
        ['Their public inbox tag (contact requests)', hex(inboxTag(unhex(c.uid)))],
        ['Mailbox tag for your messages to them', hex(mailboxTag(cur.key, unhex(c.uid)))],
        ['Mailbox tag for their messages to you', hex(mailboxTag(cur.key, this.id.uid))],
        ['Rendezvous topic today (what the public relays see)', topic ? topic[0] : 'rendezvous is off for this contact'],
      ]]);
      const mine = sp.vec[this.myFeed];
      out.push(['Delivery', [
        ['Your messages from this device', String(mine ? mine.max : 0)],
        ['Confirmed received by them', String(sp.peerHas[this.myFeed] || 0)],
        ['Handed to contacts for safekeeping, up to', String(sp.cour || 0)],
      ]]);
    }
    if (sp.kind === 'group') {
      out.push(['Membership', [
        ['Owner', `${this.nameOf(sp.roster.owner)} · ${sp.roster.owner}`],
        ['Admins', sp.roster.admins.map((u) => this.nameOf(u)).join(', ') || 'none'],
        ['Members', String(Object.keys(sp.roster.members).length)],
        ['Banned', String(sp.roster.banned.length)],
      ]]);
    }
    if (sp.kind === 'chan') out.push(['Channel', [['Channel key (verifies every post)', hex(sp.chan.pub)], ['You can post', sp.chan.seed ? 'yes, this device holds the channel key' : 'no']]]);

    // One section per connected device that shares this conversation.
    for (const r of this.routes.values()) {
      if (!r.peer || r.closed || !(c ? r.peer.uidHex === c.uid : r.sessions.has(sp.id))) continue;
      const rows = [['User', `${this.nameOf(r.peer.uidHex)} · ${r.peer.uidHex}`], ['Device id', r.peer.devHex.slice(UID * 2)]];
      if (r.kind === 'link') {
        const L = r.link;
        const st = L.raw.stats ? await L.raw.stats() : null;
        rows.push(['Path', 'direct connection, device to device'], ['Connected since', when(L.authedAt)]);
        if (st) {
          const addr = (x) => (x ? `${x.address || 'hidden by the browser'}${x.port ? ':' + x.port : ''} (${x.type || '?'}, ${x.protocol || 'udp'})` : 'unknown');
          rows.push(['Their network address', addr(st.remote)], ['Your address on this connection', addr(st.local)]);
          if (st.rtt !== undefined) rows.push(['Round trip', `${Math.round(st.rtt * 1000)} ms`]);
          if (st.sent !== undefined) rows.push(['Traffic', `${st.sent} bytes sent, ${st.received} received`]);
          rows.push(['Transport encryption', st.cipher || 'DTLS']);
        }
        rows.push(['Link encryption (under the transport\'s)', `keys from X448 and ML-KEM-1024 together, ChaCha20-Poly1305 with 256-bit one-time keys; ${L.tx.n} messages sent, ${L.rx.n} received`]);
        rows.push(['Their connection fingerprint', hex(L.raw.fpRemote)], ['Your connection fingerprint', hex(L.raw.fpLocal)]);
      } else {
        rows.push(
          ['Path', `relayed through ${Math.max(1, r.hops - 1)} device${r.hops > 2 ? 's' : ''}`],
          ['First relay on the way', this.nameOf(r.link.uidHex)],
          ['Tunnel id', r.tidHex],
          ['Session', r.tx ? `keys from X448 and ML-KEM-1024 together, ChaCha20-Poly1305 with 256-bit one-time keys; ${r.tx.n} frames sent, ${r.rx.n} received` : 'being set up'],
          ['Their network address', 'not known to this device: only the relays next to them see it'],
        );
      }
      out.push([`Connected device ${r.peer.devHex.slice(UID * 2, UID * 2 + 8)}`, rows]);
    }
    return out;
  },

  // ---- shared media and export --------------------------------------------------------

  async media(spId) {
    const out = { photos: [], videos: [], files: [], voice: [], links: [] };
    for (const m of await this.messages(spId)) {
      if (m.kind !== 'msg' || m.deleted) continue;
      for (const a of m.att || []) {
        const key = { image: 'photos', video: 'videos', voice: 'voice' }[a.kind] || 'files';
        out[key].push({ att: a, id: m.id, ts: m.ts, author: m.author });
      }
      for (const u of (m.text || '').match(URL_RE) || []) out.links.push({ url: u, id: m.id, ts: m.ts, author: m.author });
    }
    return out;
  },

  // The conversation as plain text, oldest first.
  async exportChat(spId) {
    const sp = this.spaces.get(spId);
    const title = sp.kind === 'dm' ? this.nameOf(sp.peer) : sp.name;
    const lines = [`Void conversation: ${title}`, `Exported ${new Date(this.now()).toISOString()}`, ''];
    for (const m of await this.messages(spId)) {
      const when = new Date(m.ts).toISOString().replace('T', ' ').slice(0, 16);
      if (m.kind === 'sys') {
        lines.push(`[${when}] * ${m.text}`);
        continue;
      }
      const who = sp.kind === 'chan' ? sp.name : m.author === this.uidHex ? this.id.name : this.nameOf(m.author);
      const files = (m.att || []).map((a) => `[${a.kind}: ${a.name}]`).join(' ');
      lines.push(`[${when}] ${who}: ${m.deleted ? '(deleted)' : [m.text, files].filter(Boolean).join(' ')}${m.edited ? ' (edited)' : ''}`);
    }
    return lines.join('\n') + '\n';
  },
};

