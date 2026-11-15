// SPDX-License-Identifier: AGPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { frameCipher, callKeys } from '../../src/ui/callseal.js';
import { rand, hex } from '../../src/core/bytes.js';

const run = async (fn, frame) => {
  const got = [];
  await fn(frame, { enqueue: (f) => got.push(f) });
  return got[0] || null;
};
const frame = (type, bytes) => ({ type, data: Uint8Array.from(bytes).buffer });
const bytesOf = (f) => [...new Uint8Array(f.data)];

test('call frames are sealed with their header left readable, and open only with the right key', async () => {
  const cipher = frameCipher();
  assert.equal(await cipher.selfTest(), true);
  const key = rand(32);
  const seal = cipher.sealer(key);
  const open = cipher.opener(key);
  const picture = Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
  for (const [type, head] of [['key', 10], ['delta', 3], [undefined, 1]]) {
    const sealed = await run(seal, frame(type, picture));
    const out = bytesOf(sealed);
    assert.equal(out.length, picture.length + 16 + 8);
    assert.deepEqual(out.slice(0, head), picture.slice(0, head), 'header kept');
    assert.notDeepEqual(out.slice(head, head + 40), picture.slice(head, head + 40), 'body sealed');
    const back = await run(open, { type, data: sealed.data });
    assert.deepEqual(bytesOf(back), picture);
    // another key, an altered body, an altered header, a frame that was never sealed
    assert.equal(await run(cipher.opener(rand(32)), { type, data: sealed.data.slice(0) }), null);
    const bad = new Uint8Array(sealed.data.slice(0));
    bad[head + 5] ^= 1;
    assert.equal(await run(open, { type, data: bad.buffer }), null);
    const bad2 = new Uint8Array(sealed.data.slice(0));
    bad2[0] ^= 1;
    assert.equal(await run(open, { type, data: bad2.buffer }), null);
    assert.equal(await run(open, frame(type, picture)), null);
  }
  // the counter moves with every frame: the same frame never seals to the same bytes
  const one = bytesOf(await run(seal, frame('delta', picture)));
  const two = bytesOf(await run(seal, frame('delta', picture)));
  assert.notDeepEqual(one, two);
  assert.notDeepEqual(one.slice(-8), two.slice(-8));
  // very short and empty frames
  assert.deepEqual(bytesOf(await run(open, { type: undefined, data: (await run(seal, frame(undefined, [9]))).data })), [9]);
  assert.equal(bytesOf(await run(seal, frame('delta', []))).length, 0);
});

test('each direction and each kind of media of a call has its own key', () => {
  const [a, b, id] = [rand(32), rand(32), rand(8)];
  const k = callKeys(a, b, id);
  const all = [k.caller.audio, k.caller.video, k.callee.audio, k.callee.video].map(hex);
  assert.equal(new Set(all).size, 4);
  assert.ok(all.every((x) => x.length === 64), '256-bit keys');
  assert.deepEqual(callKeys(a, b, id), k);
  assert.notEqual(hex(callKeys(a, rand(32), id).caller.audio), all[0]);
  assert.notEqual(hex(callKeys(a, b, rand(8)).caller.audio), all[0]);
});
