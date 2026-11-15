// SPDX-License-Identifier: AGPL-3.0-or-later
// A second layer of encryption for calls.
//
// WebRTC already encrypts sound and picture between the two devices (DTLS-SRTP).
// On top of that, every encoded frame (a piece of sound, a picture from the camera
// or the shared screen) is sealed here with AES-256-GCM before WebRTC gets it, and
// opened on the other device after WebRTC hands it back. The keys come from two
// random secrets, one from each side, exchanged inside the conversation's own
// channel, so they are protected by the hybrid key exchange of that channel and
// are never seen by the call's own transport. A recording of a call therefore
// stays unreadable even if the transport's key exchange is broken one day.
//
// Sealed frame:  clear header | AES-256-GCM(rest, aad = header) | 8-byte counter
// Each direction and each kind of media has its own key; the counter never
// repeats under a key. A frame that does not open is dropped, never played.

import { concat } from '../core/bytes.js';
import { derive } from '../core/crypto.js';

// This function is also turned into the script of a worker, so it uses nothing
// from outside its own body.
export function frameCipher() {
  const TAG = 16;
  const COUNT = 8;
  // Bytes left readable at the start of a frame, so that the browser can still
  // tell what the frame is and cut it into packets: the VP8 frame header, or the
  // first byte of an Opus sound frame. They are authenticated, not hidden.
  const clear = (frame) => (frame.type === 'key' ? 10 : frame.type === 'delta' ? 3 : 1);
  const load = (raw) => crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  function sealer(raw) {
    const key = load(raw);
    let n = 0n;
    return async (frame, out) => {
      const data = new Uint8Array(frame.data);
      if (!data.length) return void out.enqueue(frame);
      const head = Math.min(clear(frame), data.length);
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setBigUint64(4, n++);
      const aad = data.slice(0, head);
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await key, data.subarray(head)));
      const sealed = new Uint8Array(head + body.length + COUNT);
      sealed.set(aad);
      sealed.set(body, head);
      sealed.set(nonce.subarray(4), head + body.length);
      frame.data = sealed.buffer;
      out.enqueue(frame);
    };
  }

  function opener(raw) {
    const key = load(raw);
    return async (frame, out) => {
      const data = new Uint8Array(frame.data);
      if (!data.length) return void out.enqueue(frame);
      const head = Math.min(clear(frame), data.length);
      if (data.length < head + TAG + COUNT) return; // not sealed: dropped
      const nonce = new Uint8Array(12);
      nonce.set(data.subarray(data.length - COUNT), 4);
      const aad = data.slice(0, head);
      let body;
      try {
        body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, await key, data.subarray(head, data.length - COUNT)));
      } catch {
        return; // wrong key or altered: dropped
      }
      const plain = new Uint8Array(head + body.length);
      plain.set(aad);
      plain.set(body, head);
      frame.data = plain.buffer;
      out.enqueue(frame);
    };
  }

  const pipe = (op, raw, readable, writable) => readable
    .pipeThrough(new TransformStream({ transform: op === 'seal' ? sealer(raw) : opener(raw) }))
    .pipeTo(writable)
    .catch(() => {});

  // Seals and opens one made-up frame, to know that this browser can do it.
  async function selfTest() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const got = [];
    const out = { enqueue: (f) => got.push(f) };
    await sealer(raw)({ type: 'delta', data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8).buffer }, out);
    await opener(raw)({ type: 'delta', data: got[0].data }, out);
    return got.length === 2 && new Uint8Array(got[1].data).join() === '1,2,3,4,5,6,7,8';
  }

  return { sealer, opener, pipe, selfTest };
}

const WORKER = () => `const cipher = (${frameCipher})();
self.onrtctransform = (e) => {
  const t = e.transformer;
  cipher.pipe(t.options.op, t.options.key, t.readable, t.writable);
};
cipher.selfTest().then((ok) => self.postMessage({ ok }), () => self.postMessage({ ok: false }));`;

// Finds out how this browser lets a page reach encoded frames. Resolves to null
// when it does not, and otherwise to { legacy, attach(senderOrReceiver, op, key) }.
export async function frameSealer() {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    if (typeof RTCRtpScriptTransform === 'function' && typeof Worker === 'function') {
      const url = URL.createObjectURL(new Blob([WORKER()], { type: 'text/javascript' }));
      let worker = null;
      const ok = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 3000);
        const done = (v) => {
          clearTimeout(t);
          resolve(v);
        };
        try {
          worker = new Worker(url);
          worker.onmessage = (e) => done(!!(e.data && e.data.ok));
          worker.onerror = () => done(false);
        } catch {
          done(false);
        }
      });
      URL.revokeObjectURL(url);
      if (ok) {
        return {
          legacy: false,
          attach(target, op, key) {
            target.transform = new RTCRtpScriptTransform(worker, { op, key });
          },
        };
      }
      if (worker) worker.terminate();
    }
    if (typeof RTCRtpSender !== 'undefined' && RTCRtpSender.prototype.createEncodedStreams) {
      const cipher = frameCipher();
      if (await cipher.selfTest()) {
        return {
          legacy: true, // the connection must be created with encodedInsertableStreams
          attach(target, op, key) {
            const s = target.createEncodedStreams();
            cipher.pipe(op, key, s.readable, s.writable);
          },
        };
      }
    }
  } catch { /* no second layer on this browser */ }
  return null;
}

// One key per direction and per kind of media, from the two secrets of the call.
export function callKeys(fromCaller, fromCallee, callId) {
  const base = derive(concat(fromCaller, fromCallee), 'void/v1/call', 32, callId);
  const k = (who, kind) => derive(base, `void/v1/call/${who}/${kind}`);
  return {
    caller: { audio: k('caller', 'audio'), video: k('caller', 'video') },
    callee: { audio: k('callee', 'audio'), video: k('callee', 'video') },
  };
}

// Sealed pictures must be VP8: its packets are cut without looking inside the
// frame, which other formats do not allow.
export function onlyVp8(transceiver) {
  try {
    const all = RTCRtpReceiver.getCapabilities('video').codecs;
    const keep = all.filter((c) => /\/(VP8|rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
    if (!keep.some((c) => /\/VP8$/i.test(c.mimeType))) return false;
    transceiver.setCodecPreferences(keep);
    return true;
  } catch {
    return false;
  }
}
