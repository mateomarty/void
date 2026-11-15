# Security

Void is experimental and has not been audited. Please do not rely on it where a failure could hurt someone.

## Reporting a vulnerability

Report it privately through GitHub: on the repository page, open **Security › Report a vulnerability**. This creates an advisory that only the maintainers can see. Please do not open a public issue for something that can be exploited.

It helps to include:

- the version (bottom of the Settings dialog) and the browser;
- what the attacker needs: to be a contact, to be a relay on the path, to watch the network, to have the device;
- steps to reproduce, or better, a failing test. The simulated network in `test/unit/fakenet.js` makes most protocol attacks easy to script, and `test/unit/security.test.js` has examples.

There is no bug bounty.

## What counts

Anything that lets someone read or forge messages, pass for another user or device, learn who talks to whom beyond what is already documented, read a stored profile without its password, or run code in the page.

The gaps listed under *Security* in the README and in section 17 of [PROTOCOL.md](PROTOCOL.md) are known. A report that shows one of them to be worse than described is welcome.
