// SPDX-License-Identifier: AGPL-3.0-or-later
// Voice calls, video calls and screen sharing between two contacts.
//
// The call is set up over the conversation's own encrypted channel: ring, accept,
// the WebRTC offer and answer, and the candidate addresses all travel as sealed
// call signals whose sender is proven. The media then flows straight from one
// device to the other (DTLS-SRTP, keyed by the fingerprints in that offer and
// answer), so a call needs a direct path between the two devices and shows each
// side the other's network address. Every call has one audio and one video slot;
// camera and screen share fill the video slot without renegotiating.
//
// Sound and picture are encrypted twice: each frame is first sealed with
// AES-256-GCM under keys made from two secrets exchanged in ring and accept (see
// callseal.js), then by the connection itself. A browser that cannot reach encoded
// frames falls back to the connection's encryption alone, and the call says so.

import { h, icon, avatar, duration } from './dom.js';
import { toast } from './dialogs.js';
import { hex, unhex, rand, isBytes } from '../core/bytes.js';
import { UID } from '../core/crypto.js';
import { frameSealer, callKeys, onlyVp8 } from './callseal.js';

const RING_MS = 45000;
const REASONS = {
  declined: 'declined the call',
  busy: 'is on another call',
  off: 'does not take calls',
  timeout: 'did not answer',
  unreachable: 'is not reachable right now',
  failed: 'could not be reached directly, and calls need a direct connection',
  elsewhere: '',
  hangup: '',
};

export class Calls {
  constructor(app, iceServers) {
    this.app = app;
    this.node = app.node;
    this.ice = iceServers;
    this.call = null; // the call in progress, ringing out or connected
    this.ringing = null; // an incoming call waiting for an answer
    this.el = null;
    this.ui = null;
    this.key = '';
    this.sealing = null; // settles to what this browser offers for the second layer
    this.node.on('call', (uid, dev, m) => this.onSignal(uid, dev, m));
    this.node.on('settings', () => !this.node.settings.calls && this.call && this.end('hangup'));
  }

  // Calls need a camera/microphone API (secure pages only) and WebRTC.
  supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection);
  }

  // Why a call to this contact cannot be placed right now, or '' when it can.
  blocked(uid) {
    const c = this.node.contacts.get(uid);
    if (!this.node.settings.calls) return 'Calls are switched off in Settings';
    if (!this.supported()) return 'This page cannot use the microphone (it must be opened as a file or over https)';
    if (!c || c.pending) return 'Not a contact yet';
    if (c.relayOnly) return 'Calls are direct connections, and this contact is set to never connect directly';
    if (!this.node.uidOnline(uid)) return `${c.name} is not connected right now`;
    return '';
  }

  send(call, signal, dev = call.dev) {
    return this.node.callSignal(call.uid, dev, { ...signal, i: call.idBytes });
  }

  // The second layer of encryption, when this browser can do it (found out once).
  sealer() {
    if (!this.sealing) this.sealing = frameSealer();
    return this.sealing;
  }

  // Both sides gave a secret: every frame of this call is sealed under keys made
  // from the two of them.
  setKeys(call, seal, fromCaller, fromCallee) {
    if (!seal || !isBytes(fromCaller, 32) || !isBytes(fromCallee, 32)) return;
    call.seal = seal;
    call.keys = callKeys(fromCaller, fromCallee, call.idBytes);
  }

  // Puts the second layer on every sender and receiver of the call.
  protect(call) {
    if (!call.keys) return;
    const mine = call.keys[call.role];
    const theirs = call.keys[call.role === 'caller' ? 'callee' : 'caller'];
    for (const t of call.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      call.seal.attach(t.sender, 'seal', mine[kind]);
      call.seal.attach(t.receiver, 'open', theirs[kind]);
    }
  }

  // ---- placing a call ---------------------------------------------------------

  async start(uid, video) {
    if (this.call || this.ringing) return;
    const why = this.blocked(uid);
    if (why) return void toast(why, 'bad');
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (e) {
      return void toast(`Could not use the ${video ? 'camera or microphone' : 'microphone'}: ${e.message || e.name}`, 'bad');
    }
    const seal = await this.sealer();
    if (this.call || this.ringing) return void media.getTracks().forEach((t) => t.stop());
    const call = this.newCall(uid, rand(8), 'caller', media);
    this.call = call;
    if (seal) call.x = rand(32); // this side's half of the call's own keys
    if (!this.send(call, { k: 'ring', v: !!call.cam, ...(call.x ? { x: call.x } : {}) }, null)) return void this.end('unreachable', false);
    call.timer = setTimeout(() => this.call === call && call.state === 'calling' && this.end('timeout'), RING_MS);
    this.render();
    return undefined;
  }

  newCall(uid, idBytes, role, media) {
    const [mic] = media.getAudioTracks();
    const [cam] = media.getVideoTracks();
    return {
      id: hex(idBytes), idBytes, uid, dev: null, role, state: role === 'caller' ? 'calling' : 'connecting',
      mic, cam: cam || null, screen: null, muted: false, wantVideo: !!cam,
      remote: new MediaStream(), peerVideo: false, pc: null, queue: [], started: 0, timer: null, tick: null,
      x: null, seal: null, keys: null, // second layer: my secret, how to attach it, the keys once both secrets are known
    };
  }

  makePeer(call) {
    const pc = new RTCPeerConnection({ iceServers: this.ice(), ...(call.seal && call.seal.legacy ? { encodedInsertableStreams: true } : {}) });
    call.pc = pc;
    pc.onicecandidate = (e) => e.candidate && this.send(call, { k: 'ice', c: JSON.stringify(e.candidate) });
    pc.ontrack = (e) => {
      call.remote.addTrack(e.track);
      // The element was created before any track existed: start it explicitly.
      const el = this.el && this.el.querySelector('video.remote');
      if (el) {
        el.srcObject = call.remote;
        el.play().catch(() => {});
      }
      this.render();
    };
    pc.onconnectionstatechange = () => {
      if (this.call !== call) return;
      if (pc.connectionState === 'connected' && call.state !== 'active') {
        call.state = 'active';
        call.started = Date.now();
        call.tick = setInterval(() => this.renderStatus(), 1000);
        this.sendState(call);
      }
      if (pc.connectionState === 'failed') this.end('failed');
      this.render();
    };
    return pc;
  }

  videoSender(call) {
    const t = call.pc && call.pc.getTransceivers()[1];
    return t ? t.sender : null;
  }

  sendState(call) {
    this.send(call, { k: 'state', v: !!(call.cam || call.screen) });
  }

  // ---- signals from the other side ------------------------------------------------

  async onSignal(uid, dev, m) {
    const id = hex(m.i);
    const call = this.call;
    if (m.k === 'ring') {
      if (call || this.ringing) return void this.node.callSignal(uid, dev, { k: 'end', i: m.i, r: 'busy' });
      if (!this.supported()) return void this.node.callSignal(uid, dev, { k: 'end', i: m.i, r: 'off' });
      this.ringing = { id, idBytes: m.i, uid, dev, video: !!m.v, x: isBytes(m.x, 32) ? m.x : null, timer: setTimeout(() => this.ringing && this.ringing.id === id && this.stopRinging(), RING_MS + 5000) };
      if (m.x) this.sealer(); // get ready while it rings
      this.app.notify(null, this.node.nameOf(uid), m.v ? 'Incoming video call' : 'Incoming call');
      return void this.render();
    }
    if (m.k === 'end') {
      if (this.ringing && this.ringing.id === id && this.ringing.uid === uid) return void this.stopRinging();
      // "answered elsewhere" is addressed to every device but the one that answered
      if (call && call.id === id && call.uid === uid && !(m.keep && this.node.devHex === hex(m.keep))) this.end(typeof m.r === 'string' ? m.r : 'hangup', false);
      return;
    }
    if (!call || call.id !== id || call.uid !== uid) return;
    try {
      if (m.k === 'accept' && call.role === 'caller' && call.state === 'calling' && typeof m.s === 'string') {
        // The first device that answers takes the call; the others stop ringing.
        clearTimeout(call.timer);
        call.dev = dev;
        call.state = 'connecting';
        call.peerVideo = !!m.v;
        this.node.callSignal(uid, null, { k: 'end', i: call.idBytes, r: 'elsewhere', keep: unhex(dev.slice(UID * 2)) });
        if (call.x) this.setKeys(call, await this.sealer(), call.x, m.x);
        const pc = this.makePeer(call);
        await pc.setRemoteDescription({ type: 'offer', sdp: m.s });
        this.protect(call);
        const [audio, video] = pc.getTransceivers();
        audio.direction = 'sendrecv';
        await audio.sender.replaceTrack(call.mic);
        if (video) {
          video.direction = 'sendrecv';
          if (call.cam) await video.sender.replaceTrack(call.cam);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        this.send(call, { k: 'answer', s: pc.localDescription.sdp });
        await this.drain(call);
      } else if (m.k === 'answer' && call.role === 'callee' && dev === call.dev && typeof m.s === 'string') {
        await call.pc.setRemoteDescription({ type: 'answer', sdp: m.s });
        await this.drain(call);
      } else if (m.k === 'ice' && dev === call.dev && typeof m.c === 'string' && m.c.length < 2000) {
        const candidate = JSON.parse(m.c);
        if (call.pc && call.pc.remoteDescription) await call.pc.addIceCandidate(candidate).catch(() => {});
        else if (call.queue.length < 60) call.queue.push(candidate);
      } else if (m.k === 'state' && dev === call.dev) {
        call.peerVideo = !!m.v;
      }
    } catch (e) {
      console.error(e);
      this.end('failed');
    }
    this.render();
  }

  async drain(call) {
    for (const c of call.queue.splice(0)) await call.pc.addIceCandidate(c).catch(() => {});
  }

  // ---- answering ------------------------------------------------------------------

  async accept(video) {
    const ring = this.ringing;
    if (!ring || this.call) return;
    let media;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (e) {
      toast(`Could not use the ${video ? 'camera or microphone' : 'microphone'}: ${e.message || e.name}`, 'bad');
      return void this.decline();
    }
    const seal = ring.x ? await this.sealer() : null;
    if (this.ringing !== ring) return void media.getTracks().forEach((t) => t.stop());
    clearTimeout(ring.timer);
    this.ringing = null;
    const call = this.newCall(ring.uid, ring.idBytes, 'callee', media);
    call.dev = ring.dev;
    call.peerVideo = ring.video;
    this.call = call;
    try {
      if (seal) {
        call.x = rand(32);
        this.setKeys(call, seal, ring.x, call.x);
      }
      const pc = this.makePeer(call);
      await pc.addTransceiver('audio', { direction: 'sendrecv' }).sender.replaceTrack(call.mic);
      const video2 = pc.addTransceiver('video', { direction: 'sendrecv' });
      if (call.keys && !onlyVp8(video2)) call.keys = null; // sealed pictures need VP8
      this.protect(call);
      if (call.cam) await video2.sender.replaceTrack(call.cam);
      await pc.setLocalDescription(await pc.createOffer());
      this.send(call, { k: 'accept', s: pc.localDescription.sdp, v: !!call.cam, ...(call.keys ? { x: call.x } : {}) });
    } catch (e) {
      console.error(e);
      this.end('failed');
    }
    this.render();
  }

  decline() {
    const ring = this.ringing;
    if (!ring) return;
    this.node.callSignal(ring.uid, ring.dev, { k: 'end', i: ring.idBytes, r: 'declined' });
    this.stopRinging();
  }

  stopRinging() {
    if (this.ringing) clearTimeout(this.ringing.timer);
    this.ringing = null;
    this.render();
  }

  // ---- during the call ---------------------------------------------------------------

  toggleMute() {
    const call = this.call;
    if (!call) return;
    call.muted = !call.muted;
    call.mic.enabled = !call.muted;
    this.render();
  }

  async toggleCamera() {
    const call = this.call;
    if (!call) return;
    try {
      if (call.cam) {
        call.cam.stop();
        call.cam = null;
        if (!call.screen) await this.videoSender(call)?.replaceTrack(null);
      } else {
        [call.cam] = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks();
        if (this.call !== call) return void call.cam.stop();
        if (!call.screen) await this.videoSender(call)?.replaceTrack(call.cam);
      }
    } catch (e) {
      toast('Could not use the camera: ' + (e.message || e.name), 'bad');
    }
    this.sendState(call);
    this.render();
  }

  async toggleScreen() {
    const call = this.call;
    if (!call) return;
    try {
      if (call.screen) {
        call.screen.stop();
        call.screen = null;
        await this.videoSender(call)?.replaceTrack(call.cam);
      } else {
        const [track] = (await navigator.mediaDevices.getDisplayMedia({ video: true })).getVideoTracks();
        if (this.call !== call) return void track.stop();
        call.screen = track;
        track.contentHint = 'detail'; // keep text sharp rather than motion smooth
        track.onended = () => this.call === call && call.screen === track && this.toggleScreen();
        await this.videoSender(call)?.replaceTrack(track);
      }
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Could not share the screen: ' + (e.message || e.name), 'bad');
    }
    this.sendState(call);
    this.render();
  }

  // Ends the call on this side. `tell` also tells the other side.
  end(reason = 'hangup', tell = true) {
    const call = this.call;
    if (!call) return;
    this.call = null;
    clearTimeout(call.timer);
    clearInterval(call.tick);
    if (tell) this.send(call, { k: 'end', r: reason === 'timeout' ? 'hangup' : reason }, call.dev);
    for (const t of [call.mic, call.cam, call.screen]) if (t) t.stop();
    if (call.pc) {
      call.pc.onconnectionstatechange = null;
      call.pc.close();
    }
    const text = REASONS[reason];
    if (text) toast(`${this.node.nameOf(call.uid)} ${text}`, reason === 'failed' ? 'bad' : '');
    // The caller leaves a line in the conversation: how long, or that nobody answered.
    if (call.role === 'caller') {
      const c = this.node.contacts.get(call.uid);
      const sp = c && this.node.spaces.get(c.dm);
      const body = { v: call.wantVideo, d: call.started ? Date.now() - call.started : 0 };
      if (sp) this.node.enqueue(() => this.node.post(sp, 'call', body)).catch(() => {});
    }
    this.render();
  }

  // ---- interface -------------------------------------------------------------------

  renderStatus() {
    const call = this.call;
    const el = this.el && this.el.querySelector('.call-status');
    if (call && el) el.textContent = this.statusText(call);
  }

  statusText(call) {
    if (call.state === 'calling') return 'Calling…';
    if (call.state === 'connecting') return 'Connecting…';
    return duration(Date.now() - call.started);
  }

  // The remote video element is created once per call and never taken out of the
  // page (that would pause it); only the controls around it are redrawn.
  render() {
    const { call, ringing } = this;
    const key = call ? 'call:' + call.id : ringing ? 'ring:' + ringing.id : '';
    if (this.key !== key) {
      if (this.el) this.el.remove();
      this.el = null;
      this.key = key;
      if (key) {
        this.ui = h('div', { class: 'call-ui' });
        this.el = h('div', { class: 'call' }, this.ui);
        if (call) {
          const remote = h('video', { class: 'remote', autoplay: true, playsInline: true });
          remote.srcObject = call.remote;
          this.el.prepend(remote);
        }
        document.body.append(this.el);
      }
    }
    if (this.el && ringing && !call) {
      const name = this.node.nameOf(ringing.uid);
      this.el.className = 'call incoming';
      this.ui.replaceChildren(h('div', { class: 'call-card' },
        avatar(ringing.uid, name, 'dm', this.node.avatarOf(ringing.uid)), h('strong', null, name), h('span', null, ringing.video ? 'Incoming video call' : 'Incoming call'),
        h('div', { class: 'call-bar' },
          h('button', { class: 'round good f-accept', type: 'button', title: 'Answer', onclick: () => this.accept(false) }, icon('phone', 24)),
          h('button', { class: 'round good f-accept-video', type: 'button', title: 'Answer with video', onclick: () => this.accept(true) }, icon('video', 24)),
          h('button', { class: 'round bad f-decline', type: 'button', title: 'Decline', onclick: () => this.decline() }, icon('close', 24)))));
    } else if (this.el && call) {
      const name = this.node.nameOf(call.uid);
      const showRemote = call.state === 'active' && call.peerVideo;
      const mine = call.screen || call.cam;
      const local = mine ? h('video', { class: 'local' + (call.screen ? ' screen' : ''), autoplay: true, playsInline: true, muted: true }) : null;
      if (local) local.srcObject = new MediaStream([mine]);
      const round = (cls, name2, title, on, fn) => h('button', { class: `round ${cls}${on ? ' on' : ''}`, type: 'button', title, 'aria-label': title, onclick: fn }, icon(name2, 22));
      this.el.className = `call ${call.state}${showRemote ? ' with-video' : ''}`;
      this.ui.replaceChildren(...[
        !showRemote && h('div', { class: 'call-card' }, avatar(call.uid, name, 'dm', this.node.avatarOf(call.uid)), h('strong', null, name)),
        h('div', { class: 'call-top' }, h('strong', null, name), h('span', { class: 'call-status' }, this.statusText(call)),
          call.keys
            ? h('span', { class: 'call-lock double', title: 'Sound and picture are encrypted twice between your two devices: every frame is sealed with AES-256-GCM under keys agreed inside your encrypted conversation, then encrypted again by the connection itself (DTLS-SRTP). Nothing in between can decrypt the call.' }, icon('lock', 14), 'End-to-end encrypted, twice')
            : h('span', { class: 'call-lock', title: 'Sound and picture are encrypted between your two devices (DTLS-SRTP). The keys were agreed inside your encrypted conversation, and nothing in between can decrypt the call. One of the two browsers cannot add the second layer of encryption, so this call has one.' }, icon('lock', 14), 'End-to-end encrypted')),
        local,
        h('div', { class: 'call-bar' },
          round('f-mute', call.muted ? 'micoff' : 'mic', call.muted ? 'Unmute' : 'Mute', call.muted, () => this.toggleMute()),
          round('f-cam', call.cam ? 'video' : 'camoff', call.cam ? 'Turn the camera off' : 'Turn the camera on', !call.cam, () => this.toggleCamera()),
          navigator.mediaDevices.getDisplayMedia && round('f-share', 'screen', call.screen ? 'Stop sharing the screen' : 'Share the screen', !!call.screen, () => this.toggleScreen()),
          round('bad f-hangup', 'phone', 'Hang up', false, () => this.end('hangup'))),
      ].filter(Boolean));
    }
    this.app.refresh('head');
  }
}
