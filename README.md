# gladys-tailwind

[Gladys Assistant](https://gladysassistant.com) external integration for
**Tailwind** garage door controllers (iQ3, Light), on the local network: the
state of each garage door, Open and Close buttons, and the brightness of the
status LED, through the local API of the controller, without the Tailwind
cloud. Unofficial, not affiliated with Tailwind.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against fakes and a loopback
> HTTP server only, never with a real device.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (TailwindApp)
                                   ├─ src/tailwind/http.js    one HTTP POST (node:http): deadline, size cap, beforeSend
                                   ├─ src/tailwind/client.js  POST /json (dev_st, door_op, status_led), TOKEN header, results -> kinds
                                   ├─ src/tailwind/parse.js   status -> identity (MAC), layout, reading (pure)
                                   ├─ src/model.js            controllers -> Gladys devices and values (pure)
                                   ├─ src/publisher.js        states within 250/min (Gladys: 300)
                                   └─ src/store.js            /data/tailwind.json: controllers, pauses, refusals, guards
```

- **Controllers** are added by IP address (configuration). Each status read
  carries `dev_id` (the MAC), which identifies the controller (external ids
  `tailwind:<mac>`): a new IP address changes nothing, and a controller is
  identified again at every read and before every command.
- **Polling** every `poll_interval` seconds, never sooner (reconnection,
  configuration saved unchanged, scan, "Check" button, restart). The local
  control key is needed for every request (`TOKEN` header).
- **Door commands**: `door_op` with `open` or `close`. The controller pulses
  the wall-button input of the opener (a toggle on most openers), so "Open"
  is sent only to a door read closed just now, "Close" only to a door read
  open; unknown, disabled or locked out is refused. BOTH are off by default
  ("Allow opening and closing the garage doors"). Openings are queued per
  door; a close is in no queue (never behind a read or a slow answer), cancels
  the pending openings of its door, and is never held by a 429/5xx pause nor
  by a refused key (one try). After each command a guard per door, written to
  `/data` synchronously before the first byte and timed on a monotonic clock,
  refuses another one until a read sent after it shows the door where it was
  sent (30 s at least after an opening, 15 s after a closing, 45 s at most).
  The same press within 5 s of one that sent nothing is answered without a
  new read. See [docs/en.md](docs/en.md#command-safety).
- **Status LED**: `status_led`, confirmed only by the value read back; one
  command every 2 s at most.
- **The key** is never logged, nor put in a status, an error or `/data`. A
  refused key (`token fail`) is final for that address: only 8 bits of a
  salted fingerprint are kept (the key cannot be found back; never for a key
  that works on any controller), removed at the first success.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/helpers/fakeTailwind.js` holds controllers answering like the
gotailwind fixtures behind a fake `request`; the end-to-end tests run the
real handlers against the SDK's fake Gladys.

## Credits

- [`gotailwind`](https://github.com/frenck/python-gotailwind) (MIT), the
  library behind the Home Assistant Tailwind integration: the requests, the
  status fields, the result words and the checks before a door command are
  taken from it (ported to JavaScript, no file copied). Notice in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- The structure, `src/publisher.js` and `src/tailwind/http.js` come from
  [LM1LC3N7/gladys-opengarage](https://github.com/LM1LC3N7/gladys-opengarage)
  (same author, Apache-2.0).

Tailwind is a trademark of its owner, used here only to name the compatible
products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (gotailwind, MIT):
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
