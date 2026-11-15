// SPDX-License-Identifier: AGPL-3.0-or-later
// WebRTC data-channel transport for browsers.
//
// A browser cannot listen for connections or dial an address, so every link starts
// with an offer and an answer that must travel some other way: by hand (QR code or
// copied text) for the first link of a session, through the mesh afterwards.
// The codes are a compact binary form of the SDP: ICE credentials, the DTLS
// fingerprint and the candidate addresses. Nothing else is needed to rebuild it.

import * as cbor from '../core/cbor.js';
import { concat, isBytes } from '../core/bytes.js';

const FRAGMENT = 60 * 1024; // payload bytes per data-channel message
const HIGH_WATER = 4 * 1024 * 1024; // stop feeding the channel above this
const MAX_MESSAGE = 8 * 1024 * 1024;
const MAX_CANDIDATES = 8;

export class RtcTransport {
  // `iceServers` returns the STUN servers to use, or [] for none (the default).
  constructor(iceServers = () => []) {
    this.iceServers = iceServers;
    this.stats = { offers: 0, links: 0 };
  }

  static available() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  newPeer() {
    const servers = this.iceServers();
    return { pc: new RTCPeerConnection({ iceServers: servers }), gatherMs: servers.length ? 3000 : 1500 };
  }

  async offer() {
    const { pc, gatherMs } = this.newPeer();
    try {
      const dc = pc.createDataChannel('void', { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, gatherMs);
      const local = parseSdp(pc.localDescription.sdp);
      if (!local.c.length) throw new Error('No network address found. Check that this device is connected to a network.');
      this.stats.offers++;
      return {
        code: cbor.encode(local),
        cancel: () => pc.close(),
        accept: async (answerCode) => {
          const remote = readCode(answerCode);
          const link = new RtcLink(pc, dc, local.f, remote.f);
          await pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(remote, 'answer') });
          await link.opened(30000);
          this.stats.links++;
          return link;
        },
      };
    } catch (e) {
      pc.close();
      throw e;
    }
  }

  // `manual` is the hand-carried exchange: the other side may take minutes to
  // bring our answer back, so we keep probing instead of giving up.
  async answer(offerCode, { manual = false } = {}) {
    const remote = readCode(offerCode);
    const { pc, gatherMs } = this.newPeer();
    try {
      const channel = new Promise((resolve) => {
        pc.ondatachannel = (e) => resolve(e.channel);
      });
      await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(remote, 'offer') });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, gatherMs);
      const local = parseSdp(pc.localDescription.sdp);
      if (!local.c.length) throw new Error('No network address found. Check that this device is connected to a network.');
      let probe = null;
      let giveUp = null;
      let cancel = () => {};
      const stop = () => {
        clearInterval(probe);
        clearTimeout(giveUp);
      };
      const link = new Promise((resolve, reject) => {
        const fail = (why) => {
          stop();
          pc.close();
          reject(new Error(why));
        };
        cancel = () => fail('Cancelled');
        giveUp = setTimeout(() => fail('The connection was not completed in time'), manual ? 600000 : 30000);
        if (manual) {
          // Re-offering the remote candidates makes the ICE agent start fresh
          // checks, so it is still probing when the other side finally answers.
          const lines = candidateLines(remote);
          probe = setInterval(() => {
            if (pc.connectionState === 'connected') return;
            for (const candidate of lines) pc.addIceCandidate({ candidate, sdpMid: remote.m || '0', sdpMLineIndex: 0 }).catch(() => {});
          }, 4000);
        } else {
          pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed') fail('Could not reach the other device');
          });
        }
        channel.then((dc) => {
          const l = new RtcLink(pc, dc, local.f, remote.f);
          l.opened(manual ? 600000 : 30000).then(() => {
            stop();
            this.stats.links++;
            resolve(l);
          }, (e) => fail(e.message));
        });
      });
      link.catch(() => {});
      return { code: cbor.encode(local), link, cancel: () => cancel() };
    } catch (e) {
      pc.close();
      throw e;
    }
  }
}

// One open data channel. Large messages are split into fragments; the channel is
// ordered and reliable, so fragments of one message always arrive back to back.
class RtcLink {
  constructor(pc, dc, fpLocal, fpRemote) {
    this.pc = pc;
    this.dc = dc;
    this.fpLocal = fpLocal;
    this.fpRemote = fpRemote;
    this.closed = false;
    this.onclose = null;
    this.handler = null;
    this.inbox = [];
    this.queue = [];
    this.queued = 0; // bytes waiting in `queue`
    this.parts = [];
    this.partBytes = 0;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 512 * 1024;
    dc.onbufferedamountlow = () => this.pump();
    dc.onmessage = (e) => this.receive(new Uint8Array(e.data));
    dc.onclose = () => this.close();
    dc.onerror = () => this.close();
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close();
      if (s === 'disconnected') setTimeout(() => pc.connectionState === 'disconnected' && this.close(), 6000);
    });
  }

  opened(ms) {
    return new Promise((resolve, reject) => {
      if (this.dc.readyState === 'open') return resolve();
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('Could not reach the other device'));
      }, ms);
      this.dc.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.pc.addEventListener('connectionstatechange', () => {
        if (this.pc.connectionState !== 'failed') return;
        clearTimeout(timer);
        this.close();
        reject(new Error('Could not reach the other device'));
      });
      return undefined;
    });
  }

  // What the browser reports about this connection: the addresses in use, the
  // round-trip time, traffic counters and the cipher.
  async stats() {
    const out = { state: this.pc.connectionState };
    try {
      const report = await this.pc.getStats();
      let pair = null;
      let transport = null;
      report.forEach((s) => {
        if (s.type === 'transport') transport = s;
        if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')) && !pair) pair = s;
      });
      if (transport && transport.selectedCandidatePairId) pair = report.get(transport.selectedCandidatePairId) || pair;
      const end = (id) => {
        const c = id && report.get(id);
        return c ? { address: c.address || c.ip || '', port: c.port, type: c.candidateType, protocol: c.protocol } : null;
      };
      if (pair) Object.assign(out, { local: end(pair.localCandidateId), remote: end(pair.remoteCandidateId), rtt: pair.currentRoundTripTime, sent: pair.bytesSent, received: pair.bytesReceived });
      if (transport) out.cipher = [transport.tlsVersion && 'DTLS', transport.dtlsCipher].filter(Boolean).join(' ') || undefined;
    } catch { /* statistics are optional */ }
    return out;
  }

  // Bytes accepted for sending that have not left yet. The engine stops serving a
  // neighbour whose backlog keeps growing.
  backlog() {
    return this.queued + (this.dc.bufferedAmount || 0);
  }

  // Messages that arrive before the engine attaches are kept, not dropped.
  set onmessage(fn) {
    this.handler = fn;
    for (const b of this.inbox.splice(0)) fn(b);
  }

  get onmessage() {
    return this.handler;
  }

  send(bytes) {
    if (this.closed) throw new Error('link closed');
    this.queued += bytes.length;
    if (bytes.length <= FRAGMENT) {
      this.queue.push(withFlag(0, bytes));
    } else {
      for (let o = 0; o < bytes.length; o += FRAGMENT) {
        this.queue.push(withFlag(o + FRAGMENT >= bytes.length ? 2 : 1, bytes.subarray(o, o + FRAGMENT)));
      }
    }
    this.pump();
  }

  pump() {
    while (this.queue.length && !this.closed && this.dc.readyState === 'open' && this.dc.bufferedAmount < HIGH_WATER) {
      try {
        const part = this.queue.shift();
        this.queued = this.queue.length ? Math.max(0, this.queued - part.length + 1) : 0;
        this.dc.send(part);
      } catch {
        return this.close();
      }
    }
    return undefined;
  }

  receive(data) {
    if (!data.length) return;
    const body = data.subarray(1);
    if (data[0] === 0) return this.deliver(body);
    this.parts.push(body);
    this.partBytes += body.length;
    if (this.partBytes > MAX_MESSAGE) return this.close();
    if (data[0] === 2) {
      const whole = concat(...this.parts);
      this.parts = [];
      this.partBytes = 0;
      this.deliver(whole);
    }
    return undefined;
  }

  deliver(bytes) {
    if (this.handler) this.handler(bytes);
    else this.inbox.push(bytes);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.dc.close(); } catch { /* already closed */ }
    try { this.pc.close(); } catch { /* already closed */ }
    if (this.onclose) this.onclose();
  }
}

function withFlag(flag, bytes) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = flag;
  out.set(bytes, 1);
  return out;
}

// Waits for the candidate addresses: until the browser says it is done, or shortly
// after the first public address arrived, or until `ms` at the latest (a STUN
// server that does not answer must not hold the connection up).
function gathered(pc, ms) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let grace = null;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(grace);
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const onCandidate = (e) => {
      if (e.candidate && / typ srflx/.test(e.candidate.candidate) && !grace) grace = setTimeout(done, 400);
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
    return undefined;
  });
}

// ---- compact SDP ------------------------------------------------------------
// { u: ufrag, p: pwd, f: sha-256 fingerprint, s: setup role, m: mid (when not "0"),
//   c: [[type, address, port]] }
// type: 0 host IP, 1 server-reflexive IP, 2 relay IP, 3 host mDNS uuid, 4 host name

const SETUP = ['actpass', 'active', 'passive'];
const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

export function parseSdp(sdp) {
  const get = (re) => {
    const m = re.exec(sdp);
    return m ? m[1].trim() : '';
  };
  const fp = get(/^a=fingerprint:sha-256 (.+)$/im);
  const out = {
    u: get(/^a=ice-ufrag:(.+)$/m),
    p: get(/^a=ice-pwd:(.+)$/m),
    f: Uint8Array.from(fp.split(':').filter(Boolean).map((x) => parseInt(x, 16))),
    s: Math.max(0, SETUP.indexOf(get(/^a=setup:(.+)$/m))),
    c: [],
  };
  const mid = get(/^a=mid:(.+)$/m);
  if (mid && mid !== '0') out.m = mid;
  if (!out.u || !out.p || out.f.length !== 32) throw new Error('This browser produced an unexpected WebRTC description');
  const seen = new Set();
  for (const m of sdp.matchAll(/^a=candidate:(.+)$/gm)) {
    const f = m[1].trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '1' || f[2].toLowerCase() !== 'udp' || f[6] !== 'typ') continue;
    const type = { host: 0, srflx: 1, relay: 2 }[f[7]];
    const port = Number(f[5]);
    if (type === undefined || !(port > 0 && port < 65536) || seen.has(f[4] + port)) continue;
    seen.add(f[4] + port);
    const mdns = MDNS.exec(f[4]);
    if (mdns) out.c.push([3, hexBytes(mdns.slice(1).join('')), port]);
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(f[4])) out.c.push([type, Uint8Array.from(f[4].split('.').map(Number)), port]);
    else if (f[4].includes(':')) out.c.push([type, ipv6Bytes(f[4]), port]);
    else out.c.push([4, f[4].slice(0, 80), port]);
    if (out.c.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function readCode(code) {
  const o = cbor.decode(code, 8192);
  if (!o || typeof o.u !== 'string' || typeof o.p !== 'string' || !isBytes(o.f, 32) || !Array.isArray(o.c)) throw new Error('This code is not valid');
  if (!/^[A-Za-z0-9+/]{4,256}$/.test(o.u) || !/^[A-Za-z0-9+/]{22,256}$/.test(o.p)) throw new Error('This code is not valid');
  if (o.m !== undefined && !/^[A-Za-z0-9._-]{1,16}$/.test(o.m)) throw new Error('This code is not valid');
  return o;
}

function candidateLines(o) {
  const lines = [];
  o.c.slice(0, MAX_CANDIDATES).forEach((c, i) => {
    if (!Array.isArray(c) || !Number.isInteger(c[2]) || c[2] < 1 || c[2] > 65535) return;
    let addr;
    if (c[0] === 3 && isBytes(c[1], 16)) {
      const h = [...c[1]].map((b) => b.toString(16).padStart(2, '0')).join('');
      addr = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
    } else if (c[0] === 4 && typeof c[1] === 'string' && /^[A-Za-z0-9.-]{1,80}$/.test(c[1])) {
      addr = c[1];
    } else if (isBytes(c[1], 4)) {
      addr = [...c[1]].join('.');
    } else if (isBytes(c[1], 16)) {
      addr = Array.from({ length: 8 }, (_, k) => ((c[1][k * 2] << 8) | c[1][k * 2 + 1]).toString(16)).join(':');
    } else {
      return;
    }
    const v6 = addr.includes(':');
    if (c[0] === 1) lines.push(`candidate:${i + 1} 1 udp ${1686052607 - i} ${addr} ${c[2]} typ srflx raddr ${v6 ? '::' : '0.0.0.0'} rport 9`);
    else if (c[0] === 2) lines.push(`candidate:${i + 1} 1 udp ${41885439 - i} ${addr} ${c[2]} typ relay raddr ${v6 ? '::' : '0.0.0.0'} rport 9`);
    else lines.push(`candidate:${i + 1} 1 udp ${2122260223 - i} ${addr} ${c[2]} typ host`);
  });
  return lines;
}

export function buildSdp(o, type) {
  const fp = [...o.f].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const setup = type === 'offer' ? 'actpass' : SETUP[o.s] === 'passive' ? 'passive' : 'active';
  const mid = o.m || '0';
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${o.u}`,
    `a=ice-pwd:${o.p}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ...candidateLines(o).map((l) => 'a=' + l),
    '',
  ].join('\r\n');
}

function hexBytes(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function ipv6Bytes(text) {
  const [head, tail] = text.split('%')[0].split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail === undefined ? a : [...a, ...new Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  const out = new Uint8Array(16);
  groups.slice(0, 8).forEach((g, i) => {
    const v = parseInt(g || '0', 16) || 0;
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 255;
  });
  return out;
}
