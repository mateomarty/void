// SPDX-License-Identifier: AGPL-3.0-or-later
// Tests written from the findings of an internal security review: each one sets up the
// attack and checks that it no longer works.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, FAST, until, sleep, texts, dm } from './fakenet.js';
import { rand, hex, unhex, concat, utf8 } from '../../src/core/bytes.js';
import * as cbor from '../../src/core/cbor.js';
import { sign, seal, passSeal, kemKeys } from '../../src/core/crypto.js';
import { T } from '../../src/core/proto.js';
import { readCard, makeCard, identityFromSeed, mailboxTag } from '../../src/core/keys.js';
import { VoidNode } from '../../src/core/node.js';
import { MemStore } from '../../src/core/store.js';

test('over a tunnel nobody can pass for someone else', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    const m = await net.node('mallory');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(a, m);
    await net.pair(c, m);
    const g = await a.createGroup('Team', [b.uidHex, m.uidHex]);
    await until(() => b.spaces.has(g) && m.spaces.has(g), 3000, 'group');
    net.stop('bob');
    net.block('alice', 'mallory');
    await until(() => !a.uidOnline(b.uidHex), 3000, 'bob offline');

    // Mallory holds the group key. On every tunnel she claims to be Bob.
    m.sessionProof = function forged(route, bind, who) {
      const body = concat(route.tid, bind, b.id.uid, this.id.dev, utf8(who));
      return cbor.encode({ u: b.id.uid, d: this.id.dev, s: sign(this.id.edSk, 'void/hs', body) });
    };
    net.cut('alice', 'mallory');
    await sleep(900);
    assert.equal(a.uidOnline(b.uidHex), false, 'alice believes bob is reachable');
    assert.equal(a.uidOnline(m.uidHex), false);
    assert.equal([...a.routes.values()].filter((r) => r.kind === 'tunnel' && r.peer).length, 0);

    // With an honest proof the same tunnel is accepted, as Mallory.
    delete m.sessionProof;
    await until(() => a.reach(m.uidHex).state === 'relayed', 4000, 'honest session');
    assert.equal(a.uidOnline(b.uidHex), false);
  } finally {
    net.stopAll();
  }
});

test('relays see neither tags nor contents of tunnel traffic, and replayed or bare frames are refused', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    const carried = [];
    const forward = c.onTunnelData.bind(c);
    c.onTunnelData = (L, m) => {
      carried.push(m.d.slice());
      return forward(L, m);
    };
    net.block('alice', 'bob');
    net.cut('alice', 'bob');
    await until(() => a.reach(b.uidHex).state === 'relayed' && b.reach(a.uidHex).state === 'relayed', 4000, 'relayed route');
    await a.sendMessage(dm(a, b), { text: 'only bob may read this' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'relayed message');

    const sp = a.spaces.get(dm(a, b));
    const tag = Buffer.from(a.curKey(sp).tag);
    const kinds = new Set();
    for (const d of carried) {
      const f = cbor.decode(d);
      kinds.add(f.t);
      assert.ok([T.HS1, T.HS2, T.HS3, T.ENC, T.KEEP].includes(f.t), `a relay carried a frame of type ${f.t}`);
      if (f.t !== T.HS1) assert.equal(Buffer.from(d).includes(tag), false, 'a conversation tag is visible in carried traffic');
      assert.equal(Buffer.from(d).includes(Buffer.from(a.id.uid)) || Buffer.from(d).includes(Buffer.from(b.id.uid)), false, 'a user id is visible to the relay');
    }
    assert.ok(kinds.has(T.ENC) && kinds.has(T.HS1) && kinds.has(T.HS2) && kinds.has(T.HS3));

    // A relay replays everything it carried, then injects a bare space frame.
    const route = [...b.tunnels.values()].find((r) => r.peer && r.peer.uidHex === a.uidHex);
    const counter = route.rx.n;
    const vector = route.peerVec.get(sp.id);
    for (const d of carried) await b.enqueue(() => b.onFrame(route, d));
    const bare = cbor.encode({ t: T.SF, g: a.curKey(sp).tag, b: seal(a.curKey(sp).key, cbor.encode({ t: T.VEC, v: [], ce: 0 }), a.curKey(sp).tag) });
    await b.enqueue(() => b.onFrame(route, bare));
    assert.equal(route.rx.n, counter, 'a replayed frame was accepted');
    assert.equal(route.peerVec.get(sp.id), vector, 'a frame outside the session was accepted');
    assert.equal((await texts(b, dm(b, a))).length, 1);
  } finally {
    net.stopAll();
  }
});

test('a contact cannot take the place of another contact by announcing its device id', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const m = await net.node('mallory');
    await net.pair(a, b);
    m.id.dev = b.id.dev; // Mallory claims Bob's device id
    const inv = await a.invite();
    const j = await m.join(inv.code);
    await inv.complete(j.code);
    await j.done;
    await until(() => a.links.size === 2, 3000, 'mallory linked');
    await sleep(100);
    assert.ok(a.linkByDev.has(b.devKey), 'the link to bob was replaced');
    assert.equal(a.reach(b.uidHex).state, 'direct');
    await a.sendMessage(dm(a, b), { text: 'still for bob' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'message reaches bob');
  } finally {
    net.stopAll();
  }
});

test('bad cards, malformed route requests and made-up feeds are refused', async () => {
  const net = new FakeNet();
  try {
    // a card whose encryption key makes every shared secret zero
    const id = identityFromSeed(rand(32));
    assert.equal(readCard(makeCard({ ...id, dhPub: new Uint8Array(56) }, 'weak', 1)), null);
    assert.equal(readCard(makeCard(id, 'fine', 1)).name, 'fine');

    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    const toAlice = [...b.links.values()][0];
    const send = async (g) => {
      const i = rand(8);
      b.sendLink(toAlice, { t: T.RREQ, i, g, h: 6, n: 0 });
      await sleep(80);
      return c.seenReq.has(hex(i));
    };
    assert.equal(await send([rand(16)]), true, 'a normal request is passed on');
    assert.equal(await send([rand(16), rand(40000)]), false, 'an oversized request was passed on');
    assert.equal(await send(new Array(9).fill(rand(16))), false);
    assert.equal(await send(['text']), false);
    assert.equal(a.links.size, 2, 'the link survives');

    // Bob floods a group with first events from thirty pretended devices.
    const g = await a.createGroup('Open house', [b.uidHex]);
    await until(() => b.spaces.has(g), 3000, 'group');
    const sp = a.spaces.get(g);
    let accepted = 0;
    for (let n = 0; n < 30; n++) {
      const raw = cbor.encode({ v: 1, s: unhex(g), a: b.id.uid, d: rand(8), q: 1, p: null, ts: Date.now(), k: 'msg', b: { x: 'spam' } });
      if (await a.enqueue(() => a.acceptEvent(sp, raw, sign(b.id.edSk, 'void/ev', raw)))) accepted++;
    }
    assert.equal(accepted, 16);
    assert.equal(Object.keys(sp.vec).filter((f) => f.startsWith(b.uidHex)).length, 16);
  } finally {
    net.stopAll();
  }
});

test('held mail is only handed to someone who can sign for the mailbox', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    let b = await net.node('bob');
    const c = await net.node('carol');
    const x = await net.node('xavier');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    await net.pair(c, x);
    net.stop('bob');
    await until(() => !a.uidOnline(b.uidHex), 3000, 'bob offline');
    await a.sendMessage(dm(a, b), { text: 'kept for bob' });
    await until(() => c.courierTags.size === 1, 3000, 'carol holds it');

    // Xavier saw the mailbox tag go by and asks Carol for the mail.
    const tag = mailboxTag(a.curKey(a.spaces.get(dm(a, b))).key, b.id.uid);
    let handed = 0;
    x.onPicked = async (route, m) => {
      handed += m.f.length;
    };
    x.onTunnelUp = (route) => {
      x.routeSend(route, { t: T.PICKUP, g: tag, h: [], s: sign(rand(57), 'void/pickup', concat(tag, route.tid)) });
      x.routeSend(route, { t: T.PICKUP, g: tag, h: [] });
    };
    await x.enqueue(() => x.sendRreq([tag]));
    await sleep(400);
    assert.equal(handed, 0, 'the courier gave the mail to a stranger');

    b = await net.node('bob');
    await net.pair(b, c);
    await until(async () => (await texts(b, dm(b, a))).includes('kept for bob'), 4000, 'bob collects his mail');
  } finally {
    net.stopAll();
  }
});

test('a long list of feeds is exchanged in parts', async () => {
  const net = new FakeNet();
  try {
    const cfg = { vecChunk: 1 };
    const a = await net.node('alice', cfg);
    const b = await net.node('bob', cfg);
    const c = await net.node('carol', cfg);
    await net.pair(a, b);
    await net.pair(a, c);
    const g = await a.createGroup('Parts', [b.uidHex, c.uidHex]);
    await until(() => b.spaces.has(g) && c.spaces.has(g), 3000, 'group');
    await b.sendMessage(g, { text: 'one' });
    await c.sendMessage(g, { text: 'two' });
    await a.sendMessage(g, { text: 'three' });
    await until(async () => (await texts(b, g)).length === 3 && (await texts(c, g)).length === 3 && (await texts(a, g)).length === 3, 4000, 'everyone has everything');
  } finally {
    net.stopAll();
  }
});

test('a relay-only contact is never linked directly and is still reached through a mutual contact', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    await a.setRelayOnly(b.uidHex, true);
    await until(() => a.reach(b.uidHex).state === 'relayed', 4000, 'route through carol');
    await a.sendMessage(dm(a, b), { text: 'through carol only' });
    await until(async () => (await texts(b, dm(b, a))).includes('through carol only'), 3000, 'relayed message');
    await sleep(900); // several upgrade attempts by bob go unanswered
    assert.equal(a.reach(b.uidHex).state, 'relayed');
    assert.equal(a.linkByDev.has(b.devKey), false);
    await a.setRelayOnly(b.uidHex, false);
    await until(() => a.reach(b.uidHex).state === 'direct', 5000, 'direct again once allowed');
  } finally {
    net.stopAll();
  }
});

test('leaving a private group renews its key for those who stay', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    const g = await a.createGroup('Club', [b.uidHex, c.uidHex]);
    await until(() => b.spaces.has(g) && c.spaces.has(g) && b.members(g).length === 3, 3000, 'group');
    await c.leaveSpace(g);
    await until(() => a.spaces.get(g).keys.length === 2 && b.spaces.get(g).keys.length === 2, 4000, 'new key after the leave');
    assert.equal(c.spaces.get(g).keys.length, 1);
    await a.sendMessage(g, { text: 'after carol left' });
    await until(async () => (await texts(b, g)).includes('after carol left'), 3000, 'message on the new key');
  } finally {
    net.stopAll();
  }
});

test('profiles and backups made with the earlier keys are refused, and say why', async () => {
  const seed = rand(32);
  for (const [magic, logN] of [['VOIDBK1\n', 15], ['VOIDBK2\n', 17]]) {
    const old = concat(utf8(magic), passSeal('old passphrase', cbor.encode({ v: 1, seed, n: 'Old', ts: 1, c: [], s: [] }), logN));
    const n = new VoidNode({ store: new MemStore(), cfg: FAST });
    await assert.rejects(n.restoreBackup(old, 'old passphrase'), (e) => e.code === 'old-keys' && /earlier version/.test(e.message));
    assert.equal(n.id, null, 'no identity was made from the old backup');
  }
  // a stored profile from before the change: nothing is loaded from it
  const store = new MemStore();
  await store.put('kv', 'id', { seed, dev: rand(8), name: 'Old', ts: 1 });
  const n = new VoidNode({ store, cfg: FAST });
  await assert.rejects(n.load(), (e) => e.code === 'old-keys');
  assert.equal(n.ready, false);
  // a backup made now restores, with the same identity
  const a = new VoidNode({ store: new MemStore(), cfg: FAST });
  const b = new VoidNode({ store: new MemStore(), cfg: FAST });
  try {
    await a.create('Now');
    const backup = await a.exportBackup('a passphrase');
    assert.equal(Buffer.from(backup.subarray(0, 8)).toString(), 'VOIDBK3\n');
    await b.restoreBackup(backup, 'a passphrase');
    assert.equal(b.uidHex, a.uidHex);
    assert.equal(b.uidHex.length, 114);
  } finally {
    a.stop();
    b.stop();
  }
});

test('two builds that cannot talk to each other refuse to link and say why', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice', {}, 'alice', { rdv: true });
    const b = await net.node('bob', {}, 'bob', { rdv: true });
    await net.pair(a, b);
    net.stop('bob');
    await until(() => a.links.size === 0, 3000, 'bob gone');
    // Bob comes back on a build that speaks an older protocol.
    const old = await net.node('bob', {}, 'bob', { rdv: true });
    const send = old.sendLink.bind(old);
    old.sendLink = (L, obj) => send(L, obj.t === T.AUTH1 ? { ...obj, v: 2 } : obj);
    const seal0 = old.rdvSend.bind(old);
    old.rdvSend = (uid, msg) => seal0(uid, { ...msg, v: undefined });
    let told = null;
    a.on('version', (name, theirs, mine) => (told = { name, theirs, mine }));
    await until(() => told, 4000, 'alice is told about the other version');
    assert.equal(told.name, 'bob');
    assert.ok(told.theirs < told.mine);
    await sleep(300);
    assert.equal(a.links.size, 0);
  } finally {
    net.stopAll();
  }
});

// ---- the hybrid key exchange (X448 together with ML-KEM-1024) ---------------------

const tryDecode = (bytes) => {
  try {
    return cbor.decode(bytes, 1024 * 1024);
  } catch {
    return null;
  }
};

test('a direct link is sealed with keys from both exchanges, and what was recorded shows nothing', async () => {
  const net = new FakeNet();
  try {
    const wire = [];
    net.tap = (from, to, bytes) => void wire.push({ from, bytes });
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    await a.sendMessage(dm(a, b), { text: 'only bob may read this' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'message');

    for (const who of ['alice', 'bob']) {
      const sent = wire.filter((w) => w.from === who).map((w) => w.bytes);
      const [hello, proof] = sent.map(tryDecode);
      assert.equal(hello.t, T.AUTH1);
      assert.equal(hello.e.length, 56, 'one-use X448 key');
      assert.equal(hello.k.length, 1568, 'one-use ML-KEM-1024 key');
      assert.equal(proof.t, T.AUTH2);
      assert.equal(proof.q.length, 1568, 'ML-KEM-1024 ciphertext');
      assert.equal(proof.s.length, 114, 'Ed448 signature');
      // Everything after the two handshake messages is sealed: no message type, no
      // tag, no text.
      assert.ok(sent.length > 2);
      const tag = Buffer.from(a.curKey(a.spaces.get(dm(a, b))).tag);
      for (const bytes of sent.slice(2)) {
        const m = tryDecode(bytes);
        assert.ok(!m || typeof m !== 'object' || !Number.isInteger(m.t), 'a message left unsealed');
        assert.equal(Buffer.from(bytes).includes(tag), false);
        assert.equal(Buffer.from(bytes).includes(Buffer.from('only bob')), false);
      }
    }
    // Both ends hold the same keys, crossed, and the one-use secrets are gone.
    const la = a.linkByDev.get(b.devKey);
    const lb = b.linkByDev.get(a.devKey);
    assert.equal(hex(la.tx.key), hex(lb.rx.key));
    assert.equal(hex(la.rx.key), hex(lb.tx.key));
    assert.notEqual(hex(la.tx.key), hex(la.rx.key));
    assert.equal(la.eph, null);
    assert.equal(lb.eph, null);

    // A recorded message played again does not open, and the link is dropped.
    const again = wire.filter((w) => w.from === 'alice').pop().bytes;
    const w = net.wires.find((x) => x.a === 'alice' || x.b === 'alice');
    (w.a === 'alice' ? w.y : w.x).handler(again);
    await until(() => !b.linkByDev.has(a.devKey), 2000, 'bob drops the link');
  } finally {
    net.stopAll();
  }
});

test('a link does not come up when either half of the key exchange was swapped on the way', async () => {
  for (const swap of ['x448', 'kem-key', 'kem-ciphertext']) {
    const net = new FakeNet();
    try {
      // Someone on the path replaces one value in what Alice sends.
      net.tap = (from, to, bytes) => {
        if (from !== 'alice') return undefined;
        const m = tryDecode(bytes);
        if (!m || typeof m !== 'object') return undefined;
        if (m.t === T.AUTH1 && swap === 'x448') return cbor.encode({ ...m, e: rand(56) });
        if (m.t === T.AUTH1 && swap === 'kem-key') return cbor.encode({ ...m, k: kemKeys().publicKey });
        if (m.t === T.AUTH2 && swap === 'kem-ciphertext') {
          const q = m.q.slice();
          q[100] ^= 1;
          return cbor.encode({ ...m, q });
        }
        return undefined;
      };
      const a = await net.node('alice');
      const b = await net.node('bob');
      const inv = await a.invite();
      const j = await b.join(inv.code);
      await inv.complete(j.code);
      j.done.catch(() => {});
      await sleep(500);
      assert.equal(a.links.size + b.links.size, 0, `a link came up although the ${swap} was swapped`);
      // Bob never accepts Alice. When only Alice's last message was altered, Bob
      // had proven himself to her correctly, so she may remember him; no link stays.
      assert.equal(b.contacts.has(a.uidHex), false, swap);
      if (swap !== 'kem-ciphertext') assert.equal(a.contacts.has(b.uidHex), false, swap);
    } finally {
      net.stopAll();
    }
  }
});

test('a tunnel session does not come up when a relay alters the post-quantum exchange', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    // Carol relays, and flips one bit of every ML-KEM value passing through her.
    let tamper = true;
    let touched = 0;
    const forward = c.onTunnelData.bind(c);
    c.onTunnelData = (L, m) => {
      const inner = tamper && tryDecode(m.d);
      if (inner && (inner.t === T.HS1 || inner.t === T.HS2)) {
        const field = inner.t === T.HS1 ? 'k' : 'q';
        const v = inner[field].slice();
        v[200] ^= 1;
        touched++;
        return forward(L, { ...m, d: cbor.encode({ ...inner, [field]: v }) });
      }
      return forward(L, m);
    };
    net.block('alice', 'bob');
    net.cut('alice', 'bob');
    await until(() => touched >= 2, 4000, 'handshakes through carol');
    await sleep(400);
    assert.equal(a.uidOnline(b.uidHex), false, 'a session came up over an altered exchange');
    assert.equal(b.uidOnline(a.uidHex), false);
    tamper = false;
    await until(() => a.reach(b.uidHex).state === 'relayed' && b.reach(a.uidHex).state === 'relayed', 5000, 'honest relay');
    await a.sendMessage(dm(a, b), { text: 'through carol' });
    await until(async () => (await texts(b, dm(b, a))).includes('through carol'), 3000, 'relayed message');
  } finally {
    net.stopAll();
  }
});
