// SPDX-License-Identifier: AGPL-3.0-or-later
// Byte helpers shared by every layer. No dependencies, works in browsers and Node.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (s) => enc.encode(s);
export const text = (b) => dec.decode(b);

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function hex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += HEX[b[i]];
  return s;
}

export function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

// base64url without padding
export function b64u(b) {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i + 1 === b.length) {
    const n = b[i] << 16;
    s += B64[n >> 18] + B64[(n >> 12) & 63];
  } else if (i + 2 === b.length) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return s;
}

export function unb64u(s) {
  if (typeof s !== 'string') throw new Error('bad base64');
  s = s.replace(/=+$/, '');
  if (s.length % 4 === 1) throw new Error('bad base64');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B64_REV[c] : -1;
    if (v < 0) throw new Error('bad base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}

export function eq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function rand(n) {
  const out = new Uint8Array(n);
  // getRandomValues refuses more than 65536 bytes per call
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

export const isBytes = (v, len) => v instanceof Uint8Array && (len === undefined || v.length === len);
