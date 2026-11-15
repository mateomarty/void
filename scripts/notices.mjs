// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes THIRD-PARTY-NOTICES.md from the license files of the libraries bundled into dist/void.html.
import { readFile, writeFile } from 'node:fs/promises';

const bundled = ['@noble/curves', '@noble/hashes', '@noble/ciphers', '@noble/post-quantum', 'qrcode-generator', 'jsqr'];
let out = '# Third-party notices\n\nThese libraries are bundled into `dist/void.html`. Development-only tools (esbuild, playwright-core, @hpke/*) are not distributed.\n';
for (const name of bundled) {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  const author = typeof pkg.author === 'string' ? pkg.author : (pkg.author && pkg.author.name) || '';
  let text = '';
  try {
    text = await readFile(`node_modules/${name}/LICENSE`, 'utf8');
  } catch {
    text = `Licensed under the ${pkg.license} license. The package ships no license file; see ${pkg.homepage || pkg.repository?.url || 'its repository'}.`;
  }
  out += `\n## ${name} ${pkg.version}\n\nLicense: ${pkg.license}${author ? `. Author: ${author}` : ''}\n\n\`\`\`text\n${text.trim()}\n\`\`\`\n`;
}
await writeFile('THIRD-PARTY-NOTICES.md', out);
console.log(`THIRD-PARTY-NOTICES.md  ${bundled.length} packages`);
