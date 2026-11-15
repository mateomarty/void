// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds dist/void.html: one self-contained file with the script and styles inlined.
// Usage: node build.mjs [--dev]   (--dev keeps the code readable)

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const dev = process.argv.includes('--dev');

const result = await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: !dev,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});

// The script is inlined, so a literal closing tag inside it must not end the element.
const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const css = (await readFile('src/styles.css', 'utf8')).replace(/<\/(style)/gi, '<\\/$1');
const hash = createHash('sha256').update(js).digest('base64');

// Only the bundled script may run. The page may not load or fetch anything over
// HTTP. WebSockets are allowed because the optional rendezvous relays use them.
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${hash}'`,
  "style-src 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob:',
  'worker-src blob:', // the worker that seals call frames; its script is part of this file
  'connect-src wss:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// When package.json names a repository, the file says where its source is.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url;
const source = repo ? ` Source code: ${repo.replace(/^git\+/, '').replace(/\.git$/, '')}` : '';

const html = (await readFile('src/index.html', 'utf8'))
  .replace('__SOURCE__', source)
  .replace('__CSP__', csp)
  .replace('__CSS__', () => css)
  .replace('__JS__', () => js);

await mkdir('dist', { recursive: true });
await writeFile('dist/void.html', html);
await rm('dist/void.zip', { force: true });
try {
  execFileSync('zip', ['-j', '-q', '-9', 'dist/void.zip', 'dist/void.html']);
} catch {
  console.warn('zip not available: dist/void.zip was not created');
}
console.log(`dist/void.html  ${(html.length / 1024).toFixed(0)} KB${dev ? '  (dev build)' : ''}`);
