// SPDX-License-Identifier: AGPL-3.0-or-later
// QR codes: drawing them, and reading them with the camera where the browser allows it.

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { h } from './dom.js';

export function qrCanvas(text, px = 260) {
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const scale = Math.max(2, Math.floor(px / (n + quiet * 2)));
  const dim = (n + quiet * 2) * scale;
  const canvas = h('canvas', { class: 'qr', width: dim, height: dim, role: 'img', 'aria-label': 'QR code' });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  }
  return canvas;
}

// The camera needs a secure context (file://, https:// or localhost).
export const canScan = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

// Shows the camera in `host` and resolves with the first QR code that matches `accept`.
// Returns { result: Promise<string>, stop() }.
export function scan(host, accept = () => true) {
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true });
  const canvas = document.createElement('canvas');
  host.replaceChildren(video);
  let stream = null;
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (stream) for (const t of stream.getTracks()) t.stop();
    video.remove();
  };
  const result = (async () => {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (stopped) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('Cancelled');
    }
    video.srcObject = stream;
    await video.play();
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    return new Promise((resolve, reject) => {
      let busy = false;
      timer = setInterval(async () => {
        if (busy || stopped || !video.videoWidth) return;
        busy = true;
        try {
          let text = '';
          if (detector) {
            const found = await detector.detect(video);
            if (found.length) text = found[0].rawValue;
          } else {
            const k = Math.min(1, 720 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * k);
            canvas.height = Math.round(video.videoHeight * k);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(img.data, img.width, img.height);
            if (found) text = found.data;
          }
          if (text && accept(text)) {
            stop();
            resolve(text);
          }
        } catch (e) {
          stop();
          reject(e);
        }
        busy = false;
      }, 180);
    });
  })();
  result.catch(() => {});
  return { result, stop };
}
