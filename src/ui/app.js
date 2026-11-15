// SPDX-License-Identifier: AGPL-3.0-or-later
// The main window: conversation list on the left, the open conversation on the right.

import { h, icon, button, iconButton, avatar, clock, dayLabel, listTime, size, duration, copyText, saveBlob } from './dom.js';
import { toast, dialog, openPair, openNew, openLink, openSettings, openLock, openBackup, openDevices } from './dialogs.js';
import { openInfo, openProfile, presenceText } from './info.js';
import { readLink, readCard, channelId } from '../core/keys.js';
import { hex, isBytes } from '../core/bytes.js';
import { UID } from '../core/crypto.js';
import { privacyScreen } from './lock.js';
import { Calls } from './calls.js';

const coarse = () => window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const LINK = /(void:[a-z]:[A-Za-z0-9_-]{8,}|https?:\/\/[^\s<>"']+)/g;
// What the sender says a file is decides nothing: only these types are shown in the
// page, everything else is offered as a download with a neutral type.
const SHOWN = /^(image\/(png|jpeg|gif|webp|avif)|audio\/[\w.+-]+|video\/[\w.+-]+)$/;
const shownType = (a) => (SHOWN.test(a.mime) ? a.mime : 'application/octet-stream');

export class App {
  constructor(root, node, env) {
    this.root = root;
    this.node = node;
    this.env = env;
    this.active = null;
    this.items = [];
    this.rows = new Map(); // message id -> { el, sig }
    this.urls = new Map(); // attachment id -> object URL
    this.watch = new Map(); // attachment id -> Set(render)
    this.reply = null;
    this.editing = null;
    this.recorder = null;
    this.pendingRefresh = new Set();
    this.unseen = 0;
    this.hidden = false;
    this.lastInput = Date.now();
  }

  // Covers the window until the password is entered again. Connections stay up.
  hide() {
    if (this.hidden) return;
    this.hidden = true;
    document.querySelectorAll('.viewer, .msg-menu').forEach((el) => el.remove());
    privacyScreen((password) => this.env.verifyPassword(password)).then(() => {
      this.hidden = false;
      this.lastInput = Date.now();
      this.refresh();
    });
  }

  start() {
    this.calls = new Calls(this, this.env.iceServers);
    this.side = h('aside', { class: 'side' });
    this.pane = h('main', { class: 'pane' });
    this.shell = h('div', { class: 'shell' }, this.side, this.pane);
    this.root.replaceChildren(this.shell);
    const n = this.node;
    for (const evt of ['spaces', 'contacts', 'presence', 'net', 'request', 'settings']) n.on(evt, () => this.refresh('side', 'head'));
    n.on('message', (id) => this.refresh('side', id === this.active ? 'msgs' : null));
    n.on('blob', (id) => {
      for (const fn of this.watch.get(id) || []) fn();
    });
    n.on('notify', (id, who, text) => this.notify(id, who, text));
    n.on('joined', (uid) => toast(`${n.nameOf(uid)} opened your invite. You are now contacts.`, 'good'));
    n.on('version', (name, theirs, mine) => toast(`${name} is online but runs ${theirs < mine ? 'an older' : 'a newer'} version of Void (${theirs}; this one is ${mine}). Put the same void.html on both devices.`, 'bad'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this.unseen = 0;
      document.title = 'Void';
      if (this.active) n.setActive(this.active);
    });
    this.renderSide();
    this.renderPane();
    // Hide the screen after a while without keyboard, mouse or touch input.
    const touch = () => (this.lastInput = Date.now());
    for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(evt, touch, { passive: true, capture: true });
    setInterval(() => {
      const minutes = n.settings.autoHide;
      if (minutes > 0 && !this.hidden && Date.now() - this.lastInput > minutes * 60000) this.hide();
    }, 15000);
  }

  refresh(...what) {
    for (const w of what.length ? what : ['side', 'head', 'msgs']) if (w) this.pendingRefresh.add(w);
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const set = this.pendingRefresh;
      this.pendingRefresh = new Set();
      if (set.has('side')) this.renderSide();
      if (set.has('head')) this.renderHead();
      if (set.has('msgs')) this.renderMessages();
    });
  }

  notify(id, who, text) {
    if (!document.hidden && id) return;
    if (!document.hidden) return; // an incoming call on a visible page shows itself
    this.unseen++;
    document.title = `(${this.unseen}) Void`;
    if (this.node.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = this.hidden ? new Notification('Void', { body: 'New message', tag: 'void' }) : new Notification(who, { body: text, tag: id });
        n.onclick = () => {
          window.focus();
          if (id) this.open(id);
        };
      } catch { /* notifications unavailable in this context */ }
    }
  }

  // ---- sidebar ------------------------------------------------------------------

  renderSide() {
    const node = this.node;
    const net = node.netStatus();
    const online = net.links.length > 0;
    const searching = !online && net.rdv && net.rdv.open > 0;
    const status = online
      ? `${net.links.length} direct link${net.links.length > 1 ? 's' : ''}${net.tunnels.length ? ` · ${net.tunnels.length} relayed` : ''}`
      : searching ? 'Looking for your contacts…' : 'Not connected';
    const known = node.contactList().some((c) => !c.pending);
    const head = h('header', { class: 'me' },
      h('button', { class: 'head-id', type: 'button', title: 'Your profile and settings', onclick: () => openSettings(this) },
        avatar(node.uidHex, node.id.name, 'dm', node.avatarOf(node.uidHex)),
        h('div', { class: 'grow' }, h('strong', null, node.id.name), h('small', { class: online ? 'ok' : 'off' }, status))),
      iconButton('userplus', 'Add a friend', () => openPair(this), 'f-add'),
      iconButton('plus', 'New group or channel, or join one with a link', () => openNew(this)),
      iconButton('lock', 'Hide the screen or lock', () => openLock(this), 'f-lockbtn'),
      iconButton('gear', 'Settings', () => openSettings(this)));
    const banner = !online && h('div', { class: 'banner' },
      h('p', null, !known ? 'Start by inviting someone: send them a link, they open it when they like.'
        : searching ? 'None of your contacts is online right now. Void connects on its own as soon as one appears.'
          : net.rdv ? 'The rendezvous relays cannot be reached. You can still connect by exchanging a code with a contact.'
            : 'Automatic reconnection is off. Exchange a code with one contact who is online and the rest of your network follows.'),
      button(known && !net.rdv ? 'Reconnect with a code' : 'Add a friend', () => openPair(this), { kind: 'primary', ico: 'userplus' }));
    const requests = node.contactList().filter((c) => c.pending === 'in').map((c) => h('div', { class: 'request' },
      avatar(c.uid, c.name), h('div', { class: 'grow' }, h('strong', null, c.name), h('small', null, 'wants to connect')),
      button('Accept', () => node.acceptRequest(c.uid), { kind: 'primary' }), button('Decline', () => node.removeContact(c.uid))));
    const chats = node.chats();
    const list = h('nav', { class: 'chats' }, chats.length ? chats.map((c) => this.chatRow(c)) : h('p', { class: 'muted pad' }, 'Your conversations will appear here.'));
    const guide = this.guide(known);
    this.side.replaceChildren(head, guide || banner || '', ...requests, list);
  }

  // The first-steps guide: three things worth doing once, ticked off as they are done.
  guide(known) {
    const node = this.node;
    if (node.settings.guideDone) return null;
    const step = (n, done, title, text, label, action) => h('li', { class: done ? 'done' : '' },
      h('span', { class: 'num' }, done ? icon('check', 14) : String(n)),
      h('div', null, h('strong', null, title), h('small', null, text), !done && button(label, action, { kind: n === 1 || known ? 'primary' : '' })));
    return h('div', { class: 'guide' },
      h('div', { class: 'guide-head' }, h('strong', null, `Welcome, ${node.id.name}`), h('button', { class: 'linkish', type: 'button', onclick: () => node.saveSettings({ guideDone: true }) }, 'Hide')),
      h('ol', null,
        step(1, known, 'Add a friend', known ? 'Done. Void finds them again by itself from now on.' : 'Send them an invite link. They open it when they like, and you are connected on your own.', 'Add a friend', () => openPair(this)),
        step(2, node.settings.backedUp, 'Save a backup', node.settings.backedUp ? 'Done. Keep the file somewhere safe.' : 'So that you keep your identity and contacts if this device is lost.', 'Save a backup', () => openBackup(this)),
        step(3, false, 'Use your other devices', 'Phone, tablet, another computer: same identity everywhere.', 'Show me how', () => openDevices(this))));
  }

  chatRow(c) {
    const dot = c.kind === 'dm' ? h('span', { class: 'dot ' + c.reach.state, title: c.reach.state }) : null;
    const sub = c.blocked ? 'Blocked' : c.pending ? 'Request sent, waiting for an answer' : c.left ? 'You left' : c.text || (c.kind === 'chan' ? 'Channel' : c.kind === 'group' ? 'Group' : 'No messages yet');
    const who = c.peer || c.id;
    return h('button', { class: 'chat-row' + (c.id === this.active ? ' active' : ''), type: 'button', onclick: () => this.open(c.id) },
      h('div', { class: 'av-wrap' }, avatar(who, c.title, c.kind, this.node.avatarOf(who)), dot),
      h('div', { class: 'grow' },
        h('div', { class: 'line' }, h('strong', null, c.title), h('time', null, c.muted && icon('belloff', 13), listTime(c.ts))),
        h('div', { class: 'line' }, h('span', { class: 'preview' }, sub), c.unread ? h('span', { class: 'badge' + (c.muted ? ' quiet' : '') }, c.unread > 99 ? '99+' : String(c.unread)) : null)));
  }

  // ---- conversation ---------------------------------------------------------------

  open(id) {
    if (this.recorder) this.stopRecording(false);
    this.active = id;
    this.reply = null;
    this.editing = null;
    this.rows.clear();
    this.watch.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.node.setActive(id);
    this.shell.classList.toggle('open', !!id);
    this.renderPane();
    this.renderSide();
  }

  renderPane() {
    if (!this.active || !this.node.spaces.has(this.active)) {
      this.active = null;
      this.shell.classList.remove('open');
      const fresh = !this.node.chats().length;
      this.pane.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'logo' }, 'Void'),
        h('p', null, fresh ? 'You are all set. Add a first friend to start talking.' : 'Choose a conversation on the left.'),
        fresh && button('Add a friend', () => openPair(this), { kind: 'primary', ico: 'userplus' }),
        h('p', { class: 'muted small' }, 'Messages travel straight between devices, or through your contacts’ devices when there is no direct path.')));
      return;
    }
    this.head = h('header', { class: 'chat-head' });
    this.list = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite' });
    this.pinned = true; // the view follows new messages while the reader is at the bottom
    this.list.onscroll = () => (this.pinned = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80);
    this.foot = h('footer', { class: 'composer' });
    this.pane.replaceChildren(this.head, this.list, this.foot);
    this.renderHead();
    this.renderComposer();
    this.renderMessages(true);
  }

  renderHead() {
    if (!this.active || !this.head) return;
    const node = this.node;
    const c = node.chats().find((x) => x.id === this.active);
    if (!c) return this.renderPane();
    let sub;
    if (c.kind === 'dm') {
      sub = presenceText(node, c.peer);
    } else {
      const members = c.kind === 'group' ? `${node.members(c.id).length} members · ` : '';
      sub = c.left ? 'you left' : `${members}${c.reach.peers ? `${c.reach.peers} device${c.reach.peers > 1 ? 's' : ''} connected` : 'nobody connected right now'}`;
    }
    // Call buttons: one-to-one conversations only, and only while calls are on.
    const peer = c.kind === 'dm' && !c.pending ? node.spaces.get(c.id).peer : null;
    const callable = peer && node.settings.calls && this.calls.supported();
    const why = callable ? this.calls.blocked(peer) : '';
    const callBtn = (ico, cls, title, video) => {
      const b = iconButton(ico, why || title, () => this.calls.start(peer, video), cls);
      b.classList.toggle('dim', !!why || !!this.calls.call);
      return b;
    };
    this.head.replaceChildren(
      iconButton('back', 'Back to conversations', () => this.open(null), 'back'),
      // The name and picture open the information panel, as people expect.
      h('button', { class: 'head-id grow', type: 'button', title: 'Details', onclick: () => openInfo(this, c.id) },
        avatar(c.peer || c.id, c.title, c.kind, node.avatarOf(c.peer || c.id)),
        h('div', { class: 'grow' }, h('strong', null, c.title), h('small', { class: c.kind === 'dm' ? c.reach.state : '' }, sub, c.ttl ? ' · auto-delete on' : ''))),
      callable && callBtn('phone', 'f-call', 'Voice call', false),
      callable && callBtn('video', 'f-call-video', 'Video call', true),
      iconButton('info', 'Details', () => openInfo(this, c.id)));
    if (this.canPost !== c.canPost) this.renderComposer();
    return undefined;
  }

  async renderMessages(first = false) {
    const id = this.active;
    if (!id || !this.list) return;
    const items = await this.node.messages(id);
    if (id !== this.active) return;
    const atBottom = first || this.pinned;
    this.items = items;
    const byId = new Map(items.map((m) => [m.id, m]));
    const sp = this.node.spaces.get(id);
    const wanted = [];
    let day = '';
    for (const m of items) {
      const label = dayLabel(m.ts);
      if (label !== day) {
        day = label;
        wanted.push(this.keep('day' + label, label, () => h('div', { class: 'day' }, h('span', null, label))));
      }
      const quoted = m.re ? byId.get(m.re) : null;
      const who = sp.kind === 'group' && !m.mine ? this.node.nameOf(m.author) : '';
      const sig = [m.kind, m.text, m.edited, m.deleted, m.state, who, quoted ? quoted.text.slice(0, 60) + quoted.deleted : '', (m.att || []).map((a) => a.id).join()].join('\u0001');
      wanted.push(this.keep(m.id, sig, () => this.messageEl(m, who, quoted)));
    }
    // Messages waiting for their time are shown at the end, with a way to cancel.
    const waiting = this.node.scheduledFor(id);
    for (const s of waiting) {
      wanted.push(this.keep('later' + s.id, s.text + s.at, () => h('div', { class: 'msg mine later' }, h('div', { class: 'bubble' },
        h('div', { class: 'text' }, s.text),
        h('div', { class: 'meta' }, icon('calendar', 13), `Scheduled · ${dayLabel(s.at)} ${clock(s.at)}`,
          h('button', { class: 'linkish', type: 'button', onclick: () => this.node.cancelScheduled(s.id) }, 'Cancel'))))));
    }
    const live = new Set(wanted);
    for (const [key, row] of this.rows) if (!live.has(row.el)) this.rows.delete(key);
    const kids = [...this.list.children];
    const prefix = kids.length <= wanted.length && kids.every((k, i) => k === wanted[i]);
    if (prefix) this.list.append(...wanted.slice(kids.length));
    else this.list.replaceChildren(...wanted);
    if (!items.length && !waiting.length) {
      const about = sp.kind === 'dm' ? [`You and ${this.node.nameOf(sp.peer)} are contacts.`, 'What you write here is encrypted from your device to theirs: nobody in between can read it. Void finds them again on its own whenever you are both online, and keeps your messages with mutual contacts when they are not.']
        : sp.kind === 'chan' ? ['No posts yet.', sp.chan.seed ? 'Share the channel link (the ⓘ button) so that people can subscribe.' : 'Posts appear here as soon as a device that carries this channel is reachable.']
          : ['No messages yet.', 'Everyone in the group sees what is written here, and nobody else.'];
      this.list.replaceChildren(h('div', { class: 'hint' }, h('strong', null, about[0]), h('p', null, about[1])));
    }
    if (atBottom) {
      this.pinned = true;
      this.stick();
    }
  }

  // Keeps the newest message in view; called again when pictures finish loading.
  stick() {
    if (this.pinned && this.list) this.list.scrollTop = this.list.scrollHeight;
  }

  // Reuses the element of a message when nothing about it changed, so media keeps playing.
  keep(key, sig, make) {
    const row = this.rows.get(key);
    if (row && row.sig === sig) return row.el;
    const el = make();
    this.rows.set(key, { el, sig });
    return el;
  }

  messageEl(m, who, quoted) {
    if (m.kind === 'sys') return h('div', { class: 'sys' }, h('span', null, m.text));
    const bubble = h('div', { class: 'bubble' });
    if (who) {
      bubble.append(h('button', { class: 'who', type: 'button', onclick: () => {
        const member = this.node.members(this.active).find((x) => x.uid === m.author);
        openProfile(this, m.author, member ? member.card : '');
      } }, who));
    }
    if (quoted) bubble.append(h('div', { class: 'quote' }, quoted.deleted ? 'Deleted message' : quoted.text.slice(0, 140) || 'Attachment'));
    if (m.deleted) bubble.append(h('em', { class: 'muted' }, 'Message deleted'));
    for (const a of m.att || []) bubble.append(this.attachmentEl(a));
    if (m.text) bubble.append(this.textEl(m.text));
    const state = m.mine && m.state ? h('span', { class: 'state ' + m.state, title: { sent: 'Waiting on this device for a route', held: 'Held by a contact until the recipient returns', delivered: 'Delivered' }[m.state] }, icon({ sent: 'clock', held: 'check', delivered: 'checks' }[m.state], 14)) : null;
    bubble.append(h('div', { class: 'meta' }, m.edited && !m.deleted ? 'edited · ' : '', clock(m.ts), state));
    const row = h('div', { class: 'msg' + (m.mine ? ' mine' : '') }, bubble);
    if (!m.deleted) bubble.addEventListener('click', (e) => {
      if (e.target.closest('a, button, audio, video, img, .att')) return;
      this.messageMenu(m, bubble);
    });
    return row;
  }

  textEl(text) {
    const p = h('div', { class: 'text' });
    let last = 0;
    for (const m of text.matchAll(LINK)) {
      p.append(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[0].startsWith('void:')) {
        p.append(this.linkCard(m[0]));
      } else {
        p.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
      }
    }
    p.append(text.slice(last));
    return p;
  }

  // A Void link inside a message, shown for what it is: whose card, which channel
  // or group, and what opening it does.
  linkCard(link) {
    const node = this.node;
    const d = readLink(link);
    const text = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : fallback);
    let c = { ico: 'link', kind: 'Void link', title: 'Unreadable link', sub: '', label: '', run: null };
    const open = () => openLink(this, link);
    if (d && d.kind === 'u') {
      const info = readCard(d.data);
      const uid = info ? hex(info.uid) : '';
      const known = node.contacts.get(uid);
      c = { ico: 'user', kind: d.data.k ? 'Invite to connect' : 'Contact card', title: info ? info.name : 'Not a valid card', sub: '', label: '', run: null };
      if (!info) c.sub = '';
      else if (uid === node.uidHex) c.sub = 'This is your own card';
      else if (known && !known.pending) Object.assign(c, { sub: 'Already in your contacts', label: 'Message', run: () => this.open(known.dm) });
      else if (known && known.pending === 'out') c.sub = 'Request sent, waiting for an answer';
      else Object.assign(c, { sub: d.data.k ? 'Opening it makes you contacts' : 'Not in your contacts yet', label: d.data.k ? 'Accept' : 'Add contact', run: open });
    } else if (d && d.kind === 'c') {
      const secret = isBytes(d.data.k, 32);
      const id = isBytes(d.data.p, UID) ? hex(channelId(d.data.p)) : '';
      const sp = node.spaces.get(id);
      c = { ico: 'horn', kind: secret ? 'Private channel' : 'Public channel', title: text(d.data.n, 'Channel'), sub: secret ? 'This link carries the key to read it' : 'Anyone with the link can read it', label: 'Subscribe', run: open };
      if (sp && !sp.left) Object.assign(c, { sub: 'You are subscribed', label: 'Open', run: () => this.open(id) });
    } else if (d && d.kind === 'g') {
      const id = isBytes(d.data.i, 16) ? hex(d.data.i) : '';
      const sp = node.spaces.get(id);
      c = { ico: 'users', kind: 'Invitation to an open group', title: text(d.data.n, 'Group'), sub: 'Joining shows your name to everyone in it', label: 'Join', run: open };
      if (sp && !sp.left) Object.assign(c, { sub: 'You are a member', label: 'Open', run: () => this.open(id) });
    } else if (d && d.kind === 'i') {
      c = { ico: 'wifi', kind: 'Connection invite', title: 'Connect with the sender', sub: 'Works once, while their Void is open', label: 'Answer', run: open };
    } else if (d && d.kind === 'r') {
      c = { ico: 'wifi', kind: 'Connection reply', title: 'Reply to an invite', sub: 'To be entered in the window where the invite was made', label: '', run: null };
    }
    return h('div', { class: 'linkcard' }, icon(c.ico, 22),
      h('div', { class: 'grow' }, h('small', null, c.kind), h('strong', null, c.title), c.sub && h('span', null, c.sub)),
      c.run && button(c.label, c.run, { kind: 'primary' }));
  }

  // Lets the user pick when a message should go out.
  schedule(text, done) {
    const pad = (n) => String(n).padStart(2, '0');
    const local = (t) => {
      const x = new Date(t);
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
    };
    const d = dialog('Send later');
    const when = h('input', { class: 'f-when', type: 'datetime-local', value: local(Date.now() + 3600000), min: local(Date.now() + 60000) });
    const at = (hour, plusDays) => {
      const x = new Date();
      x.setDate(x.getDate() + plusDays);
      x.setHours(hour, 0, 0, 0);
      return x.getTime();
    };
    const quick = [['In 1 hour', Date.now() + 3600000], ['This evening, 20:00', at(20, 0)], ['Tomorrow, 9:00', at(9, 1)]].filter(([, t]) => t > Date.now() + 60000);
    d.body.append(
      h('div', { class: 'quote' }, text.slice(0, 200)),
      h('label', { class: 'field' }, h('span', null, 'Send it on'), when),
      h('div', { class: 'row' }, quick.map(([label, t]) => button(label, () => (when.value = local(t))))),
      h('p', { class: 'muted small' }, 'There is no server to send it for you: it leaves when the time comes if Void is open on this device, and otherwise the next time you open it.'),
      button('Schedule', async () => {
        try {
          await this.node.scheduleMessage(this.active, text, new Date(when.value).getTime());
          d.close();
          done();
          toast('Scheduled', 'good');
        } catch (e) {
          toast(e.message, 'bad');
        }
      }, { kind: 'primary f-schedule-ok', ico: 'calendar' }));
  }

  messageMenu(m, anchor) {
    document.querySelectorAll('.msg-menu').forEach((el) => el.remove());
    const sp = this.node.spaces.get(this.active);
    const canDelete = m.mine || (sp.kind === 'group' && this.node.isAdmin(sp, this.node.uidHex));
    const close = () => {
      menu.remove();
      document.removeEventListener('click', onDoc, true);
    };
    const onDoc = (e) => !menu.contains(e.target) && close();
    const item = (label, ico, fn) => h('button', { type: 'button', onclick: () => { close(); fn(); } }, icon(ico, 16), label);
    const menu = h('div', { class: 'msg-menu' },
      this.canPost && item('Reply', 'reply', () => { this.reply = m; this.editing = null; this.renderComposer(); }),
      m.text && item('Copy', 'copy', async () => toast((await copyText(m.text)) ? 'Copied' : 'Could not copy')),
      m.mine && m.text && this.canPost && item('Edit', 'edit', () => { this.editing = m; this.reply = null; this.renderComposer(); }),
      canDelete && item('Delete', 'trash', () => confirm('Delete this message? Devices that already received it are asked to hide it; this cannot be enforced.') && this.node.deleteMessage(this.active, m.id).catch((e) => toast(e.message, 'bad'))));
    anchor.append(menu);
    setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  }

  // ---- attachments ---------------------------------------------------------------------

  async blobUrl(a) {
    if (!this.urls.has(a.id)) this.urls.set(a.id, URL.createObjectURL(new Blob(await this.node.blobChunks(a), { type: shownType(a) })));
    return this.urls.get(a.id);
  }

  attachmentEl(a) {
    const node = this.node;
    const spId = this.active;
    if (a.kind !== 'file' && !SHOWN.test(a.mime)) a = { ...a, kind: 'file' };
    const box = h('div', { class: 'att ' + a.kind });
    const thumb = a.thumb ? URL.createObjectURL(new Blob([a.thumb], { type: 'image/jpeg' })) : '';
    let asked = false;
    const fetchIt = (force = false) => {
      asked = true;
      node.fetchBlob(spId, a, { force }).then(render, render);
      setTimeout(render, 0);
    };
    const render = async () => {
      if (spId !== this.active) return;
      const have = await node.hasBlob(a.id);
      const dl = node.blobState(a.id);
      const loading = !have && dl && dl.state === 'loading';
      const failed = !have && dl && dl.state === 'failed';
      const pct = loading ? Math.round((dl.have / Math.max(1, dl.n)) * 100) + '%' : '';
      const label = failed ? 'Not available right now. Tap to retry.' : loading ? `Downloading ${pct}` : `Download ${size(a.size)}`;
      const big = a.size > node.cfg.blobTunnelMax;
      if (!have && !asked && !dl && a.size <= node.cfg.blobAuto && (a.kind === 'image' || a.kind === 'voice')) fetchIt();
      if (a.kind === 'image') {
        const img = h('img', { alt: a.name, src: have ? await this.blobUrl(a) : thumb, loading: 'lazy' });
        if (a.w && a.h) img.style.aspectRatio = `${a.w} / ${a.h}`;
        img.onclick = () => (have ? this.viewImage(a) : fetchIt(failed && big));
        img.onload = () => this.stick();
        box.replaceChildren(...[img, !have && h('button', { class: 'att-over', type: 'button', onclick: () => fetchIt(failed && big) }, label)].filter(Boolean));
      } else if (a.kind === 'voice' || (a.kind === 'video' && have)) {
        if (have) {
          const media = h(a.kind === 'voice' ? 'audio' : 'video', { controls: true, preload: 'metadata', src: await this.blobUrl(a) });
          box.replaceChildren(media, a.kind === 'voice' && a.dur ? h('small', null, duration(a.dur)) : '');
        } else {
          box.replaceChildren(h('button', { class: 'chip', type: 'button', onclick: () => fetchIt(failed && big) }, icon('mic'), h('span', null, h('strong', null, `Voice message${a.dur ? ' · ' + duration(a.dur) : ''}`), h('small', null, label))));
        }
      } else {
        const save = async () => saveBlob(new Blob(await node.blobChunks(a), { type: 'application/octet-stream' }), a.name);
        box.replaceChildren(h('button', { class: 'chip', type: 'button', onclick: () => (have ? save() : fetchIt(failed && big)) },
          icon(have ? 'download' : 'file'), h('span', null, h('strong', null, a.name), h('small', null, have ? `${size(a.size)} · tap to save` : label))));
      }
    };
    let set = this.watch.get(a.id);
    if (!set) this.watch.set(a.id, (set = new Set()));
    set.add(render);
    render();
    return box;
  }

  async viewImage(a) {
    const url = await this.blobUrl(a);
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'viewer', onclick: close },
      h('img', { src: url, alt: a.name }),
      h('div', { class: 'viewer-bar', onclick: (e) => e.stopPropagation() }, h('span', null, a.name),
        button('Save', async () => saveBlob(new Blob(await this.node.blobChunks(a), { type: 'application/octet-stream' }), a.name), { ico: 'download' }), iconButton('close', 'Close', close)));
    document.body.append(overlay);
  }

  // ---- composer --------------------------------------------------------------------------

  renderComposer() {
    if (!this.foot) return;
    const node = this.node;
    const c = node.chats().find((x) => x.id === this.active);
    if (!c) return;
    this.canPost = c.canPost;
    if (!c.canPost) {
      this.foot.replaceChildren(h('p', { class: 'muted center' }, c.left ? 'You are no longer part of this conversation.' : 'Only the owner posts in this channel.'));
      return;
    }
    const ta = h('textarea', { rows: 1, placeholder: c.kind === 'chan' ? 'Write a post' : 'Message', 'aria-label': 'Message' });
    this.input = ta;
    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
    };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !coarse() && !e.isComposing) {
        e.preventDefault();
        send();
      }
      if (e.key === 'Escape') cancel();
    });
    const cancel = () => {
      this.reply = null;
      this.editing = null;
      this.renderComposer();
    };
    const send = async () => {
      const text = ta.value.trim();
      if (!text) return;
      const { editing, reply } = this;
      ta.value = '';
      grow();
      this.reply = null;
      this.editing = null;
      try {
        if (editing) await node.editMessage(this.active, editing.id, text);
        else await node.sendMessage(this.active, { text, re: reply ? reply.id : null });
      } catch (e) {
        ta.value = text;
        toast(e.message, 'bad');
      }
      if (editing || reply) this.renderComposer();
      else ta.focus();
    };
    const file = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => {
      const files = [...file.files];
      file.value = '';
      for (const f of files) await this.sendFile(f, 'file');
    } });
    const context = this.editing ? h('div', { class: 'ctx' }, icon('edit', 16), h('span', null, 'Editing: ' + this.editing.text.slice(0, 80)), iconButton('close', 'Cancel', cancel))
      : this.reply ? h('div', { class: 'ctx' }, icon('reply', 16), h('span', null, 'Reply to: ' + (this.reply.text.slice(0, 80) || 'attachment')), iconButton('close', 'Cancel', cancel)) : null;
    const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    this.micBtn = canRecord ? iconButton('mic', 'Record a voice message', () => (this.recorder ? this.stopRecording(true) : this.startRecording())) : null;
    const later = () => {
      const text = ta.value.trim();
      if (!text) return toast('Write the message first, then choose when to send it');
      return this.schedule(text, () => {
        ta.value = '';
        grow();
      });
    };
    this.foot.replaceChildren(context || '', h('div', { class: 'bar' },
      file, iconButton('attach', 'Attach files', () => file.click()), ta, this.micBtn || '',
      !this.editing && iconButton('calendar', 'Send later', later, 'f-later'), iconButton('send', 'Send', send, 'primary')));
    if (this.editing) {
      ta.value = this.editing.text;
      grow();
    }
    if (!coarse()) ta.focus();
    // Dropping or pasting files into the conversation sends them.
    this.pane.ondragover = (e) => e.preventDefault();
    this.pane.ondrop = async (e) => {
      e.preventDefault();
      for (const f of [...(e.dataTransfer.files || [])]) await this.sendFile(f, 'file');
    };
    ta.addEventListener('paste', async (e) => {
      const files = [...(e.clipboardData.files || [])];
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await this.sendFile(f, 'file');
    });
  }

  async sendFile(f, hint) {
    const node = this.node;
    const spId = this.active;
    if (f.size > node.cfg.blobMax) return toast(`${f.name} is larger than ${size(node.cfg.blobMax)}`, 'bad');
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mime = f.type || 'application/octet-stream';
      const meta = { name: f.name || 'file', mime, kind: hint === 'voice' ? 'voice' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file', dur: f.dur || 0 };
      if (meta.kind === 'image') Object.assign(meta, await thumbnail(f).catch(() => ({ kind: 'file' })));
      const att = await node.addBlob(bytes, meta);
      await node.sendMessage(spId, { att: [att] });
    } catch (e) {
      toast(`Could not send ${f.name}: ${e.message}`, 'bad');
    }
    return undefined;
  }

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      const started = Date.now();
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        for (const t of stream.getTracks()) t.stop();
        clearInterval(this.recorder.tick);
        const keep = this.recorder.keep;
        this.recorder = null;
        this.renderComposer();
        if (!keep || !chunks.length) return;
        const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
        const blob = new Blob(chunks, { type });
        blob.name = `voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'}`;
        blob.dur = Date.now() - started;
        await this.sendFile(blob, 'voice');
      };
      this.recorder = { rec, keep: true, tick: 0 };
      rec.start();
      const label = h('span', { class: 'rec' }, 'Recording 0:00');
      this.recorder.tick = setInterval(() => (label.textContent = 'Recording ' + duration(Date.now() - started)), 500);
      this.foot.querySelector('.bar').replaceChildren(iconButton('close', 'Discard', () => this.stopRecording(false)), label, iconButton('send', 'Send voice message', () => this.stopRecording(true), 'primary'));
    } catch (e) {
      toast('Microphone not available: ' + (e.message || e.name), 'bad');
    }
  }

  stopRecording(keep) {
    if (!this.recorder) return;
    this.recorder.keep = keep;
    try {
      this.recorder.rec.stop();
    } catch { /* already stopped */ }
  }
}

// A small JPEG preview that travels inside the message, plus the original size.
async function thumbnail(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = h('canvas', { width: Math.max(1, Math.round(img.naturalWidth * k)), height: Math.max(1, Math.round(img.naturalHeight * k)) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.6));
    const thumb = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    return { thumb: thumb && thumb.length <= 30000 ? thumb : null, w: img.naturalWidth, h: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

