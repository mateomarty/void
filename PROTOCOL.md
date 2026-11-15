# Void protocol, version 4

This document describes what a Void device sends and accepts, in enough detail to write an independent implementation. The reference implementation is in `src/core/`. Where this text and the code disagree, the code is what currently runs; please report the difference.

Status: experimental. The protocol has not been audited and will change.

## 1. Conventions

- **Encoding.** Every structure is CBOR (RFC 8949) restricted to unsigned and negative integers, byte strings, text strings, arrays, maps with text keys, `true`, `false` and `null`. Senders use the core deterministic encoding (shortest integer form, map keys sorted by their encoded bytes). Receivers verify signatures and compute hashes over the bytes as received, so they never need to re-encode.
- **Primitives.**

| Purpose | Algorithm |
| --- | --- |
| Signatures | Ed448 (RFC 8032, empty context): public key 57 bytes, signature 114 bytes |
| Key agreement | X448 (RFC 7748): public key 56 bytes |
| Post-quantum key encapsulation | ML-KEM-1024 (FIPS 203): public key 1568 bytes, ciphertext 1568 bytes, shared secret 32 bytes. Only ever used together with X448 |
| Symmetric encryption | XChaCha20-Poly1305, 256-bit key, random 24-byte nonce, box = nonce ‖ ciphertext ‖ tag |
| Key derivation | HKDF-SHA512, empty salt, `info` = ASCII label ‖ context bytes |
| Public-key encryption | HPKE base mode (RFC 9180): DHKEM(X448, HKDF-SHA512), HKDF-SHA512, ChaCha20-Poly1305 |
| Hash | SHA-256 |
| Call frames | AES-256-GCM (section 7.4) |
| Backup passphrase | scrypt, N = 2^17, r = 8, p = 1 |

The elliptic curve gives about 224 bits of security against known attacks, the symmetric keys 256. ML-KEM-1024 is in NIST's highest category (comparable to AES-256) and is there against an attacker who records traffic now and owns a large quantum computer later. Section 17 says exactly what it covers.

- **Signature domains.** A signature is always over an ASCII label followed by the signed bytes: `void/card`, `void/link`, `void/hs`, `void/ev`, `void/request`, `void/pickup`.
- `derive(key, label, len, ctx…)` below means HKDF-SHA512 with the label and context as `info`; `len` is 32 where it is not given.

## 2. Identity

A user is a 32-byte random **seed**. From it:

| Value | Derivation |
| --- | --- |
| Ed448 signing secret | `derive(seed, "void/v1/id-sign", 57)` |
| X448 secret | `derive(seed, "void/v1/id-dh", 56)` |
| Own-devices key | `derive(seed, "void/v1/self", 32)` |

The **user id** (`uid`) is the 57-byte Ed448 public key. Each installation also has a random 8-byte **device id** (`dev`). A user may run several devices with the same seed. A device is always identified by the pair `(uid, dev)`: a device id on its own names nothing, so one user cannot stand in for another user's device by announcing the same id.

A **card** binds a name and the X448 key to the user id:

```
card  = { c: bytes, s: bytes(114) }
c     = cbor({ v: 1, id: uid, dh: x448_public, n: text (≤ 64), ts: integer ms })
s     = Ed448(sign_secret, "void/card" ‖ c)
```

A device keeps the card with the highest `ts` for a user and never accepts a card whose `dh` differs from the one it already holds for that `uid`. A card whose `dh` is a low-order point (the shared secret would be all zero) is invalid.

The **safety number** shown to users is derived from `SHA-256("void/v1/safety" ‖ lower uid ‖ higher uid)`: six groups of five decimal digits, each from four bytes of the hash modulo 100000.

## 3. Links

A link is one reliable, ordered, message-oriented channel between two devices. The reference transport is a WebRTC data channel (label `void`); any transport with a per-connection fingerprint pair works. Messages above 60 KiB are fragmented by the transport: each data-channel message starts with one byte, `0` = whole message, `1` = fragment, `2` = last fragment.

### 3.1 Authentication and link keys

Each side has `fpLocal` and `fpRemote`: the SHA-256 DTLS certificate fingerprints of the connection as that side sees them. Each side picks a random 32-byte nonce, a one-use X448 key pair (public half `e`) and a one-use ML-KEM-1024 key pair (public half `k`).

```
AUTH1 { t: 1, v: 4, c, s, d: dev, n: nonce, e, k }   protocol version, card fields c and s, device id, nonce, one-use keys
AUTH2 { t: 2, q, s }
        q = ML-KEM ciphertext for the peer's k (the sender keeps the shared secret ssMine)
        s = Ed448(sign_secret, "void/link" ‖ fpLocal ‖ fpRemote ‖ myNonce ‖ peerNonce ‖ my dev
                                           ‖ my e ‖ peer e ‖ SHA-256(my k) ‖ SHA-256(peer k) ‖ SHA-256(q))
```

A device closes the link when the peer's `v` differs from its own and tells its user that the other device runs another version. Both sides send `AUTH1` at once, then `AUTH2` after receiving the peer's `AUTH1`. The receiver verifies the signature over its own view, mirrored: `fpRemote ‖ fpLocal ‖ peerNonce ‖ myNonce ‖ peer dev ‖ peer e ‖ my e ‖ SHA-256(peer k) ‖ SHA-256(my k) ‖ SHA-256(peer q)`. A relay that altered the signalling to sit in the middle changes the fingerprints and the check fails; so does anyone who replaced a key or a ciphertext of the exchange.

**Link keys.** Call *lo* the side with the lexicographically smaller nonce and *hi* the other. With `ss_lo` the ML-KEM secret that lo encapsulated (for hi's `k`) and `ss_hi` the one hi encapsulated:

```
bind  = SHA-256(n_lo ‖ n_hi ‖ e_lo ‖ e_hi ‖ SHA-256(k_lo) ‖ SHA-256(k_hi) ‖ SHA-256(q_lo) ‖ SHA-256(q_hi))
base  = derive(X448(e_secret, peer e) ‖ ss_lo ‖ ss_hi, "void/v1/link", 32, bind)
k_lo  = derive(base, "void/v1/link/lo")      k_hi = derive(base, "void/v1/link/hi")
```

Every message a side sends after it has verified the peer's `AUTH2` is ChaCha20-Poly1305 under its own key (`k_lo` for lo), nonce = the count of messages it has sealed so far as 12 bytes big-endian, starting at 0, aad = `bind`. The count is not transmitted: the channel is ordered and reliable. A message that does not open closes the link. The one-use secrets are discarded as soon as the keys exist.

The transport's own encryption (DTLS) stays in place underneath. This layer does not depend on it: someone who recorded the connection and later breaks the transport's key exchange still faces X448 and ML-KEM together.

After authentication a device closes the link unless the peer is one of: another device of the same user, an accepted contact, or the other side of a hand-carried pairing (section 9). A link to its own `(uid, dev)` is closed. A user may mark a contact *relay only*: links from that contact are then refused unless they come from a hand-carried pairing, and the two only talk through tunnels.

A device stops sending to, and closes, a link whose outgoing backlog exceeds 48 MiB.

If a device already holds a live link to the same `dev`: when the older link was authenticated less than 3 s ago, both links came from a simultaneous dial and the one with the smaller `SHA-256(lower nonce ‖ higher nonce)` is kept; otherwise the new link replaces the old one.

### 3.2 Link messages

Every message is a map with an integer `t`.

| t | Name | Fields | Meaning |
| --- | --- | --- | --- |
| 3 | RREQ | `i` id(8), `g` [tag(16)…] (≤ 8), `h` hops left, `n` hops travelled | route request |
| 4 | RREP | `i`, `x` tunnel id(8), `m` [index…], `c` [index…], `n` | route reply |
| 5 | TDATA | `x`, `d` frame bytes | frame along a tunnel |
| 6 | TCLOSE | `x` | tunnel closed |
| 7 | FRAME | `d` frame bytes | frame for the directly linked device |
| 8 | STORE | `g` mailbox tag, `x` lifetime ms, `f` [frame…] | ask the peer to hold frames |
| 9 / 10 | PING / PONG | | liveness |

A device sends `PING` every 10 s and closes a link that has been silent for 35 s.

## 4. Routing

The overlay is friend-to-friend: links exist only between contacts (and a user's own devices), and every device may relay for its contacts.

**Tags.** A tag is 16 bytes derived from a secret that only the members of a conversation hold (section 5). Relays see tags and ciphertext, nothing else.

**Request.** To find devices listening on tags, a device sends `RREQ` with a fresh random id on all its links, `h` = 6, `n` = 0. A receiver:

1. drops the request unless it is well formed (1 to 8 tags of exactly 16 bytes, `h` and `n` between 0 and 64), and drops it if it has seen the id in the last 2 minutes or if the link exceeded 40 requests in the current second;
2. remembers `id → link it came from`;
3. if it listens on any tag, or holds courier frames for any tag, creates a tunnel: picks a random tunnel id `x`, and answers `RREP { i, x, m: indexes it listens on, c: indexes it holds mail for, n: 0 }` on the same link. It sends nothing else until the requester starts a session (section 4.1). At most 24 tunnels may be waiting for a session at once, and such a tunnel is dropped after 30 s;
4. if `h - 1 > 0` and it relays, forwards the request on all its other links with `h - 1` and `n + 1`.

**Reply.** A device that receives `RREP` for a request it forwarded records `x → (link toward requester, link toward responder)` and forwards the reply toward the requester with `n + 1`. It passes on at most 8 replies per request and carries at most 48 tunnels for any one neighbour. The requester ends up with one tunnel per responder (at most 3 per request). From then on `TDATA { x, d }` is forwarded hop by hop in both directions. A relay drops frames above 72 KiB and forgets a tunnel idle for 2 minutes, answering `TCLOSE` to frames for unknown tunnels. Tunnel ends send a keep-alive frame every 10 s.

### 4.1 Sessions over tunnels

A tunnel runs through other people's devices. Before anything about a conversation is exchanged, its two ends prove who they are and agree on fresh keys. `T` is a tag the requester asked for and the responder matched, `K` the key of that tag, `x` the tunnel id.

```
requester -> responder   HS1 { t: 27, g: T, e: eI, k }       one-use X448 key and one-use ML-KEM-1024 key
responder -> requester   HS2 { t: 28, e: eR, q, b: seal(hsR, proof_R, aad = x) }    q = ML-KEM ciphertext for k, shared secret ss
requester -> responder   HS3 { t: 29, b: seal(hsI, proof_I, aad = x) }

bind     = SHA-256(eI ‖ eR ‖ k ‖ q)
base     = derive(X448(e_secret, e_peer) ‖ ss ‖ K, "void/v1/session", 32, x, bind)
hsI, hsR, dataI, dataR = derive(base, "void/v1/session/hs-i" | "hs-r" | "data-i" | "data-r")
proof_W  = cbor({ u: uid, d: dev, s: Ed448(sign_secret, "void/hs" ‖ x ‖ bind ‖ uid ‖ dev ‖ W) })   W = "I" or "R"
```

Each side checks the other's signature against the `uid` it states, and that this user may take part in the conversation `T` belongs to (section 8); otherwise it closes the tunnel. The keys need all three secrets: the X448 exchange, the ML-KEM exchange and `K`. Mixing `K` in means only holders of that conversation can complete the handshake or learn who the other side is. The one-use secrets are discarded once the session is up.

From then on every frame on the tunnel is `ENC { t: 30, n, b }` with `b` = ChaCha20-Poly1305 under `dataI` (requester to responder) or `dataR`, nonce = `n` as 12 bytes big-endian, aad = `x`. `n` starts at 0 and counts frames; a receiver refuses any `n` lower than the next one it expects. Outside a session a tunnel only carries the handshake, `PICKUP`, `PICKED`, `HPKE` and `KEEP`.

Direct links need no such session: the link authentication (section 3.1) already proves `(uid, dev)` and provides the fresh keys.

**One route per device.** When the device at the other end of a route has been proven (link authentication or session handshake), a device keeps one route to it: a direct link wins over a tunnel, a shorter tunnel over a longer one, the lexicographically smaller tunnel id on a tie. If the kept route is a direct link that has been silent for 2 s, it is probed with `PING` first; if no answer comes within 3 s the link is closed and the tunnel kept.

**Discovery schedule.** While at least one link is up, a device periodically requests: for each contact with no route, the conversation tag and its own mailbox tag for that conversation; for each group or channel with no connected member, the two most recent tags; for a pending outgoing contact request, the target's inbox tag. Retries start at 20 s and double up to 5 minutes.

## 5. Spaces

A space is a conversation with a 16-byte id and a list of **epoch keys** `{ e: integer, key: bytes(32) }`. For every key, `tag = derive(key, "void/v1/tag", 16)`.

| Kind | Space id | Key |
| --- | --- | --- |
| One-to-one (`dm`) | `derive(key, "void/v1/space", 16)` | `derive(X448(my_dh, peer_dh), "void/v1/dm", 32, lower uid, higher uid)` |
| Own devices (`self`) | `derive(key, "void/v1/space", 16)` | the own-devices key |
| Group | random 16 bytes | random; a new epoch on member removal |
| Channel | `SHA-256("void/v1/chan" ‖ channel_pub)[0..16]` | public: `derive(channel_pub, "void/v1/chan-public", 32)`; private: random, carried in the invite link |

Other tags:

- **Mailbox tag** of a one-to-one conversation for a recipient: `derive(key, "void/v1/mbx", 16, recipient uid)`.
- **Inbox tag** of a user, public: `SHA-256("void/v1/inbox" ‖ uid)[0..16]`.

## 6. Frames

A frame travels in `FRAME` or `TDATA`.

| t | Name | Fields |
| --- | --- | --- |
| 21 | SF | `g` tag, `b` box |
| 22 | PICKUP | `g` mailbox tag, `h` [frame id(8)…] already held, `s` signature (section 11) |
| 23 | PICKED | `g`, `f` [frame…] |
| 25 | HPKE | `g` inbox tag, `e` encapsulated key(56), `c` ciphertext |
| 26 | KEEP | |
| 27–29 | HS1, HS2, HS3 | session handshake over a tunnel (section 4.1) |
| 30 | ENC | `n` counter, `b` sealed frame (section 4.1) |

**Space frame.** `b = seal(epoch key, cbor(message), aad = tag)`. Every space message carries `ce`, the sender's newest epoch number for that space. A receiver finds the key by tag, opens the box, and ignores the message when the device at the other end of the route, as proven when the route was set up, may not take part in the space (section 8). Nothing inside a frame says who sent it.

**Key choice.** A sender uses its newest key, unless the peer's last `ce` is lower, in which case it uses the key of that epoch so the lagging peer can read it.

## 7. Events and replication

### 7.1 Events

```
event = cbor({ v: 1, s: space id, a: author key(57), d: dev(8), q: sequence ≥ 1,
               p: SHA-256 of the previous event in this feed, or null,
               ts: integer ms, k: kind (text), b: body (map) })
sig   = Ed448(author secret, "void/ev" ‖ event)
id    = SHA-256(event)
```

A **feed** is the sequence of events of one `(a, d)` pair inside one space. The author key is the user id, except in channels where it is the channel key. Maximum event size is 56 KiB.

In a conversation whose auto-delete timer is on, every device removes `msg`, `edit`, `del` and `call` events older than the timer from its storage, with their attachments. Feeds there may have holes: a device accepts an event whose sequence number is higher than the next one it expects, and a sender skips what it no longer holds. Membership, key and settings events are never removed.

A device accepts an event only if: the space id matches; the author has fewer than 16 feeds in the space, or the event continues an existing one; `q` is exactly one more than the last accepted event of that feed and `p` equals its id (a feed's first accepted event must have `q = 1`, except in channels, which may be joined part-way); the signature verifies; and the author is permitted (section 8). Anything else is silently dropped and will be offered again later.

### 7.2 Space messages

| t | Name | Fields |
| --- | --- | --- |
| 40 | VEC | `v` [[feed(65) = a ‖ d, highest sequence held]…], `i` part index, `z` number of parts |
| 41 | EV | `e` [[event bytes, sig]…] |
| 42 | SIG | `to` dev, `k` "o" or "a", `i` id(8), `s` pairing code (section 9) |
| 43 | BREQ | `i` blob id(32), `c` first chunk, `n` count |
| 44 | BDATA | `i`, `c` chunk index, `d` bytes, `z` total chunks |
| 45 | BNONE | `i` |
| 46 | CHS | `a` salt(8), `g` [digest(8)…] |
| 47 | CALL | `k` kind, `i` call id(8), and per kind: `v`, `s`, `c`, `r`, `keep` (section 7.4) |

**Replication.** When two devices share a space over a route they both send `VEC`, in parts of at most 800 feeds; a vector takes effect when its last part has arrived. A device also sends its `VEC` the first time it hears a given device in a space, because an earlier one may have arrived before that device held the key. On receiving a `VEC`, a device sends, per feed, the events the peer lacks, in order, at most 400 per feed per round, in `EV` messages of about 40 KiB. A peer with nothing of a channel feed gets its last 200 events. After accepting events a device answers with its own `VEC` (after 120 ms), which acknowledges them and triggers the next round, and offers the new events to its other routes that share the space. Every 30 s a device re-sends `VEC` on routes where its state changed, and on every route every 3 minutes.

A sender does not re-offer a range it sent less than 8 s ago; if the peer makes no progress the delay doubles, up to 10 minutes.

A peer on an older epoch only receives events its sender accepted while that epoch was current, plus `g.key` events.

**Shared channels.** Contacts cannot know each other's channel subscriptions, so after connecting each sends `CHS` inside their one-to-one space: `digest = SHA-256(salt ‖ current tag)[0..8]` for each of its channels and open groups. A receiver that holds a space with a matching digest starts replicating it over that route.

**Direct connection upgrade.** Over a tunnel, the device with the lexicographically lower `dev` sends `SIG` `k = "o"` with a pairing offer in the one-to-one (or own-devices) space; the other answers `k = "a"`. Success yields a new link, which replaces the tunnel. Failed attempts are retried after 1 minute, doubling up to 30 minutes.

### 7.4 Calls

A call is set up with `CALL` messages in the one-to-one space, so its signalling is end-to-end encrypted and comes from a proven device. The media connection is a separate WebRTC connection made directly between the two devices; it is protected by DTLS-SRTP, and the fingerprints that key it travel in the `accept` and `answer` signals below. Under that, every encoded frame is sealed with the call's own keys (below). Nothing between the two devices can decrypt the call. A call therefore needs a direct path and shows each side the other's network address.

| k | From | Fields | Meaning |
| --- | --- | --- | --- |
| `ring` | caller, to every connected device of the contact | `v` camera on, `x` caller's call secret(32) | a call is offered |
| `accept` | the device that answers | `s` SDP offer, `v`, `x` callee's call secret(32) | the first one wins |
| `answer` | caller, to that device | `s` SDP answer | |
| `ice` | either | `c` candidate (JSON) | candidate address |
| `state` | either | `v` sending video (camera or screen) | |
| `end` | either | `r` reason; `keep` dev | hang up, decline, busy, calls off, or "answered elsewhere" for every device but `keep` |

Each call negotiates one audio and one video stream. The camera and a shared screen both use the video stream, switched without renegotiation. A device with calls switched off answers a `ring` with `end` and reason `off`.

**Frame sealing.** A device that can reach encoded frames (WebRTC encoded transforms) puts a fresh random 32-byte `x` in its `ring`; the answering device, if it can too, puts its own in `accept`. When both are present, with `i` the call id:

```
base            = derive(x_caller ‖ x_callee, "void/v1/call", 32, i)
key(who, kind)  = derive(base, "void/v1/call/" ‖ who ‖ "/" ‖ kind)      who = "caller" | "callee" (the sender), kind = "audio" | "video"
sealed frame    = header ‖ AES-256-GCM(key, nonce, rest of the frame, aad = header) ‖ counter(8)
```

`header` is the first 10 bytes of a VP8 key frame, 3 bytes of any other video frame, 1 byte of an audio frame, left readable so that the frame can still be packetised; the video stream is restricted to VP8. `counter` starts at 0 and counts the frames sealed under that key, big-endian; the nonce is 4 zero bytes followed by it. A receiver drops every frame that does not open, and passes empty frames through. The two secrets travel inside the conversation's channel, so they are covered by its hybrid key exchange, and the call's transport never sees them. When either `x` is missing the call runs on DTLS-SRTP alone and the interface says so.

### 7.3 Event kinds

| Kind | Space | Body | Effect |
| --- | --- | --- | --- |
| `msg` | any | `x` text, `a` [attachment…], `r` id of the message replied to | a message |
| `edit` | any | `of` event id, `x` | replaces the text, only by the same author |
| `del` | any | `of` | hides the message; same author, or a group admin |
| `d.ginv` | dm | `g` space description | the peer added me to a group |
| `g.meta`, `c.meta` | group, channel | `n` name, `about` description, `av` photo (JPEG ≤ 20000 bytes, empty to remove), `w` what changed | name, description or photo |
| `p.set` | dm, group | `av` photo or null, `bio` (≤ 300 characters), `ts` | the author's photo and bio; the newest `ts` wins |
| `ttl` | any | `s` seconds, 0 for off | auto-delete timer of the conversation (group: admins; channel: the channel key) |
| `call` | dm | `v` video, `d` duration ms | a line in the history left by the caller |
| `g.add`, `g.join` | group | card `c`, `s` | adds the card's user to the roster |
| `g.rm` | group | `u` uid | removes a member (banned in open groups) |
| `g.adm` | group | `u`, `on` | grants or revokes admin |
| `g.leave` | group | | the author leaves |
| `g.key` | group | `e` new epoch, `k` [[uid, enc(56), ct]…] | new epoch key, HPKE-sealed per member with info `void/v1/group-key` and aad = space id ‖ epoch (4 bytes, big-endian) |
| `s.contact`, `s.space`, `s.gone`, `s.name` | self | | keep a user's own devices in step |

Attachment descriptor: `{ i: blob id(32), k: key(32), n: name, m: MIME type, z: plaintext size, c: chunk count, t: "image" | "video" | "voice" | "file", p: JPEG preview (≤ 32 KiB), w, h, d: duration ms }`. A descriptor is ignored unless `c = max(1, ceil(z / 32752))` and `z` ≤ 256 MiB. The MIME type and name are the sender's claim; a client shows only image, audio and video types it knows inline and offers everything else as a plain download.

## 8. Permissions

| Space | Who may send frames | Who may author events |
| --- | --- | --- |
| dm | the two users | the two users |
| self | the user | the user |
| channel | anyone holding the key | the channel key only |
| private group | roster members | members; `g.rm`, `g.meta`, `g.key` need an admin or the owner; `g.adm` needs the owner; the owner cannot be removed |
| open group | anyone not banned | as above, plus `g.join` by anyone not banned |

The roster of a group is the result of applying its `g.*` events to the roster received in the invite. Removing a member from a private group is followed by `g.key` from the admin who removed; a `g.leave` is followed by `g.key` from the owner (from the owner device with the lowest feed id in the group, and only for a leave less than 10 minutes old). A member whose card cannot be sealed to is skipped, not waited for. The former member keeps what it already had and gets nothing new: it can no longer open a session as a member.

Known weakness: concurrent conflicting roster changes are applied in arrival order and may leave devices with different rosters.

## 9. Pairing codes

A pairing code is the compact form of a WebRTC session description:

```
cbor({ u: ICE ufrag, p: ICE password, f: DTLS fingerprint SHA-256 (32),
       s: setup role (0 actpass, 1 active, 2 passive), m: mid when not "0",
       c: [[type, address, port]…] })     at most 8 candidates, UDP component 1 only
type: 0 host IP, 1 server-reflexive IP, 2 relay IP, 3 host mDNS name (16-byte UUID), 4 host name (text)
address: 4 bytes (IPv4), 16 bytes (IPv6 or UUID), or text
```

The receiver rebuilds a data-channel-only description (`m=application 9 UDP/DTLS/SCTP webrtc-datachannel`, `a=sctp-port:5000`, `a=max-message-size:262144`).

Hand-carried pairing wraps the code in links: `void:i:` + base64url(cbor({ v: 1, s: offer code })) and `void:r:` + base64url(cbor({ v: 1, s: answer code })). Completing it makes the two users contacts.

## 10. Contact requests

To reach a user known only by card, a device requests the user's inbox tag. On the resulting tunnel it sends `HPKE { g, e, c }` where the plaintext, sealed to the target's X448 key with info `void/v1/request` and aad = inbox tag, is:

```
cbor({ b: body, s: Ed448(sign_secret, "void/request" ‖ body) })
body = cbor({ c, s, to: target uid, ts, k })     the requester's card, the target, the time, and the secret of an invite link if it has one
```

A user can turn contact requests off; the device then neither answers requests for its inbox tag nor reads `HPKE` frames. Otherwise the target checks the card, the signature, that `to` is its own id and that `ts` is within two days, then shows the request to its user. Accepting it creates the one-to-one space; the requester learns of the acceptance when the first valid frame arrives on the conversation tag.

## 11. Couriers

When the recipient of a one-to-one message has no route, the sender builds, for each undelivered event, a complete `SF` frame containing `EV` with that event, and sends `STORE { g: recipient's mailbox tag, k: mailbox public key, x: 7 days, f: [frames] }` to up to three linked contacts. The mailbox key pair is Ed448 from the secret `derive(conversation key, "void/v1/mbx-sign", 57, recipient uid)`, so both people in the conversation can compute it and the courier only gets the public half. A courier accepts frames only from contacts, up to 64 KiB each, 6 MiB per contact and 24 MiB in total, and keeps them until they expire. A frame's id is the first 8 bytes of its SHA-256.

A courier answers a `RREQ` for a mailbox tag it holds (index listed in `c`). The recipient then sends `PICKUP` with the frame ids it already has and `s = Ed448(mailbox secret, "void/pickup" ‖ tag ‖ tunnel id)`. The courier hands over only the frames whose stored mailbox key verifies that signature; binding it to the tunnel id keeps anyone on the path from reusing it. The recipient processes the returned frames as if they had arrived from the author, without acknowledging to the courier.

## 12. Attachments

The plaintext is cut into chunks of 32752 bytes. Chunk `i` is sealed with XChaCha20-Poly1305 under the per-file random key and a nonce of 20 zero bytes followed by `i` as a 32-bit big-endian integer, giving ciphertext chunks of at most 32768 bytes. The **blob id** is the SHA-256 of all ciphertext chunks concatenated. Any device that shares the conversation and holds the ciphertext answers `BREQ`; the requester checks the total against the blob id and discards everything on a mismatch.

## 13. Links

| Prefix | Payload (base64url of CBOR) | Meaning |
| --- | --- | --- |
| `void:u:` | card | contact |
| `void:c:` | `{ p: channel key, n: name, k: read key (private channels) }` | channel |
| `void:g:` | `{ i, n, y: [epoch, key], o: owner uid, a: [admin uid…] }` | open group |
| `void:i:`, `void:r:` | pairing invite and reply | section 9 |

## 14. Backup

`"VOIDBK3\n"` ‖ salt(16) ‖ seal(scrypt(passphrase, salt, N = 2^17), cbor({ v: 1, seed, n, ts, c: [cards], s: [space descriptions] }), aad = salt). Files starting with `"VOIDBK1\n"` or `"VOIDBK2\n"` hold an identity with the Curve25519 keys of protocol 3 and earlier; they are refused, as is a stored profile whose identity record lacks `k: 2`.

## 15. Rendezvous through public relays (optional, on by default)

A browser cannot dial a contact it already knows, so two contacts that are both online need a place to exchange a WebRTC offer and answer. With this option a device uses public relays speaking the Nostr protocol (NIP-01) as a short-lived notice board. The relays are third parties. Without the option, the first link of a session is made with hand-carried pairing codes (section 9).

For each accepted contact, and for the user's own devices, with `k` the one-to-one key (or the own-devices key) and `day = floor(unix_ms / 86400000)`:

```
topic(day) = hex(derive(k, "void/v1/rdv-topic", 16, day as 4 bytes big-endian))
rdv_key    = derive(k, "void/v1/rdv-key", 32)
```

A device listens on `topic(day)`, and also on the neighbouring day during the 15 minutes around midnight UTC. It posts on `topic(day)`.

**Carrier.** A note is a Nostr event of kind 20451 (ephemeral: relays forward it to current subscribers and do not store it), with one tag `["t", topic]` and `content` = base64url of the sealed note. It is signed with a secp256k1 key generated at random each time the application starts. Subscriptions filter on `kinds: [20451]`, `#t: [topics]`, `since: now - 30 s`. Receivers ignore the event signature and rely on the seal.

**Note.** `seal(rdv_key, cbor(note), aad = topic bytes)`, where every note carries `v` (protocol version), `u` (sender uid), `d` (sender dev) and `ts` (ms). A note with another version is not acted on; the user is told that the contact runs another version. A receiver drops notes it cannot open, notes older or newer than 90 s, notes from itself, notes whose `u` is not the contact the topic belongs to, and notes it has already seen.

| t | Name | Fields | Meaning |
| --- | --- | --- | --- |
| 1 | HELLO | | this device is online and has no link to you |
| 2 | OFFER | `to` dev, `i` id(8), `s` pairing code | WebRTC offer |
| 3 | ANSWER | `to` dev, `i`, `s` | WebRTC answer |

A device posts HELLO for every contact it holds no link to: when a relay connects, when a link closes, and every 2 minutes. On HELLO from a device it has no link to, the device with the lower `dev` posts OFFER; the other posts its own HELLO (at most once per 8 s) so that the first one dials. On HELLO from a device it does hold a link to, it probes that link (section 4). The link that results is authenticated as in section 3 and must belong to a contact. Failed attempts back off as in section 7.

**Requests and invite links.** A device also listens on its own inbox topic, `hex(SHA-256("void/v1/rdv-inbox" ‖ uid ‖ day as 4 bytes)[0..16])`, unless its user turned contact requests off and no invite link is pending. A device that wants to become someone's contact posts there, every 2 minutes until it is answered, a note `cbor({ e, c })`: the HPKE-sealed request of section 10, unsigned by anything but its inner signature and readable only by the target.

An **invite link** is a contact link with a secret: `void:u:` + base64url(cbor({ c, s, k })), `k` 16 random bytes that the inviter remembers for 14 days. Whoever opens it puts `k` in the body of its request. A device that receives a request carrying a secret it issued accepts the sender as a contact at once, forgets the secret (one person per link), and says HELLO on the pairwise topic; the requester, which listens on that topic while its request is pending, then connects as above. A request without a valid secret is shown to the user to accept or decline.

What a relay learns: the IP addresses of the devices that post and listen on a topic, and when. Two devices on one topic are contacts, so a relay can link two IP addresses. It cannot read or forge notes, and neither topics nor signing keys reveal user ids.

## 16. Storage on the device (reference client)

Everything the reference client stores is sealed before it is handed to the browser's storage.

- **Password.** `kek = scrypt(NFKC(password), salt(16), N = 2^17, r = 8, p = 1)`; devices that cannot allocate that use N = 2^15. A random 32-byte master key is stored as `seal(kek, master, aad = salt)` next to the salt and the scrypt settings. This header is the only unsealed record. Changing the password re-wraps the master key.
- **Values.** `data_key = derive(master, "void/v1/vault-data")`. Each record is `seal(data_key, cbor(value), aad = bucket ‖ "|" ‖ stored name)`, so a record cannot be moved or swapped.
- **Names.** `name_key = derive(master, "void/v1/vault-names")`. A record name is a list of parts joined by `|`; every part is replaced by the first 16 bytes of `HMAC-SHA256(name_key, part)` in hex, except all-digit parts of at most 12 digits (sequence numbers), which are kept so that records stay ordered.

Someone who copies the storage sees how many records there are, their sizes and the sequence numbers. The keys are in memory while the application is unlocked.

## 17. Security properties and known gaps

What the design provides:

- Relays see a conversation tag in route requests and in the first handshake message, then only sealed, counted frames: no contents, no user ids, no tags. Couriers see a mailbox tag and ciphertext. Links between neighbours are sealed with their own keys (section 3.1) and additionally protected by DTLS.
- **Key strength.** Identity and key-agreement keys are on Curve448 (about 224 bits); every symmetric key is 256 bits.
- **Recorded traffic and quantum computers.** Everything that crosses a link or a tunnel is sealed with keys that need both an X448 exchange and an ML-KEM-1024 exchange. Someone who records the traffic between two devices, or a relay that keeps what it forwarded, cannot open it later by breaking the elliptic curve alone, with a quantum computer or otherwise. Calls get the same protection through their frame keys (section 7.4).
- Every event is signed; a space member cannot forge another member's events, and a courier or relay cannot alter anything undetected.
- The device at the other end of every route is proven: by link authentication for a direct link, by the session handshake for a tunnel. A member of a group, a holder of a channel key or a relay cannot pass for someone else, and a relay cannot replay or reorder tunnel frames.
- Traffic on links and tunnels has forward secrecy: its keys come from one-use secrets that are discarded, so recorded traffic stays closed even if long-term keys leak later.
- A man in the middle of the signalling is detected at link authentication.
- Flooding is bounded by the hop limit, per-link rate limits and duplicate suppression; only contacts can open links, which limits Sybil identities to those some user chose to accept.

What it does not provide yet:

- **The post-quantum layer covers connections, not everything.** Three things still rest on the elliptic curve alone. (1) Signatures: an attacker with a quantum computer *at the time of the connection* could forge an identity; recorded traffic is not affected. (2) The one-to-one conversation key, which comes from the two users' long-term X448 keys, and group keys, which are handed to each member with HPKE over X448. They seal events before those are sent, held by couriers, or announced on the rendezvous relays. A courier that kept held mail, or a relay that kept rendezvous notes (which contain network addresses, not messages), could open them with a future quantum computer; someone who only recorded network traffic could not, because the connection layer is in the way. (3) Contact requests, sealed with HPKE to the recipient's X448 key. Putting an ML-KEM key in every card would close (2) and (3) and make cards and invite links about 2 KB longer.
- **The ML-KEM implementation is not independently audited** (`@noble/post-quantum`). It is always combined with X448, so a flaw in it leaves the X448 protection intact.
- **The second layer on calls depends on the browser.** It needs WebRTC encoded transforms; without them a call is protected by DTLS-SRTP alone (128-bit AES in most browsers) and says so.
- **No forward secrecy or post-compromise security for messages at rest in the network.** Conversation keys are static (one-to-one) or change only when a member leaves or is removed (groups). Mail held by couriers is sealed with those keys: someone who obtains held mail and later a user's seed can read it. A ratchet is the planned replacement.
- **First-hop visibility.** `n = 0` in a route request or reply tells the neighbour that it came from the device it is linked to. Anyone within six hops who knows a user id can ask for its inbox tag and learn whether that user is online, unless the user turned contact requests off. A contact can test whether you follow a public channel it knows.
- **Reply racing.** The first three replies to a route request are kept and each states its own hop count; a device in range can answer falsely and waste a slot until the handshake fails.
- **Tags are stable**, so a relay can tell that the same conversation is active again, though not whose it is. The neighbour a request arrives from is visible to the next hop.
- **The public helpers see IP addresses.** STUN servers see the address of a device that asks; rendezvous relays see which addresses share a topic (section 15). Both are optional.
- **No protection against traffic analysis** by an observer who watches many links.
- **Deletion cannot be enforced**; it is a request honoured by well-behaved clients.
- **A running, unlocked application holds its keys in memory.** Storage encryption (section 16) protects a device that is off or a profile that is locked, not one that is compromised while in use.
