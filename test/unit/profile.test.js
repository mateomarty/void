// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, until, sleep, texts, dm } from './fakenet.js';
import { rand, hex } from '../../src/core/bytes.js';

const sys = async (node, id) => (await node.messages(id)).filter((m) => m.kind === 'sys').map((m) => m.text);

test('photos and bios reach contacts and group members; group and channel photos reach everyone', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    const photo = rand(4000);
    await a.setProfile({ av: photo, bio: 'Tea, maps and long walks' });
    await until(() => b.avatarOf(a.uidHex) && hex(b.avatarOf(a.uidHex)) === hex(photo), 3000, 'photo at bob');
    assert.equal(b.bioOf(a.uidHex), 'Tea, maps and long walks');
    assert.equal(hex(b.avatarOf(dm(b, a))), hex(photo), 'the conversation shows the contact photo');

    // A contact made later gets the profile too, and so does a group member who is not a contact.
    await net.pair(a, c);
    await until(() => c.avatarOf(a.uidHex), 3000, 'photo at a new contact');
    const g = await b.createGroup('Hikers', [a.uidHex]);
    await until(() => a.spaces.has(g), 3000, 'group');
    await b.setProfile({ bio: 'Bob in the group' });
    await net.pair(b, c);
    await b.groupAdd(g, c.uidHex);
    await until(() => c.spaces.has(g) && c.bioOf(a.uidHex) === 'Tea, maps and long walks', 3000, 'profiles through the group');

    // Too large a photo is refused by everyone.
    await a.setProfile({ av: rand(30000) });
    await sleep(200);
    assert.equal(a.avatarOf(a.uidHex), null);

    const gp = rand(3000);
    await b.setSpaceMeta(g, { name: 'Mountain hikers', about: 'Every Sunday', av: gp });
    await until(() => a.spaces.get(g).name === 'Mountain hikers' && a.avatarOf(g) && hex(a.avatarOf(g)) === hex(gp), 3000, 'group photo and name');
    assert.equal(a.spaceInfo(g).about, 'Every Sunday');
    assert.ok((await sys(a, g)).some((t) => t.includes('changed the group photo')));
    await assert.rejects(a.setSpaceMeta(g, { name: 'Hijacked' }), /event/i, 'a plain member cannot rename the group');

    const ch = await a.createChannel('Alice daily');
    const cp = rand(2500);
    await a.setSpaceMeta(ch, { av: cp, about: 'One post a day' });
    await b.openLink(a.spaceInfo(ch).link);
    await until(() => b.avatarOf(ch) && hex(b.avatarOf(ch)) === hex(cp), 4000, 'channel photo');
  } finally {
    net.stopAll();
  }
});

test('local name, mute and block', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    await a.setAlias(b.uidHex, 'Bobby from work');
    assert.equal(a.nameOf(b.uidHex), 'Bobby from work');
    assert.equal(a.chats()[0].title, 'Bobby from work');
    assert.equal(b.nameOf(a.uidHex), 'alice', 'a local name stays local');

    let notified = 0;
    a.on('notify', () => notified++);
    await b.sendMessage(dm(b, a), { text: 'one' });
    await until(() => notified === 1, 3000, 'notification');
    await a.setMuted(dm(a, b), true);
    await b.sendMessage(dm(b, a), { text: 'two' });
    await until(async () => (await texts(a, dm(a, b))).length === 2, 3000, 'second message');
    assert.equal(notified, 1, 'a muted conversation does not notify');
    assert.equal(a.chats()[0].unread, 2);

    await a.setBlocked(b.uidHex, true);
    await until(() => a.links.size === 0 && !a.uidOnline(b.uidHex), 3000, 'link closed');
    await b.sendMessage(dm(b, a), { text: 'are you there' });
    await sleep(600);
    assert.equal(a.links.size, 0, 'a blocked contact cannot reconnect');
    assert.equal((await texts(a, dm(a, b))).length, 2);
    assert.equal(a.chats()[0].canPost, false);
    assert.ok(a.contacts.get(b.uidHex).seen > 0, 'last seen was recorded');
    await a.setBlocked(b.uidHex, false);
    await net.pair(a, b);
    await until(async () => (await texts(a, dm(a, b))).includes('are you there'), 3000, 'unblocked');
  } finally {
    net.stopAll();
  }
});

test('a scheduled message is sent when its time comes, survives a restart, and can be cancelled', async () => {
  const net = new FakeNet();
  try {
    let a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    await assert.rejects(a.scheduleMessage(dm(a, b), 'too late', Date.now() - 1000), /future/);
    await a.scheduleMessage(dm(a, b), 'soon', Date.now() + 250);
    const later = await a.scheduleMessage(dm(a, b), 'never', Date.now() + 60000);
    const afterRestart = await a.scheduleMessage(dm(a, b), 'after a restart', Date.now() + 700);
    assert.equal(a.scheduledFor(dm(a, b)).length, 3);
    assert.equal((await texts(b, dm(b, a))).length, 0);
    await until(async () => (await texts(b, dm(b, a))).includes('soon'), 3000, 'scheduled delivery');
    await a.cancelScheduled(later);
    net.stop('alice');
    await sleep(900); // its time passes while alice is closed
    a = await net.node('alice');
    assert.ok(afterRestart);
    await net.pair(a, b);
    await until(async () => (await texts(b, dm(b, a))).includes('after a restart'), 3000, 'sent at the next opening');
    assert.equal(a.scheduledFor(dm(a, b)).length, 0);
    assert.equal((await texts(b, dm(b, a))).includes('never'), false);
  } finally {
    net.stopAll();
  }
});

test('self-deleting messages are removed from storage on both sides, and a device that missed them moves on', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    let b = await net.node('bob');
    await net.pair(a, b);
    const att = await a.addBlob(rand(5000), { name: 'secret.pdf' });
    await a.sendMessage(dm(a, b), { text: 'kept forever' });
    const sp = a.spaces.get(dm(a, b));
    // The timer is set to 60 s; the test moves both clocks instead of waiting.
    await a.setAutoDelete(dm(a, b), 60);
    await until(() => b.spaces.get(dm(b, a)).ttl === 60, 3000, 'timer at bob');
    assert.ok((await sys(b, dm(b, a))).some((t) => t.includes('delete themselves after 1 minute')));
    await a.sendMessage(dm(a, b), { text: 'gone in a minute', att: [att] });
    await until(async () => (await texts(b, dm(b, a))).length === 2, 3000, 'messages at bob');
    await b.fetchBlob(dm(b, a), (await b.messages(dm(b, a))).find((m) => m.att && m.att.length).att[0]);

    net.stop('bob'); // bob is away while more messages come and go
    await a.sendMessage(dm(a, b), { text: 'bob never sees this one' });
    const skew = 120000;
    a.now = () => Date.now() + skew;
    await a.enqueue(() => a.purgeExpired());
    assert.deepEqual(await texts(a, dm(a, b)), [], 'alice kept expired messages');
    assert.equal(await a.hasBlob(hex(att.i)), false, 'the attachment was kept');
    const left = (await a.store.range('events', sp.id + '|')).map((r) => r.value.k);
    assert.ok(left.includes('ttl') && !left.includes('msg'), 'only messages are removed');

    await a.sendMessage(dm(a, b), { text: 'after the gap' });
    b = await net.node('bob');
    b.now = () => Date.now() + skew;
    await net.pair(a, b);
    await until(async () => (await texts(b, dm(b, a))).includes('after the gap'), 4000, 'bob moves past what expired');
    await b.enqueue(() => b.purgeExpired());
    assert.deepEqual(await texts(b, dm(b, a)), ['after the gap']);
    assert.equal(await b.hasBlob(hex(att.i)), false);

    // Without a timer a gap is never accepted.
    await a.setAutoDelete(dm(a, b), 0);
    await until(() => b.spaces.get(dm(b, a)).ttl === 0, 3000, 'timer off');
  } finally {
    net.stopAll();
  }
});

test('shared media, groups in common and export', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice');
    const b = await net.node('bob');
    await net.pair(a, b);
    const g = await a.createGroup('Both', [b.uidHex]);
    await until(() => b.spaces.has(g), 3000, 'group');
    const pic = await a.addBlob(rand(900), { name: 'beach.jpg', mime: 'image/jpeg', kind: 'image' });
    const doc = await a.addBlob(rand(900), { name: 'notes.txt' });
    await a.sendMessage(dm(a, b), { text: 'see https://example.org/a and https://example.org/b', att: [pic] });
    await a.sendMessage(dm(a, b), { att: [doc] });
    const id = await a.sendMessage(dm(a, b), { text: 'tpyo' });
    await a.editMessage(dm(a, b), id, 'typo');
    const m = await a.media(dm(a, b));
    assert.deepEqual([m.photos.length, m.files.length, m.links.length, m.voice.length, m.videos.length], [1, 1, 2, 0, 0]);
    assert.deepEqual(a.commonGroups(b.uidHex).map((x) => x.name), ['Both']);
    const text = await a.exportChat(dm(a, b));
    assert.match(text, /Void conversation: bob/);
    assert.match(text, /alice: see https:\/\/example\.org\/a and https:\/\/example\.org\/b \[image: beach\.jpg\]/);
    assert.match(text, /alice: typo \(edited\)/);
  } finally {
    net.stopAll();
  }
});
