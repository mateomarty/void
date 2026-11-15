// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, until, sleep, texts, dm } from './fakenet.js';
import { rand, hex } from '../../src/core/bytes.js';

const sys = async (node, id) => (await node.messages(id)).filter((m) => m.kind === 'sys').map((m) => m.text);

test('private group: members who are not contacts talk through the group, removal renews the key', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c); // bob and carol never pair
    const g = await a.createGroup('Trip', [b.uidHex, c.uidHex]);
    await until(() => b.spaces.has(g) && c.spaces.has(g), 3000, 'invitations');
    assert.equal(b.spaces.get(g).name, 'Trip');
    await until(() => b.members(g).length === 3 && c.members(g).length === 3, 3000, 'full roster everywhere');

    await b.sendMessage(g, { text: 'bob here' });
    await until(async () => (await texts(c, g)).includes('bob here'), 3000, 'bob to carol via alice');
    await c.sendMessage(g, { text: 'carol here' });
    await until(async () => (await texts(b, g)).includes('carol here') && (await texts(a, g)).length === 2, 3000, 'carol to bob via alice');
    assert.ok((await sys(c, g)).some((t) => t.includes('added you')));

    // Carol tries to remove Bob: she is not an admin, so nobody accepts it.
    await assert.rejects(c.groupRemove(g, b.uidHex), /admins/);

    const oldTag = hex(a.curKey(a.spaces.get(g)).tag);
    await a.groupRemove(g, c.uidHex);
    await until(() => b.spaces.get(g).keys.length === 2 && c.spaces.get(g).left, 3000, 'rekey and removal');
    assert.notEqual(hex(a.curKey(a.spaces.get(g)).tag), oldTag);
    assert.equal(hex(a.curKey(a.spaces.get(g)).key), hex(b.curKey(b.spaces.get(g)).key));
    assert.equal(c.spaces.get(g).keys.length, 1, 'the removed member never gets the new key');

    await a.sendMessage(g, { text: 'after removal' });
    await b.sendMessage(g, { text: 'bob after removal' });
    await until(async () => (await texts(b, g)).includes('after removal') && (await texts(a, g)).includes('bob after removal'), 3000, 'messages on the new key');
    await sleep(400);
    assert.equal((await texts(c, g)).includes('after removal'), false);
    await assert.rejects(c.sendMessage(g, { text: 'still here?' }));
  } finally {
    net.stopAll();
  }
});

test('a member who was offline during a rekey catches up', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    let b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    const g = await a.createGroup('Team', [b.uidHex, c.uidHex]);
    await until(() => b.spaces.has(g) && c.spaces.has(g), 3000, 'invitations');
    await until(() => Object.keys(b.spaces.get(g).vec).length >= 1, 3000, 'bob synced');
    net.stop('bob');
    await until(() => !a.uidOnline(b.uidHex), 3000, 'bob offline');
    await a.groupRemove(g, c.uidHex);
    await a.sendMessage(g, { text: 'new era' });
    b = await net.node('bob');
    assert.equal(b.spaces.get(g).keys.length, 1);
    await net.pair(a, b);
    await until(async () => (await texts(b, g)).includes('new era'), 4000, 'bob to catch up past the rekey');
    assert.equal(b.spaces.get(g).keys.length, 2);
  } finally {
    net.stopAll();
  }
});

test('open group joined by link', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    const g = await a.createGroup('Public square', [], { open: true });
    await a.sendMessage(g, { text: 'welcome' });
    const link = a.spaceInfo(g).link;
    assert.match(link, /^void:g:/);
    const res = await b.openLink(link);
    assert.equal(res.id, g);
    await until(async () => (await texts(b, g)).includes('welcome'), 4000, 'history after joining');
    await until(() => a.members(g).length === 2, 3000, 'alice sees bob as a member');
    await b.sendMessage(g, { text: 'hi all' });
    await until(async () => (await texts(a, g)).includes('hi all'), 3000, 'bob posts');
  } finally {
    net.stopAll();
  }
});

test('channel: only the owner posts, subscribers pass posts on to each other', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const d = await net.node('dave');
    await net.pair(a, b);
    await net.pair(b, d); // dave does not know alice at all
    net.block('alice', 'dave');
    const ch = await a.createChannel('News');
    await a.sendMessage(ch, { text: 'post 1' });
    await a.sendMessage(ch, { text: 'post 2' });
    const link = a.spaceInfo(ch).link;

    await b.openLink(link);
    await until(async () => (await texts(b, ch)).length === 2, 4000, 'bob gets the history from alice');
    assert.equal(b.chats().find((x) => x.id === ch).canPost, false);
    await assert.rejects(b.sendMessage(ch, { text: 'i am not the owner' }), /owner/);

    await d.openLink(link);
    await until(async () => (await texts(d, ch)).length === 2, 4000, 'dave gets the history from bob');
    assert.equal(d.contacts.has(a.uidHex), false);

    await a.sendMessage(ch, { text: 'post 3' });
    await until(async () => (await texts(d, ch)).includes('post 3'), 4000, 'new post reaches dave through bob');
    assert.equal(d.spaces.get(ch).name, 'News');

    // A forged post signed by someone else is refused by subscribers.
    const sp = b.spaces.get(ch);
    const before = sp.rev;
    await assert.rejects(b.enqueue(() => b.post(sp, 'msg', { x: 'forged' })));
    assert.equal(sp.rev, before);
  } finally {
    net.stopAll();
  }
});

test('private channel needs the key from the link', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    const ch = await a.createChannel('Insiders', { isPublic: false });
    await a.sendMessage(ch, { text: 'secret post' });
    const link = a.spaceInfo(ch).link;
    await b.openLink(link);
    await until(async () => (await texts(b, ch)).includes('secret post'), 4000, 'private channel sync');
    assert.equal(hex(b.curKey(b.spaces.get(ch)).key), hex(a.curKey(a.spaces.get(ch)).key));
  } finally {
    net.stopAll();
  }
});

test('second device: restore a backup, then contacts, groups and history sync', async () => {
  const net = new FakeNet();
  try {
    const a1 = await net.node('alice-laptop', {}, 'alice');
    const b = await net.node('bob');
    await net.pair(a1, b);
    await a1.sendMessage(dm(a1, b), { text: 'from the laptop' });
    const g = await a1.createGroup('Family', [b.uidHex]);
    await until(() => b.spaces.has(g), 3000, 'group invite');

    const backup = a1.exportBackup('long passphrase');
    const { VoidNode } = await import('../../src/core/node.js');
    const { MemStore } = await import('../../src/core/store.js');
    const { FAST } = await import('./fakenet.js');
    const a2 = new VoidNode({ store: new MemStore(), rtc: net.rtc('alice-phone'), cfg: FAST, name: 'alice-phone' });
    await assert.rejects(a2.restoreBackup(backup, 'wrong'), /passphrase/);
    await a2.restoreBackup(backup, 'long passphrase');
    net.nodes.set('alice-phone', a2);
    assert.equal(a2.uidHex, a1.uidHex);
    assert.notEqual(a2.devHex, a1.devHex);
    assert.ok(a2.contacts.has(b.uidHex) && a2.spaces.has(g));

    await net.pair(a1, a2); // the two devices of alice link up
    await until(async () => (await texts(a2, dm(a2, b))).includes('from the laptop'), 4000, 'history on the phone');

    // New contact added on the laptop shows up on the phone.
    const c = await net.node('carol');
    await net.pair(a1, c);
    await until(() => a2.contacts.has(c.uidHex), 4000, 'contact synced to the phone');

    // Bob writes: both devices get it. The phone answers through the laptop.
    await b.sendMessage(dm(b, a1), { text: 'hello both' });
    await until(async () => (await texts(a2, dm(a2, b))).includes('hello both') && (await texts(a1, dm(a1, b))).includes('hello both'), 4000, 'fan-out to both devices');
    await a2.sendMessage(dm(a2, b), { text: 'from the phone' });
    await until(async () => (await texts(b, dm(b, a1))).includes('from the phone'), 4000, 'phone message reaches bob');
    assert.deepEqual(await texts(a1, dm(a1, b)), await texts(a2, dm(a2, b)));
  } finally {
    net.stopAll();
  }
});

test('attachments: direct transfer, relayed transfer, corruption is detected', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    const data = rand(65536 * 3 + 123);
    const att = await a.addBlob(data, { name: 'photo.jpg', mime: 'image/jpeg', kind: 'image' });
    await a.sendMessage(dm(a, b), { text: 'look', att: [att] });
    await until(async () => (await b.messages(dm(b, a))).length === 1, 3000, 'message with attachment');
    const got = (await b.messages(dm(b, a)))[0].att[0];
    assert.equal(got.name, 'photo.jpg');
    assert.equal(got.size, data.length);
    assert.equal(await b.hasBlob(got.id), false);
    await b.fetchBlob(dm(b, a), got);
    assert.equal(hex(await b.blobBytes(got)), hex(data));

    // Relayed: carol only knows bob, and is in a group with alice and bob.
    await net.pair(b, c);
    net.block('alice', 'carol');
    const g = await b.createGroup('Three', [a.uidHex, c.uidHex]);
    await until(() => a.spaces.has(g) && c.spaces.has(g), 3000, 'group');
    const att2 = await a.addBlob(rand(50000), { name: 'doc.pdf' });
    await a.sendMessage(g, { text: 'file', att: [att2] });
    await until(async () => (await c.messages(g)).some((m) => m.kind === 'msg'), 3000, 'group message at carol');
    const got2 = (await c.messages(g)).find((m) => m.kind === 'msg').att[0];
    // Bob has not downloaded it, so carol must reach alice. They are not contacts
    // and cannot connect directly: the bytes travel through a tunnel via bob.
    assert.equal(c.uidOnline(a.uidHex), false);
    await c.fetchBlob(g, got2);
    assert.equal(c.reach(a.uidHex).state, 'relayed');
    assert.equal((await c.blobBytes(got2)).length, 50000);
    assert.ok(b.relays.size >= 1);

    // A holder that serves altered ciphertext is caught by the content hash.
    const att3 = await a.addBlob(rand(40000), { name: 'x.bin' });
    const key = `c|${hex(att3.i)}|0000000`;
    const chunk = (await a.store.get('blobs', key)).slice();
    chunk[5] ^= 1;
    await a.store.put('blobs', key, chunk);
    await a.sendMessage(dm(a, b), { text: 'bad', att: [att3] });
    await until(async () => (await b.messages(dm(b, a))).some((m) => m.text === 'bad'), 3000, 'second message');
    const got3 = (await b.messages(dm(b, a))).find((m) => m.text === 'bad').att[0];
    await assert.rejects(b.fetchBlob(dm(b, a), got3), /corrupted/);
    assert.equal(await b.hasBlob(got3.id), false);
  } finally {
    net.stopAll();
  }
});

test('edits and deletions', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    const id = await a.sendMessage(dm(a, b), { text: 'typo' });
    const id2 = await a.sendMessage(dm(a, b), { text: 'oops' });
    await a.editMessage(dm(a, b), id, 'fixed');
    await a.deleteMessage(dm(a, b), id2);
    await until(async () => {
      const list = await b.messages(dm(b, a));
      return list.length === 2 && list[0].text === 'fixed' && list[0].edited && list[1].deleted;
    }, 3000, 'edit and delete applied at bob');
    // Bob cannot edit Alice's message: his edit event is stored but has no effect.
    await b.editMessage(dm(b, a), id, 'hacked');
    await sleep(200);
    assert.equal((await a.messages(dm(a, b)))[0].text, 'fixed');
  } finally {
    net.stopAll();
  }
});
