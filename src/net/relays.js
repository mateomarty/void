// SPDX-License-Identifier: AGPL-3.0-or-later
// Public rendezvous relays.
//
// A web page cannot dial a contact it already knows: every WebRTC connection needs
// a fresh offer and answer, and something has to carry them. When the user allows
// it, these relays do. They are third-party servers speaking the Nostr protocol
// (NIP-01); Void uses them as a dumb, short-lived notice board:
//
//   - a notice is posted under an opaque topic that only two contacts can compute,
//     and its content is sealed with a key only they hold;
//   - notices use an "ephemeral" kind, which relays pass on to current listeners
//     and do not keep;
//   - the signing key is random and new each time the page starts, so notices are
//     not tied to the user's identity.
//
// A relay learns the IP addresses of the devices that post and listen on a topic,
// and when. It cannot read notices, forge them, or learn who the users are.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex, b64u, unb64u, utf8, rand } from '../core/bytes.js';

const KIND = 20451; // in the ephemeral range 20000-29999
const TOPICS_PER_REQUEST = 100;
const MAX_RELAYS = 8;

export class RelayPool {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.secret = rand(32);
    this.pub = hex(schnorr.getPublicKey(this.secret));
    this.relays = new Map(); // url -> { url, ws, open, retry, timer, subs }
    this.topics = [];
    this.seen = new Set();
    this.onmessage = null; // (topic, bytes)
    this.onup = null; // a relay just connected
    this.onstatus = null;
  }

  // Sets the relays to use. An empty list disconnects from all of them.
  configure(urls) {
    const want = new Set((urls || []).filter((u) => /^wss:\/\/[^\s/]+/.test(u)).slice(0, MAX_RELAYS));
    for (const url of [...this.relays.keys()]) if (!want.has(url)) this.drop(url);
    for (const url of want) {
      if (this.relays.has(url)) continue;
      const r = { url, ws: null, open: false, retry: 0, timer: null, subs: 0, rate: { t: 0, n: 0 } };
      this.relays.set(url, r);
      this.connect(r);
    }
  }

  connect(r) {
    if (this.relays.get(r.url) !== r) return;
    let ws;
    try {
      ws = new WebSocket(r.url);
    } catch {
      return this.retryLater(r);
    }
    r.ws = ws;
    ws.onopen = () => {
      r.open = true;
      r.retry = 0;
      r.subs = 0;
      this.subscribe(r);
      if (this.onup) this.onup();
      if (this.onstatus) this.onstatus();
    };
    ws.onmessage = (e) => {
      // A relay that floods is not allowed to fill the application's work queue.
      const t = this.now();
      if (t - r.rate.t > 1000) r.rate = { t, n: 0 };
      if (++r.rate.n <= 60) this.receive(e.data);
    };
    ws.onclose = ws.onerror = () => {
      if (r.ws !== ws) return;
      r.ws = null;
      r.open = false;
      if (this.onstatus) this.onstatus();
      this.retryLater(r);
    };
    return undefined;
  }

  retryLater(r) {
    if (this.relays.get(r.url) !== r || r.timer) return;
    const delay = Math.min(4000 * 2 ** r.retry++, 300000);
    r.timer = setTimeout(() => {
      r.timer = null;
      this.connect(r);
    }, delay);
  }

  drop(url) {
    const r = this.relays.get(url);
    if (!r) return;
    this.relays.delete(url);
    clearTimeout(r.timer);
    if (r.ws) {
      r.ws.onclose = r.ws.onerror = r.ws.onmessage = null;
      try { r.ws.close(); } catch { /* already closed */ }
    }
    if (this.onstatus) this.onstatus();
  }

  setTopics(topics) {
    const next = [...new Set(topics)].sort();
    if (next.join() === this.topics.join()) return;
    this.topics = next;
    for (const r of this.relays.values()) if (r.open) this.subscribe(r);
  }

  subscribe(r) {
    const since = Math.floor(this.now() / 1000) - 30;
    const n = Math.ceil(this.topics.length / TOPICS_PER_REQUEST);
    try {
      for (let i = 0; i < n; i++) {
        const chunk = this.topics.slice(i * TOPICS_PER_REQUEST, (i + 1) * TOPICS_PER_REQUEST);
        r.ws.send(JSON.stringify(['REQ', 'v' + i, { kinds: [KIND], '#t': chunk, since }]));
      }
      for (let i = n; i < r.subs; i++) r.ws.send(JSON.stringify(['CLOSE', 'v' + i]));
      r.subs = n;
    } catch { /* the socket closed meanwhile; it reconnects and subscribes again */ }
  }

  // Posts sealed bytes under a topic. Returns how many relays took it.
  publish(topic, bytes) {
    const created = Math.floor(this.now() / 1000);
    const tags = [['t', topic]];
    const content = b64u(bytes);
    const id = sha256(utf8(JSON.stringify([0, this.pub, created, KIND, tags, content])));
    const event = { id: hex(id), pubkey: this.pub, created_at: created, kind: KIND, tags, content, sig: hex(schnorr.sign(id, this.secret)) };
    this.remember(event.id);
    const frame = JSON.stringify(['EVENT', event]);
    let sent = 0;
    for (const r of this.relays.values()) {
      if (!r.open) continue;
      try {
        r.ws.send(frame);
        sent++;
      } catch { /* closing */ }
    }
    return sent;
  }

  remember(id) {
    this.seen.add(id);
    if (this.seen.size > 6000) this.seen = new Set([...this.seen].slice(-3000));
  }

  receive(data) {
    if (typeof data !== 'string' || data.length > 32768) return;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(m) || m[0] !== 'EVENT' || !m[2] || typeof m[2] !== 'object') return;
    const ev = m[2];
    if (ev.kind !== KIND || typeof ev.id !== 'string' || typeof ev.content !== 'string' || !Array.isArray(ev.tags) || this.seen.has(ev.id)) return;
    this.remember(ev.id);
    const tag = ev.tags.find((t) => Array.isArray(t) && t[0] === 't' && typeof t[1] === 'string');
    if (!tag || !this.onmessage) return;
    // The relay's signature is not checked: the content is sealed, so a notice
    // that was not written by the contact fails to open and is dropped.
    try {
      this.onmessage(tag[1], unb64u(ev.content));
    } catch { /* not for us */ }
  }

  status() {
    let open = 0;
    for (const r of this.relays.values()) if (r.open) open++;
    return { open, total: this.relays.size };
  }
}
