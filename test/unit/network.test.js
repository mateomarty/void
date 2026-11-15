// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, until, sleep, texts, dm } from './fakenet.js';
import { rand, hex } from '../../src/core/bytes.js';

test('pairing makes two people contacts and messages are delivered', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    assert.equal(a.contacts.get(b.uidHex).name, 'bob');
    assert.equal(b.contacts.get(a.uidHex).name, 'alice');
    assert.equal(a.reach(b.uidHex).state, 'direct');
    await a.sendMessage(dm(a, b), { text: 'hello bob' });
    await b.sendMessage(dm(b, a), { text: 'hello alice' });
    await until(async () => (await texts(b, dm(b, a))).length === 2 && (await texts(a, dm(a, b))).length === 2, 3000, 'both messages');
    assert.deepEqual((await texts(b, dm(b, a))).sort(), ['hello alice', 'hello bob']);
    await until(async () => (await a.messages(dm(a, b))).find((m) => m.mine).state === 'delivered', 3000, 'delivery receipt');
    assert.equal(a.safety(b.uidHex), b.safety(a.uidHex));
  } finally {
    net.stopAll();
  }
});

test('a stranger cannot connect without pairing', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const m = await net.node('mallory');
    const o = await a.rtc.offer();
    const ans = await m.rtc.answer(o.code);
    const rawA = await o.accept(ans.code);
    const rawM = await ans.link;
    await a.enqueue(() => void a.attachLink(rawA)); // not a pairing: must be an existing contact
    await m.enqueue(() => void m.attachLink(rawM, { pairing: true }));
    await sleep(300);
    assert.equal(a.links.size, 0);
    assert.equal(a.contacts.size, 0);
  } finally {
    net.stopAll();
  }
});

test('contact request, multi-hop relay through two strangers, then upgrade to direct', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const c = await net.node('charlie');
    const d = await net.node('david');
    const b = await net.node('bob');
    await net.pair(a, c);
    await net.pair(c, d);
    await net.pair(d, b);
    net.block('alice', 'bob'); // their NATs cannot be traversed for now

    // Alice only has Bob's contact link. The request travels alice > charlie > david > bob.
    let asked = null;
    b.on('request', (uid) => (asked = uid));
    await a.openLink(b.myLink());
    await until(() => asked === a.uidHex, 4000, 'contact request to arrive');
    assert.equal(b.contacts.get(a.uidHex).pending, 'in');
    await b.acceptRequest(a.uidHex);
    await until(() => a.reach(b.uidHex).state === 'relayed' && b.reach(a.uidHex).state === 'relayed', 4000, 'relayed route');
    assert.equal(a.reach(b.uidHex).hops, 3);
    assert.equal(a.contacts.get(b.uidHex).pending, null);

    await a.sendMessage(dm(a, b), { text: 'through the mesh' });
    await until(async () => (await texts(b, dm(b, a))).includes('through the mesh'), 3000, 'relayed message');
    await b.sendMessage(dm(b, a), { text: 'got it' });
    await until(async () => (await texts(a, dm(a, b))).includes('got it'), 3000, 'relayed reply');

    // The relays carried the traffic but hold no key for it.
    assert.ok(c.relays.size >= 1 && d.relays.size >= 1);
    assert.equal(c.spaces.has(dm(a, b)), false);
    assert.equal(d.spaces.has(dm(a, b)), false);
    assert.equal(a.links.size, 1);

    // A direct path becomes possible: the route is replaced by a direct link.
    net.unblock('alice', 'bob');
    await until(() => a.reach(b.uidHex).state === 'direct' && b.reach(a.uidHex).state === 'direct', 5000, 'direct upgrade');
    await until(() => ![...a.tunnels.values()].some((r) => r.peer && r.peer.uidHex === b.uidHex), 3000, 'tunnel closed');
    await a.sendMessage(dm(a, b), { text: 'now direct' });
    await until(async () => (await texts(b, dm(b, a))).includes('now direct'), 3000, 'direct message');
  } finally {
    net.stopAll();
  }
});

test('a mutual contact holds messages for an offline recipient', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice');
    let b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    await a.sendMessage(dm(a, b), { text: 'first' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'first message');

    net.stop('bob');
    await until(() => !a.uidOnline(b.uidHex), 3000, 'bob offline');
    await a.sendMessage(dm(a, b), { text: 'while you were away' });
    await until(() => c.courierTags.size === 1, 3000, 'carol to hold the message');
    await until(async () => (await a.messages(dm(a, b))).at(-1).state === 'held', 2000, 'held state');
    assert.equal(c.spaces.has(dm(a, b)), false, 'the courier has no key');
    net.stop('alice');

    // Bob comes back while Alice is gone. He only reaches Carol.
    b = await net.node('bob');
    await net.pair(b, c);
    await until(async () => (await texts(b, dm(b, a))).includes('while you were away'), 4000, 'message from the courier');
    assert.deepEqual(await texts(b, dm(b, a)), ['first', 'while you were away']);

    // Alice returns later and learns it was delivered.
    a = await net.node('alice');
    await net.pair(a, b);
    await until(async () => (await a.messages(dm(a, b))).at(-1).state === 'delivered', 4000, 'delivery receipt');
  } finally {
    net.stopAll();
  }
});

test('forged and replayed events are rejected', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    await a.sendMessage(dm(a, b), { text: 'real' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'message');
    const sp = b.spaces.get(dm(b, a));
    const row = (await b.store.range('events', sp.id + '|'))[0].value;
    const before = sp.rev;
    assert.equal(await b.enqueue(() => b.acceptEvent(sp, row.raw, row.sig)), null, 'replay');
    const bad = row.raw.slice();
    bad[bad.length - 1] ^= 1;
    assert.equal(await b.enqueue(() => b.acceptEvent(sp, bad, row.sig)), null, 'tampered');
    assert.equal(await b.enqueue(() => b.acceptEvent(sp, row.raw, rand(114))), null, 'bad signature');
    assert.equal(sp.rev, before);
    assert.equal(hex(row.raw).length > 0, true);
  } finally {
    net.stopAll();
  }
});

test('a dead link left behind by a crashed peer is detected and replaced', async () => {
  const net = new FakeNet();
  let crashed = null;
  try {
    let a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await net.pair(b, c);
    // Alice crashes: her wires go silent in both directions without closing, so
    // Bob and Carol are left holding links that look alive.
    for (const w of net.wires.filter((x) => x.a === 'alice' || x.b === 'alice')) {
      w.x.send = () => {};
      w.y.send = () => {};
    }
    crashed = a;
    a.stopped = true;
    net.nodes.delete('alice');
    assert.equal(b.reach(a.uidHex).state, 'direct', 'bob still believes in the dead link');
    await sleep(300);

    a = await net.node('alice');
    await net.pair(a, c);
    await until(() => a.reach(b.uidHex).state === 'direct' && b.reach(a.uidHex).state === 'direct', 5000, 'fresh direct link');
    await a.sendMessage(dm(a, b), { text: 'back again' });
    await until(async () => (await texts(b, dm(b, a))).includes('back again'), 3000, 'message over the new link');
  } finally {
    if (crashed) {
      crashed.stopped = false;
      crashed.stop();
    }
    net.stopAll();
  }
});
