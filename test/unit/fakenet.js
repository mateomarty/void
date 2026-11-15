// SPDX-License-Identifier: AGPL-3.0-or-later
// A simulated network for tests: in-memory links with the same interface as the
// WebRTC transport, plus a fake signalling layer that can refuse direct
// connections between chosen pairs (to stand in for NATs that cannot be traversed).

import { rand, hex } from '../../src/core/bytes.js';
import { MemStore } from '../../src/core/store.js';
import { VoidNode } from '../../src/core/node.js';
import { VaultStore } from '../../src/core/vault.js';

export const FAST = {
  rdvTick: 80, rdvEvery: 250, schedTick: 40, ttlTick: 60,
  rreqTick: 40, rreqEvery: 120, rreqMax: 500, antiEntropy: 250, keepalive: 200, linkTimeout: 3000, authTimeout: 1500,
  gcEvery: 200, vecDelay: 10, upgradeRetry: 250, upgradeTimeout: 600, tunnelIdle: 4000, seenTtl: 3000, blobTimeout: 600, probeTimeout: 150, dialRace: 120, sigEvery: 40,
};

// `tap(end, bytes)` sees every message put on the wire and may return other bytes
// to deliver instead (a wiretap, or someone tampering with the connection).
function makePair(latency, tap) {
  const mk = () => ({
    closed: false, buf: [], handler: null, onclose: null, peer: null, fpLocal: null, fpRemote: null,
    set onmessage(fn) {
      this.handler = fn;
      for (const b of this.buf.splice(0)) fn(b);
    },
    get onmessage() {
      return this.handler;
    },
    send(bytes) {
      if (this.closed) throw new Error('closed');
      const copy = (tap && tap(this, bytes.slice())) || bytes.slice();
      const p = this.peer;
      setTimeout(() => {
        if (p.closed) return;
        if (p.handler) p.handler(copy);
        else p.buf.push(copy);
      }, latency);
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      const p = this.peer;
      setTimeout(() => {
        if (this.onclose) this.onclose();
        p.close();
      }, 0);
    },
  });
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  a.fpLocal = b.fpRemote = rand(32);
  b.fpLocal = a.fpRemote = rand(32);
  return [a, b];
}

// A stand-in for the public rendezvous relays: a notice board that passes each
// notice to the other devices listening on its topic, and keeps a log of everything
// it was shown (which is all a real relay would ever see).
class NoticeBoard {
  constructor() {
    this.members = new Set();
    this.log = [];
  }

  join(from = '?') {
    const board = this;
    return {
      topics: new Set(), on: false, onmessage: null, onup: null, onstatus: null,
      configure(urls) {
        const was = this.on;
        this.on = urls.length > 0;
        if (this.on) board.members.add(this);
        else board.members.delete(this);
        if (this.on && !was) setTimeout(() => this.on && this.onup && this.onup(), 1);
      },
      setTopics(list) {
        this.topics = new Set(list);
      },
      publish(topic, bytes) {
        if (!this.on) return 0;
        board.log.push({ topic, bytes: bytes.slice(), from });
        for (const m of board.members) {
          if (m !== this && m.topics.has(topic)) setTimeout(() => m.on && m.onmessage && m.onmessage(topic, bytes.slice()), 1);
        }
        return 1;
      },
      status() {
        return { open: this.on ? 1 : 0, total: 1 };
      },
    };
  }
}

export class FakeNet {
  constructor({ latency = 1 } = {}) {
    this.latency = latency;
    this.board = new NoticeBoard();
    this.offers = new Map();
    this.answers = new Map();
    this.blocked = new Set();
    this.nodes = new Map();
    this.stores = new Map();
    this.wires = [];
    this.tap = null; // (fromName, toName, bytes) => replacement bytes or nothing
  }

  block(a, b) {
    this.blocked.add(`${a}|${b}`).add(`${b}|${a}`);
  }

  unblock(a, b) {
    this.blocked.delete(`${a}|${b}`);
    this.blocked.delete(`${b}|${a}`);
  }

  rtc(name) {
    const net = this;
    return {
      async offer() {
        const code = rand(8);
        const o = { name, cancelled: false };
        net.offers.set(hex(code), o);
        return {
          code,
          cancel() {
            o.cancelled = true;
          },
          accept(answer) {
            const a = net.answers.get(hex(answer));
            if (!a || a.offer !== o) return Promise.reject(new Error('unknown answer'));
            if (net.blocked.has(`${name}|${a.name}`)) {
              a.reject(new Error('no route between the two devices'));
              return Promise.reject(new Error('no route between the two devices'));
            }
            const [x, y] = makePair(net.latency, (end, bytes) => net.tap && (end === x ? net.tap(name, a.name, bytes) : net.tap(a.name, name, bytes)));
            net.wires.push({ a: name, b: a.name, x, y });
            a.resolve(y);
            return Promise.resolve(x);
          },
        };
      },
      async answer(offerCode) {
        const o = net.offers.get(hex(offerCode));
        if (!o || o.cancelled) throw new Error('unknown offer');
        const code = rand(8);
        const a = { name, offer: o };
        a.link = new Promise((resolve, reject) => {
          a.resolve = resolve;
          a.reject = reject;
        });
        a.link.catch(() => {});
        net.answers.set(hex(code), a);
        return { code, link: a.link, cancel() {} };
      },
    };
  }

  // Starts a device. With an existing store it comes back with its identity.
  // `rdv: true` gives the device the rendezvous (off unless a test asks for it).
  async node(name, cfg = {}, user = name, { rdv = false } = {}) {
    // Every device stores through the encrypted vault, as the application does.
    const store = this.stores.get(name) || new VaultStore(new MemStore(), rand(32));
    this.stores.set(name, store);
    const n = new VoidNode({
      store, rtc: this.rtc(name), rdv: rdv ? this.board.join(name) : null, defaults: { stun: false, rdv }, cfg: { ...FAST, ...cfg }, name,
      debug: process.env.VOID_DEBUG ? (...a) => console.log(...a) : null,
    });
    if (!(await n.load())) await n.create(user);
    this.nodes.set(name, n);
    return n;
  }

  // The manual invite / reply exchange.
  async pair(a, b) {
    const inv = await a.invite();
    const j = await b.join(inv.code);
    await inv.complete(j.code);
    await j.done;
    await until(() => a.linkByDev.has(b.devKey) && b.linkByDev.has(a.devKey), 2000, 'pairing');
  }

  cut(a, b) {
    for (const w of this.wires) if ((w.a === a && w.b === b) || (w.a === b && w.b === a)) w.x.close();
  }

  stop(name) {
    const n = this.nodes.get(name);
    if (n) n.stop();
    for (const w of this.wires) if (w.a === name || w.b === name) w.x.close();
    this.nodes.delete(name);
  }

  stopAll() {
    for (const name of [...this.nodes.keys()]) this.stop(name);
  }
}

export async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const texts = async (node, spId) => (await node.messages(spId)).filter((m) => m.kind === 'msg').map((m) => m.text);
export const dm = (node, other) => node.contacts.get(other.uidHex).dm;
