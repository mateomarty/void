// SPDX-License-Identifier: AGPL-3.0-or-later
// Entry point of the single-file application.

import { VoidNode } from './core/node.js';
import { openStore, IdbStore, dropDatabase } from './core/store.js';
import { createVault, openVault, wrapVault, VaultStore, migratePlain } from './core/vault.js';
import { RtcTransport } from './net/rtc.js';
import { RelayPool } from './net/relays.js';
import { App } from './ui/app.js';
import { toast, openLink } from './ui/dialogs.js';
import { setupScreen, unlockScreen, protectScreen, outdatedScreen } from './ui/lock.js';
import { KEYGEN } from './core/proto.js';
import { h } from './ui/dom.js';

const VERSION = '0.4.0';

// One tab per profile: two tabs writing the same device feeds would corrupt them.
function tabIsFree(name) {
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === 'undefined') return resolve(true);
    const ch = new BroadcastChannel('void-tab-' + name);
    let taken = false;
    ch.onmessage = (e) => {
      if (e.data === 'who' && !taken) ch.postMessage('here');
      if (e.data === 'here') taken = true;
    };
    ch.postMessage('who');
    setTimeout(() => {
      if (taken) ch.close();
      resolve(!taken);
    }, 250);
    return undefined;
  });
}

// A profile saved by a version that did not encrypt its storage, if there is one.
async function findUnprotected(dbName) {
  if (typeof indexedDB === 'undefined') return null;
  let plain;
  try {
    plain = await IdbStore.open(dbName);
  } catch {
    return null;
  }
  const id = await plain.get('kv', 'id');
  if (id) return { store: plain, name: id.name, keys: id.k };
  await dropDatabase(plain, dbName);
  return null;
}

async function main() {
  const root = document.getElementById('app');
  const params = new URLSearchParams(location.search);
  // ?profile=name keeps a separate identity in the same browser (handy for trying
  // Void with two tabs on one computer).
  const profile = (params.get('profile') || '').replace(/[^\w-]/g, '').slice(0, 32);
  const dbName = profile ? `void-${profile}` : 'void';
  if (!(await tabIsFree(dbName))) {
    root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'logo' }, 'Void'), h('p', null, 'Void is already open in another tab of this browser. Use that tab, or close it and reload this one.')));
    return;
  }

  // `disk` is what the browser stores. Only the vault header is readable in it;
  // everything else goes through the VaultStore, sealed with the password.
  const disk = await openStore(dbName + '-vault');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  let header = await disk.get('kv', 'vault');
  if (header && header.unfinished) {
    await disk.clear(); // a migration was interrupted: the original is still intact
    header = undefined;
  }

  const env = { persistent: disk.persistent, profile, version: VERSION };
  let node = null;
  const ice = () => (node.settings.stun && node.settings.stunServers.length ? [{ urls: node.settings.stunServers }] : []);
  const rtc = RtcTransport.available() ? new RtcTransport(ice) : null;
  const rdv = typeof WebSocket !== 'undefined' ? new RelayPool() : null;
  // ?debug=offline starts with both public helpers off (used by the browser tests).
  const defaults = params.get('debug') === 'offline' ? { stun: false, rdv: false } : {};

  // Starts the engine on the unlocked vault. `first` creates or restores the identity.
  const launch = async (masterKey, first = null) => {
    const candidate = new VoidNode({ store: new VaultStore(disk, masterKey), rtc, rdv, defaults, name: profile });
    if (first) await first(candidate);
    else if (!(await candidate.load())) throw new Error('This profile holds no identity. Erase it and start again.');
    node = candidate;
    env.verifyPassword = (password) => openVault(header, password);
    env.changePassword = async (current, next) => {
      const key = await openVault(header, current);
      header = await wrapVault(key, next);
      await disk.put('kv', 'vault', header);
    };
    env.iceServers = ice; // calls use the same address helpers as the links
    env.lock = () => {
      node.stop();
      location.reload(); // a fresh page holds no key until the password is entered
    };
    const app = new App(root, node, env);
    app.start();
    if (params.has('debug')) Object.assign(window, { voidNode: node, voidApp: app }); // for the browser tests
    if (!rtc) toast('This browser has no WebRTC, so it cannot connect to other devices.', 'bad');
    // Closing the page closes the links, so contacts see it at once instead of
    // waiting for a timeout. A page restored from the back/forward cache starts over.
    window.addEventListener('pagehide', () => node.stop());
    window.addEventListener('pageshow', (e) => e.persisted && location.reload());
    // A void: link after the # opens straight away, e.g. void.html#void:c:…
    // It is then removed from the address so it does not stay in the browser history.
    const hash = decodeURIComponent(location.hash.slice(1));
    if (/^void:[a-z]:/.test(hash)) {
      history.replaceState(null, '', location.pathname + location.search);
      openLink(app, hash);
    }
  };

  // A new vault is only announced on disk once the identity is safely inside it.
  const begin = async (password, first) => {
    const vault = await createVault(password);
    await disk.clear();
    await launch(vault.masterKey, async (candidate) => {
      await first(candidate);
      header = vault.header;
      await disk.put('kv', 'vault', header);
    });
  };

  if (header) {
    const onErase = async () => {
      await disk.clear();
      location.reload();
    };
    unlockScreen(root, {
      profile,
      onUnlock: async (password) => {
        try {
          await launch(await openVault(header, password));
        } catch (e) {
          if (e.code !== 'old-keys') throw e;
          outdatedScreen(root, { name: profile, onErase });
        }
      },
      onErase,
    });
    return;
  }

  const old = disk.persistent ? await findUnprotected(dbName) : null;
  if (old && old.keys !== KEYGEN) {
    outdatedScreen(root, {
      name: old.name,
      onErase: async () => {
        await dropDatabase(old.store, dbName);
        location.reload();
      },
    });
    return;
  }
  if (old) {
    protectScreen(root, {
      name: old.name,
      onProtect: async (password) => {
        const vault = await createVault(password);
        await disk.clear();
        await disk.put('kv', 'vault', { ...vault.header, unfinished: true });
        await migratePlain(old.store, new VaultStore(disk, vault.masterKey));
        header = vault.header;
        await disk.put('kv', 'vault', header);
        await dropDatabase(old.store, dbName);
        await launch(vault.masterKey);
      },
    });
    return;
  }

  setupScreen(root, {
    persistent: disk.persistent,
    onCreate: (name, password) => begin(password, (candidate) => candidate.create(name)),
    onRestore: (bytes, passphrase, password) => begin(password, (candidate) => candidate.restoreBackup(bytes, passphrase)),
  });
}

main().catch((e) => {
  console.error(e);
  const root = document.getElementById('app');
  root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'logo' }, 'Void'), h('p', null, 'Void could not start in this browser.'), h('p', { class: 'muted small' }, String((e && e.message) || e))));
});
