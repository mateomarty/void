// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal deterministic CBOR (RFC 8949, section 4.2.1 core deterministic encoding).
// Supported: unsigned and negative integers, byte strings, text strings, arrays,
// maps with text keys, true, false, null. No floats, tags or indefinite lengths.
// Everything that is signed or hashed in the protocol is encoded with this.

import { utf8, text, concat } from './bytes.js';

const MAX_DEPTH = 16;

function head(major, n) {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 255);
  if (n < 0x100000000) return Uint8Array.of(m | 26, n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return Uint8Array.of(m | 27, hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
}

function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function enc(v, out, depth) {
  if (depth > MAX_DEPTH) throw new Error('cbor: too deep');
  if (v === null || v === undefined) return void out.push(Uint8Array.of(0xf6));
  if (v === true) return void out.push(Uint8Array.of(0xf5));
  if (v === false) return void out.push(Uint8Array.of(0xf4));
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('cbor: only safe integers are supported');
    return void out.push(v >= 0 ? head(0, v) : head(1, -1 - v));
  }
  if (typeof v === 'string') {
    const b = utf8(v);
    return void out.push(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return void out.push(head(2, v.length), v);
  if (Array.isArray(v)) {
    out.push(head(4, v.length));
    for (const x of v) enc(x, out, depth + 1);
    return;
  }
  if (typeof v === 'object') {
    const entries = [];
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      const kb = utf8(k);
      entries.push([concat(head(3, kb.length), kb), v[k]]);
    }
    entries.sort((a, b) => cmpBytes(a[0], b[0]));
    out.push(head(5, entries.length));
    for (const [k, x] of entries) {
      out.push(k);
      enc(x, out, depth + 1);
    }
    return;
  }
  throw new Error('cbor: unsupported type ' + typeof v);
}

export function encode(v) {
  const out = [];
  enc(v, out, 0);
  return concat(...out);
}

export function decode(bytes, maxBytes = 16 * 1024 * 1024) {
  if (!(bytes instanceof Uint8Array)) throw new Error('cbor: not bytes');
  if (bytes.length > maxBytes) throw new Error('cbor: too large');
  let p = 0;
  const need = (n) => {
    if (p + n > bytes.length) throw new Error('cbor: truncated');
  };
  const arg = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) {
      need(1);
      return bytes[p++];
    }
    if (ai === 25) {
      need(2);
      const v = (bytes[p] << 8) | bytes[p + 1];
      p += 2;
      return v;
    }
    if (ai === 26) {
      need(4);
      const v = bytes[p] * 0x1000000 + ((bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
      p += 4;
      return v;
    }
    if (ai === 27) {
      need(8);
      const hi = bytes[p] * 0x1000000 + ((bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]);
      const lo = bytes[p + 4] * 0x1000000 + ((bytes[p + 5] << 16) | (bytes[p + 6] << 8) | bytes[p + 7]);
      p += 8;
      const v = hi * 0x100000000 + lo;
      if (!Number.isSafeInteger(v)) throw new Error('cbor: integer too large');
      return v;
    }
    throw new Error('cbor: unsupported length encoding');
  };
  const item = (depth) => {
    if (depth > MAX_DEPTH) throw new Error('cbor: too deep');
    need(1);
    const b = bytes[p++];
    const major = b >> 5;
    const ai = b & 31;
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22 || ai === 23) return null;
      throw new Error('cbor: unsupported simple value');
    }
    const n = arg(ai);
    switch (major) {
      case 0:
        return n;
      case 1:
        return -1 - n;
      case 2: {
        need(n);
        const v = bytes.slice(p, p + n);
        p += n;
        return v;
      }
      case 3: {
        need(n);
        const v = text(bytes.subarray(p, p + n));
        p += n;
        return v;
      }
      case 4: {
        if (n > bytes.length - p) throw new Error('cbor: truncated');
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = item(depth + 1);
        return a;
      }
      case 5: {
        if (n > bytes.length - p) throw new Error('cbor: truncated');
        const o = Object.create(null);
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== 'string') throw new Error('cbor: map keys must be text');
          o[k] = item(depth + 1);
        }
        return o;
      }
      default:
        throw new Error('cbor: tags are not supported');
    }
  };
  const v = item(0);
  if (p !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}
