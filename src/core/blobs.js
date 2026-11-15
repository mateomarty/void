// SPDX-License-Identifier: AGPL-3.0-or-later
// Attachments. A file is split into chunks, each sealed with a per-file key, and
// addressed by the SHA-256 of its ciphertext. Any device that shares the
// conversation and holds the ciphertext can serve it; only holders of the message
// have the key.

import { T } from './proto.js';
import { hex, unhex, rand, concat, isBytes } from './bytes.js';
import { hasher, sealChunk, openChunk } from './crypto.js';

const chunkKey = (id, i) => `c|${id}|${String(i).padStart(7, '0')}`;
const metaKey = (id) => `m|${id}`;

export const blobMethods = {
  // Encrypts and stores a file. Returns the descriptor to put in a message.
  async addBlob(bytes, { name = 'file', mime = 'application/octet-stream', kind = 'file', thumb = null, w = 0, h = 0, dur = 0 } = {}) {
    if (bytes.length > this.cfg.blobMax) throw new Error('File too large');
    const key = rand(32);
    const plain = this.cfg.blobChunk - 16;
    const n = Math.max(1, Math.ceil(bytes.length / plain));
    const digest = hasher();
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const ct = sealChunk(key, i, bytes.subarray(i * plain, (i + 1) * plain));
      digest.update(ct);
      chunks.push(ct);
    }
    const idBytes = digest.digest();
    const id = hex(idBytes);
    for (let i = 0; i < n; i++) await this.store.put('blobs', chunkKey(id, i), chunks[i]);
    await this.store.put('blobs', metaKey(id), { n, have: n, done: true });
    const att = { i: idBytes, k: key, n: String(name).slice(0, 200), m: String(mime).slice(0, 100), z: bytes.length, c: n, t: kind };
    if (thumb) att.p = thumb;
    if (w) att.w = w;
    if (h) att.h = h;
    if (dur) att.d = dur;
    return att;
  },

  async hasBlob(id) {
    const meta = await this.store.get('blobs', metaKey(id));
    return !!(meta && meta.done);
  },

  // Decrypted content of a complete attachment, as a list of chunks.
  async blobChunks(att) {
    const meta = await this.store.get('blobs', metaKey(att.id));
    if (!meta || !meta.done) throw new Error('Not downloaded yet');
    const out = [];
    for (let i = 0; i < meta.n; i++) out.push(openChunk(att.key, i, await this.store.get('blobs', chunkKey(att.id, i))));
    return out;
  },

  async blobBytes(att) {
    return concat(...(await this.blobChunks(att)));
  },

  // Download progress for the UI: { state: 'none' | 'loading' | 'done' | 'failed', have, n }.
  blobState(id) {
    const d = this.downloads.get(id);
    return d ? { state: d.failed ? 'failed' : 'loading', have: d.have, n: d.n, error: d.failed || '' } : null;
  },

  // Fetches an attachment from the devices that share the conversation.
  // `force` allows large files over relayed routes.
  fetchBlob(spId, att, { force = false } = {}) {
    // The queue task must not wait for the download itself: the download needs the
    // queue to process incoming chunks. It hands back the promise in a wrapper.
    return this.enqueue(async () => {
      if (await this.hasBlob(att.id)) return { p: Promise.resolve(true) };
      let d = this.downloads.get(att.id);
      if (d && !d.failed) return { p: d.promise };
      const meta = (await this.store.get('blobs', metaKey(att.id))) || { n: att.chunks, have: 0, done: false };
      if (meta.n !== att.chunks || att.chunks < 1 || att.chunks > Math.ceil(this.cfg.blobMax / (this.cfg.blobChunk - 16)) + 1) throw new Error('Bad attachment');
      d = { id: att.id, idBytes: unhex(att.id), sp: spId, n: meta.n, have: meta.have, digest: hasher(), tried: new Set(), route: null, timer: null, failed: '', force, searched: false };
      for (let i = 0; i < d.have; i++) d.digest.update(await this.store.get('blobs', chunkKey(att.id, i)));
      d.promise = new Promise((resolve, reject) => {
        d.resolve = resolve;
        d.reject = reject;
      });
      d.promise.catch(() => {});
      this.downloads.set(att.id, d);
      this.blobAsk(d);
      return { p: d.promise };
    }).then((x) => x.p);
  },

  blobAsk(d) {
    clearTimeout(d.timer);
    const sp = this.spaces.get(d.sp);
    if (!d.route || d.route.closed || d.tried.has(d.route.id)) {
      const tooBig = d.n * this.cfg.blobChunk > this.cfg.blobTunnelMax && !d.force;
      const candidates = [...this.routes.values()]
        .filter((r) => r.peer && !r.closed && r.sessions.has(d.sp) && !d.tried.has(r.id) && !(r.kind === 'tunnel' && tooBig))
        .sort((a, b) => (a.kind === 'link' ? 0 : 1 + a.hops) - (b.kind === 'link' ? 0 : 1 + b.hops));
      d.route = candidates[0] || null;
    }
    if (sp && !d.route && !d.searched && this.links.size) {
      // Nobody I am connected to has it: look for other members of the conversation.
      d.searched = true;
      this.sendRreq(sp.keys.slice(-2).map((k) => k.tag));
      d.timer = setTimeout(() => this.run(() => {
        if (this.downloads.get(d.id) === d && !d.failed) this.blobAsk(d);
      }), Math.min(this.cfg.blobTimeout, 4000));
      return undefined;
    }
    if (!sp || !d.route) return this.blobFail(d, 'No connected device has this file right now');
    this.sendSpace(d.route, sp, { t: T.BREQ, i: d.idBytes, c: d.have, n: this.cfg.blobWindow });
    d.timer = setTimeout(() => this.run(() => {
      if (this.downloads.get(d.id) !== d || d.failed) return;
      d.tried.add(d.route.id);
      this.blobAsk(d);
    }), this.cfg.blobTimeout);
    return undefined;
  },

  blobFail(d, why) {
    clearTimeout(d.timer);
    d.failed = why;
    d.reject(new Error(why));
    this.emit('blob', d.id);
  },

  async onBlobReq(route, sp, msg) {
    if (!isBytes(msg.i, 32) || !Number.isInteger(msg.c) || msg.c < 0 || !Number.isInteger(msg.n)) return;
    const id = hex(msg.i);
    const raw = route.link.raw;
    if (raw.backlog && raw.backlog() > this.cfg.blobBacklog) return undefined; // it asks again once it has caught up
    const meta = await this.store.get('blobs', metaKey(id));
    if (!meta || msg.c >= meta.have) return void this.sendSpace(route, sp, { t: T.BNONE, i: msg.i });
    const end = Math.min(meta.have, msg.c + Math.min(Math.max(msg.n, 1), 32));
    for (let c = msg.c; c < end; c++) {
      const data = await this.store.get('blobs', chunkKey(id, c));
      if (!data || !this.sendSpace(route, sp, { t: T.BDATA, i: msg.i, c, d: data, z: meta.n })) return undefined;
    }
    return undefined;
  },

  async onBlobData(route, sp, msg) {
    if (!isBytes(msg.i, 32) || !isBytes(msg.d) || msg.d.length > this.cfg.blobChunk || msg.d.length < 16) return;
    const d = this.downloads.get(hex(msg.i));
    if (!d || d.failed || d.route !== route || msg.c !== d.have || msg.z !== d.n) return;
    await this.store.put('blobs', chunkKey(d.id, d.have), msg.d);
    d.digest.update(msg.d);
    d.have++;
    if (d.have < d.n) {
      await this.store.put('blobs', metaKey(d.id), { n: d.n, have: d.have, done: false });
      if (d.have % this.cfg.blobWindow === 0) this.blobAsk(d);
      if (d.have % 4 === 0) this.emit('blob', d.id);
      return;
    }
    clearTimeout(d.timer);
    if (hex(d.digest.digest()) !== d.id) {
      await this.store.delRange('blobs', `c|${d.id}|`);
      await this.store.del('blobs', metaKey(d.id));
      return void this.blobFail(d, 'The file was corrupted in transit');
    }
    await this.store.put('blobs', metaKey(d.id), { n: d.n, have: d.n, done: true });
    this.downloads.delete(d.id);
    d.resolve(true);
    this.emit('blob', d.id);
  },

  onBlobNone(route, sp, msg) {
    if (!isBytes(msg.i, 32)) return;
    const d = this.downloads.get(hex(msg.i));
    if (!d || d.failed || d.route !== route) return;
    d.tried.add(route.id);
    this.blobAsk(d);
  },
};
