// SPDX-License-Identifier: AGPL-3.0-or-later
// Password screens: first run, unlocking, protecting an older profile, and the
// privacy screen that hides the conversations while the page stays connected.

import { h, button, icon } from './dom.js';
import { unb64u } from '../core/bytes.js';
import { MIN_PASSWORD } from '../core/vault.js';

const passInput = (cls, placeholder, fresh) => h('input', { class: cls, type: 'password', placeholder, autocomplete: fresh ? 'new-password' : 'current-password' });

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint && h('small', null, hint));
}

// Runs an action from a button: disables it, shows progress, reports the error.
function guarded(btn, err, fn) {
  const label = btn.textContent;
  return async () => {
    err.textContent = '';
    btn.disabled = true;
    btn.lastChild.textContent = 'Working…';
    try {
      await fn();
    } catch (e) {
      err.textContent = e.message || String(e);
      btn.disabled = false;
      btn.lastChild.textContent = label;
    }
  };
}

export function newPassword(a, b) {
  if (a.value.length < MIN_PASSWORD) throw new Error(`Choose a password of at least ${MIN_PASSWORD} characters`);
  if (a.value !== b.value) throw new Error('The two passwords are not the same');
  return a.value;
}

const NO_RECOVERY = 'There is no way to recover a forgotten password: nobody else holds your data. Keep a backup file somewhere safe.';

// A password field with a button to show what is being typed.
function secretField(cls, placeholder, fresh) {
  const input = passInput(cls, placeholder, fresh);
  const eye = h('button', { class: 'icon-btn eye', type: 'button', title: 'Show or hide', 'aria-label': 'Show or hide the password', onclick: () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    eye.classList.toggle('on', input.type === 'text');
  } }, icon('eye', 18));
  return { input, el: h('div', { class: 'secret' }, input, eye) };
}

export function setupScreen(root, { onCreate, onRestore, persistent }) {
  const name = h('input', { class: 'f-name', type: 'text', maxLength: 64, placeholder: 'For example your first name', autocomplete: 'off' });
  const p1 = secretField('f-pass', 'At least 8 characters', true);
  const p2 = secretField('f-pass2', 'Type it again', true);
  const err = h('p', { class: 'error', role: 'alert' });
  const long = h('li', null, `${MIN_PASSWORD} characters or more`);
  const same = h('li', null, 'Typed the same twice');
  const check = () => {
    long.classList.toggle('ok', p1.input.value.length >= MIN_PASSWORD);
    same.classList.toggle('ok', p1.input.value.length > 0 && p1.input.value === p2.input.value);
  };
  p1.input.addEventListener('input', check);
  p2.input.addEventListener('input', check);
  const create = button('Create my profile', null, { kind: 'primary f-start' });
  create.onclick = guarded(create, err, () => onCreate(name.value.trim() || 'Anonymous', newPassword(p1.input, p2.input)));
  for (const el of [name, p1.input, p2.input]) el.addEventListener('keydown', (e) => e.key === 'Enter' && create.click());

  const file = h('input', { type: 'file', accept: '.voidbackup,application/octet-stream' });
  const backupPass = passInput('f-backup-pass', 'Passphrase of the backup');
  const r1 = passInput('f-rpass', 'Password for this device', true);
  const r2 = passInput('f-rpass2', 'Repeat the password', true);
  const restore = button('Restore my profile', null, { kind: 'f-restore' });
  restore.onclick = guarded(restore, err, async () => {
    if (!file.files[0]) throw new Error('Choose a backup file first');
    const password = newPassword(r1, r2);
    let bytes = new Uint8Array(await file.files[0].arrayBuffer());
    if (bytes[0] !== 0x56) bytes = unb64u(new TextDecoder().decode(bytes).trim());
    await onRestore(bytes, backupPass.value, password);
  });

  const point = (ico, title, text) => h('li', null, icon(ico, 22), h('div', null, h('strong', null, title), h('span', null, text)));
  root.replaceChildren(h('div', { class: 'setup' },
    h('div', { class: 'logo' }, 'Void'),
    h('p', { class: 'lead' }, 'Private messaging between your devices and your contacts’ devices. Nothing to install, no account to open.'),
    h('ul', { class: 'points' },
      point('user', 'No account', 'No phone number, no email. Your identity is a key made on this device.'),
      point('lock', 'Locked with your password', 'Everything Void keeps here is encrypted. Only your password opens it.'),
      point('wifi', 'Straight to your contacts', 'Messages go from device to device, or through your contacts’ devices. Never through a server of ours.')),
    h('div', { class: 'card' },
      h('h2', null, 'Create your profile'),
      field('Your name, as your contacts will see it', name),
      field('Choose a password', p1.el),
      field('Repeat the password', p2.el),
      h('ul', { class: 'checks' }, long, same),
      create,
      h('p', { class: 'muted small' }, NO_RECOVERY)),
    h('details', { class: 'card' },
      h('summary', null, 'I already use Void on another device'),
      h('p', { class: 'muted' }, 'Bring the backup file you saved there (Settings › Backup).'),
      field('Backup file', file), field('Passphrase of the backup', backupPass),
      field('Password for this device', r1), field('Repeat the password', r2), restore),
    err,
    !persistent && h('p', { class: 'warn' }, 'This browser did not allow permanent storage. You can still use Void, but your identity will be lost when the page closes unless you export a backup.')));
  name.focus();
}

export function unlockScreen(root, { profile, onUnlock, onErase }) {
  const pass = passInput('f-unlock-pass', 'Password');
  const err = h('p', { class: 'error', role: 'alert' });
  const go = button('Unlock', null, { kind: 'primary f-unlock', ico: 'lock' });
  go.onclick = guarded(go, err, async () => {
    try {
      await onUnlock(pass.value);
    } catch (e) {
      pass.select();
      throw e;
    }
  });
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  root.replaceChildren(h('div', { class: 'setup' },
    h('div', { class: 'logo' }, 'Void'),
    h('p', { class: 'lead' }, profile ? `Profile “${profile}” is locked.` : 'Your profile is locked.'),
    h('div', { class: 'card' }, field('Password', pass), go, err),
    h('details', { class: 'card' },
      h('summary', null, 'I forgot my password'),
      h('p', { class: 'muted' }, NO_RECOVERY + ' You can erase this profile and start again, then restore a backup if you have one.'),
      button('Erase this profile', () => confirm('Erase this profile from this browser? This cannot be undone.') && onErase(), { kind: 'danger', ico: 'trash' }))));
  pass.focus();
}

// Shown for a profile made with the keys of an earlier version. It cannot be
// carried over: with new keys its user id changes, and nothing in it would match.
export function outdatedScreen(root, { name, onErase }) {
  root.replaceChildren(h('div', { class: 'setup' },
    h('div', { class: 'logo' }, 'Void'),
    h('p', { class: 'lead' }, name ? `The profile “${name}” was made by an earlier version of Void.` : 'This profile was made by an earlier version of Void.'),
    h('div', { class: 'card outdated' },
      h('h2', null, 'This version uses new, stronger keys'),
      h('p', null, 'Identities are now on a 448-bit curve, and every connection adds a key exchange that resists quantum computers. A profile made before that change cannot be carried over, and devices running this version no longer accept its keys.'),
      h('p', null, 'To keep something from it, open it once more with the earlier file and export the conversations you want. Then erase it here, create a new profile and invite your contacts again; they need this version too.'),
      button('Erase the old profile and start again', () => confirm('Erase the old profile from this browser? This cannot be undone.') && onErase(), { kind: 'danger f-erase-old', ico: 'trash' }))));
}

// Shown once for a profile created before storage was encrypted.
export function protectScreen(root, { name, onProtect }) {
  const p1 = passInput('f-pass', 'Password', true);
  const p2 = passInput('f-pass2', 'Repeat the password', true);
  const err = h('p', { class: 'error', role: 'alert' });
  const go = button('Encrypt my profile', null, { kind: 'primary f-start', ico: 'lock' });
  go.onclick = guarded(go, err, () => onProtect(newPassword(p1, p2)));
  for (const el of [p1, p2]) el.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  root.replaceChildren(h('div', { class: 'setup' },
    h('div', { class: 'logo' }, 'Void'),
    h('p', { class: 'lead' }, `Welcome back, ${name}. Void now encrypts everything it stores on this device.`),
    h('div', { class: 'card' },
      h('h2', null, 'Choose a password'),
      field('Password', p1, 'Your identity, contacts and messages will be encrypted with it. You enter it each time you open Void.'),
      field('Repeat the password', p2), go,
      h('p', { class: 'muted small' }, NO_RECOVERY)),
    err));
  p1.focus();
}

// Covers the whole window until the password is entered. The page keeps running
// behind it, so the connections stay up. Resolves once the password was right.
export function privacyScreen(verify) {
  return new Promise((resolve) => {
    const pass = passInput('f-unlock-pass', 'Password');
    const err = h('p', { class: 'error', role: 'alert' });
    const go = button('Show', null, { kind: 'primary f-unlock', ico: 'eye' });
    const others = [...document.body.children];
    for (const el of others) el.inert = true;
    const screen = h('div', { class: 'lockscreen' }, h('div', { class: 'setup' },
      h('div', { class: 'logo' }, 'Void'),
      h('p', { class: 'lead' }, 'Hidden. Still connected: messages keep arriving.'),
      h('div', { class: 'card' }, field('Password', pass), go, err)));
    go.onclick = guarded(go, err, async () => {
      try {
        await verify(pass.value);
      } catch (e) {
        pass.select();
        throw e;
      }
      for (const el of others) el.inert = false;
      screen.remove();
      resolve();
    });
    pass.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
    document.body.append(screen);
    pass.focus();
  });
}

