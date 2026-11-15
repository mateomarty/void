// SPDX-License-Identifier: AGPL-3.0-or-later
// Encryption of everything the application writes to disk.
//
// A password is stretched with scrypt into a key that unwraps a random master key.
// Two keys come from the master key: one seals every stored value, one turns the
// names of stored records into opaque strings. Without the password the browser's
// storage holds only ciphertext and meaningless record names.
//
// The wrapped master key and the scrypt salt are the only things stored in clear.

import { utf8, hex, rand, isBytes } from './bytes.js';
import * as cbor from './cbor.js';
import { derive, seal, open, mac, passKey } from './crypto.js';

// Each password guess costs 128 MiB of memory and a fraction of a second. Devices
// that cannot spare that much fall back to a lighter setting; the setting used is
// stored with the vault.
const KDFS = [{ N: 2 ** 17, r: 8, p: 1 }, { N: 2 ** 15, r: 8, p: 1 }];
export const MIN_PASSWORD = 8;

export async function createVault(password, kdfs = KDFS) {
  const masterKey = rand(32);
  return { masterKey, header: await wrapVault(masterKey, password, kdfs) };
}

// Used when the password changes: the data stays as it is, only the wrapping changes.
export async function wrapVault(masterKey, password, kdfs = KDFS) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters`);
  const salt = rand(16);
  let failure = null;
  for (const kdf of kdfs) {
    try {
      const kek = await passKey(password, salt, kdf);
      return { v: 1, salt, kdf: { ...kdf }, wrap: seal(kek, masterKey, salt) };
    } catch (e) {
      failure = e; // most likely not enough memory: try the next setting
    }
  }
  throw failure;
}

// Returns the master key, or throws when the password is wrong.
export async function openVault(header, password) {
  if (!header || header.v !== 1 || !isBytes(header.salt, 16) || !isBytes(header.wrap) || !header.kdf) throw new Error('This profile is damaged');
  const kek = await passKey(String(password), header.salt, header.kdf);
  try {
    return open(kek, header.wrap, header.salt);
  } catch {
    throw new Error('Wrong password');
  }
}

// Wraps a store. Same interface; values are sealed and record names are hidden.
export class VaultStore {
  constructor(inner, masterKey) {
    this.inner = inner;
    this.persistent = inner.persistent;
    this.dataKey = derive(masterKey, 'void/v1/vault-data');
    this.nameKey = derive(masterKey, 'void/v1/vault-names');
    this.names = new Map();
  }

  // Record names are made of parts joined by "|". Each part is replaced by a keyed
  // hash, so equal parts still match (prefix scans keep working) but reveal nothing.
  // Short all-digit parts are sequence numbers: they stay, to keep records in order.
  k(key) {
    return key.split('|').map((part) => {
      if (part === '' || /^\d{1,12}$/.test(part)) return part;
      let name = this.names.get(part);
      if (!name) {
        name = hex(mac(this.nameKey, utf8(part)).subarray(0, 16));
        if (this.names.size > 20000) this.names.clear();
        this.names.set(part, name);
      }
      return name;
    }).join('|');
  }

  // The record's bucket and name are bound to the ciphertext, so a record cannot
  // be moved or swapped with another one without failing to open.
  seal(bucket, stored, value) {
    return seal(this.dataKey, cbor.encode(value), utf8(`${bucket}|${stored}`));
  }

  open(bucket, stored, box) {
    return cbor.decode(open(this.dataKey, box, utf8(`${bucket}|${stored}`)), 64 * 1024 * 1024);
  }

  async get(bucket, key) {
    const stored = this.k(key);
    const box = await this.inner.get(bucket, stored);
    return box === undefined ? undefined : this.open(bucket, stored, box);
  }

  async put(bucket, key, value) {
    const stored = this.k(key);
    await this.inner.put(bucket, stored, this.seal(bucket, stored, value));
  }

  del(bucket, key) {
    return this.inner.del(bucket, this.k(key));
  }

  rows(bucket, list) {
    const out = [];
    for (const { key, value } of list) if (isBytes(value)) out.push({ key, value: this.open(bucket, key, value) });
    return out;
  }

  async range(bucket, prefix = '', limit = Infinity, reverse = false) {
    return this.rows(bucket, await this.inner.range(bucket, this.k(prefix), limit, reverse));
  }

  async between(bucket, lo, hi) {
    return this.rows(bucket, await this.inner.between(bucket, this.k(lo), this.k(hi)));
  }

  delRange(bucket, prefix) {
    return this.inner.delRange(bucket, this.k(prefix));
  }

  clear() {
    return this.inner.clear();
  }
}

const BUCKETS = ['kv', 'contacts', 'spaces', 'events', 'blobs', 'courier'];

// Copies a profile that was stored without encryption into a vault.
export async function migratePlain(plain, vault) {
  let n = 0;
  for (const bucket of BUCKETS) {
    for (const { key, value } of await plain.range(bucket)) {
      if (bucket === 'kv' && key === 'probe') continue;
      const v = bucket === 'courier' && value && !value.tag ? { ...value, tag: key.slice(0, 32), id: key.slice(33) } : value;
      await vault.put(bucket, key, v);
      n++;
    }
  }
  return n;
}
