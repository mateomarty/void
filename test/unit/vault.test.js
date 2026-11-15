// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeNet, until, texts, dm } from './fakenet.js';
import { MemStore } from '../../src/core/store.js';
import { VoidNode } from '../../src/core/node.js';
import { createVault, openVault, wrapVault, VaultStore, migratePlain } from '../../src/core/vault.js';
import { rand, hex, utf8, concat } from '../../src/core/bytes.js';

const LIGHT = [{ N: 2 ** 14, r: 8, p: 1 }];

test('the password opens the vault, a wrong one does not, and it can be changed', async () => {
  const { masterKey, header } = await createVault('correct horse', LIGHT);
  assert.equal(hex(await openVault(header, 'correct horse')), hex(masterKey));
  await assert.rejects(openVault(header, 'correct horsf'), /Wrong password/);
  await assert.rejects(openVault(header, ''), /Wrong password/);
  await assert.rejects(createVault('short', LIGHT), /at least 8/);
  const changed = await wrapVault(masterKey, 'a new password', LIGHT);
  await assert.rejects(openVault(changed, 'correct horse'), /Wrong password/);
  assert.equal(hex(await openVault(changed, 'a new password')), hex(masterKey));
  const tampered = { ...header, wrap: header.wrap.slice() };
  tampered.wrap[30] ^= 1;
  await assert.rejects(openVault(tampered, 'correct horse'), /Wrong password/);
  await assert.rejects(openVault({ v: 1 }, 'x'), /damaged/);
  // A device that cannot afford the first setting falls back to the next one.
  const fallback = await createVault('correct horse', [{ N: 2 ** 30, r: 8, p: 1 }, ...LIGHT]);
  assert.equal(fallback.header.kdf.N, 2 ** 14);
  // The default setting is the strong one.
  assert.equal((await createVault('correct horse')).header.kdf.N, 2 ** 17);
});

test('the vault store gives the same answers as a plain store', async () => {
  const plain = new MemStore();
  const vault = new VaultStore(new MemStore(), rand(32));
  const sp = [hex(rand(16)), hex(rand(16))];
  const feed = [hex(rand(40)), hex(rand(40))];
  const keys = [];
  for (const s of sp) for (const f of feed) for (let q = 1; q <= 12; q++) keys.push(`${s}|${f}|${String(q).padStart(10, '0')}`);
  for (const key of keys) {
    const value = { raw: rand(20), q: Number(key.slice(-10)), note: 'héllo', deep: { list: [1, null, true, 'x'], bytes: rand(3) } };
    await plain.put('events', key, value);
    await vault.put('events', key, value);
  }
  const blob = hex(rand(32));
  for (let i = 0; i < 5; i++) {
    const key = `c|${blob}|${String(i).padStart(7, '0')}`;
    await plain.put('blobs', key, Uint8Array.of(i, i, i));
    await vault.put('blobs', key, Uint8Array.of(i, i, i));
  }
  // Decoded records are plain data without a prototype; compare by content.
  const canon = (x) => {
    if (x instanceof Uint8Array) return 'bytes:' + hex(x);
    if (Array.isArray(x)) return x.map(canon);
    if (x && typeof x === 'object') return Object.keys(x).sort().map((k) => [k, canon(x[k])]);
    return x;
  };
  const flat = (v) => JSON.stringify(canon(v));
  const same = (a, b) => assert.equal(flat(a.map((r) => r.value)), flat(b.map((r) => r.value)));
  same(await vault.range('events', `${sp[0]}|${feed[1]}|`), await plain.range('events', `${sp[0]}|${feed[1]}|`));
  same(await vault.range('events', `${sp[0]}|${feed[1]}|`, 3, true), await plain.range('events', `${sp[0]}|${feed[1]}|`, 3, true));
  same(await vault.between('events', `${sp[1]}|${feed[0]}|0000000004`, `${sp[1]}|${feed[0]}|0000000009`), await plain.between('events', `${sp[1]}|${feed[0]}|0000000004`, `${sp[1]}|${feed[0]}|0000000009`));
  assert.equal((await vault.range('events', sp[0] + '|')).length, 24);
  assert.equal((await vault.range('events')).length, 48);
  same(await vault.range('blobs', `c|${blob}|`), await plain.range('blobs', `c|${blob}|`));
  assert.equal(flat(await vault.get('events', keys[5])), flat(await plain.get('events', keys[5])));
  assert.equal(await vault.get('events', 'missing|key'), undefined);
  await vault.del('events', keys[0]);
  assert.equal(await vault.get('events', keys[0]), undefined);
  await vault.delRange('blobs', `c|${blob}|`);
  assert.equal((await vault.range('blobs')).length, 0);
});

test('a stored record cannot be read without the key, altered, or moved', async () => {
  const inner = new MemStore();
  const key = rand(32);
  const vault = new VaultStore(inner, key);
  await vault.put('contacts', 'aa', { name: 'Alice' });
  await vault.put('contacts', 'bb', { name: 'Bob' });
  assert.equal((await inner.range('contacts')).length, 2);
  assert.equal((await vault.get('contacts', 'bb')).name, 'Bob');
  // moved: the sealed value of Bob's record placed under Alice's name
  await inner.put('contacts', vault.k('aa'), await inner.get('contacts', vault.k('bb')));
  await assert.rejects(vault.get('contacts', 'aa'));
  await assert.rejects(vault.range('contacts'));
  // altered: one bit of a sealed value flipped
  const box = (await inner.get('contacts', vault.k('bb'))).slice();
  box[box.length - 1] ^= 1;
  await inner.put('contacts', vault.k('bb'), box);
  await assert.rejects(vault.get('contacts', 'bb'));
  // another password's vault sees nothing it can open
  const other = new VaultStore(inner, rand(32));
  assert.equal(await other.get('contacts', 'bb'), undefined);
  await assert.rejects(other.range('contacts'));
});

test('nothing readable reaches the disk', async () => {
  const net = new FakeNet();
  try {
    const a = await net.node('alice', {}, 'Alice Liddell');
    const b = await net.node('bob', {}, 'Robert Tables');
    await net.pair(a, b);
    await a.sendMessage(dm(a, b), { text: 'the launch code is 0451' });
    await b.sendMessage(dm(b, a), { text: 'understood, burning this message' });
    const g = await a.createGroup('Secret plans', [b.uidHex]);
    await a.sendMessage(g, { text: 'meet at the old mill' });
    const secretFile = utf8('PLAINTEXT-ATTACHMENT-'.repeat(200));
    const att = await a.addBlob(secretFile, { name: 'treasure-map.txt', mime: 'text/plain' });
    await a.sendMessage(dm(a, b), { text: 'see attached', att: [att] });
    await until(async () => (await texts(b, dm(b, a))).length === 3 && (await texts(b, g)).length === 1, 4000, 'messages');
    await a.saveSettings({ stunServers: ['stun:private.example.org:3478'] });
    await a.enqueue(() => {}); // let the last writes land

    const disk = net.stores.get('alice').inner;
    let records = 0;
    const everything = [];
    for (const [bucket, map] of disk.buckets) {
      for (const [key, value] of map) {
        records++;
        assert.ok(value instanceof Uint8Array, `${bucket}/${key} is stored as ciphertext`);
        everything.push(utf8(bucket + '|' + key + '|'), value);
      }
    }
    assert.ok(records >= 12, `the scenario wrote a realistic amount of data (${records} records)`);
    const dump = Buffer.from(concat(...everything));
    const mustNotAppear = [
      'Alice Liddell', 'Robert Tables', 'launch code', 'burning this message', 'Secret plans', 'old mill', 'treasure-map',
      'PLAINTEXT-ATTACHMENT', 'private.example.org', 'see attached', 'void/v1',
      a.uidHex, b.uidHex, a.devHex, dm(a, b), g, hex(att.i),
    ];
    for (const text of mustNotAppear) assert.equal(dump.includes(text), false, `"${text.slice(0, 24)}" is readable on disk`);
    for (const bytes of [a.id.seed, a.id.edSk, a.id.dhSk, a.id.uid, b.id.uid, a.id.selfKey, att.k, att.i, a.curKey(a.spaces.get(g)).key, a.curKey(a.spaces.get(dm(a, b))).key]) {
      assert.equal(dump.includes(Buffer.from(bytes)), false, 'key material is readable on disk');
    }
    // ... and with the key everything is still there after a restart.
    net.stop('alice');
    const again = await net.node('alice');
    assert.equal(again.uidHex, a.uidHex);
    assert.deepEqual(await texts(again, g), ['meet at the old mill']);
    assert.equal(hex(await again.blobBytes({ id: hex(att.i), key: att.k })), hex(secretFile));
  } finally {
    net.stopAll();
  }
});

test('a profile stored without encryption moves into the vault intact', async () => {
  const net = new FakeNet();
  try {
    const plain = new MemStore();
    net.stores.set('alice', plain); // alice runs an old version: no vault
    let a = await net.node('alice');
    const b = await net.node('bob');
    const c = await net.node('carol');
    await net.pair(a, b);
    await net.pair(a, c);
    await a.sendMessage(dm(a, b), { text: 'written before encryption existed' });
    await until(async () => (await texts(b, dm(b, a))).length === 1, 3000, 'message');
    // carol goes offline and bob leaves her a message with alice, in the old record format
    net.stop('carol');
    await net.pair(b, await net.node('carol'));
    net.stop('carol');
    await until(() => !b.uidOnline(c.uidHex), 3000, 'carol offline');
    await b.sendMessage(dm(b, c), { text: 'for carol' });
    await until(() => a.courierTags.size === 1, 3000, 'alice holds mail');
    for (const [key, value] of plain.bucket('courier')) plain.bucket('courier').set(key, { f: value.f, exp: value.exp, from: value.from });
    const uid = a.uidHex;
    net.stop('alice');

    const { masterKey, header } = await createVault('a long password', LIGHT);
    const disk = new MemStore();
    const vault = new VaultStore(disk, masterKey);
    assert.ok((await migratePlain(plain, vault)) > 5);
    net.stores.set('alice', new VaultStore(disk, await openVault(header, 'a long password')));
    a = await net.node('alice');
    assert.equal(a.uidHex, uid);
    assert.ok(a.contacts.has(b.uidHex));
    assert.deepEqual(await texts(a, dm(a, b)), ['written before encryption existed']);
    assert.equal(a.courierTags.size, 1, 'held mail survived the move');
    for (const map of disk.buckets.values()) for (const value of map.values()) assert.ok(value instanceof Uint8Array);
    assert.ok(a instanceof VoidNode);
  } finally {
    net.stopAll();
  }
});
