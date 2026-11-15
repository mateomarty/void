// SPDX-License-Identifier: AGPL-3.0-or-later
// Wire constants. See PROTOCOL.md for the message layouts.

// Raised whenever two builds could no longer understand each other. Devices on
// different versions refuse to link and tell their users why.
export const PROTOCOL = 4;

// Generation of the identity keys a profile or a backup was made with:
// 1 = Curve25519 (protocol 3 and earlier), 2 = Curve448. A profile of another
// generation cannot be carried over: its user id would change and none of its
// contacts or conversations would match any more.
export const KEYGEN = 2;
export function oldKeys(what) {
  return Object.assign(new Error(`This ${what} was made by an earlier version of Void. This version uses new, stronger keys and cannot carry it over.`), { code: 'old-keys' });
}

export const T = {
  // link level: between two directly connected devices
  AUTH1: 1, // { c, s, d, n }        signed card, device id, nonce
  AUTH2: 2, // { s }                 signature binding both DTLS fingerprints and nonces
  RREQ: 3, //  { i, g: [tag], h, n } route request, flooded over contact links
  RREP: 4, //  { i, x, m, c, n }     route reply, creates tunnel x along the reverse path
  TDATA: 5, // { x, d }              opaque frame carried along tunnel x
  TCLOSE: 6, // { x }
  FRAME: 7, // { d }                 same frame, sent to the directly connected device
  STORE: 8, // { g, x, f: [frame] }  ask a contact to hold frames for an offline recipient
  PING: 9,
  PONG: 10,

  // frame level: end to end between two devices, over a link or a tunnel
  SF: 21, //     { g, b }            space frame: tag + AEAD box under the space key
  PICKUP: 22, // { g, h: [id] }      fetch held frames for a mailbox tag
  PICKED: 23, // { g, f: [frame] }
  HPKE: 25, //   { g, e, c }         contact request sealed to an identity key
  KEEP: 26, //   {}                  keeps a tunnel alive
  HS1: 27, //    { g, e }            session handshake over a tunnel: requester's ephemeral key
  HS2: 28, //    { e, b }            responder's ephemeral key and sealed identity proof
  HS3: 29, //    { b }               requester's sealed identity proof
  ENC: 30, //    { n, b }            any frame, sealed with the session key, counted

  // space level: inside a space frame
  VEC: 40, //   { v: [[feed, max]] } what the sender holds
  EV: 41, //    { e: [[raw, sig]] }  signed events
  SIG: 42, //   { to, k, i, s }      WebRTC signalling for a direct connection
  BREQ: 43, //  { i, c, n }          request n chunks of blob i starting at chunk c
  BDATA: 44, // { i, c, d, z }       one chunk, z = total chunks
  BNONE: 45, // { i }
  CHS: 46, //   { a, g: [digest] }   salted digests of channel tags, to find shared channels
  CALL: 47, //  { k, i, to, … }      call signalling between two contacts (ring, accept, answer, ice, state, end)
};

export const DEFAULTS = {
  ttl: 6, // maximum hops a route request travels
  maxTunnelsPerRequest: 3,
  maxEndpointTunnels: 96,
  maxRelayTunnels: 256,
  maxFrame: 72 * 1024, // largest frame a relay forwards
  maxRelayPerLink: 48, // tunnels one neighbour may have us carry
  maxRepliesRelayed: 8, // route replies passed back per request
  maxAnonTunnels: 24, // tunnels whose other end has not proven who it is
  anonTunnelTtl: 30000,
  maxBacklog: 48 * 1024 * 1024, // bytes queued toward one neighbour before the link is dropped
  blobBacklog: 4 * 1024 * 1024, // above this, file requests from that neighbour wait
  maxDevicesPerAuthor: 16, // feeds one user may open in a conversation
  vecChunk: 800, // feeds listed per VEC message
  rreqPerSecond: 40, // per link, excess is dropped
  rreqTick: 4000, // how often the discovery loop runs
  rreqEvery: 20000, // first retry delay for an unreachable target, doubles up to rreqMax
  rreqMax: 300000,
  antiEntropy: 30000,
  keepalive: 10000,
  linkTimeout: 35000,
  probeTimeout: 3000, // how long a doubtful link has to answer a ping
  dialRace: 3000, // two links to one device within this window count as a simultaneous dial
  authTimeout: 15000,
  tunnelIdle: 120000,
  seenTtl: 120000,
  gcEvery: 15000,
  vecDelay: 120, // debounce for acknowledgements
  batchBytes: 40 * 1024,
  syncBurst: 400, // events sent per feed before waiting for an acknowledgement
  historyWindow: 200, // events of a channel feed sent to a new subscriber
  maxEvent: 56 * 1024,
  courierTtl: 7 * 86400 * 1000,
  courierFanout: 3,
  courierMaxFrame: 64 * 1024,
  courierMaxBytes: 24 * 1024 * 1024,
  courierPerPeer: 6 * 1024 * 1024,
  schedTick: 5000, // how often scheduled messages are checked
  ttlTick: 60000, // how often self-deleting messages are purged
  rdvTick: 20000, // how often rendezvous topics are refreshed
  rdvEvery: 120000, // pause between two hellos to a contact that stays unreachable
  upgradeRetry: 60000, // first retry delay for a direct connection attempt, doubles
  upgradeTimeout: 30000,
  sigEvery: 5000, // one direct-connection offer per device is answered in this time
  blobChunk: 32 * 1024, // ciphertext bytes per chunk
  blobWindow: 8, // chunks requested at a time
  blobTimeout: 15000,
  blobMax: 256 * 1024 * 1024,
  blobTunnelMax: 8 * 1024 * 1024, // larger files wait for a direct connection
  blobAuto: 3 * 1024 * 1024, // images and voice messages below this download automatically
};

export const SETTINGS = {
  relay: true, // forward route requests and carry tunnels for others
  courier: true, // hold messages for contacts' offline recipients
  autoDirect: true, // try to replace relayed routes with direct connections
  stun: true, // ask public STUN servers for this device's public address, so links work across networks
  stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  rdv: true, // find contacts again after a restart through public rendezvous relays
  rdvRelays: ['wss://nos.lol', 'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub'],
  requests: true, // accept contact requests from people who hold my contact link
  calls: true, // voice calls, video calls and screen sharing with contacts
  guideDone: false, // the first-steps guide was completed or dismissed
  backedUp: false, // a backup file was saved at least once
  notify: false,
  autoHide: 15, // minutes without input before the screen is hidden behind the password, 0 = never
};
