// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end test in a real browser: several profiles of dist/void.html talk to
// each other over real WebRTC data channels. Usage: node test/browser/run.mjs [--slow] [--headed]

import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as cbor from '../../src/core/cbor.js';

const slow = process.argv.includes('--slow');
const file = pathToFileURL(resolve('dist/void.html')).href;
const shots = resolve('test/browser/screenshots');
await mkdir(shots, { recursive: true });
const PASSWORD = 'correct horse battery';

// A simulated camera and microphone, so that calls can be tested without hardware.
const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed'), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const problems = [];
const requests = [];
const sockets = [];

// `mode` is 'offline' (both public helpers off: the tests then need no internet)
// or '1' (the defaults a real user gets).
async function open(profile, viewport = { width: 1200, height: 800 }, mode = 'offline') {
  const ctx = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write', 'camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`${profile}: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${profile}: ${e.message}`));
  page.on('request', (r) => !r.url().startsWith('file:') && !r.url().startsWith('blob:') && !r.url().startsWith('data:') && requests.push(r.url()));
  page.on('websocket', (ws) => sockets.push(`${profile}: ${ws.url()}`));
  await page.goto(`${file}?profile=${profile}&debug=${mode}`);
  return page;
}

async function signUp(page, name, password = PASSWORD) {
  await page.fill('.f-name', name);
  await page.fill('.f-pass', password);
  await page.fill('.f-pass2', password);
  await page.click('.f-start');
  await page.waitForSelector('.shell');
}

async function unlock(page, password = PASSWORD) {
  await page.fill('.f-unlock-pass', password);
  await page.click('.f-unlock');
}

const wait = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    e.message = `in step "${name}": ${e.message}`;
    throw e;
  }
  console.log(`  ok  ${name}  (${Date.now() - t} ms)`);
};

// Pairing through the node API (the UI path is exercised once, below).
async function pair(a, b, delayMs = 0) {
  const invite = await a.evaluate(async () => {
    window.inv = await window.voidNode.invite();
    return window.inv.code;
  });
  const reply = await b.evaluate(async (code) => {
    window.joined = await window.voidNode.join(code);
    return window.joined.code;
  }, invite);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  await a.evaluate((code) => window.inv.complete(code), reply);
  const idA = await a.evaluate(() => window.voidNode.uidHex);
  const idB = await b.evaluate(() => window.voidNode.uidHex);
  await wait(a, (uid) => window.voidNode.reach(uid).state === 'direct', idB);
  await wait(b, (uid) => window.voidNode.reach(uid).state === 'direct', idA);
}

const uid = (page) => page.evaluate(() => window.voidNode.uidHex);
const reach = (page, id) => page.evaluate((u) => window.voidNode.reach(u), id);

// Reads the browser's storage directly, the way someone with the disk would, and
// reports which of the given strings can be found in it.
const readDisk = (page, dbName, needles) => page.evaluate(async ({ dbName, needles }) => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(dbName);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const done = (r) => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const latin1 = new TextDecoder('latin1');
  let text = '';
  let records = 0;
  const readable = [];
  for (const name of db.objectStoreNames) {
    const os = db.transaction(name, 'readonly').objectStore(name);
    const keys = await done(os.getAllKeys());
    const values = await done(os.getAll());
    keys.forEach((k, i) => {
      records++;
      text += `|${name}/${k}|`;
      if (values[i] instanceof Uint8Array) text += latin1.decode(values[i]);
      else readable.push(`${name}/${k}`);
    });
  }
  db.close();
  return { records, readable, found: needles.filter((n) => text.includes(n)) };
}, { dbName, needles });

try {
  const alice = await open('alice');
  const bob = await open('bob');
  const carol = await open('carol');
  let A;
  let B;

  await step('first run asks for a name and a password, and refuses a weak or mistyped one', async () => {
    await alice.waitForSelector('.f-name');
    await alice.screenshot({ path: `${shots}/desktop-welcome.png`, fullPage: true });
    await alice.fill('.f-name', 'Alice');
    await alice.fill('.f-pass', 'short');
    await alice.fill('.f-pass2', 'short');
    await alice.click('.f-start');
    await alice.waitForSelector('.error >> text=at least 8');
    await alice.fill('.f-pass', PASSWORD);
    await alice.fill('.f-pass2', PASSWORD + 'x');
    await alice.click('.f-start');
    await alice.waitForSelector('.error >> text=not the same');
    await signUp(alice, 'Alice');
    await signUp(bob, 'Bob');
    await signUp(carol, 'Carol');
    A = await uid(alice);
    B = await uid(bob);
    assert.notEqual(A, B);
    await alice.waitForSelector('.guide');
    await alice.screenshot({ path: `${shots}/desktop-first-steps.png` });
  });

  await step('pairing through the dialogs (invite, reply)', async () => {
    // "Add a friend" has two tabs. Alice invites; Bob was invited.
    await alice.click('.guide .btn.primary');
    await alice.waitForSelector('.dialog >> text=Add a friend');
    await alice.waitForSelector('.f-tab-mine.on');
    await alice.waitForSelector('.code-card canvas.qr');
    const invite = await alice.inputValue('.code-card textarea');
    assert.match(invite, /^void:i:/);
    console.log(`        invite code: ${invite.length} characters`);
    await alice.screenshot({ path: `${shots}/desktop-connect.png` });
    await bob.click('.me .f-add');
    await bob.click('.f-tab-theirs');
    await bob.fill('.code-input textarea', invite);
    await bob.screenshot({ path: `${shots}/desktop-connect-theirs.png` });
    await bob.click('.code-input .btn.primary');
    await wait(bob, () => (document.querySelector('.code-card textarea') || {}).value?.startsWith('void:r:'));
    const reply = await bob.inputValue('.code-card textarea');
    await alice.fill('.code-input textarea', reply);
    await alice.click('.code-input .btn.primary');
    await wait(alice, () => !document.querySelector('.overlay'));
    await wait(bob, () => !document.querySelector('.overlay'));
    assert.equal((await reach(alice, B)).state, 'direct');
    // The new conversation opens by itself and explains what it is.
    await alice.waitForSelector('.chat-head >> text=Bob');
    await alice.waitForSelector('.hint >> text=You and Bob are contacts');
    await bob.waitForSelector('.chat-head >> text=Alice');
  });

  await step('the first-steps guide ticks off what is done and goes away', async () => {
    await alice.waitForSelector('.guide li.done >> text=Add a friend');
    assert.equal(await alice.locator('.guide li.done').count(), 1);
    await alice.click('.guide .btn >> text=Save a backup');
    await alice.fill('.f-bpass', 'backup passphrase');
    await alice.fill('.f-bpass2', 'backup passphrase');
    const [download] = await Promise.all([alice.waitForEvent('download'), alice.click('.btn >> text=Download the backup file')]);
    assert.match(download.suggestedFilename(), /^void-backup-Alice\.voidbackup$/);
    await wait(alice, () => document.querySelectorAll('.guide li.done').length === 2);
    await alice.click('.guide .btn >> text=Show me how');
    await alice.waitForSelector('.dialog >> text=iPhone, iPad, TV');
    await alice.click('.btn >> text=Got it');
    await wait(alice, () => !document.querySelector('.guide') && !document.querySelector('.overlay'));
    await bob.click('.guide .linkish');
    await wait(bob, () => !document.querySelector('.guide'));
  });

  await step('a message typed in the composer shows up on the other side', async () => {
    await alice.fill('.composer textarea', 'Hello Bob, no server involved');
    await alice.press('.composer textarea', 'Enter');
    await bob.waitForSelector('.bubble >> text=Hello Bob, no server involved');
    await bob.fill('.composer textarea', 'Hi Alice');
    await bob.press('.composer textarea', 'Enter');
    await alice.waitForSelector('.bubble >> text=Hi Alice');
    await alice.waitForSelector('.msg.mine .state.delivered');
  });

  await step('carol links to both; alice and bob lose their direct link and talk through carol', async () => {
    await pair(alice, carol);
    await pair(bob, carol);
    for (const p of [alice, bob]) await p.evaluate(() => window.voidNode.saveSettings({ autoDirect: false }));
    await alice.evaluate((u) => {
      const n = window.voidNode;
      for (const L of [...n.links.values()]) if (L.uidHex === u) n.closeLink(L, 'test');
    }, B);
    await wait(alice, (u) => window.voidNode.reach(u).state === 'relayed', B, 30000);
    await wait(bob, (u) => window.voidNode.reach(u).state === 'relayed', A, 30000);
    assert.equal((await reach(alice, B)).hops, 2);
    await alice.fill('.composer textarea', 'relayed through Carol');
    await alice.press('.composer textarea', 'Enter');
    await bob.waitForSelector('.bubble >> text=relayed through Carol');
    assert.ok(await carol.evaluate(() => window.voidNode.relays.size) >= 1);
    await alice.waitForSelector('.chat-head small.relayed');
    await alice.screenshot({ path: `${shots}/desktop-relayed.png` });
  });

  await step('the relayed route upgrades to a direct WebRTC link signalled through the mesh', async () => {
    for (const p of [alice, bob]) await p.evaluate(() => window.voidNode.saveSettings({ autoDirect: true }));
    await alice.evaluate(() => window.voidNode.run(() => window.voidNode.antiEntropy()));
    await bob.evaluate(() => window.voidNode.run(() => window.voidNode.antiEntropy()));
    await wait(alice, (u) => window.voidNode.reach(u).state === 'direct', B, 40000);
    await wait(bob, (u) => window.voidNode.reach(u).state === 'direct', A, 40000);
  });

  await step('a file crosses intact and an image shows a preview', async () => {
    const sum = await alice.evaluate(async () => {
      const bytes = new Uint8Array(300000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
      await window.voidApp.sendFile(new File([bytes], 'data.bin', { type: 'application/octet-stream' }), 'file');
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      const g = c.getContext('2d');
      g.fillStyle = '#4f46c8';
      g.fillRect(0, 0, 400, 300);
      g.fillStyle = '#fff';
      g.fillRect(120, 90, 160, 120);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await window.voidApp.sendFile(new File([blob], 'picture.png', { type: 'image/png' }), 'file');
      return bytes.reduce((a, b) => (a + b) % 1000003, 0);
    });
    await bob.waitForSelector('.att.file .chip');
    await bob.waitForSelector('.att.image img');
    const got = await bob.evaluate(async () => {
      const n = window.voidNode;
      const id = window.voidApp.active;
      const list = await n.messages(id);
      const att = list.find((m) => m.att && m.att[0] && m.att[0].name === 'data.bin').att[0];
      await n.fetchBlob(id, att);
      const bytes = await n.blobBytes(att);
      return { len: bytes.length, sum: bytes.reduce((a, b) => (a + b) % 1000003, 0) };
    });
    assert.deepEqual(got, { len: 300000, sum });
    await wait(bob, () => {
      const img = document.querySelector('.att.image img');
      return img && img.naturalWidth === 400 && !document.querySelector('.att.image .att-over');
    });
  });

  await step('video call both ways, screen sharing, mute, hang up, and calls switched off', async () => {
    await alice.click('.f-call-video');
    await bob.waitForSelector('.call.incoming >> text=Incoming video call');
    await bob.click('.f-accept-video');
    await alice.waitForSelector('.call.active.with-video', { timeout: 20000 });
    await bob.waitForSelector('.call.active.with-video', { timeout: 20000 });
    const playing = (p, height) => wait(p, (h) => {
      const v = document.querySelector('.call video.remote');
      // The sender may scale the picture down, so the shape is checked, not the size.
      return v && !v.paused && v.videoWidth > 0 && (!h || Math.abs(v.videoWidth / v.videoHeight - 16 / 9) < 0.03);
    }, height, 20000).catch(async (e) => {
      const seen = await p.evaluate(() => {
        const v = document.querySelector('.call video.remote');
        const c = window.voidApp.calls.call;
        return v ? { paused: v.paused, w: v.videoWidth, h: v.videoHeight, ready: v.readyState, tracks: v.srcObject ? v.srcObject.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`) : null, screen: !!(c && c.screen) } : 'no video element';
      });
      e.message += ` (wanted height ${height || 'any'}; saw ${JSON.stringify(seen)})`;
      throw e;
    });
    await playing(alice);
    await playing(bob);
    // The media is encrypted between the two devices, and the call says so.
    const secure = await alice.evaluate(async () => {
      let transport = null;
      (await window.voidApp.calls.call.pc.getStats()).forEach((x) => {
        if (x.type === 'transport') transport = x;
      });
      return { dtls: transport && transport.dtlsState, srtp: transport && transport.srtpCipher };
    });
    assert.equal(secure.dtls, 'connected');
    assert.ok(secure.srtp, 'the call has no SRTP cipher');
    console.log(`        call media cipher: ${secure.srtp}`);
    await alice.waitForSelector('.call-lock >> text=End-to-end encrypted');
    // ... twice: every frame is also sealed with the call's own 256-bit keys.
    for (const [who, p] of [['alice', alice], ['bob', bob]]) {
      const layer = await p.evaluate(async () => {
        const c = window.voidApp.calls.call;
        let codec = '';
        (await c.pc.getStats()).forEach((x) => {
          if (x.type === 'codec' && /video/i.test(x.mimeType)) codec = x.mimeType;
        });
        const frames = () => new Promise((resolve) => c.pc.getStats().then((st) => {
          let n = 0;
          st.forEach((x) => {
            if (x.type === 'inbound-rtp' && x.kind === 'video') n = x.framesDecoded || 0;
          });
          resolve(n);
        }));
        return {
          keys: !!c.keys, legacy: !!(c.seal && c.seal.legacy), codec, decoded: await frames(),
          transforms: c.seal && !c.seal.legacy ? c.pc.getTransceivers().every((t) => t.sender.transform && t.receiver.transform) : null,
          label: document.querySelector('.call-lock').textContent, double: !!document.querySelector('.call-lock.double'),
        };
      });
      assert.equal(layer.keys, true, `${who}: the call has no second layer`);
      assert.equal(layer.double, true);
      assert.match(layer.label, /twice/);
      assert.match(layer.codec, /VP8/i);
      if (layer.transforms !== null) assert.equal(layer.transforms, true, `${who}: a sender or receiver is not sealed`);
      assert.ok(layer.decoded > 0, `${who}: no sealed picture was decoded`);
      if (who === 'alice') console.log(`        second layer: AES-256-GCM per frame (${layer.legacy ? 'encoded streams' : 'script transform in a worker'}), ${layer.codec}`);
    }
    // With the wrong key nothing opens: the picture stops instead of showing noise.
    const before = await bob.evaluate(async () => {
      const c = window.voidApp.calls.call;
      const count = async () => {
        let n = 0;
        (await c.pc.getStats()).forEach((x) => {
          if (x.type === 'inbound-rtp' && x.kind === 'video') n = x.framesDecoded || 0;
        });
        return n;
      };
      if (c.seal.legacy) return null; // streams cannot be re-attached on this browser
      const video = c.pc.getTransceivers()[1];
      c.seal.attach(video.receiver, 'open', crypto.getRandomValues(new Uint8Array(32)));
      await new Promise((r) => setTimeout(r, 700));
      const a = await count();
      await new Promise((r) => setTimeout(r, 900));
      const b = await count();
      c.seal.attach(video.receiver, 'open', c.keys.caller.video);
      return { a, b };
    });
    if (before) assert.ok(before.b - before.a <= 1, `pictures kept being decoded with the wrong key (${before.a} -> ${before.b})`);
    await playing(bob);
    // Alice shares her screen (a drawn surface stands in for the screen picker).
    await alice.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const g = c.getContext('2d');
        let n = 0;
        setInterval(() => {
          g.fillStyle = n++ % 2 ? '#fff' : '#4f46c8';
          g.fillRect(0, 0, 640, 360);
        }, 100);
        return c.captureStream(10);
      };
    });
    await alice.click('.f-share');
    await playing(bob, 360);
    await alice.click('.f-mute');
    assert.equal(await alice.evaluate(() => window.voidApp.calls.call.mic.enabled), false);
    await bob.screenshot({ path: `${shots}/desktop-call.png` });
    await bob.click('.f-hangup');
    await wait(alice, () => !document.querySelector('.call'));
    await wait(bob, () => !document.querySelector('.call'));
    await alice.waitForSelector('.sys >> text=Video call');
    await bob.waitForSelector('.sys >> text=Video call');
    assert.equal(await alice.evaluate(() => window.voidApp.calls.call), null);

    // Bob turns calls off: his buttons go, and Alice is told.
    await bob.evaluate(() => window.voidNode.saveSettings({ calls: false }));
    await wait(bob, () => !document.querySelector('.f-call'));
    await alice.click('.f-call');
    await alice.waitForSelector('.toast >> text=does not take calls');
    await wait(alice, () => !document.querySelector('.call'));
    await bob.evaluate(() => window.voidNode.saveSettings({ calls: true }));
    await bob.waitForSelector('.f-call');
  });

  await step('group and channel', async () => {
    const C = await uid(carol);
    const g = await alice.evaluate((ids) => window.voidNode.createGroup('Weekend plans', ids), [B, C]);
    await wait(bob, (id) => window.voidNode.spaces.has(id), g);
    await wait(carol, (id) => window.voidNode.spaces.has(id), g);
    await carol.evaluate((id) => window.voidNode.sendMessage(id, { text: 'carol in the group' }), g);
    await wait(bob, async (id) => (await window.voidNode.messages(id)).some((m) => m.text === 'carol in the group'), g);
    const link = await alice.evaluate(async () => {
      const id = await window.voidNode.createChannel('Alice news');
      await window.voidNode.sendMessage(id, { text: 'first post' });
      return window.voidNode.spaceInfo(id).link;
    });
    const ch = await bob.evaluate(async (l) => (await window.voidNode.openLink(l)).id, link);
    await wait(bob, async (id) => (await window.voidNode.messages(id)).some((m) => m.text === 'first post'), ch);
    await bob.evaluate((id) => window.voidApp.open(id), ch);
    await bob.waitForSelector('.composer >> text=Only the owner posts');
    await bob.screenshot({ path: `${shots}/desktop-channel.png` });
  });

  await step('profile photo and bio, information panel, Advanced tab, local name, mute', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await alice.click('.me .head-id');
    const [chooser] = await Promise.all([alice.waitForEvent('filechooser'), alice.click('.f-photo')]);
    await chooser.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: png });
    await alice.waitForSelector('.photo-edit .avatar img');
    await alice.fill('.f-bio', 'Testing Void all day');
    await alice.click('.f-save-profile');
    await alice.waitForSelector('.toast.good >> text=Saved');
    await alice.keyboard.press('Escape');
    await alice.waitForSelector('.me .avatar img');

    // Bob sees the photo in his list, opens the panel by clicking the name.
    await bob.click('.chat-row strong:text-is("Alice")');
    await bob.waitForSelector('.chat-head .avatar img');
    await bob.click('.chat-head .head-id');
    await bob.waitForSelector('.dialog.info .info-head .avatar img');
    await bob.waitForSelector('.dialog.info >> text=Testing Void all day');
    await bob.waitForSelector('.dialog.info >> text=online · connected directly');
    await bob.waitForSelector('.dialog.info .info-row >> text=1 photo');
    await bob.waitForSelector('.dialog.info .info-row >> text=1 group in common');
    await bob.screenshot({ path: `${shots}/desktop-contact.png` });
    await bob.click('.f-advanced');
    await bob.waitForSelector(`.kv >> text=${A}`);
    await bob.waitForSelector('.dialog.info >> text=Their network address');
    await bob.waitForSelector('.dialog.info >> text=direct connection, device to device');
    await bob.screenshot({ path: `${shots}/desktop-advanced.png`, fullPage: true });
    await bob.click('.tabs button >> nth=0');
    await bob.click('.f-mute-chat');
    await wait(bob, () => window.voidNode.chats().find((c) => c.title === 'Alice').muted === true);
    await bob.click('.f-more');
    await bob.click('.popup >> text=Edit contact');
    await bob.fill('.f-alias', 'Alice from work');
    await bob.click('.btn.primary >> text=Save');
    await bob.waitForSelector('.info-name >> text=Alice from work');
    await bob.waitForSelector('.dialog.info >> text=calls themselves Alice');
    await bob.keyboard.press('Escape');
    await bob.waitForSelector('.chat-head >> text=Alice from work');
    await bob.evaluate(async () => {
      const n = window.voidNode;
      const c = n.contactList().find((x) => x.given === 'Alice');
      await n.setAlias(c.uid, '');
      await n.setMuted(c.dm, false);
    });
    await bob.waitForSelector('.chat-head strong:text-is("Alice")');
  });

  await step('link cards say what a link is, send later, auto-delete', async () => {
    await alice.click('.chat-row strong:text-is("Bob")');
    const links = await alice.evaluate(async () => {
      const n = window.voidNode;
      const ch = n.chats().find((c) => c.kind === 'chan');
      const g = await n.createGroup('Open house', [], { open: true });
      return { channel: n.spaceInfo(ch.id).link, group: n.spaceInfo(g).link, me: n.myLink() };
    });
    await alice.fill('.composer textarea', `my channel ${links.channel}`);
    await alice.press('.composer textarea', 'Enter');
    await alice.fill('.composer textarea', links.group);
    await alice.press('.composer textarea', 'Enter');
    await bob.waitForSelector('.linkcard:has-text("Public channel"):has-text("Alice news"):has-text("You are subscribed")');
    await bob.waitForSelector('.linkcard:has-text("Invitation to an open group"):has-text("Open house") .btn >> text=Join');
    await alice.waitForSelector('.linkcard:has-text("Open house"):has-text("You are a member")');
    assert.equal(await bob.evaluate(() => document.querySelector('.msgs').innerText.includes('false')), false, 'a stray value is shown in the conversation');
    await bob.screenshot({ path: `${shots}/desktop-linkcards.png` });
    await bob.click('.linkcard:has-text("Open house") .btn');
    await bob.waitForSelector('.dialog .warn >> text=This is the open group “Open house”');
    await bob.click('.code-input .btn.primary');
    await bob.waitForSelector('.chat-head >> text=Open house');
    await bob.click('.chat-row strong:text-is("Alice")');

    // Send later: the dialog opens from the composer; a short delay is set through the engine.
    await bob.fill('.composer textarea', 'sent later');
    await bob.click('.f-later');
    await bob.waitForSelector('.f-when');
    await bob.keyboard.press('Escape');
    await bob.fill('.composer textarea', '');
    await bob.evaluate(() => window.voidNode.scheduleMessage(window.voidApp.active, 'sent later', Date.now() + 1500));
    await bob.waitForSelector('.msg.later >> text=sent later');
    await alice.waitForSelector('.bubble >> text=sent later', { timeout: 20000 });
    await wait(bob, () => !document.querySelector('.msg.later'));

    await alice.click('.chat-head .head-id');
    await alice.click('.f-more');
    await alice.click('.popup >> text=Auto-delete');
    await alice.click('.dialog .menu button >> text=1 day');
    await bob.waitForSelector('.sys >> text=delete themselves after 1 day');
    await alice.keyboard.press('Escape');
    await wait(alice, () => !document.querySelector('.overlay'));
  });

  await step('the browser storage holds only ciphertext and opaque names', async () => {
    const C = await uid(carol);
    const disk = await readDisk(alice, 'void-alice-vault', ['Alice', 'Bob', 'Carol', 'Hello Bob', 'relayed through', 'Weekend plans', 'Alice news', 'first post', 'data.bin', 'picture.png', 'stun:', 'Testing Void', 'Open house', 'sent later', 'JFIF', A, B, C]);
    console.log(`        ${disk.records} records on disk`);
    assert.ok(disk.records > 30);
    assert.deepEqual(disk.readable, ['kv/vault'], 'only the vault header is stored unsealed');
    assert.deepEqual(disk.found, [], 'readable data found on disk');
    assert.equal(await alice.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort().join()), 'void-alice-vault');
  });

  await step('hiding the screen keeps the connections; only the password brings it back', async () => {
    await alice.click('.f-lockbtn');
    await alice.click('.f-hide');
    await alice.waitForSelector('.lockscreen');
    assert.equal(await alice.evaluate(() => document.getElementById('app').inert), true);
    await bob.evaluate(async () => {
      const n = window.voidNode;
      const c = n.chats().find((x) => x.kind === 'dm' && x.title === 'Alice');
      await n.sendMessage(c.id, { text: 'sent while hidden' });
    });
    await unlock(alice, 'wrong password');
    await alice.waitForSelector('.lockscreen .error >> text=Wrong password');
    await unlock(alice);
    await wait(alice, () => !document.querySelector('.lockscreen'));
    assert.equal((await reach(alice, B)).state, 'direct');
    await alice.click('.chat-row >> text=Bob');
    await alice.waitForSelector('.bubble >> text=sent while hidden');
  });

  await step('after an abrupt reload the profile is locked; the password restores identity and history, one pairing brings everyone back', async () => {
    // Simulate a crash: the page goes away without closing its links, so Bob and
    // Carol are left holding dead connections to Alice.
    await alice.evaluate(() => {
      window.voidNode.stop = () => {};
    });
    await alice.reload();
    await alice.waitForSelector('.f-unlock-pass');
    assert.equal(await alice.evaluate(() => typeof window.voidNode), 'undefined', 'nothing is loaded before the password');
    await unlock(alice, 'not the password');
    await alice.waitForSelector('.error >> text=Wrong password');
    await unlock(alice);
    await alice.waitForSelector('.shell');
    assert.equal(await uid(alice), A);
    assert.equal(await alice.evaluate(() => window.voidNode.links.size), 0);
    await alice.waitForSelector('.banner');
    assert.equal(await alice.locator('.guide').count(), 0, 'the guide stays dismissed');
    await alice.click('.chat-row >> text=Bob');
    await alice.waitForSelector('.bubble >> text=relayed through Carol');
    await pair(alice, carol);
    await wait(alice, (u) => window.voidNode.reach(u).state !== 'offline', B, 30000);
    await wait(alice, (u) => window.voidNode.reach(u).state === 'direct', B, 40000);
  });

  await step('changing the password, then locking: the old one no longer works', async () => {
    await bob.click('.me .icon-btn >> nth=3');
    await bob.click('summary >> text=Change password');
    await bob.fill('.f-cur', PASSWORD);
    await bob.fill('.f-new', 'a brand new password');
    await bob.fill('.f-new2', 'a brand new password');
    await bob.click('.btn >> text=Change password');
    await bob.waitForSelector('.toast.good >> text=Password changed');
    await bob.keyboard.press('Escape');
    await bob.click('.f-lockbtn');
    await bob.click('.f-lock');
    await bob.waitForSelector('.f-unlock-pass');
    await unlock(bob, PASSWORD);
    await bob.waitForSelector('.error >> text=Wrong password');
    await unlock(bob, 'a brand new password');
    await bob.waitForSelector('.shell');
    assert.equal(await uid(bob), B);
    await wait(carol, (u) => window.voidNode.reach(u).state === 'offline', B, 20000);
  });

  await step('a profile saved without encryption by an older version is encrypted on first open', async () => {
    const old = await open('legacy');
    await old.waitForSelector('.f-name');
    await old.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('void-legacy', 1);
        r.onupgradeneeded = () => {
          for (const b of ['kv', 'contacts', 'spaces', 'events', 'blobs', 'courier']) r.result.createObjectStore(b);
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ seed: crypto.getRandomValues(new Uint8Array(32)), dev: crypto.getRandomValues(new Uint8Array(8)), name: 'Old Timer', ts: Date.now(), k: 2 }, 'id');
      await new Promise((res) => (tx.oncomplete = res));
      db.close();
    });
    await old.reload();
    await old.waitForSelector('text=Welcome back, Old Timer');
    await old.fill('.f-pass', PASSWORD);
    await old.fill('.f-pass2', PASSWORD);
    await old.click('.f-start');
    await old.waitForSelector('.shell');
    await old.waitForSelector('.me >> text=Old Timer');
    assert.equal(await old.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).sort().join()), 'void-legacy-vault', 'the unencrypted copy is gone');
    const disk = await readDisk(old, 'void-legacy-vault', ['Old Timer']);
    assert.deepEqual([disk.readable, disk.found], [['kv/vault'], []]);
    await old.reload();
    await old.waitForSelector('.f-unlock-pass');
    await old.context().close();
  });

  await step('a profile made with the earlier keys is not loaded: the page says why and lets it be erased', async () => {
    const page = await open('ancient');
    await signUp(page, 'Ancient');
    // Make the stored identity look like one from before the key change.
    await page.evaluate(async () => {
      const rec = await window.voidNode.store.get('kv', 'id');
      delete rec.k;
      await window.voidNode.store.put('kv', 'id', rec);
    });
    await page.reload();
    await unlock(page);
    await page.waitForSelector('.outdated >> text=new, stronger keys');
    assert.equal(await page.evaluate(() => !!document.querySelector('.shell')), false, 'the old profile was loaded');
    page.once('dialog', (d) => d.accept());
    await page.click('.f-erase-old');
    await page.waitForSelector('.f-name');
    assert.equal(await page.evaluate(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('void-ancient-vault');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const n = await new Promise((res) => {
        const q = db.transaction('kv').objectStore('kv').count();
        q.onsuccess = () => res(q.result);
      });
      db.close();
      return n;
    }), 0, 'the old profile is still on disk');
    await page.context().close();
  });

  await step('phone layout', async () => {
    const phone = await open('dave', { width: 390, height: 800 });
    await phone.screenshot({ path: `${shots}/phone-setup.png` });
    await signUp(phone, 'Dave');
    await pair(phone, carol);
    await phone.click('.chat-row');
    await phone.fill('.composer textarea', 'from a phone-sized screen');
    await phone.click('.composer .icon-btn.primary');
    await phone.waitForSelector('.bubble >> text=from a phone-sized screen');
    await phone.screenshot({ path: `${shots}/phone-chat.png` });
    await phone.click('.chat-head .back');
    await phone.screenshot({ path: `${shots}/phone-list.png` });
    await phone.click('.me .icon-btn >> nth=0');
    await phone.waitForSelector('.code-card canvas.qr');
    await phone.screenshot({ path: `${shots}/phone-invite.png` });
  });

  if (slow) {
    await step('a reply carried by hand 50 seconds later still connects', async () => {
      const e = await open('erin');
      const f = await open('frank');
      await signUp(e, 'Erin');
      await signUp(f, 'Frank');
      await pair(e, f, 50000);
    });
  }

  assert.deepEqual(requests, [], 'the page made network requests');
  assert.deepEqual(sockets, [], 'the page opened sockets although both public helpers were off');
  assert.deepEqual(problems, [], 'console errors');
  console.log('\nAll browser checks passed. With both public helpers off the page contacted nothing.');

  // ---- with the defaults a real user gets -------------------------------------
  // These two checks need the internet and third-party services, so they are
  // reported, not counted in the pass/fail result above.
  console.log('\nWith the default settings (public helpers on):');
  const x = await open('xavier', undefined, '1');
  const y = await open('yvonne', undefined, '1');
  await signUp(x, 'Xavier');
  await signUp(y, 'Yvonne');
  const stun = await x.evaluate(async () => {
    const t = Date.now();
    const o = await window.voidNode.rtc.offer();
    o.cancel();
    return { code: [...o.code], ms: Date.now() - t };
  });
  const kinds = cbor.decode(Uint8Array.from(stun.code)).c.map((c) => (c[0] === 1 ? 'public' : 'local'));
  console.log(`  public address: ${kinds.includes('public') ? 'obtained' : 'NOT obtained (STUN servers unreachable from here)'}; invite ready in ${stun.ms} ms with ${kinds.join(', ')} addresses`);
  try {
    // An invite link: Xavier copies it and closes the window; Yvonne opens it.
    // Nothing is sent back by hand.
    await x.click('.guide .btn.primary');
    await x.waitForSelector('.f-invite-link');
    const link = await x.inputValue('.f-invite-link');
    assert.match(link, /^void:u:/);
    await x.click('.f-copy-link');
    await x.waitForSelector('.toast >> text=Link copied');
    assert.equal(await x.evaluate(() => navigator.clipboard.readText()), link);
    await x.screenshot({ path: `${shots}/desktop-invite-link.png` });
    await x.keyboard.press('Escape');
    const [X, Y] = [await uid(x), await uid(y)];
    const t1 = Date.now();
    await y.click('.me .f-add');
    await y.click('.f-tab-theirs');
    await y.fill('.code-input textarea', link);
    await y.screenshot({ path: `${shots}/desktop-invited.png` });
    await y.click('.code-input .btn.primary');
    await wait(x, (u) => window.voidNode.reach(u).state === 'direct', Y, 45000);
    await wait(y, (u) => window.voidNode.reach(u).state === 'direct', X, 45000);
    await x.waitForSelector('.toast >> text=opened your invite');
    console.log(`  invite link: ${link.length} characters; opened on the other device, contacts and connected ${Date.now() - t1} ms later, nothing sent back`);
    await x.waitForFunction(() => window.voidNode.netStatus().rdv && window.voidNode.netStatus().rdv.open > 0, null, { timeout: 15000 });
    const relays = await x.evaluate(() => window.voidNode.netStatus().rdv);
    // Both pages go away and come back: no link is left, and nobody exchanges a code.
    await Promise.all([x.reload(), y.reload()]);
    await x.waitForSelector('.f-unlock-pass');
    await y.waitForSelector('.f-unlock-pass');
    const t0 = Date.now();
    await Promise.all([unlock(x), unlock(y)]);
    await x.waitForSelector('.shell');
    await y.waitForSelector('.shell');
    await wait(x, (u) => window.voidNode.reach(u).state === 'direct', Y, 45000);
    await wait(y, (u) => window.voidNode.reach(u).state === 'direct', X, 45000);
    console.log(`  automatic reconnection: both pages reloaded and found each other in ${Date.now() - t0} ms through ${relays.open} of ${relays.total} public relays, with no code exchanged`);
    await y.evaluate(async () => {
      const n = window.voidNode;
      await n.sendMessage(n.chats()[0].id, { text: 'back without a code' });
    });
    await x.click('.chat-row');
    await x.waitForSelector('.bubble >> text=back without a code');
    await x.screenshot({ path: `${shots}/desktop-reconnected.png` });
    console.log(`  sockets opened by one page: ${[...new Set(sockets.filter((u) => u.startsWith('xavier')).map((u) => u.split(' ')[1]))].join(', ')}`);
  } catch (e) {
    console.log(`  automatic reconnection: FAILED here (${String(e.message).split('\n')[0]})`);
  }
} catch (e) {
  console.error('\nFAILED:', e.message);
  if (problems.length) console.error('console errors:\n  ' + problems.join('\n  '));
  process.exitCode = 1;
} finally {
  await browser.close();
}
