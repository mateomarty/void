// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, until, sleep, texts, dm } from './fakenet.js';
import { rand, hex, concat } from '../../src/core/bytes.js';
import { seal } from '../../src/core/crypto.js';
import * as cbor from '../../src/core/cbor.js';

const RDV = { rdv: true };

test('after a restart, contacts find each other again with no exchange of codes', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice', {}, 'alice', RDV);
    let b = await net.node('bob', {}, 'bob', RDV);
    let c = await net.node('carol', {}, 'carol', RDV);
    await net.pair(a, b);
    await net.pair(a, c);
    await a.sendMessage(dm(a, b), { text: 'before the restart' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'first message');
    for (const name of ['alice', 'bob', 'carol']) net.stop(name);
    await sleep(100);
    const wiresBefore = net.wires.length;

    a = await net.node('alice', {}, 'alice', RDV);
    b = await net.node('bob', {}, 'bob', RDV);
    c = await net.node('carol', {}, 'carol', RDV);
    assert.equal(a.links.size, 0);
    await until(() => a.reach(b.uidHex).state === 'direct' && a.reach(c.uidHex).state === 'direct', 5000, 'automatic reconnection');
    assert.equal(net.wires.length - wiresBefore, 2, 'one new link per contact, no duplicates');
    await b.sendMessage(dm(b, a), { text: 'found you' });
    await until(async () => (await texts(a, dm(a, b))).includes('found you'), 3000, 'message after reconnection');

    // What the notice board was shown: opaque topics and sealed notes, nothing else.
    assert.ok(net.board.log.length >= 3);
    const dump = Buffer.from(concat(...net.board.log.map((n) => n.bytes)));
    for (const bytes of [a.id.uid, b.id.uid, c.id.uid, a.id.dev, b.id.dev]) assert.equal(dump.includes(Buffer.from(bytes)), false, 'an identifier is readable on the board');
    const topics = new Set(net.board.log.map((n) => n.topic));
    for (const t of topics) assert.match(t, /^[0-9a-f]{32}$/);
    for (const sp of a.spaces.values()) for (const k of sp.keys) assert.equal(topics.has(hex(k.tag)), false, 'a rendezvous topic equals a routing tag');
  } finally {
    net.stopAll();
  }
});

test('a contact who comes online later is found, and a second device too', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice', {}, 'alice', RDV);
    let b = await net.node('bob', {}, 'bob', RDV);
    await net.pair(a, b);
    const backup = a.exportBackup('long passphrase');
    net.stop('alice');
    net.stop('bob');

    a = await net.node('alice', {}, 'alice', RDV);
    await sleep(400); // alice says hello a few times; nobody is there
    assert.equal(a.links.size, 0);
    b = await net.node('bob', {}, 'bob', RDV);
    await until(() => b.reach(a.uidHex).state === 'direct', 5000, 'bob finds alice when he arrives');

    // Alice restores her backup on a phone: her two devices meet through her own key.
    const phone = await net.node('alice-phone', {}, 'alice', RDV);
    net.stop('alice-phone');
    net.stores.delete('alice-phone');
    const { VoidNode } = await import('../../src/core/node.js');
    const { MemStore } = await import('../../src/core/store.js');
    const { FAST } = await import('./fakenet.js');
    const p = new VoidNode({ store: new MemStore(), rtc: net.rtc('alice-phone'), rdv: net.board.join(), defaults: { stun: false, rdv: true }, cfg: FAST, name: 'alice-phone' });
    await p.restoreBackup(backup, 'long passphrase');
    net.nodes.set('alice-phone', p);
    assert.equal(p.uidHex, a.uidHex);
    assert.ok(phone);
    await until(() => p.linkByDev.has(a.devKey) && p.reach(b.uidHex).state === 'direct', 5000, 'the phone finds the laptop and bob');
  } finally {
    net.stopAll();
  }
});

test('notes from strangers, forgeries and replays do nothing', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice', {}, 'alice', RDV);
    const b = await net.node('bob', {}, 'bob', RDV);
    await net.pair(a, b);
    await sleep(300);
    net.stop('bob');
    await until(() => a.links.size === 0, 3000, 'bob gone');
    await until(() => net.board.log.some((n) => a.rdvTopics.has(n.topic)), 3000, 'alice says hello');
    const topic = [...a.rdvTopics.keys()].find((t) => a.rdvTopics.get(t).uid === b.uidHex);
    const mallory = net.board.join();
    mallory.configure(['x']);
    const offersBefore = net.offers.size;
    // garbage, a well-formed hello sealed with the wrong key, and a replay of alice's own note
    mallory.publish(topic, rand(200));
    mallory.publish(topic, seal(rand(32), cbor.encode({ t: 1, u: b.id.uid, d: rand(8), ts: Date.now() }), rand(16)));
    const own = net.board.log.find((n) => n.topic === topic);
    mallory.publish(topic, own.bytes);
    mallory.publish(topic, own.bytes);
    await sleep(400);
    assert.equal(net.offers.size, offersBefore, 'nothing made alice prepare a connection');
    assert.equal(a.links.size, 0);
    assert.equal(a.pendingSig.size, 0);
  } finally {
    net.stopAll();
  }
});

test('with the setting off nothing is posted; when a direct path is impossible the attempts back off', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice', {}, 'alice', RDV);
    let b = await net.node('bob', {}, 'bob', RDV);
    await net.pair(a, b);
    await a.saveSettings({ rdv: false });
    net.stop('alice');
    net.stop('bob');
    const before = net.board.log.length;
    a = await net.node('alice', {}, 'alice', RDV); // the stored setting wins over the default
    assert.equal(a.settings.rdv, false);
    b = await net.node('bob', {}, 'bob', RDV);
    await sleep(500);
    assert.equal(a.links.size, 0);
    assert.equal(net.board.log.slice(before).filter((n) => n.from === 'alice').length, 0, 'alice posted nothing');
    assert.ok(net.board.log.slice(before).some((n) => n.from === 'bob'), 'bob, who left it on, did');
    assert.equal(a.rdvTopics, null, 'alice never computed a topic');

    // Alice turns it back on, but their networks cannot be traversed.
    net.block('alice', 'bob');
    await a.saveSettings({ rdv: true });
    await sleep(1500);
    assert.equal(a.links.size, 0);
    assert.ok(net.offers.size <= 6, `attempts stay rare (${net.offers.size})`);
    net.unblock('alice', 'bob');
    await until(() => a.reach(b.uidHex).state === 'direct', 6000, 'reconnection once a path exists');
  } finally {
    net.stopAll();
  }
});

test('an invite link makes two strangers contacts with nothing to send back, even if the inviter is away when it is opened', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice', {}, 'alice', RDV);
    const link = await a.createInviteLink();
    assert.match(link, /^void:u:/);
    assert.equal(a.openInvites(), 1);
    net.stop('alice'); // alice sends the link and closes Void

    const b = await net.node('bob', {}, 'bob', RDV);
    const res = await b.openLink(link); // bob opens it hours later, alice is not there
    assert.equal(res.kind, 'contact');
    assert.equal(b.contacts.get(a.uidHex).pending, 'out');
    await sleep(500);
    assert.equal(b.links.size, 0);

    a = await net.node('alice', {}, 'alice', RDV); // alice comes back
    let joined = null;
    a.on('joined', (uid) => (joined = uid));
    await until(() => a.reach(b.uidHex).state === 'direct' && b.reach(a.uidHex).state === 'direct', 6000, 'contacts and connected');
    assert.equal(joined, b.uidHex);
    assert.equal(a.contacts.get(b.uidHex).pending, null);
    assert.equal(b.contacts.get(a.uidHex).pending, null);
    assert.equal(a.openInvites(), 0, 'the link is used up');
    await b.sendMessage(dm(b, a), { text: 'thanks for the invite' });
    await until(async () => (await texts(a, dm(a, b))).includes('thanks for the invite'), 3000, 'first message');

    // The same link in other hands only produces an ordinary request to approve.
    const c = await net.node('carol', {}, 'carol', RDV);
    await c.openLink(link);
    await until(() => a.contacts.has(c.uidHex), 4000, 'request from carol');
    assert.equal(a.contacts.get(c.uidHex).pending, 'in');
    assert.equal(a.reach(c.uidHex).state, 'offline');
    await a.acceptRequest(c.uidHex);
    await until(() => a.reach(c.uidHex).state === 'direct', 6000, 'connected after approval');

    // With requests off and no invite pending, nothing gets through.
    const d = await net.node('dave', {}, 'dave', RDV);
    await a.saveSettings({ requests: false });
    await d.openLink(a.myLink());
    await sleep(700);
    assert.equal(a.contacts.has(d.uidHex), false);
    // ... but a fresh invite still does.
    const e = await net.node('erin', {}, 'erin', RDV);
    await e.openLink(await a.createInviteLink());
    await until(() => a.reach(e.uidHex).state === 'direct', 6000, 'invite works with requests off');
  } finally {
    net.stopAll();
  }
});
