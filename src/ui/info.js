// SPDX-License-Identifier: AGPL-3.0-or-later
// The information panel of a contact, a group or a channel: who or what it is,
// quick actions, shared media, members, and an Advanced tab that lists everything
// this device knows about it.

import { h, icon, button, avatar, size, clock, dayLabel, lastSeen, copyText, saveBlob, pickPhoto } from './dom.js';
import { dialog, toast, shareDialog } from './dialogs.js';

// One line saying where a contact is: online and how, or when it was last seen.
export function presenceText(node, uid) {
  const c = node.contacts.get(uid);
  if (!c) return '';
  if (c.blocked) return 'blocked';
  if (c.pending === 'out') return 'request sent, waiting for an answer';
  const r = node.reach(uid);
  if (r.state === 'direct') return 'online · connected directly';
  if (r.state === 'relayed') {
    const n = Math.max(1, r.hops - 1);
    return `online · relayed through ${n} contact${n > 1 ? 's' : ''}`;
  }
  return lastSeen(c.seen);
}

// A small menu that opens under a button.
export function popup(anchor, items) {
  document.querySelectorAll('.popup').forEach((el) => el.remove());
  const close = () => {
    menu.remove();
    document.removeEventListener('click', outside, true);
  };
  const outside = (e) => !menu.contains(e.target) && close();
  const menu = h('div', { class: 'popup', role: 'menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('hr') : h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onclick: () => {
      close();
      it.run();
    },
  }, icon(it.icon, 18), it.label))));
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 40 * items.length - 20)}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('click', outside, true), 0);
}

const AUTO_DELETE = [[0, 'Off'], [3600, '1 hour'], [86400, '1 day'], [7 * 86400, '1 week'], [30 * 86400, '1 month']];
const ttlLabel = (s) => (AUTO_DELETE.find(([v]) => v === s) || [0, s ? `${Math.round(s / 60)} min` : 'Off'])[1];

export function openInfo(app, spId) {
  const node = app.node;
  if (!node.spaceInfo(spId)) return;
  const d = dialog('Info');
  d.card.classList.add('info');
  let tab = 'main';
  let alive = true;
  let turn = 0;
  const offs = ['spaces', 'contacts', 'presence', 'settings'].map((e) => node.on(e, () => alive && render()));
  d.onclose = () => {
    alive = false;
    offs.forEach((off) => off());
  };
  const go = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(e.message || String(e), 'bad');
    }
  };

  const more = (anchor, i) => {
    const dm = i.kind === 'dm';
    const mine = (i.kind === 'group' && i.admin) || (i.kind === 'chan' && i.owner);
    popup(anchor, [
      (dm || mine) && { icon: 'timer', label: `Auto-delete: ${ttlLabel(i.ttl)}`, run: () => autoDelete(app, spId, i.ttl) },
      (dm || mine) && '-',
      dm && { icon: 'share', label: 'Share this contact', run: () => shareTo(app, i.link, `the contact card of ${i.given}`) },
      dm && { icon: 'edit', label: 'Edit contact', run: () => editContact(app, i) },
      mine && { icon: 'edit', label: i.kind === 'chan' ? 'Edit channel' : 'Edit group', run: () => editSpace(app, spId) },
      !dm && i.link && { icon: 'share', label: 'Share the invite link', run: () => shareTo(app, i.link, `an invite to ${i.name}`) },
      { icon: 'export', label: 'Export chat history', run: go(async () => saveBlob(new Blob([await node.exportChat(spId)], { type: 'text/plain' }), `void-${i.name.replace(/[^\w-]+/g, '_')}.txt`)) },
      dm && { icon: 'ban', label: i.blocked ? 'Unblock' : 'Block user', run: go(async () => {
        if (!i.blocked && !confirm(`Block ${i.name}? They will no longer be able to reach you, write to you or call you.`)) return;
        await node.setBlocked(i.peer, !i.blocked);
      }) },
      '-',
      dm ? { icon: 'trash', danger: true, label: 'Delete contact', run: go(async () => {
        if (!confirm(`Delete ${i.name} from your contacts? The conversation is removed from this device.`)) return;
        await node.removeContact(i.peer);
        d.close();
        app.open(null);
      }) } : { icon: 'trash', danger: true, label: i.kind === 'chan' ? 'Unsubscribe' : 'Leave group', run: go(async () => {
        if (!confirm(i.kind === 'chan' && i.owner ? 'You own this channel. Leaving removes it from this device.' : 'Leave this conversation?')) return;
        await node.leaveSpace(spId);
        d.close();
        app.open(null);
      }) },
    ]);
  };

  const render = async () => {
    const mark = ++turn;
    const i = node.spaceInfo(spId);
    if (!i) return void d.close();
    const dm = i.kind === 'dm';
    const who = dm ? i.peer : spId;
    const media = await node.media(spId);
    const details = tab === 'advanced' ? await node.details(spId) : null;
    if (mark !== turn || !alive) return;

    d.title.textContent = dm ? 'Contact' : i.kind === 'group' ? 'Group' : 'Channel';
    const status = dm ? presenceText(node, i.peer)
      : i.kind === 'group' ? `${node.members(spId).length} members · ${i.open ? 'open group' : 'private group'}${i.left ? ' · you left' : ''}`
        : `${i.public ? 'public' : 'private'} channel${i.owner ? ' · you post here' : ''}`;
    const head = h('div', { class: 'info-head' },
      avatar(who, i.name, i.kind, node.avatarOf(who)),
      h('div', { class: 'grow' }, h('strong', { class: 'info-name' }, i.name), dm && i.alias && h('small', null, `calls themselves ${i.given}`), h('small', { class: dm ? node.reach(i.peer).state : '' }, status)));

    const tile = (ico, label, run, cls = '') => h('button', { class: 'tile ' + cls, type: 'button', onclick: run }, icon(ico, 22), h('span', null, label));
    const why = dm ? app.calls.blocked(i.peer) : 'x';
    const tiles = h('div', { class: 'tiles' },
      tile('send', 'Message', () => {
        d.close();
        app.open(spId);
      }),
      tile(i.muted ? 'belloff' : 'bell', i.muted ? 'Unmute' : 'Mute', go(() => node.setMuted(spId, !i.muted)), 'f-mute-chat'),
      dm && node.settings.calls && app.calls.supported() && tile('phone', 'Call', () => (why ? toast(why, 'bad') : (d.close(), app.calls.start(i.peer, false))), why ? 'dim' : ''),
      dm && node.settings.calls && app.calls.supported() && tile('video', 'Video', () => (why ? toast(why, 'bad') : (d.close(), app.calls.start(i.peer, true))), why ? 'dim' : ''),
      !dm && i.link && tile('qr', 'Invite', () => shareDialog(i.name, i.link, i.kind === 'chan' && !i.public ? 'This link contains the key of the channel. Share it only with people who should read it.' : 'Anyone with this link can join.')),
      tile('more', 'More', (e) => more(e.currentTarget, i), 'f-more'));

    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', class: tab === 'main' ? 'on' : '', onclick: () => { tab = 'main'; render(); } }, 'Overview'),
      h('button', { type: 'button', role: 'tab', class: 'f-advanced' + (tab === 'advanced' ? ' on' : ''), onclick: () => { tab = 'advanced'; render(); } }, 'Advanced'));

    const body = [];
    if (tab === 'advanced') {
      body.push(h('p', { class: 'muted small' }, 'Everything this device knows here: identifiers, public keys, routing tags, network paths and addresses. It needs them to deliver your messages, so they cannot be hidden from it. Secret keys and message contents are never shown. Click a value to copy it.'));
      for (const [title, rows] of details) {
        body.push(h('h3', null, title), h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { title: 'Copy', onclick: async () => toast((await copyText(String(v))) ? 'Copied' : 'Could not copy') }, String(v))])));
      }
    } else {
      const row = (ico, label, value, run) => h(run ? 'button' : 'div', { class: 'info-row', type: run ? 'button' : undefined, onclick: run || undefined }, icon(ico, 20), h('div', { class: 'grow' }, h('span', null, label), value && h('small', null, value)));
      if (i.about) body.push(h('div', { class: 'info-text' }, h('p', null, i.about), h('small', null, dm ? 'Bio' : 'Description')));
      if (dm) {
        body.push(row('qr', 'Contact link and QR code', 'Lets someone else ask this person to connect', () => shareDialog(i.name, i.link, `Anyone who opens this link can send ${i.given} a contact request.`)));
        body.push(row('check', 'Verify', i.safety, () => verify(i)));
      }
      body.push(h('div', { class: 'info-sep' }));
      const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const shelf = (key, ico, one, many) => media[key].length && body.push(row(ico, count(media[key].length, one, many), '', () => mediaDialog(app, spId, key, many)));
      shelf('photos', 'image', 'photo', 'photos');
      shelf('videos', 'video', 'video', 'videos');
      shelf('files', 'file', 'file', 'files');
      shelf('voice', 'mic', 'voice message', 'voice messages');
      shelf('links', 'link', 'shared link', 'shared links');
      if (dm) {
        const groups = node.commonGroups(i.peer);
        if (groups.length) body.push(row('users', count(groups.length, 'group in common', 'groups in common'), groups.map((g) => g.name).join(', '), () => popup(d.card.querySelector('.info-head'), groups.map((g) => ({ icon: 'users', label: g.name, run: () => { d.close(); app.open(g.id); } })))));
        body.push(h('div', { class: 'info-sep' }),
          h('label', { class: 'check' },
            h('input', { class: 'f-relayonly', type: 'checkbox', checked: !!i.relayOnly, onchange: go(async (e) => {
              await node.setRelayOnly(i.peer, e.target.checked);
              toast(e.target.checked ? 'Direct connections to this contact are off' : 'Direct connections allowed again', 'good');
            }) }),
            h('span', null, h('strong', null, 'Never connect directly'), h('small', null, 'Neither of you learns the other’s network address. Messages go through contacts you both can reach, and wait when there is none. Calls are not possible.'))));
      }
      if (i.kind === 'group') {
        const members = node.members(spId);
        body.push(h('h3', null, `Members (${members.length})`), h('div', { class: 'members' }, members.map((m) => h('div', { class: 'member' },
          h('button', { class: 'member-id', type: 'button', onclick: () => openProfile(app, m.uid, m.card) },
            avatar(m.uid, m.name, 'dm', node.avatarOf(m.uid)),
            h('span', null, h('strong', null, m.me ? `${m.name} (you)` : m.name), h('small', null, m.owner ? 'owner' : m.admin ? 'admin' : m.contact || m.me ? '' : 'not in your contacts'))),
          (i.owner || i.admin) && !m.me && !m.owner && h('button', { class: 'icon-btn', type: 'button', title: 'Manage', onclick: (e) => popup(e.currentTarget, [
            i.owner && { icon: 'user', label: m.admin ? 'Remove as admin' : 'Make admin', run: go(() => node.groupSetAdmin(spId, m.uid, !m.admin)) },
            { icon: 'trash', danger: true, label: 'Remove from the group', run: go(async () => confirm(`Remove ${m.name} from the group?`) && node.groupRemove(spId, m.uid)) },
          ]) }, icon('more'))))));
        const candidates = node.contactList().filter((c) => !c.pending && !c.blocked && !members.some((m) => m.uid === c.uid));
        if (!i.left && candidates.length) {
          body.push(button('Add a member', (e) => popup(e.currentTarget, candidates.map((c) => ({ icon: 'user', label: c.name, run: go(() => node.groupAdd(spId, c.uid)) }))), { ico: 'plus' }));
        }
      }
    }
    d.body.replaceChildren(head, tiles, tabs, ...body.filter(Boolean));
  };
  render();
}

function verify(i) {
  const d = dialog(`Verify ${i.name}`);
  d.body.append(
    h('p', null, 'Compare this number with the one shown on their device, in person or over a call. If both are the same, nobody is sitting between you pretending to be either of you.'),
    h('div', { class: 'safety' }, i.safety),
    h('p', { class: 'muted small' }, 'It is computed from your two identity keys and never changes for this contact.'));
}

function autoDelete(app, spId, current) {
  const d = dialog('Auto-delete messages');
  d.body.append(
    h('p', null, 'Messages older than the time you choose are removed from this device, attachments included. The other devices in the conversation receive the same setting and do the same.'),
    h('p', { class: 'muted small' }, 'This is an agreement between devices: nothing can force a device, or a person, to forget what it already received.'),
    h('div', { class: 'menu' }, AUTO_DELETE.map(([s, label]) => h('button', { type: 'button', class: s === current ? 'on' : '', onclick: async () => {
      try {
        await app.node.setAutoDelete(spId, s);
        d.close();
        toast(s ? `Messages now delete themselves after ${label}` : 'Auto-delete is off', 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
    } }, icon(s === current ? 'check' : 'timer'), h('div', null, h('strong', null, label))))));
}

function editContact(app, i) {
  const d = dialog('Edit contact');
  const input = h('input', { class: 'f-alias', type: 'text', maxLength: 64, value: i.alias, placeholder: i.given });
  d.body.append(
    h('label', { class: 'field' }, h('span', null, 'Name shown on this device'), input, h('small', null, `They call themselves ${i.given}. The name you give stays on your devices.`)),
    button('Save', async () => {
      await app.node.setAlias(i.peer, input.value);
      d.close();
    }, { kind: 'primary' }));
  input.focus();
}

// Name, description and photo of a group or a channel; also used for the user's own profile.
export function photoEditor(current, id, name, kind, onChange) {
  let photo = current;
  const pic = h('div', { class: 'photo-edit' });
  const draw = () => pic.replaceChildren(avatar(id, name, kind, photo),
    h('div', { class: 'row' },
      button(photo ? 'Change photo' : 'Add a photo', async () => {
        const bytes = await pickPhoto();
        if (!bytes) return toast('That picture could not be used', 'bad');
        photo = bytes;
        onChange(photo);
        return draw();
      }, { ico: 'image', kind: 'f-photo' }),
      photo && button('Remove', () => {
        photo = null;
        onChange(null);
        draw();
      })));
  draw();
  return pic;
}

function editSpace(app, spId) {
  const node = app.node;
  const i = node.spaceInfo(spId);
  const d = dialog(i.kind === 'chan' ? 'Edit channel' : 'Edit group');
  const name = h('input', { type: 'text', maxLength: 80, value: i.name });
  const about = h('textarea', { rows: 3, maxLength: 500, value: i.about, placeholder: 'What is it about?' });
  let photo; // undefined = unchanged
  d.body.append(
    photoEditor(node.avatarOf(spId), spId, i.name, i.kind, (p) => (photo = p)),
    h('label', { class: 'field' }, h('span', null, 'Name'), name),
    h('label', { class: 'field' }, h('span', null, 'Description'), about),
    button('Save', async () => {
      try {
        await node.setSpaceMeta(spId, { name: name.value, about: about.value, av: photo === undefined ? undefined : photo || new Uint8Array(0) });
        d.close();
      } catch (e) {
        toast(e.message, 'bad');
      }
    }, { kind: 'primary' }));
}

// Sends a link into one of the user's conversations, or shows it as text and QR code.
export function shareTo(app, link, what) {
  const node = app.node;
  const d = dialog('Share');
  const chats = node.chats().filter((c) => c.canPost);
  d.body.append(
    h('p', { class: 'muted' }, `Send ${what} to:`),
    h('div', { class: 'menu' }, chats.map((c) => h('button', { type: 'button', onclick: async () => {
      try {
        await node.sendMessage(c.id, { text: link });
        d.close();
        toast(`Sent to ${c.title}`, 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
    } }, avatar(c.peer || c.id, c.title, c.kind, node.avatarOf(c.peer || c.id)), h('div', null, h('strong', null, c.title))))),
    button('Show the link and its QR code', () => {
      d.close();
      shareDialog('Share', link);
    }, { ico: 'qr' }));
}

function mediaDialog(app, spId, key, title) {
  const node = app.node;
  const d = dialog(title[0].toUpperCase() + title.slice(1), { wide: true });
  const fetchThen = (att, fn) => async () => {
    try {
      await node.fetchBlob(spId, att, { force: true });
      await fn();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  node.media(spId).then((media) => {
    const items = media[key].slice().reverse();
    if (key === 'photos') {
      d.body.append(h('div', { class: 'grid' }, items.map((it) => h('button', { type: 'button', title: it.att.name, onclick: fetchThen(it.att, () => app.viewImage(it.att)) },
        it.att.thumb ? h('img', { alt: it.att.name, src: URL.createObjectURL(new Blob([it.att.thumb], { type: 'image/jpeg' })) }) : icon('image', 28)))));
    } else if (key === 'links') {
      d.body.append(h('div', { class: 'menu' }, items.map((it) => h('a', { class: 'info-row', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 20), h('div', { class: 'grow' }, h('span', null, it.url), h('small', null, `${node.nameOf(it.author)} · ${dayLabel(it.ts)} ${clock(it.ts)}`))))));
    } else {
      d.body.append(h('div', { class: 'menu' }, items.map((it) => h('button', { type: 'button', class: 'info-row', onclick: fetchThen(it.att, async () => saveBlob(new Blob(await node.blobChunks(it.att), { type: 'application/octet-stream' }), it.att.name)) },
        icon(key === 'voice' ? 'mic' : key === 'videos' ? 'video' : 'file', 20), h('div', { class: 'grow' }, h('span', null, it.att.name), h('small', null, `${size(it.att.size)} · ${node.nameOf(it.author)} · ${dayLabel(it.ts)} ${clock(it.ts)}`))))));
    }
  });
}

// Someone seen in a group: their conversation if they are a contact, a small card otherwise.
export function openProfile(app, uid, card = '') {
  const node = app.node;
  if (uid === node.uidHex) return;
  const c = node.contacts.get(uid);
  if (c && !c.pending && c.dm) return void openInfo(app, c.dm);
  const name = node.nameOf(uid);
  const d = dialog('Person');
  d.card.classList.add('info');
  d.body.append(
    h('div', { class: 'info-head' }, avatar(uid, name, 'dm', node.avatarOf(uid)), h('div', { class: 'grow' }, h('strong', { class: 'info-name' }, name), h('small', null, c && c.pending === 'out' ? 'contact request sent' : 'not in your contacts'))),
    node.bioOf(uid) && h('div', { class: 'info-text' }, h('p', null, node.bioOf(uid)), h('small', null, 'Bio')),
    card && !c && button('Send a contact request', async () => {
      try {
        await node.openLink(card);
        d.close();
        toast('Contact request sent. It arrives when a chain of contacts reaches them.', 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
    }, { kind: 'primary', ico: 'user' }),
    h('h3', null, 'Advanced'),
    h('dl', { class: 'kv' }, h('dt', null, 'User id (signing public key)'), h('dd', { onclick: async () => toast((await copyText(uid)) ? 'Copied' : 'Could not copy') }, uid)),
    h('p', { class: 'muted small' }, 'You know this person through a group. Until you are contacts, you only talk inside that group.'));
}
