// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { CipherSuite, HkdfSha512 } from '@hpke/core';
import { DhkemX448HkdfSha512 } from '@hpke/dhkem-x448';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';

import { b64u, unb64u, hex, unhex, utf8, text, rand, eq } from '../../src/core/bytes.js';
import * as cbor from '../../src/core/cbor.js';
import * as c from '../../src/core/crypto.js';
import * as keys from '../../src/core/keys.js';

test('base64url and hex round-trip for every length', () => {
  for (let n = 0; n < 70; n++) {
    const b = rand(n);
    assert.ok(eq(unb64u(b64u(b)), b) || n === 0);
    assert.equal(b64u(b), Buffer.from(b).toString('base64url'));
    assert.equal(hex(unhex(hex(b))), Buffer.from(b).toString('hex'));
  }
  assert.throws(() => unb64u('a*b'));
});

test('cbor encodes deterministically and round-trips', () => {
  const v = { b: [1, -1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 53 - 1, -(2 ** 40)], a: 'héllo', zz: null, y: true, n: false, bytes: Uint8Array.of(1, 2, 3), m: { k: {} } };
  const e1 = cbor.encode(v);
  const e2 = cbor.encode({ m: { k: {} }, bytes: Uint8Array.of(1, 2, 3), n: false, y: true, zz: null, a: 'héllo', b: v.b });
  assert.equal(hex(e1), hex(e2), 'key order must not matter');
  const d = cbor.decode(e1);
  assert.deepEqual(d.b, v.b);
  assert.equal(d.a, 'héllo');
  assert.equal(d.zz, null);
  assert.equal(hex(d.bytes), '010203');
  // RFC 8949 appendix A vectors
  assert.equal(hex(cbor.encode(1000000)), '1a000f4240');
  assert.equal(hex(cbor.encode(1000000000000)), '1b000000e8d4a51000');
  assert.equal(hex(cbor.encode(-1000)), '3903e7');
  assert.equal(hex(cbor.encode([1, [2, 3], [4, 5]])), '8301820203820405');
  assert.equal(hex(cbor.encode({ a: 1, b: [2, 3] })), 'a26161016162820203');
  assert.equal(hex(cbor.encode('ü')), '62c3bc');
});

test('cbor rejects malformed input', () => {
  assert.throws(() => cbor.decode(Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff)), /truncated/);
  assert.throws(() => cbor.decode(Uint8Array.of(0x01, 0x02)), /trailing/);
  assert.throws(() => cbor.decode(Uint8Array.of(0x9f)), /unsupported/);
  assert.throws(() => cbor.decode(Uint8Array.of(0xa1, 0x01, 0x01)), /text/);
  assert.throws(() => cbor.decode(new Uint8Array(40).fill(0x81)), /deep|truncated/);
  assert.throws(() => cbor.encode(1.5));
});

test('aead seals and rejects tampering', () => {
  const key = rand(32);
  const box = c.seal(key, utf8('secret'), utf8('aad'));
  assert.equal(text(c.open(key, box, utf8('aad'))), 'secret');
  assert.throws(() => c.open(key, box, utf8('other')));
  box[30] ^= 1;
  assert.throws(() => c.open(key, box, utf8('aad')));
  const ch = c.sealChunk(key, 7, utf8('chunk'));
  assert.equal(text(c.openChunk(key, 7, ch)), 'chunk');
  assert.throws(() => c.openChunk(key, 8, ch));
});

test('hpke interoperates with an independent RFC 9180 implementation', async () => {
  const suite = new CipherSuite({ kem: new DhkemX448HkdfSha512(), kdf: new HkdfSha512(), aead: new Chacha20Poly1305() });
  const skR = rand(56);
  const pkR = c.dhPublic(skR);
  const info = utf8('void/test');
  const aad = utf8('aad');
  // ours -> reference
  const { enc, ct } = c.hpkeSeal(pkR, info, aad, utf8('from void'));
  const refKey = await suite.kem.importKey('raw', skR.buffer.slice(0), false);
  const pt = await suite.open({ recipientKey: refKey, enc: enc.buffer.slice(0), info: info.buffer.slice(0) }, ct.buffer.slice(0), aad.buffer.slice(0));
  assert.equal(text(new Uint8Array(pt)), 'from void');
  // reference -> ours
  const refPub = await suite.kem.importKey('raw', pkR.buffer.slice(0), true);
  const out = await suite.seal({ recipientPublicKey: refPub, info: info.buffer.slice(0) }, utf8('from reference').buffer.slice(0), aad.buffer.slice(0));
  assert.equal(text(c.hpkeOpen(skR, new Uint8Array(out.enc), info, aad, new Uint8Array(out.ct))), 'from reference');
  assert.throws(() => c.hpkeOpen(rand(56), new Uint8Array(out.enc), info, aad, new Uint8Array(out.ct)));
});

test('passphrase sealing', () => {
  const blob = c.passSeal('correct horse', utf8('backup'));
  assert.equal(text(c.passOpen('correct horse', blob)), 'backup');
  assert.throws(() => c.passOpen('wrong', blob));
});

test('identity, cards, pairwise keys and links', () => {
  const a = keys.identityFromSeed(rand(32));
  const b = keys.identityFromSeed(rand(32));
  const again = keys.identityFromSeed(a.seed);
  assert.equal(hex(again.uid), hex(a.uid));
  const card = keys.makeCard(a, 'Alice', 1700000000000);
  const read = keys.readCard(card);
  assert.equal(read.name, 'Alice');
  assert.equal(hex(read.uid), hex(a.uid));
  const forged = { c: card.c, s: keys.makeCard(b, 'Alice', 1).s };
  assert.equal(keys.readCard(forged), null);
  const kab = keys.dmKey(a.dhSk, b.dhPub, a.uid, b.uid);
  const kba = keys.dmKey(b.dhSk, a.dhPub, b.uid, a.uid);
  assert.equal(hex(kab), hex(kba));
  assert.notEqual(hex(keys.mailboxTag(kab, a.uid)), hex(keys.mailboxTag(kab, b.uid)));
  assert.equal(keys.safetyNumber(a.uid, b.uid), keys.safetyNumber(b.uid, a.uid));
  const link = keys.makeLink('u', card);
  const parsed = keys.readLink(`hello ${link} bye`);
  assert.equal(parsed.kind, 'u');
  assert.equal(keys.readCard(parsed.data).name, 'Alice');
  assert.equal(keys.readLink('void:u:!!!'), null);
});

test('keys and signatures are on the 448-bit curve', () => {
  const id = keys.identityFromSeed(rand(32));
  assert.equal(id.uid.length, 57);
  assert.equal(id.dhPub.length, 56);
  const sig = c.sign(id.edSk, 'void/test', utf8('hello'));
  assert.equal(sig.length, 114);
  assert.equal(c.verify(id.uid, 'void/test', utf8('hello'), sig), true);
  assert.equal(c.verify(id.uid, 'void/other', utf8('hello'), sig), false);
  assert.equal(c.verify(id.uid, 'void/test', utf8('hellp'), sig), false);
  // RFC 7748 section 6.2: the X448 public key of a known secret
  const alice = unhex('9a8f4925d1519f5775cf46b04b5800d4ee9ee8bae8bc5565d498c28dd9c9baf574a9419744897391006382a6f127ab1d9ac2d8c0a598726b');
  assert.equal(hex(c.dhPublic(alice)), '9b08f7cc31b7e3e67d22d5aea121074a273bd2b83de09c63faa73d2c22c5d9bbc836647241d953d40c5b12da88120d53177f80e532c41fa0');
  const bobPub = unhex('3eb7a829b0cd20f5bcfc0b599b6feccf6da4627107bdb0d4f345b43027d8b972fc3e34fb4232a13ca706dcb57aec3dae07bdc1c67bf33609');
  assert.equal(hex(c.dh(alice, bobPub)), '07fff4181ac6cc95ec1c16a94a0f74d12da232ce40a77552281d282bb60c0b56fd2464c335543936521c24403085d59a449a5037514a879d');
  // a key that would make every shared secret zero is refused
  assert.throws(() => c.dh(alice, new Uint8Array(56)));
});

test('post-quantum encapsulation agrees on a secret only with the right key and ciphertext', () => {
  const kp = c.kemKeys();
  assert.equal(kp.publicKey.length, c.KEM_PUB);
  const sent = c.kemSend(kp.publicKey);
  assert.equal(sent.ct.length, c.KEM_CT);
  assert.equal(sent.secret.length, 32);
  assert.equal(hex(c.kemReceive(sent.ct, kp.secretKey)), hex(sent.secret));
  const bad = sent.ct.slice();
  bad[7] ^= 1;
  assert.notEqual(hex(c.kemReceive(bad, kp.secretKey)), hex(sent.secret));
  assert.notEqual(hex(c.kemReceive(sent.ct, c.kemKeys().secretKey)), hex(sent.secret));
  assert.throws(() => c.kemSend(new Uint8Array(c.KEM_PUB).fill(255)), 'a malformed key is refused');
});
