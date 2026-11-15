// SPDX-License-Identifier: AGPL-3.0-or-later
// VoidNode: one device in the network. This file holds the lifecycle and the
// overlay (authenticated links, route discovery, multi-hop tunnels, couriers).
// Spaces and events live in sync.js, contacts/groups/channels in social.js,
// attachments in blobs.js. Nothing here touches the DOM or WebRTC directly: the
// transport is injected (`rtc`), so the same engine runs in tests on a fake network.

import { T, DEFAULTS, SETTINGS, PROTOCOL, KEYGEN, oldKeys } from './proto.js';
import { hex, unhex, eq, rand, concat, isBytes } from './bytes.js';
import * as cbor from './cbor.js';
import { sign, verify, hash, seal, sealSeq, openSeq, derive, dh, dhPublic, kemKeys, kemSend, kemReceive, UID, DH, SIG, KEM_PUB, KEM_CT } from './crypto.js';
import { identityFromSeed, makeCard, readCard, inboxTag, mailboxTag, mailboxSigner, tagOf, spaceIdOf, feedKey } from './keys.js';
import { syncMethods, evKey } from './sync.js';
import { socialMethods } from './social.js';
import { blobMethods } from './blobs.js';
import { rdvMethods } from './rdv.js';
import { sessionMethods } from './session.js';
import { profileMethods } from './profile.js';

// Frames a tunnel carries before its two ends share a session: the handshake itself,
// mail pick-up and contact requests (both anonymous by design), and keep-alives.
const OPEN = new Set([T.HS1, T.HS2, T.HS3, T.PICKUP, T.PICKED, T.HPKE, T.KEEP]);

export class VoidNode {
  constructor({ store, rtc = null, rdv = null, cfg = {}, defaults = {}, now = Date.now, debug = null, name = '' }) {
    this.store = store;
    this.rtc = rtc;
    this.rdvNet = rdv; // rendezvous carrier, or null
    this.rdvTopics = null;
    this.rdvHi = new Map(); // uid -> time of my last hello
    this.rdvSeen = new Set();
    this.rdvAnswering = 0;
    this.clashes = new Map();
    this.cfg = { ...DEFAULTS, ...cfg };
    this.defaultSettings = { ...SETTINGS, ...defaults };
    this.settings = { ...this.defaultSettings };
    this.now = now;
    this.debug = debug;
    this.label = name;
    this.handlers = new Map();
    this.q = Promise.resolve();
    this.ready = false;
    this.stopped = false;
    this.seq = 0;
    this.id = null;

    this.contacts = new Map(); // uid hex -> contact
    this.spaces = new Map(); // space id hex -> space
    this.tags = new Map(); // tag hex -> { sp, k }
    this.mbx = new Map(); // my mailbox tag hex -> dm space

    this.halfLinks = new Set(); // links still authenticating
    this.links = new Map(); // link id -> authenticated link
    this.linkByDev = new Map(); // device hex -> link
    this.routes = new Map(); // route id -> route (a link or a tunnel end)
    this.routesByDev = new Map(); // device hex -> Set(route)
    this.tunnels = new Map(); // tunnel id hex -> route (we are an end)
    this.relays = new Map(); // tunnel id hex -> { x, a, b } (we forward)
    this.seenReq = new Map(); // request id hex -> { from, ts }
    this.pendingReq = new Map(); // my request id hex -> { tags, got, contact }
    this.disc = new Map(); // discovery backoff per target
    this.upgrades = new Map(); // direct-connection attempts per device
    this.pendingSig = new Map();

    this.courierTags = new Map(); // tag hex -> number of frames held for others
    this.courierBytes = 0;
    this.courierBy = new Map(); // uid hex -> bytes held on their behalf
    this.picked = new Map(); // mailbox tag hex -> Set(frame id) already received
    this.couriered = new Map(); // space id + uid -> highest seq handed to that contact

    this.views = new Map(); // space id -> message list
    this.dirty = new Set(); // spaces to persist after the current task
    this.dirtyContacts = new Set();
    this.profile = { av: null, bio: '', ts: 0 };
    this.profiles = new Map();
    this.scheduled = [];
    this.invites = [];
    this.downloads = new Map();
    this.activeSpace = null;
    this.timers = [];
  }

  // ---- events for the UI ----------------------------------------------------

  on(evt, fn) {
    let set = this.handlers.get(evt);
    if (!set) this.handlers.set(evt, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  emit(evt, ...args) {
    const set = this.handlers.get(evt);
    if (set) for (const fn of set) try { fn(...args); } catch (e) { console.error(e); }
  }

  log(...args) {
    if (this.debug) this.debug(this.label, ...args);
  }

  // Every state change runs through this queue, one task at a time. The caller
  // gets the result or the error.
  enqueue(fn) {
    const task = async () => {
      if (this.stopped) return undefined;
      try {
        return await fn();
      } finally {
        await this.flush();
      }
    };
    const p = this.q.then(task);
    this.q = p.catch(() => {});
    return p;
  }

  // Same queue, for work nobody waits on (timers, network input): errors are logged.
  run(fn) {
    this.enqueue(fn).catch((e) => {
      this.log('error', e);
      if (!this.debug && typeof console !== 'undefined') console.error(e);
    });
  }

  async flush() {
    if (this.dirtyContacts.size) {
      const uids = [...this.dirtyContacts];
      this.dirtyContacts.clear();
      for (const uid of uids) if (this.contacts.has(uid)) await this.store.put('contacts', uid, this.contacts.get(uid));
    }
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const sp = this.spaces.get(id);
      if (sp) await this.store.put('spaces', id, sp);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async load() {
    const rec = await this.store.get('kv', 'id');
    if (!rec) return false;
    if (rec.k !== KEYGEN) throw oldKeys('profile');
    await this.boot(rec);
    return true;
  }

  async create(name, seed = rand(32)) {
    const rec = { seed, dev: rand(8), name: String(name || 'Anonymous').slice(0, 64), ts: this.now(), k: KEYGEN };
    await this.store.put('kv', 'id', rec);
    await this.boot(rec);
  }

  async boot(rec) {
    this.id = { ...identityFromSeed(rec.seed), dev: rec.dev, name: rec.name, ts: rec.ts };
    this.uidHex = hex(this.id.uid);
    this.devHex = hex(this.id.dev);
    this.devKey = this.uidHex + this.devHex; // devices are always named by user and device together
    this.myFeed = feedKey(this.id.uid, this.id.dev);
    this.card = makeCard(this.id, rec.name, rec.ts);
    this.myInboxHex = hex(inboxTag(this.id.uid));
    this.settings = { ...this.defaultSettings, ...((await this.store.get('kv', 'settings')) || {}) };
    for (const { value } of await this.store.range('contacts')) this.contacts.set(value.uid, value);
    for (const { value } of await this.store.range('spaces')) {
      this.spaces.set(value.id, value);
      this.indexSpace(value);
    }
    const selfId = hex(spaceIdOf(this.id.selfKey));
    if (!this.spaces.has(selfId)) {
      const sp = this.blankSpace(selfId, 'self', 'Saved', [{ e: 0, key: this.id.selfKey, tag: tagOf(this.id.selfKey) }]);
      this.spaces.set(selfId, sp);
      this.indexSpace(sp);
      this.dirty.add(selfId);
    }
    this.selfSpace = this.spaces.get(selfId);
    for (const c of this.contacts.values()) if (c.pending !== 'in' && !this.spaces.has(c.dm)) this.ensureDm(c);
    await this.loadProfiles();
    await this.loadCourier();
    await this.flush();
    const every = (ms, fn) => this.timers.push(setInterval(() => this.run(fn), ms));
    every(this.cfg.keepalive, () => this.keepalive());
    every(this.cfg.rreqTick, () => this.discover());
    every(this.cfg.antiEntropy, () => this.antiEntropy());
    every(this.cfg.gcEvery, () => this.gc());
    every(this.cfg.rdvTick, () => this.rdvTick());
    every(this.cfg.schedTick, () => this.sendDue());
    every(this.cfg.ttlTick, () => this.purgeExpired());
    this.ready = true;
    this.rdvStart();
    this.emit('ready');
  }

  async saveSettings(patch) {
    Object.assign(this.settings, patch);
    await this.store.put('kv', 'settings', this.settings);
    if ('rdv' in patch || 'rdvRelays' in patch || 'requests' in patch) this.rdvApply();
    this.emit('settings');
  }

  stop() {
    this.stopped = true;
    if (this.rdvNet) this.rdvNet.configure([]);
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.kickTimer);
    for (const L of [...this.links.values(), ...this.halfLinks]) {
      clearTimeout(L.timer);
      clearTimeout(L.probe);
      L.closed = true;
      try { L.raw.close(); } catch { /* already closed */ }
    }
    for (const r of this.routes.values()) for (const t of r.vecTimers.values()) clearTimeout(t);
    for (const d of this.downloads.values()) clearTimeout(d.timer);
  }

  // ---- links: one authenticated connection to a contact's device --------------

  // `raw` is { send(bytes), close(), onmessage, onclose, fpLocal, fpRemote }.
  // `pairing` is true when the user exchanged invite codes by hand: that exchange
  // is the consent to become contacts. Every other link must come from a contact.
  //
  // Both ends speak at once:
  //   AUTH1  card, device id, nonce, one-use X448 key, one-use ML-KEM-1024 key
  //   AUTH2  ML-KEM ciphertext for the other side's key, signature over everything
  // After that each message on the link is sealed with keys that come from the X448
  // exchange and both ML-KEM exchanges together. The transport (DTLS) encrypts the
  // link as well; this layer is there so that a recording of the connection stays
  // unreadable even if the transport's own key exchange is broken one day.
  attachLink(raw, { pairing = false } = {}) {
    const L = { id: ++this.seq, raw, pairing, nonce: rand(32), peerNonce: null, info: null, dev: null, authed: false, authedAt: 0, closed: false, last: this.now(), rq: { t: 0, n: 0 }, uidHex: null, devHex: null, route: null, lid: '', probe: null, eph: null, tx: null, rx: null, bind: null };
    this.halfLinks.add(L);
    raw.onclose = () => this.run(() => this.linkClosed(L, 'transport closed'));
    raw.onmessage = (bytes) => this.run(() => this.linkBytes(L, bytes));
    L.timer = setTimeout(() => this.run(() => { if (!L.authed) this.closeLink(L, 'auth timeout'); }), this.cfg.authTimeout);
    const secret = rand(DH);
    const kem = kemKeys();
    L.eph = { secret, e: dhPublic(secret), kem, k: hash(kem.publicKey), shared: null, mine: null, q: null, peerE: null, peerK: null };
    this.sendLink(L, { t: T.AUTH1, v: PROTOCOL, c: this.card.c, s: this.card.s, d: this.id.dev, n: L.nonce, e: L.eph.e, k: kem.publicKey });
    return L;
  }

  // The other device runs a build this one cannot talk to. Said once a minute at most.
  versionClash(uidHex, name, theirs) {
    const now = this.now();
    if (now - (this.clashes.get(uidHex) || 0) < 60000) return;
    this.clashes.set(uidHex, now);
    this.emit('version', name, Number.isInteger(theirs) ? theirs : 1, PROTOCOL);
  }

  sendLink(L, obj) {
    if (L.closed) return false;
    try {
      // A neighbour that makes us queue without bound is cut off, not served.
      if (L.raw.backlog && L.raw.backlog() > this.cfg.maxBacklog) throw new Error('backlog');
      const bytes = cbor.encode(obj);
      L.raw.send(L.tx ? sealSeq(L.tx.key, L.tx.n++, bytes, L.bind) : bytes);
      return true;
    } catch {
      this.closeLink(L, 'send failed');
      return false;
    }
  }

  closeLink(L, why) {
    if (L.closed) return;
    try { L.raw.close(); } catch { /* already closed */ }
    this.linkClosed(L, why);
  }

  linkClosed(L, why) {
    if (L.closed) return;
    L.closed = true;
    clearTimeout(L.timer);
    clearTimeout(L.probe);
    this.halfLinks.delete(L);
    this.log('link closed', L.devHex, why);
    if (!L.authed) return;
    this.links.delete(L.id);
    if (this.linkByDev.get(L.devHex) === L) this.linkByDev.delete(L.devHex);
    for (const r of [...this.routes.values()]) if (r.link === L) this.routeDown(r);
    for (const [tid, rt] of [...this.relays]) {
      if (rt.a !== L && rt.b !== L) continue;
      this.sendLink(rt.a === L ? rt.b : rt.a, { t: T.TCLOSE, x: rt.x });
      this.relays.delete(tid);
    }
    // If the device is still reachable through tunnels, keep the best one and try a
    // new direct link right away.
    this.pruneRoutes(L.devHex);
    this.upgrades.delete(L.devHex);
    for (const r of this.routes.values()) if (r.peer && r.peer.devHex === L.devHex) this.maybeUpgrade(r);
    // ... and say hello on the rendezvous, in case it is not reachable at all.
    this.rdvHi.delete(L.uidHex);
    this.rdvAnnounce(true);
    this.emit('net');
  }

  async linkBytes(L, bytes) {
    if (L.closed) return;
    let m;
    try {
      // The channel is ordered and reliable, so both ends count the same messages.
      if (L.rx) bytes = openSeq(L.rx.key, L.rx.n++, bytes, L.bind);
      m = cbor.decode(bytes, 1024 * 1024);
    } catch {
      return this.closeLink(L, 'malformed message');
    }
    if (!m || typeof m !== 'object') return;
    L.last = this.now();
    if (!L.authed) {
      if (m.t === T.AUTH1) return this.onAuth1(L, m);
      if (m.t === T.AUTH2) return this.onAuth2(L, m);
      return;
    }
    switch (m.t) {
      case T.FRAME: return this.onFrame(L.route, m.d);
      case T.TDATA: return this.onTunnelData(L, m);
      case T.RREQ: return this.onRreq(L, m);
      case T.RREP: return this.onRrep(L, m);
      case T.TCLOSE: return this.onTunnelClose(L, m);
      case T.STORE: return this.onStore(L, m);
      case T.PING: return void this.sendLink(L, { t: T.PONG });
      default: return;
    }
  }

  onAuth1(L, m) {
    if (L.info) return;
    if (m.v !== PROTOCOL) {
      // Another build: its card may not even be readable here. The name is only
      // used to tell the user which contact needs the same version.
      let name = 'A contact';
      try {
        const n = cbor.decode(m.c).n;
        if (typeof n === 'string' && n) name = n.slice(0, 64);
      } catch { /* keep the generic name */ }
      this.versionClash(isBytes(m.c) ? hex(hash(m.c)) : '?', name, m.v);
      return this.closeLink(L, 'other version');
    }
    const info = readCard({ c: m.c, s: m.s });
    if (!info || !isBytes(m.d, 8) || !isBytes(m.n, 32) || !isBytes(m.e, DH) || !isBytes(m.k, KEM_PUB)) return this.closeLink(L, 'bad hello');
    if (eq(info.uid, this.id.uid) && eq(m.d, this.id.dev)) return this.closeLink(L, 'connected to myself');
    const x = L.eph;
    try {
      x.shared = dh(x.secret, m.e);
      const pq = kemSend(m.k);
      x.mine = pq.secret;
      x.q = pq.ct;
    } catch {
      return this.closeLink(L, 'bad hello'); // a degenerate or malformed key
    }
    x.peerE = m.e;
    x.peerK = hash(m.k);
    L.info = info;
    L.dev = m.d;
    L.peerNonce = m.n;
    // Signing both DTLS fingerprints as each side sees them detects a relay that
    // tampered with the signalling to sit in the middle of the connection. The
    // signature also covers every key of the exchange, so nobody can swap one.
    const transcript = concat(L.raw.fpLocal, L.raw.fpRemote, L.nonce, m.n, this.id.dev, x.e, x.peerE, x.k, x.peerK, hash(x.q));
    this.sendLink(L, { t: T.AUTH2, q: x.q, s: sign(this.id.edSk, 'void/link', transcript) });
  }

  async onAuth2(L, m) {
    const x = L.eph;
    if (!L.info || L.authed || !x || !isBytes(m.s, SIG) || !isBytes(m.q, KEM_CT)) return this.closeLink(L, 'bad auth');
    const transcript = concat(L.raw.fpRemote, L.raw.fpLocal, L.peerNonce, L.nonce, L.dev, x.peerE, x.e, x.peerK, x.k, hash(m.q));
    if (!verify(L.info.uid, 'void/link', transcript, m.s)) return this.closeLink(L, 'auth failed');
    // Link keys: the side with the smaller nonce is "lo". Both sides list the same
    // values in the same order, so they derive the same keys or none that work.
    const lo = hex(L.nonce) < hex(L.peerNonce);
    let theirs;
    try {
      theirs = kemReceive(m.q, x.kem.secretKey);
    } catch {
      return this.closeLink(L, 'bad auth');
    }
    const ord = (mine, peer) => (lo ? [mine, peer] : [peer, mine]);
    const bind = hash(...ord(L.nonce, L.peerNonce), ...ord(x.e, x.peerE), ...ord(x.k, x.peerK), ...ord(hash(x.q), hash(m.q)));
    const base = derive(concat(x.shared, ...ord(x.mine, theirs)), 'void/v1/link', 32, bind);
    const [mineKey, peerKey] = ord(derive(base, 'void/v1/link/lo'), derive(base, 'void/v1/link/hi'));
    const keys = { tx: { key: mineKey, n: 0 }, rx: { key: peerKey, n: 0 }, bind };
    L.eph = null; // the one-use secrets are gone: this link cannot be decrypted later
    const uidHex = hex(L.info.uid);
    // A device id only means something together with its user: a contact cannot
    // take the place of someone else's device by announcing the same id.
    const devHex = uidHex + hex(L.dev);
    if (uidHex !== this.uidHex) {
      const c = this.contacts.get(uidHex);
      if (c && c.blocked) return this.closeLink(L, 'blocked');
      if (c && c.relayOnly && !L.pairing) return this.closeLink(L, 'relay only');
      if ((!c || c.pending === 'in') && !L.pairing) return this.closeLink(L, 'not a contact');
      await this.addContact(L.info);
    }
    clearTimeout(L.timer);
    Object.assign(L, keys); // from here on, everything on the link is sealed
    L.authed = true;
    L.authedAt = this.now();
    L.uidHex = uidHex;
    L.devHex = devHex;
    L.lid = hex(L.nonce) < hex(L.peerNonce) ? hex(hash(L.nonce, L.peerNonce)) : hex(hash(L.peerNonce, L.nonce));
    const old = this.linkByDev.get(devHex);
    if (old && !old.closed) {
      // Both sides dialled at once: keep the same link on both ends. Otherwise the
      // new link wins, because the old one is usually a leftover from a reload.
      if (this.now() - old.authedAt < this.cfg.dialRace && old.lid < L.lid) return this.closeLink(L, 'duplicate');
      this.closeLink(old, 'replaced');
    }
    this.halfLinks.delete(L);
    this.links.set(L.id, L);
    this.linkByDev.set(devHex, L);
    const route = this.newRoute({ kind: 'link', link: L, hops: 0 });
    L.route = route;
    route.peer = { uidHex, devHex };
    this.log('link up', devHex);
    this.onRoutePeer(route);
    this.disc.clear();
    this.kick();
    await this.courierCatchUp(L);
  }

  // ---- routes: how frames reach another device --------------------------------

  newRoute({ kind, link, tid = null, hops = 0 }) {
    const r = {
      id: ++this.seq, kind, link, tid, tidHex: tid ? hex(tid) : null, hops, peer: null, closed: false,
      created: this.now(), last: this.now(),
      sessions: new Set(), heard: new Set(), peerVec: new Map(), vecParts: new Map(), sent: new Map(), vecAt: new Map(), vecRev: new Map(), epoch: new Map(), vecTimers: new Map(),
      hs: null, tx: null, rx: null, sigAt: 0, // tunnel session: handshake state, then one key and counter per direction
    };
    this.routes.set(r.id, r);
    if (tid) this.tunnels.set(r.tidHex, r);
    return r;
  }

  routeSend(r, obj) {
    if (r.closed) return false;
    if (r.kind === 'link') return this.sendLink(r.link, { t: T.FRAME, d: cbor.encode(obj) });
    let d;
    if (r.tx) {
      d = cbor.encode({ t: T.ENC, n: r.tx.n, b: sealSeq(r.tx.key, r.tx.n, cbor.encode(obj), r.tid) });
      r.tx.n++;
    } else if (OPEN.has(obj.t)) {
      d = cbor.encode(obj);
    } else {
      return false; // nothing about a conversation leaves before the session exists
    }
    return this.sendLink(r.link, { t: T.TDATA, x: r.tid, d });
  }

  routeDown(r) {
    if (r.closed) return;
    r.closed = true;
    this.routes.delete(r.id);
    if (r.tidHex) this.tunnels.delete(r.tidHex);
    for (const t of r.vecTimers.values()) clearTimeout(t);
    // A direct-connection attempt that was being signalled over this route is void;
    // it does not count as a failure, so the next route may try again at once.
    for (const [sid, p] of [...this.pendingSig]) {
      if (p.route !== r) continue;
      this.pendingSig.delete(sid);
      p.o.cancel();
      Object.assign(p.st, { busy: false, next: 0, n: Math.max(0, p.st.n - 1) });
    }
    if (r.peer) {
      const set = this.routesByDev.get(r.peer.devHex);
      if (set) {
        set.delete(r);
        if (!set.size) this.routesByDev.delete(r.peer.devHex);
      }
      this.disc.delete('u' + r.peer.uidHex);
      for (const id of r.sessions) this.disc.delete('s' + id);
      const gone = this.contacts.get(r.peer.uidHex);
      if (gone && !this.uidOnline(r.peer.uidHex)) {
        gone.seen = this.now(); // shown as "last seen"
        this.dirtyContacts.add(gone.uid);
      }
      this.emit('presence', r.peer.uidHex);
      this.kick();
    }
    this.emit('net');
  }

  closeRoute(r) {
    if (r.closed) return;
    if (r.kind === 'link') return this.closeLink(r.link, 'closed');
    this.sendLink(r.link, { t: T.TCLOSE, x: r.tid });
    this.routeDown(r);
  }

  // Called once the device at the other end of a route is known. One route per
  // device is kept: a direct link beats any tunnel, a shorter tunnel beats a longer
  // one. Returns false when this route lost and was closed.
  onRoutePeer(route) {
    const { uidHex, devHex } = route.peer;
    let set = this.routesByDev.get(devHex);
    if (!set) this.routesByDev.set(devHex, (set = new Set()));
    set.add(route);
    const direct = [...set].find((r) => !r.closed && r.kind === 'link');
    const doubtful = direct && route.kind === 'tunnel' && (direct.link.probe || this.now() - direct.link.last > 2000);
    // The device reached us through a tunnel although we hold a direct link to it.
    // If that link has been quiet it may be a leftover from a page that was reloaded
    // or killed: ask it to answer, and keep the tunnels until we know.
    if (doubtful) this.probeLink(direct.link);
    else this.pruneRoutes(devHex, route);
    if (route.closed) return false;
    this.disc.delete('u' + uidHex);
    this.startSessions(route);
    this.emit('presence', uidHex);
    this.emit('net');
    return true;
  }

  pruneRoutes(devHex, fresh = null) {
    const set = this.routesByDev.get(devHex);
    const live = set ? [...set].filter((r) => !r.closed) : [];
    if (live.length < 2) return;
    const rank = (r) => (r.kind === 'link' ? '0' : '1' + String(r.hops).padStart(3, '0') + r.tidHex);
    const keep = live.reduce((x, y) => (rank(y) < rank(x) ? y : x));
    for (const r of live) {
      if (r === keep || r.kind !== 'tunnel') continue;
      // Conversations found through the losing tunnel continue on the kept route.
      for (const id of r.sessions) {
        const sp = this.spaces.get(id);
        if (!sp || sp.left || keep.sessions.has(id)) continue;
        keep.sessions.add(id);
        if (keep !== fresh) this.sendVec(keep, sp);
      }
      this.closeRoute(r);
    }
  }

  probeLink(L) {
    if (L.probe || L.closed) return;
    const asked = this.now();
    this.sendLink(L, { t: T.PING });
    L.probe = setTimeout(() => this.run(() => {
      L.probe = null;
      if (L.closed) return;
      if (L.last >= asked) this.pruneRoutes(L.devHex); // it answered: the tunnels are redundant
      else this.closeLink(L, 'stale');
    }), this.cfg.probeTimeout);
  }

  uidOnline(uidHex) {
    for (const r of this.routes.values()) if (r.peer && r.peer.uidHex === uidHex) return true;
    return false;
  }

  // 'direct', 'relayed' or 'offline', plus the hop count when relayed.
  reach(uidHex) {
    let best = null;
    for (const r of this.routes.values()) {
      if (!r.peer || r.peer.uidHex !== uidHex) continue;
      if (r.kind === 'link') return { state: 'direct', hops: 0 };
      if (!best || r.hops < best.hops) best = r;
    }
    return best ? { state: 'relayed', hops: best.hops } : { state: 'offline', hops: 0 };
  }

  async onFrame(route, d) {
    if (!route || route.closed || !isBytes(d)) return undefined;
    let m;
    try {
      m = cbor.decode(d, 512 * 1024);
    } catch {
      return undefined;
    }
    if (!m || typeof m !== 'object') return undefined;
    route.last = this.now();
    if (route.kind === 'tunnel') {
      if (m.t === T.ENC) {
        // Sealed with the session key. Counters only go up, so a frame that a
        // relay replays or reorders does not open.
        const n = m.n;
        if (!route.rx || !Number.isSafeInteger(n) || n < route.rx.n || !isBytes(m.b)) return undefined;
        try {
          m = cbor.decode(openSeq(route.rx.key, n, m.b, route.tid));
        } catch {
          return undefined;
        }
        route.rx.n = n + 1;
        if (!m || typeof m !== 'object' || m.t === T.ENC) return undefined;
      } else if (!OPEN.has(m.t)) {
        return undefined; // conversations only travel inside a session
      }
    }
    switch (m.t) {
      case T.SF: return this.onSpaceFrame(route, m, false);
      case T.HS1: return this.onHs1(route, m);
      case T.HS2: return this.onHs2(route, m);
      case T.HS3: return this.onHs3(route, m);
      case T.PICKUP: return this.onPickup(route, m);
      case T.PICKED: return this.onPicked(route, m);
      case T.HPKE: return this.onRequest(route, m);
      default: return undefined;
    }
  }

  // ---- route discovery and tunnels --------------------------------------------
  // A request for a tag floods over contact links, at most `ttl` hops. Every node
  // that listens on the tag (or holds mail for it) answers; the answer travels
  // back along the reverse path and leaves a tunnel behind. Relays only ever see
  // tags and ciphertext.

  sendRreq(tags, extra = {}) {
    if (!this.links.size) return;
    const id = rand(8);
    const idHex = hex(id);
    this.pendingReq.set(idHex, { tags, ts: this.now(), got: 0, ...extra });
    this.seenReq.set(idHex, { from: null, ts: this.now() });
    for (const L of this.links.values()) this.sendLink(L, { t: T.RREQ, i: id, g: tags, h: this.cfg.ttl, n: 0 });
  }

  onRreq(L, m) {
    // Checked in full before anything is remembered or passed on.
    if (!isBytes(m.i, 8) || !Array.isArray(m.g) || !m.g.length || m.g.length > 8 || !m.g.every((t) => isBytes(t, 16))) return;
    if (!Number.isInteger(m.h) || m.h < 1 || m.h > 64 || !Number.isInteger(m.n) || m.n < 0 || m.n > 64) return;
    const now = this.now();
    if (now - L.rq.t > 1000) L.rq = { t: now, n: 0 };
    if (++L.rq.n > this.cfg.rreqPerSecond) return;
    const idHex = hex(m.i);
    if (this.seenReq.has(idHex)) return;
    this.seenReq.set(idHex, { from: L, ts: now });
    const matched = [];
    const held = [];
    m.g.forEach((tag, i) => {
      const th = hex(tag);
      const ent = this.tags.get(th);
      if ((ent && !ent.sp.left) || (th === this.myInboxHex && (this.settings.requests || this.openInvites()))) matched.push(i);
      if (this.courierTags.has(th)) held.push(i);
    });
    let anonymous = 0;
    for (const r of this.tunnels.values()) if (!r.peer) anonymous++;
    if ((matched.length || held.length) && this.tunnels.size < this.cfg.maxEndpointTunnels && anonymous < this.cfg.maxAnonTunnels) {
      // The requester starts the session handshake; nothing is sent before it.
      const tid = rand(8);
      this.newRoute({ kind: 'tunnel', link: L, tid, hops: m.n + 1 });
      this.sendLink(L, { t: T.RREP, i: m.i, x: tid, m: matched, c: held, n: 0 });
    }
    const ttl = Math.min(m.h, this.cfg.ttl) - 1;
    if (ttl > 0 && this.settings.relay) {
      for (const o of this.links.values()) if (o !== L) this.sendLink(o, { t: T.RREQ, i: m.i, g: m.g, h: ttl, n: m.n + 1 });
    }
  }

  onRrep(L, m) {
    if (!isBytes(m.i, 8) || !isBytes(m.x, 8) || !Array.isArray(m.m) || !Array.isArray(m.c) || m.m.length > 8 || m.c.length > 8) return;
    if (!Number.isInteger(m.n) || m.n < 0 || m.n > 64 || ![...m.m, ...m.c].every((i) => Number.isInteger(i) && i >= 0 && i < 8)) return;
    const idHex = hex(m.i);
    const tidHex = hex(m.x);
    if (this.tunnels.has(tidHex) || this.relays.has(tidHex)) return;
    const refuse = () => void this.sendLink(L, { t: T.TCLOSE, x: m.x });
    const mine = this.pendingReq.get(idHex);
    if (mine) {
      if (mine.got >= this.cfg.maxTunnelsPerRequest || this.tunnels.size >= this.cfg.maxEndpointTunnels) return refuse();
      mine.got++;
      const route = this.newRoute({ kind: 'tunnel', link: L, tid: m.x, hops: m.n + 1 });
      return this.onTunnelUp(route, mine, m);
    }
    const seen = this.seenReq.get(idHex);
    if (!seen || !seen.from || seen.from.closed || !this.settings.relay || this.relays.size >= this.cfg.maxRelayTunnels) return refuse();
    // One neighbour, or one request, cannot take all the tunnels this device carries.
    seen.replies = (seen.replies || 0) + 1;
    let carried = 0;
    for (const rt of this.relays.values()) if (rt.a === seen.from) carried++;
    if (seen.replies > this.cfg.maxRepliesRelayed || carried >= this.cfg.maxRelayPerLink) return refuse();
    this.relays.set(tidHex, { x: m.x, a: seen.from, b: L, last: this.now(), bytes: 0 });
    this.sendLink(seen.from, { t: T.RREP, i: m.i, x: m.x, m: m.m, c: m.c, n: m.n + 1 });
    this.emit('net');
  }

  onTunnelUp(route, req, m) {
    for (const i of m.m) {
      const tag = req.tags[i];
      if (!isBytes(tag, 16)) continue;
      const th = hex(tag);
      const ent = this.tags.get(th);
      if (ent && !ent.sp.left) this.startSession(route, tag); // prove who we are before anything else
      else if (req.contact && th === hex(inboxTag(unhex(req.contact)))) this.sendRequest(route, req.contact);
    }
    for (const i of m.c) {
      const tag = req.tags[i];
      const sp = isBytes(tag, 16) ? this.mbx.get(hex(tag)) : null;
      if (!sp) continue;
      // The courier only hands mail to someone who signs for this mailbox, and the
      // signature is tied to this tunnel so nobody on the way can reuse it.
      const have = [...(this.picked.get(hex(tag)) || [])].slice(-1000).map(unhex);
      const signer = mailboxSigner(this.curKey(sp).key, this.id.uid);
      this.routeSend(route, { t: T.PICKUP, g: tag, h: have, s: sign(signer.seed, 'void/pickup', concat(tag, route.tid)) });
    }
  }

  onTunnelData(L, m) {
    if (!isBytes(m.x, 8) || !isBytes(m.d)) return;
    const tidHex = hex(m.x);
    const r = this.tunnels.get(tidHex);
    if (r) return r.link === L ? this.onFrame(r, m.d) : undefined;
    const rt = this.relays.get(tidHex);
    const out = rt ? (rt.a === L ? rt.b : rt.b === L ? rt.a : null) : null;
    if (!out || m.d.length > this.cfg.maxFrame) return void this.sendLink(L, { t: T.TCLOSE, x: m.x });
    rt.last = this.now();
    rt.bytes += m.d.length;
    if (!this.sendLink(out, { t: T.TDATA, x: m.x, d: m.d })) {
      this.relays.delete(tidHex);
      this.sendLink(L, { t: T.TCLOSE, x: m.x });
    }
    return undefined;
  }

  onTunnelClose(L, m) {
    if (!isBytes(m.x, 8)) return;
    const tidHex = hex(m.x);
    const r = this.tunnels.get(tidHex);
    if (r) return void (r.link === L && this.routeDown(r));
    const rt = this.relays.get(tidHex);
    if (!rt || (rt.a !== L && rt.b !== L)) return;
    this.sendLink(rt.a === L ? rt.b : rt.a, { t: T.TCLOSE, x: m.x });
    this.relays.delete(tidHex);
    this.emit('net');
  }

  kick() {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => this.run(() => this.discover()), 200);
  }

  keepalive() {
    const now = this.now();
    for (const L of [...this.links.values()]) {
      if (now - L.last > this.cfg.linkTimeout) this.closeLink(L, 'timeout');
      else this.sendLink(L, { t: T.PING });
    }
    for (const r of this.tunnels.values()) this.routeSend(r, { t: T.KEEP });
  }

  async gc() {
    const now = this.now();
    for (const [k, v] of this.seenReq) if (now - v.ts > this.cfg.seenTtl) this.seenReq.delete(k);
    for (const [k, v] of this.pendingReq) if (now - v.ts > this.cfg.seenTtl) this.pendingReq.delete(k);
    for (const [k, rt] of [...this.relays]) {
      if (now - rt.last <= this.cfg.tunnelIdle) continue;
      this.sendLink(rt.a, { t: T.TCLOSE, x: rt.x });
      this.sendLink(rt.b, { t: T.TCLOSE, x: rt.x });
      this.relays.delete(k);
    }
    for (const r of [...this.tunnels.values()]) {
      const stale = now - r.last > this.cfg.tunnelIdle;
      const anonymous = !r.peer && now - r.created > this.cfg.anonTunnelTtl;
      if (stale || anonymous) this.closeRoute(r);
    }
    if (now - (this.courierGcAt || 0) > 600000) {
      this.courierGcAt = now;
      await this.loadCourier();
    }
  }

  // ---- couriers: contacts that hold sealed frames for an offline recipient ------

  async loadCourier() {
    this.courierTags.clear();
    this.courierBy.clear();
    this.courierBytes = 0;
    const now = this.now();
    for (const { key, value } of await this.store.range('courier')) {
      // The store may hide record names, so everything needed is inside the record.
      if (value.exp < now || !value.tag) {
        await this.store.del('courier', value.tag ? `${value.tag}|${value.id}` : key);
        continue;
      }
      const th = value.tag;
      this.courierTags.set(th, (this.courierTags.get(th) || 0) + 1);
      this.courierBytes += value.f.length;
      this.courierBy.set(value.from, (this.courierBy.get(value.from) || 0) + value.f.length);
    }
  }

  async onStore(L, m) {
    if (!this.settings.courier || !isBytes(m.g, 16) || !isBytes(m.k, UID) || !Array.isArray(m.f) || m.f.length > 512) return;
    if (L.uidHex !== this.uidHex) {
      const c = this.contacts.get(L.uidHex);
      if (!c || c.pending || c.blocked) return;
    }
    const th = hex(m.g);
    const ttl = Number.isSafeInteger(m.x) && m.x > 0 ? Math.min(m.x, this.cfg.courierTtl) : this.cfg.courierTtl;
    for (const f of m.f) {
      if (!isBytes(f) || f.length > this.cfg.courierMaxFrame) continue;
      const by = this.courierBy.get(L.uidHex) || 0;
      if (this.courierBytes + f.length > this.cfg.courierMaxBytes || by + f.length > this.cfg.courierPerPeer) break;
      const id = hex(hash(f).subarray(0, 8));
      const key = th + '|' + id;
      if (await this.store.get('courier', key)) continue;
      await this.store.put('courier', key, { f, exp: this.now() + ttl, from: L.uidHex, tag: th, id, k: m.k });
      this.courierTags.set(th, (this.courierTags.get(th) || 0) + 1);
      this.courierBytes += f.length;
      this.courierBy.set(L.uidHex, by + f.length);
    }
    this.emit('net');
  }

  async onPickup(route, m) {
    if (!isBytes(m.g, 16) || !Array.isArray(m.h) || !isBytes(m.s, SIG) || !route.tid) return;
    const th = hex(m.g);
    if (!this.courierTags.has(th)) return;
    const proof = concat(m.g, route.tid);
    const allowed = new Map(); // mailbox key -> did the requester sign for it?
    const mayHave = (k) => {
      if (!isBytes(k, UID)) return false;
      const id = hex(k);
      if (!allowed.has(id)) allowed.set(id, verify(k, 'void/pickup', proof, m.s));
      return allowed.get(id);
    };
    const have = new Set();
    for (const h of m.h.slice(0, 2000)) if (isBytes(h, 8)) have.add(hex(h));
    let batch = [];
    let size = 0;
    const send = () => {
      if (batch.length) this.routeSend(route, { t: T.PICKED, g: m.g, f: batch });
      batch = [];
      size = 0;
    };
    for (const { value } of await this.store.range('courier', th + '|')) {
      if (have.has(value.id) || !mayHave(value.k)) continue;
      if (size + value.f.length > this.cfg.batchBytes) send();
      batch.push(value.f);
      size += value.f.length;
    }
    send();
  }

  async onPicked(route, m) {
    if (!isBytes(m.g, 16) || !Array.isArray(m.f)) return;
    const th = hex(m.g);
    if (!this.mbx.has(th)) return;
    let set = this.picked.get(th);
    if (!set) this.picked.set(th, (set = new Set()));
    if (set.size > 4000) this.picked.set(th, (set = new Set([...set].slice(-2000))));
    for (const f of m.f.slice(0, 512)) {
      if (!isBytes(f)) continue;
      set.add(hex(hash(f).subarray(0, 8)));
      try {
        const inner = cbor.decode(f, 256 * 1024);
        if (inner && inner.t === T.SF) await this.onSpaceFrame(route, inner, true);
      } catch { /* not for us or corrupted */ }
    }
  }

  // Hands my undelivered one-to-one messages to contacts that are online now.
  courierSend(sp, recs, links) {
    if (!recs.length || !links.length) return;
    const key = this.curKey(sp);
    const tag = mailboxTag(key.key, unhex(sp.peer));
    const signer = mailboxSigner(key.key, unhex(sp.peer));
    let batch = [];
    let size = 0;
    const send = () => {
      if (batch.length) for (const L of links) this.sendLink(L, { t: T.STORE, g: tag, k: signer.pub, x: this.cfg.courierTtl, f: batch });
      batch = [];
      size = 0;
    };
    let top = 0;
    for (const r of recs) {
      const f = cbor.encode({ t: T.SF, g: key.tag, b: seal(key.key, cbor.encode({ t: T.EV, e: [[r.raw, r.sig]] }), key.tag) });
      if (f.length > this.cfg.courierMaxFrame) continue;
      if (size + f.length > 200 * 1024) send();
      batch.push(f);
      size += f.length;
      top = Math.max(top, r.q);
    }
    send();
    for (const L of links) this.couriered.set(sp.id + L.uidHex, Math.max(this.couriered.get(sp.id + L.uidHex) || 0, top));
    if (top > (sp.cour || 0)) {
      sp.cour = top;
      this.dirty.add(sp.id);
      this.emit('message', sp.id);
    }
  }

  courierLinks(sp) {
    return [...this.links.values()].filter((L) => L.uidHex !== sp.peer && L.uidHex !== this.uidHex).slice(0, this.cfg.courierFanout);
  }

  async courierCatchUp(L) {
    if (L.closed || L.uidHex === this.uidHex) return;
    for (const sp of this.spaces.values()) {
      if (sp.kind !== 'dm' || sp.left || sp.peer === L.uidHex || this.uidOnline(sp.peer)) continue;
      const st = sp.vec[this.myFeed];
      if (!st) continue;
      const from = Math.max(sp.peerHas[this.myFeed] || 0, this.couriered.get(sp.id + L.uidHex) || 0, st.max - 200) + 1;
      if (from > st.max) continue;
      const rows = await this.store.between('events', evKey(sp.id, this.myFeed, from), evKey(sp.id, this.myFeed, st.max));
      this.courierSend(sp, rows.map((r) => r.value), [L]);
    }
  }

  // ---- status for the UI ----------------------------------------------------

  netStatus() {
    const links = [...this.links.values()].map((L) => ({ uid: L.uidHex, dev: L.devHex, name: this.nameOf(L.uidHex), self: L.uidHex === this.uidHex }));
    const tunnels = [...this.tunnels.values()].filter((r) => r.peer).map((r) => ({ uid: r.peer.uidHex, name: this.nameOf(r.peer.uidHex), hops: r.hops }));
    const rdv = this.rdvNet && this.rdvOn() ? this.rdvNet.status() : null;
    return { links, tunnels, relaying: this.relays.size, held: this.courierBytes, heldTags: this.courierTags.size, rdv };
  }
}

Object.assign(VoidNode.prototype, syncMethods, socialMethods, blobMethods, rdvMethods, sessionMethods, profileMethods);
