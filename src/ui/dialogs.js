// SPDX-License-Identifier: AGPL-3.0-or-later
// Dialogs: connecting, creating conversations, conversation details, settings.

import { h, icon, button, iconButton, avatar, size, copyText, saveBlob } from './dom.js';
import { qrCanvas, canScan, scan } from './qr.js';
import { readLink, readCard } from '../core/keys.js';
import { newPassword } from './lock.js';
import { photoEditor } from './info.js';
import { PROTOCOL } from '../core/proto.js';

export function toast(text, kind = '') {
  const el = h('div', { class: 'toast ' + kind, role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('gone'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// Opens a modal. Returns { body, close, onclose }.
export function dialog(title, { wide = false } = {}) {
  const body = h('div', { class: 'dialog-body' });
  const d = { body, onclose: null, close: null };
  const heading = h('h2', null, title);
  const card = h('div', { class: 'dialog' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, heading, iconButton('close', 'Close', () => d.close())),
    body);
  d.title = heading;
  d.card = card;
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && d.close() }, card);
  const onKey = (e) => e.key === 'Escape' && d.close();
  d.close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (d.onclose) d.onclose();
  };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return d;
}

function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', null, label), input, hint && h('small', null, hint));
}

// A code shown as QR plus copyable text.
function codeCard(code, caption) {
  const text = h('textarea', { class: 'code', readOnly: true, rows: 3, value: code, onfocus: (e) => e.target.select() });
  const actions = h('div', { class: 'row' },
    button('Copy', async () => toast((await copyText(code)) ? 'Copied' : 'Select the text and copy it by hand'), { ico: 'copy' }),
    navigator.share && button('Share', () => navigator.share({ text: code }).catch(() => {}), { ico: 'send' }));
  return h('div', { class: 'code-card' }, caption && h('p', { class: 'muted' }, caption), h('div', { class: 'qr-wrap' }, qrCanvas(code)), text, actions);
}

// A box to paste a code into, with a camera button where scanning is possible.
function codeInput(placeholder, accept, onCode, action = 'Continue') {
  const ta = h('textarea', { class: 'code', rows: 3, placeholder, spellcheck: false, autocapitalize: 'off' });
  const cam = h('div', { class: 'scan-host' });
  const err = h('p', { class: 'error' });
  let scanner = null;
  const submit = async (value) => {
    err.textContent = '';
    const m = /void:[a-z]:[A-Za-z0-9_-]+/.exec(value || '');
    if (!m || !accept(m[0])) {
      err.textContent = 'This does not look like the right kind of code.';
      return;
    }
    try {
      await onCode(m[0]);
    } catch (e) {
      err.textContent = e.message || String(e);
    }
  };
  ta.addEventListener('paste', () => setTimeout(() => /void:[a-z]:/.test(ta.value) && submit(ta.value), 0));
  const scanBtn = canScan() && button('Scan QR code', async () => {
    if (scanner) {
      scanner.stop();
      scanner = null;
      return;
    }
    scanner = scan(cam, (t) => /void:[a-z]:/.test(t) && accept(/void:[a-z]:[A-Za-z0-9_-]+/.exec(t)[0]));
    try {
      const code = await scanner.result;
      scanner = null;
      ta.value = code;
      submit(code);
    } catch (e) {
      scanner = null;
      if (e.message !== 'Cancelled') err.textContent = 'Camera not available: ' + (e.message || e.name);
    }
  }, { ico: 'qr' });
  const el = h('div', { class: 'code-input' }, cam, ta, h('div', { class: 'row' }, button(action, () => submit(ta.value), { kind: 'primary' }), scanBtn), err);
  el.stop = () => scanner && scanner.stop();
  return el;
}

const isKind = (k) => (code) => {
  const d = readLink(code);
  return !!d && d.kind === k;
};

// ---- connecting ---------------------------------------------------------------

// Adding a friend. Two tabs, one per side: "I invite them" gives something to
// send, "They invited me" takes what was received. With the public relays on, the
// invite is a link that needs nothing in return. Without them, it is a pair of
// one-time codes exchanged while both windows stay open.
export function openPair(app, presetInvite = null) {
  const node = app.node;
  const d = dialog('Add a friend');
  const relays = !!node.netStatus().rdv;
  let codes = !relays; // one-time codes instead of a link
  let tab = presetInvite ? 'theirs' : 'mine';
  let pending = null; // a one-time invite or reply waiting for the other side
  let input = null;
  let turn = 0;
  const before = new Set(node.netStatus().links.map((l) => l.uid));
  const drop = () => {
    if (pending) pending.cancel();
    if (input) input.stop();
    pending = null;
    input = null;
  };
  d.onclose = drop;

  const done = async () => {
    pending = null;
    d.close();
    toast('Connected', 'good');
    for (let i = 0; i < 30; i++) { // open the conversation with whoever just got linked
      const fresh = node.netStatus().links.find((l) => !before.has(l.uid) && !l.self);
      const c = fresh && node.contacts.get(fresh.uid);
      if (c && c.dm) return app.open(c.dm);
      await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
  };

  const tabs = () => h('div', { class: 'seg', role: 'tablist' },
    h('button', { type: 'button', role: 'tab', class: 'f-tab-mine' + (tab === 'mine' ? ' on' : ''), onclick: () => show('mine') }, icon('send', 18), 'I invite them'),
    h('button', { type: 'button', role: 'tab', class: 'f-tab-theirs' + (tab === 'theirs' ? ' on' : ''), onclick: () => show('theirs') }, icon('download', 18), 'They invited me'));
  const other = () => relays && h('button', { class: 'linkish other', type: 'button', onclick: () => {
    codes = !codes;
    show(tab);
  } }, codes ? 'Back to the invite link' : 'No public relays? Use one-time codes instead');
  const paint = (mark, ...content) => mark === turn && d.body.replaceChildren(tabs(), ...content.filter(Boolean), other() || '');
  const fail = (mark, e) => paint(mark, h('p', { class: 'error' }, e.message || String(e)), button('Try again', () => show(tab)));

  // They sent me a one-time invite: answer it and show my reply.
  const answer = async (invite) => {
    const mark = ++turn;
    drop();
    tab = 'theirs';
    codes = true;
    paint(mark, h('p', { class: 'muted wait' }, 'Preparing…'));
    try {
      const j = await node.join(invite);
      if (mark !== turn) return void j.cancel();
      pending = j;
      paint(mark,
        h('ol', { class: 'steps' },
          h('li', { class: 'done' }, 'You entered their code.'),
          h('li', { class: 'now' }, h('strong', null, 'Send this reply back to your friend.'), ' They paste it in the window where they made their code.'),
          h('li', null, 'This window closes by itself once you are connected.')),
        codeCard(j.code),
        h('p', { class: 'muted small wait' }, 'Waiting for your friend’s device…'));
      j.done.then(done, (e) => pending === j && fail(mark, e));
    } catch (e) {
      fail(mark, e);
    }
  };

  async function show(which) {
    const mark = ++turn;
    drop();
    tab = which;
    paint(mark, h('p', { class: 'muted wait' }, 'Preparing…'));
    try {
      if (tab === 'mine' && !codes) {
        // ---- I invite them, with a link
        const link = await node.createInviteLink();
        if (mark !== turn) return;
        const field1 = h('input', { class: 'code f-invite-link', type: 'text', readOnly: true, value: link, onfocus: (e) => e.target.select() });
        paint(mark,
          h('ol', { class: 'steps big' },
            h('li', { class: 'now' }, h('strong', null, 'Send this link to your friend'), ', in a message, a mail, anything.',
              h('div', { class: 'row' },
                button('Copy the link', async () => toast((await copyText(link)) ? 'Link copied. Send it to your friend.' : 'Select the link and copy it by hand', 'good'), { kind: 'primary f-copy-link', ico: 'copy' }),
                navigator.share && button('Share', () => navigator.share({ text: link }).catch(() => {}), { ico: 'share' })),
              field1),
            h('li', null, 'Your friend opens Void, chooses ', h('strong', null, 'Add a friend › They invited me'), ' and pastes it.'),
            h('li', null, h('strong', null, 'That is all.'), ' You are connected as soon as you are both online. Nothing comes back to you, and you can close this window.')),
          h('details', { class: 'qr-more' }, h('summary', null, 'Show a QR code instead (to scan with a phone)'), h('div', { class: 'qr-wrap' }, qrCanvas(link))),
          h('p', { class: 'muted small' }, 'One link per friend. It works for two weeks. When someone appears, check that the name is the one you expect.'));
      } else if (tab === 'theirs' && !codes) {
        // ---- they invited me, with a link
        input = codeInput('Paste the link here', (c) => ['u', 'i'].includes((readLink(c) || {}).kind), async (code) => {
          if (isKind('i')(code)) return answer(code);
          const res = await node.openLink(code);
          d.close();
          toast('Done. You will be connected as soon as you are both online.', 'good');
          return res.id && app.open(res.id);
        }, 'Add this friend');
        paint(mark, h('p', null, h('strong', null, 'Paste the link your friend sent you.'), ' You will be connected as soon as you are both online.'), input);
        if (presetInvite) input.querySelector('textarea').value = presetInvite;
      } else if (tab === 'mine') {
        // ---- I invite them, with one-time codes
        const inv = await node.invite();
        if (mark !== turn) return void inv.cancel();
        pending = inv;
        input = codeInput('Paste their reply here', (c) => isKind('r')(c) || isKind('i')(c), async (code) => {
          if (isKind('i')(code)) return answer(code); // they made a code too: answer theirs
          await inv.complete(code);
          return done();
        }, 'Connect');
        paint(mark,
          h('ol', { class: 'steps' },
            h('li', { class: 'now' }, h('strong', null, 'Send this code to your friend'), ', or let them scan it.'),
            h('li', null, 'They choose ', h('strong', null, 'Add a friend › They invited me'), ', paste it, and send you back the reply they get.'),
            h('li', null, h('strong', null, 'Paste their reply below.'), ' Keep this window open until then: the code only works while it is.')),
          codeCard(inv.code),
          h('h3', null, 'Their reply'),
          input);
      } else {
        // ---- they invited me, with one-time codes
        input = codeInput('Paste their code here', isKind('i'), answer, 'Continue');
        paint(mark, h('p', null, h('strong', null, 'Paste the code your friend sent you.'), ' You will get a reply to send back to them.'), input);
      }
    } catch (e) {
      fail(mark, e);
    }
  }

  if (presetInvite && isKind('i')(presetInvite)) answer(presetInvite);
  else show(tab);
}

// ---- backup and other devices (also reachable from the first-steps guide) ------------

export function openBackup(app) {
  const node = app.node;
  const d = dialog('Save a backup');
  const p1 = h('input', { class: 'f-bpass', type: 'password', placeholder: 'Passphrase for the backup file', autocomplete: 'new-password' });
  const p2 = h('input', { class: 'f-bpass2', type: 'password', placeholder: 'Repeat it', autocomplete: 'new-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  d.body.append(
    h('p', null, 'The backup file holds your identity, your contacts, your groups and your channels. It is the only way to get them back if this browser’s data is erased or this device is lost.'),
    h('p', { class: 'muted' }, 'It is encrypted with the passphrase you choose here. It can be the same as your Void password. Keep the file somewhere else than on this device.'),
    field('Passphrase', p1), field('Repeat', p2), err,
    button('Download the backup file', async () => {
      try {
        const passphrase = newPassword(p1, p2);
        saveBlob(new Blob([node.exportBackup(passphrase)], { type: 'application/octet-stream' }), `void-backup-${node.id.name.replace(/[^\w-]+/g, '_')}.voidbackup`);
        await node.saveSettings({ backedUp: true });
        d.close();
        toast('Backup saved', 'good');
        app.refresh();
      } catch (e) {
        err.textContent = e.message;
      }
    }, { kind: 'primary', ico: 'download' }));
  p1.focus();
}

export function openDevices(app) {
  const d = dialog('Void on your other devices');
  d.body.append(
    h('p', null, 'The same identity can run on several devices. They keep each other up to date whenever two of them are open.'),
    h('ol', { class: 'steps' },
      h('li', null, h('strong', null, 'Save a backup here'), ' (previous step of the guide).'),
      h('li', null, h('strong', null, 'Open Void on the other device'), ' and choose “I already use Void on another device”.'),
      h('li', null, h('strong', null, 'Give it the backup file'), ' and its passphrase, then choose a password for that device.')),
    h('h3', null, 'Getting Void onto a device'),
    h('p', null, h('strong', null, 'Computer: '), 'copy the file void.html and open it in a browser.'),
    h('p', null, h('strong', null, 'Android: '), 'copy the file to the phone and open it with Chrome or Firefox from the file manager.'),
    h('p', null, h('strong', null, 'iPhone, iPad, TV: '), 'these do not open a local HTML file. Put void.html at a web address and open that address: any web host works, or a computer on the same Wi-Fi. From a secure address (https) the camera and microphone work too, and you can add Void to the home screen.'),
    h('p', { class: 'muted small' }, 'A web host only hands out the file. Your identity and your messages stay on your devices.'),
    button('Got it', async () => {
      await app.node.saveSettings({ guideDone: true });
      d.close();
      app.refresh();
    }, { kind: 'primary' }));
}

// ---- new conversation ------------------------------------------------------------

export function openNew(app) {
  const d = dialog('New');
  const go = (fn) => () => {
    d.close();
    fn(app);
  };
  d.body.append(h('div', { class: 'menu' },
    h('button', { type: 'button', onclick: go(newGroup) }, icon('users'), h('div', null, h('strong', null, 'New group'), h('span', null, 'Talk with several friends at once'))),
    h('button', { type: 'button', onclick: go(newChannel) }, icon('horn'), h('div', null, h('strong', null, 'New channel'), h('span', null, 'Only you post; anyone with the link can follow'))),
    h('button', { type: 'button', onclick: go(openLink) }, icon('link'), h('div', null, h('strong', null, 'Join with a link'), h('span', null, 'A channel or a group someone sent you')))));
}

export function shareDialog(title, link, note) {
  const d = dialog(title);
  d.body.append(note && h('p', { class: 'muted' }, note), codeCard(link));
}

export function openLink(app, preset = '') {
  const d = dialog('Open a link');
  const input = codeInput('Paste a void: link', (c) => ['u', 'c', 'g', 'i'].includes((readLink(c) || {}).kind), async (code) => {
    const kind = readLink(code).kind;
    if (kind === 'i') {
      d.close();
      return openPair(app, code);
    }
    const res = await app.node.openLink(code);
    d.close();
    toast(res.kind === 'contact' ? 'Sent. You will be connected as soon as you are both online.' : 'Joined', 'good');
    if (res.id) app.open(res.id);
    return undefined;
  });
  d.onclose = () => input.stop();
  d.body.append(input);
  if (preset) {
    // A link that came from a message or from the address bar is shown for what it
    // is and waits for a click: opening it tells other people about you.
    input.querySelector('textarea').value = preset;
    d.body.prepend(h('p', { class: 'warn' }, describeLink(preset)));
    input.querySelector('.primary').focus();
  }
}

function describeLink(code) {
  const d = readLink(code);
  const name = (v) => (typeof v === 'string' && v.trim() ? `“${v.trim().slice(0, 80)}”` : 'with no name');
  if (!d) return 'This does not look like a Void link.';
  if (d.kind === 'u') {
    const info = readCard(d.data);
    if (!info) return 'This contact card is not valid.';
    if (d.data.k) return `This is an invite from ${name(info.name)}. Continuing makes you contacts as soon as you are both online.`;
    return `This is the contact card of ${name(info.name)}. Continuing sends them a contact request that shows your name.`;
  }
  if (d.kind === 'c') return `This is the channel ${name(d.data.n)}. Continuing subscribes you; devices that carry the channel will see that yours does too.`;
  if (d.kind === 'g') return `This is the open group ${name(d.data.n)}. Continuing joins it and shows your name to everyone in it.`;
  if (d.kind === 'i') return 'This is a connection invite. Continuing prepares a reply for the person who sent it and makes you contacts.';
  return 'This link is of a kind this version does not know.';
}

function newGroup(app) {
  const node = app.node;
  const d = dialog('New group');
  const name = h('input', { type: 'text', maxLength: 80, placeholder: 'Group name' });
  const open = h('input', { type: 'checkbox' });
  const contacts = node.contactList().filter((c) => !c.pending && !c.blocked);
  const picks = new Set();
  const list = h('div', { class: 'checklist' }, contacts.length ? contacts.map((c) => h('label', null,
    h('input', { type: 'checkbox', onchange: (e) => (e.target.checked ? picks.add(c.uid) : picks.delete(c.uid)) }), avatar(c.uid, c.name, 'dm', node.avatarOf(c.uid)), h('span', null, c.name))) : h('p', { class: 'muted' }, 'No contacts yet. You can still create the group and invite people later.'));
  const err = h('p', { class: 'error' });
  d.body.append(field('Name', name), h('h3', null, 'Members'), list,
    h('label', { class: 'check' }, open, h('span', null, 'Open group: anyone with the link can join and read the history')),
    err,
    button('Create group', async () => {
      try {
        const id = await node.createGroup(name.value || 'Group', [...picks], { open: open.checked });
        d.close();
        app.open(id);
      } catch (e) {
        err.textContent = e.message;
      }
    }, { kind: 'primary' }));
  name.focus();
}

function newChannel(app) {
  const d = dialog('New channel');
  const name = h('input', { type: 'text', maxLength: 80, placeholder: 'Channel name' });
  const priv = h('input', { type: 'checkbox' });
  d.body.append(field('Name', name),
    h('label', { class: 'check' }, priv, h('span', null, 'Private: only people with the invite link can read it')),
    h('p', { class: 'muted small' }, 'A public channel can be read by anyone who has its link. Posts are signed with the channel key, so nobody else can post in your name.'),
    button('Create channel', async () => {
      const id = await app.node.createChannel(name.value || 'Channel', { isPublic: !priv.checked });
      d.close();
      app.open(id);
    }, { kind: 'primary' }));
  name.focus();
}

// ---- settings ------------------------------------------------------------------------

export function openSettings(app) {
  const node = app.node;
  const d = dialog('Settings', { wide: true });
  const off = node.on('net', () => renderNet());
  d.onclose = off;

  const name = h('input', { type: 'text', maxLength: 64, value: node.id.name });
  const bio = h('textarea', { class: 'f-bio', rows: 2, maxLength: 300, value: node.bioOf(node.uidHex), placeholder: 'Nothing yet' });
  let photo; // undefined = unchanged, null = removed
  const toggle = (key, label, hint) => {
    const box = h('input', { type: 'checkbox', checked: !!node.settings[key], onchange: () => node.saveSettings({ [key]: box.checked }) });
    return h('label', { class: 'check' }, box, h('span', null, h('strong', null, label), h('small', null, hint)));
  };
  const stun = h('textarea', { class: 'code', rows: 2, value: node.settings.stunServers.join('\n'), onchange: () => node.saveSettings({ stunServers: stun.value.split(/\s+/).filter((s) => /^stuns?:/.test(s)).slice(0, 6) }) });
  const relays = h('textarea', { class: 'code', rows: 3, value: node.settings.rdvRelays.join('\n'), onchange: () => node.saveSettings({ rdvRelays: relays.value.split(/\s+/).filter((s) => /^wss:\/\//.test(s)).slice(0, 8) }) });
  const net = h('div', { class: 'netlist' });
  const renderNet = () => {
    const s = node.netStatus();
    net.replaceChildren(
      h('p', null, s.links.length ? `${s.links.length} direct link${s.links.length > 1 ? 's' : ''}` : 'No direct link. Use Connect to get on the network.'),
      ...s.links.map((l) => h('div', { class: 'netrow' }, h('span', { class: 'dot direct' }), l.self ? 'Your other device' : l.name, h('small', null, 'direct'))),
      ...s.tunnels.map((t) => h('div', { class: 'netrow' }, h('span', { class: 'dot relayed' }), t.name, h('small', null, `through ${Math.max(1, t.hops - 1)} contact${t.hops > 2 ? 's' : ''}`))),
      h('p', { class: 'muted small' }, `Carrying ${s.relaying} conversation${s.relaying === 1 ? '' : 's'} for others · holding ${size(s.held)} of mail for ${s.heldTags} offline recipient${s.heldTags === 1 ? '' : 's'}`),
      h('p', { class: 'muted small' }, s.rdv ? `Rendezvous: connected to ${s.rdv.open} of ${s.rdv.total} public relays` : 'Rendezvous: off'));
  };
  renderNet();

  const cur = h('input', { class: 'f-cur', type: 'password', autocomplete: 'current-password' });
  const n1 = h('input', { class: 'f-new', type: 'password', autocomplete: 'new-password' });
  const n2 = h('input', { class: 'f-new2', type: 'password', autocomplete: 'new-password' });
  const autoHide = h('select', { onchange: () => node.saveSettings({ autoHide: Number(autoHide.value) }) },
    [[0, 'Never'], [5, '5 minutes without activity'], [15, '15 minutes without activity'], [60, '1 hour without activity']].map(([v, label]) => h('option', { value: String(v), selected: node.settings.autoHide === v }, label)));

  d.body.append(
    h('h3', null, 'Profile'),
    photoEditor(node.avatarOf(node.uidHex), node.uidHex, node.id.name, 'dm', (p) => (photo = p)),
    field('Name', name),
    field('Bio', bio, 'A line or two your contacts and the groups you are in can read.'),
    button('Save profile', async () => {
      if (name.value.trim() && name.value.trim() !== node.id.name) await node.setName(name.value);
      await node.setProfile({ bio: bio.value, av: photo === undefined ? undefined : photo });
      toast('Saved', 'good');
      app.refresh();
    }, { kind: 'primary f-save-profile' }),
    h('p', { class: 'muted small' }, 'Your identity is a key pair kept in this browser. There is no account and nothing to register.'),
    !app.env.persistent && h('p', { class: 'warn' }, 'This browser did not allow permanent storage, so everything is kept in memory and disappears when the page closes. Export a backup below before leaving.'),

    h('h3', null, 'Security'),
    h('p', { class: 'muted' }, 'Everything Void stores on this device (your keys, contacts, messages and files) is encrypted with your password before it reaches the disk. The password is asked each time Void opens.'),
    h('div', { class: 'row' },
      button('Hide the screen', () => {
        d.close();
        app.hide();
      }, { ico: 'eye' }),
      button('Lock and disconnect', () => app.env.lock(), { ico: 'lock' })),
    field('Hide the screen after', autoHide, 'Hiding keeps you connected. It stops someone who walks up to this device from reading; only locking removes your keys from memory.'),
    h('details', null, h('summary', null, 'Change password'),
      field('Current password', cur), field('New password', n1), field('Repeat the new password', n2),
      button('Change password', async () => {
        try {
          await app.env.changePassword(cur.value, newPassword(n1, n2));
          cur.value = n1.value = n2.value = '';
          toast('Password changed', 'good');
        } catch (e) {
          toast(e.message, 'bad');
        }
      })),

    h('h3', null, 'Network'),
    net,
    toggle('requests', 'Accept contact requests', 'People who hold your contact link can reach you through chains of contacts. Off: only the people you exchange codes with can become contacts, and nobody can check whether you are online.'),
    toggle('relay', 'Relay for my contacts', 'Pass encrypted traffic between contacts who cannot reach each other. Relays never see message contents.'),
    toggle('courier', 'Hold messages for offline contacts', 'Keep sealed messages addressed to your contacts’ contacts until they come back, for up to a week.'),
    toggle('autoDirect', 'Switch to direct connections', 'When a contact is reached through relays, try to connect directly.'),
    h('h3', null, 'Public helpers'),
    h('p', { class: 'muted' }, 'A web page cannot find its public address or call back a contact on its own. These two helpers are run by third parties, not by Void. They never see your messages, your contacts or your keys. Turn both off for strict mode: then only your contacts’ devices are ever contacted, links work on the same local network, and each session starts with an exchange of codes.'),
    toggle('rdv', 'Reconnect automatically', 'When Void opens, it leaves a sealed note for each contact on public relays (below) and connects to those who are online. The relays see your IP address and that two devices use the same unreadable topic.'),
    relays,
    toggle('stun', 'Find my public address', 'Asks the STUN servers below for your public address, so that devices on different networks can connect directly. They see your IP address, nothing else.'),
    stun,

    h('h3', null, 'Calls'),
    toggle('calls', 'Voice calls, video calls and screen sharing', 'A call connects your device directly to your contact’s, so each of you sees the other’s network address. Off: the call buttons disappear and anyone who calls is told that you do not take calls.'),

    h('h3', null, 'Notifications'),
    button(node.settings.notify ? 'Turn off notifications' : 'Turn on notifications', async () => {
      if (node.settings.notify) await node.saveSettings({ notify: false });
      else if (!('Notification' in window)) return toast('This browser has no notifications', 'bad');
      else if ((await Notification.requestPermission()) === 'granted') await node.saveSettings({ notify: true });
      else return toast('Notifications were not allowed', 'bad');
      d.close();
      return toast('Saved', 'good');
    }),
    h('p', { class: 'muted small' }, 'Notifications only work while this page is open. A closed page receives nothing; messages wait with your contacts until you return.'),

    h('h3', null, 'Backup and other devices'),
    h('p', { class: 'muted' }, 'The backup file contains your identity, contacts, groups and channels, protected by a passphrase. Restore it in Void on another device to use the same identity there; the devices then sync when they are connected.'),
    h('div', { class: 'row' },
      button('Save a backup', () => {
        d.close();
        openBackup(app);
      }, { ico: 'download' }),
      button('Other devices', () => {
        d.close();
        openDevices(app);
      }, { ico: 'users' })),

    h('h3', null, 'Danger zone'),
    button('Erase everything on this device', async () => {
      if (!confirm('Erase your identity, contacts and messages from this browser? This cannot be undone.')) return;
      node.stop();
      await node.store.clear();
      location.reload();
    }, { kind: 'danger', ico: 'trash' }),
    h('p', { class: 'muted small about' }, `Void ${app.env.version} · protocol ${PROTOCOL} · user id ${node.uidHex.slice(0, 16)}…`));
}

// ---- hide or lock ------------------------------------------------------------------

export function openLock(app) {
  const d = dialog('Hide or lock');
  d.body.append(h('div', { class: 'menu' },
    h('button', { class: 'f-hide', type: 'button', onclick: () => { d.close(); app.hide(); } }, icon('eye'),
      h('div', null, h('strong', null, 'Hide the screen'), h('span', null, 'Stay connected. Your password brings the conversations back.'))),
    h('button', { class: 'f-lock', type: 'button', onclick: () => app.env.lock() }, icon('lock'),
      h('div', null, h('strong', null, 'Lock and disconnect'), h('span', null, 'Closes every connection and removes your keys from memory. You will need your password and a new connection.')))));
}
