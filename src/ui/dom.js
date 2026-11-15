// SPDX-License-Identifier: AGPL-3.0-or-later
// Small DOM helpers. All user-provided text goes through text nodes, never innerHTML.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const ICONS = {
  send: 'M4 12l16-8-6 16-3-7z',
  attach: 'M20 11.5l-8.2 8.2a5 5 0 01-7-7l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.8-7.8',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3',
  stop: 'M7 7h10v10H7z',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6zM19 12a7 7 0 00-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 00-2.2-1.3L14 3h-4l-.4 2.4a7 7 0 00-2.2 1.3l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.6l-2 1.5 2 3.4 2.3-.9a7 7 0 002.2 1.3L10 21h4l.4-2.4a7 7 0 002.2-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5v.5',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  checks: 'M2 12.5l4.5 4.5L16 7.5M11 16l1 1 9.5-9.5',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20a8 8 0 0116 0',
  userplus: 'M10 12a4 4 0 100-8 4 4 0 000 8zM2 20a8 8 0 0113.5-5.8M19 13v6M16 16h6',
  users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18 14.5a6.5 6.5 0 013.5 5.5',
  horn: 'M4 10v4h3l7 4V6l-7 4zM17 9a4 4 0 010 6',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  reply: 'M10 8L5 13l5 5M5 13h9a5 5 0 015 5v1',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  wifi: 'M3 9a14 14 0 0118 0M6 12.5a9.5 9.5 0 0112 0M9 16a5 5 0 016 0M12 19.5v.5',
  lock: 'M8 11V8a4 4 0 018 0v3M6 11h12v9H6zM12 15v2',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a1 1 0 01-1 1A16 16 0 014 5a1 1 0 011-1z',
  bell: 'M6 16V11a6 6 0 0112 0v5l1.5 2h-15zM10 20a2 2 0 004 0',
  belloff: 'M4 4l16 16M6 16v-5a6 6 0 01.6-2.6M9 6a6 6 0 019 5v3M4.5 18H16M10 20a2 2 0 004 0',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  share: 'M14 5l6 6-6 6M20 11H10a6 6 0 00-6 6v2',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4L15 12l5 5M9 9.5v.01',
  ban: 'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8',
  timer: 'M12 21a8 8 0 100-16 8 8 0 000 16zM12 9v4l2.5 1.5M9.5 2h5',
  calendar: 'M5 6h14v14H5zM5 10h14M9 3v4M15 3v4',
  export: 'M12 15V4M7 9l5-5 5 5M5 15v5h14v-5',
  video: 'M3 7h11v10H3zM14 10.5l7-3.5v10l-7-3.5',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  micoff: 'M4 4l16 16M9 9v3a3 3 0 005 2.2M15 10.5V6a3 3 0 00-5.7-1.3M5 11a7 7 0 0011.2 5.6M19 11a7 7 0 01-.6 2.8M12 18v3',
  camoff: 'M4 4l16 16M14 10.5l7-3.5v10l-3.5-1.75M10 7h4v4M14 14.5V17H3V7h3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
};

export function icon(name, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}

export function button(label, onclick, { kind = '', ico = null, title = '', disabled = false } = {}) {
  return h('button', { class: 'btn ' + kind, onclick, title: title || undefined, disabled, type: 'button' }, ico && icon(ico, 18), label && h('span', null, label));
}

export function iconButton(name, title, onclick, kind = '') {
  return h('button', { class: 'icon-btn ' + kind, title, 'aria-label': title, onclick, type: 'button' }, icon(name));
}

// A stable colour per id, for avatars.
export function hueOf(id) {
  let n = 0;
  for (let i = 0; i < Math.min(id.length, 12); i++) n = (n * 31 + id.charCodeAt(i)) % 360;
  return n;
}

const PHOTO_URLS = new WeakMap(); // photo bytes -> object URL, made once

export function photoUrl(bytes) {
  let url = PHOTO_URLS.get(bytes);
  if (!url) PHOTO_URLS.set(bytes, (url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))));
  return url;
}

// `photo` is the JPEG of a profile, group or channel picture, when there is one.
export function avatar(id, name, kind = 'dm', photo = null) {
  const letters = (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?';
  const el = h('div', { class: 'avatar', style: { background: `hsl(${hueOf(id)} 55% 45%)` } });
  if (photo) el.append(h('img', { src: photoUrl(photo), alt: '' }));
  else if (kind === 'chan') el.append(icon('horn', 18));
  else if (kind === 'group') el.append(icon('users', 18));
  else el.textContent = letters;
  return el;
}

// Lets the user choose a picture and returns it as a small square JPEG, or null.
export function pickPhoto() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*' });
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        for (const [px, quality] of [[192, 0.82], [160, 0.7], [128, 0.6], [96, 0.5]]) {
          const c = h('canvas', { width: px, height: px });
          c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
          const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
          const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
          if (bytes && bytes.length <= 20000) return resolve(bytes);
        }
        return resolve(null);
      } catch {
        return resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    input.click();
  });
}

export function lastSeen(ts) {
  if (!ts) return 'offline';
  const d = new Date(ts);
  const label = dayLabel(ts);
  const day = label === 'Today' ? 'today' : label === 'Yesterday' ? 'yesterday' : 'on ' + label;
  return `last seen ${day} at ${clock(d)}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function listTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ts);
  if (now - d < 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* clipboard not available */ }
    ta.remove();
    return ok;
  }
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
