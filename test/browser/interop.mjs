// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-browser check: two different browser engines pair, exchange messages and a
// file, in both offer/answer directions. Usage: node test/browser/interop.mjs [a-b ...]
// where a and b are chromium, firefox or webkit. Without arguments, runs every pair.

import { chromium, firefox, webkit } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const engines = { chromium, firefox, webkit };
// VOID_URL lets the same check run against a copy served over plain http.
const file = process.env.VOID_URL || pathToFileURL(resolve('dist/void.html')).href;
const names = Object.keys(engines);
const pairs = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => p.split('-'))
  : names.flatMap((a) => names.map((b) => [a, b]));

const launched = new Map();
async function launch(name) {
  if (!launched.has(name)) {
    launched.set(name, await engines[name].launch(name === 'chromium' ? { channel: 'chrome', headless: true } : { headless: true }));
  }
  return launched.get(name);
}

async function open(engine, profile, errors) {
  const ctx = await (await launch(engine)).newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${profile}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${profile}: ${m.text()}`));
  await page.goto(`${file}?profile=${profile}&debug=offline`);
  await page.fill('.f-name', profile);
  await page.fill('.f-pass', 'interop password');
  await page.fill('.f-pass2', 'interop password');
  await page.click('.f-start');
  await page.waitForSelector('.shell', { timeout: 20000 });
  return page;
}

async function check(offerer, answerer) {
  const errors = [];
  const a = await open(offerer, 'offerer', errors);
  const b = await open(answerer, 'answerer', errors);
  try {
    const info = await a.evaluate(() => ({ secure: window.isSecureContext, idb: window.voidNode.store.persistent }));
    const invite = await a.evaluate(async () => {
      window.inv = await window.voidNode.invite();
      return window.inv.code;
    });
    const reply = await b.evaluate(async (code) => {
      window.joined = await window.voidNode.join(code);
      return window.joined.code;
    }, invite);
    await a.evaluate((code) => window.inv.complete(code), reply);
    const opts = { timeout: 20000, polling: 100 };
    await a.waitForFunction(() => window.voidNode.links.size === 1, null, opts);
    await b.waitForFunction(() => window.voidNode.links.size === 1, null, opts);
    for (const [from, to, text] of [[a, b, 'offerer to answerer'], [b, a, 'answerer to offerer']]) {
      await from.evaluate(async (t) => {
        const n = window.voidNode;
        await n.sendMessage(n.chats()[0].id, { text: t });
      }, text);
      await to.waitForFunction(async (t) => {
        const n = window.voidNode;
        return (await n.messages(n.chats()[0].id)).some((m) => m.text === t);
      }, text, opts);
    }
    const sum = await a.evaluate(async () => {
      const n = window.voidNode;
      const bytes = new Uint8Array(200000).map((_, i) => (i * 13 + 5) & 255);
      const att = await n.addBlob(bytes, { name: 'interop.bin' });
      await n.sendMessage(n.chats()[0].id, { att: [att] });
      return bytes.reduce((x, y) => (x + y) % 1000003, 0);
    });
    const got = await b.evaluate(async () => {
      const n = window.voidNode;
      const id = n.chats()[0].id;
      for (let i = 0; i < 100; i++) {
        const m = (await n.messages(id)).find((x) => x.att && x.att.length);
        if (m) {
          await n.fetchBlob(id, m.att[0]);
          return (await n.blobBytes(m.att[0])).reduce((x, y) => (x + y) % 1000003, 0);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return -1;
    });
    if (got !== sum) throw new Error('file content differs');
    if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
    return `ok  (secure context: ${info.secure}, permanent storage: ${info.idb})`;
  } finally {
    await a.context().close();
    await b.context().close();
  }
}

let failed = 0;
for (const [x, y] of pairs) {
  const label = `${x} offers, ${y} answers`.padEnd(36);
  try {
    console.log(`${label} ${await check(x, y)}`);
  } catch (e) {
    failed++;
    console.log(`${label} FAILED: ${String(e.message).split('\n')[0]}`);
  }
}
for (const b of launched.values()) await b.close();
process.exitCode = failed ? 1 : 0;
