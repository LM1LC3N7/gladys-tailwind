# TODO — Tailwind v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local API** (2026-10-23): typed addresses and local
      control key, status polling (`dev_st`), identity by MAC at every read,
      firmware 10.10 or later, door states, Open and Close buttons per door
      (decided on a fresh read, off by default, guard per door), status LED
      brightness (confirmed by a read back), refused key and pauses
      persisted, manifest, docs en/fr. Tested against fakes and a loopback
      HTTP server only. The store validator was not run by the development
      agent (it cannot): to run from the real terminal.
- [ ] **Milestone 2 — real hardware** (testers with a controller): record
      real answers as fixtures, fix what differs. To check first:
  - the door `status` values besides `open` / `close` (an intermediate
    state?), and how long a door stays read "closed" after an opening
    command (the guard: 15 s minimum, 45 s maximum);
  - whether the controller itself refuses `close` on a door its sensor reads
    closed (and `open` on an open one), and what it answers then;
  - the answer to `door_op` (does `OK` come before the relay pulse?), and to
    a command on a disabled or locked-out door;
  - `token fail` on a wrong key, on the status AND on the commands;
  - the Tailwind Light (one door, no LED?) and the iQ3 with three doors.
- [ ] **Milestone 3 — more**: night mode (read only), the notifications the
      controller can push to a URL (needs an inbound port: probably not),
      mDNS discovery (`_http._tcp` with `vendor=tailwind`), identify button.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: gotailwind (MIT, Franck Nijhof, the library of the Home Assistant
  integration, 0.4.0, LICENSE.md read) is Python, so its requests, status
  fields, result words and checks are ported, not imported; no runtime
  dependency besides the SDK. Credited in `THIRD_PARTY_NOTICES.md` (copied
  into the image with `LICENSE`). No application imitation: no User-Agent,
  no app header, only the documented local API and the user's own key.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1 (the template's 1.0.0 was
  someone else's). The first release (patch) gives 0.1.1; every later
  version comes from the Release workflow. The manifest test checks the
  semver shape and the equality, never a fixed number.
- Structure taken from LM1LC3N7/gladys-opengarage 0.1.3 (approved after two
  reviews, same risk: a garage door on a toggle relay), with its lessons:
  generation checked after every await, guard set in `beforeSend`, queue
  bound at 3.3 s, clock going back.
- External ids: `gladys.externalIds('tailwind', mac)`, `mac` the 12
  lower-case hex digits of `dev_id` (`_3c_e9_e_6d_21_84_` -> `3ce90e6d2184`,
  as gotailwind's `tailwind_device_id_to_mac_address`). ONE Gladys device per
  controller (the LED belongs to the controller); feature keys frozen:
  `door<n>`, `door<n>_open`, `door<n>_close` with n = API index + 1 (1 to
  3), and `led`. A created feature is never removed (`publishDevices` keeps
  it); a door once seen stays in the layout.
- Door: `opening-sensor`/`binary` (open for `status` "open", closed for
  "close", nothing published otherwise). Never a `switch` nor a commandable
  `binary`: two `button`/`push` features per door. LED: `light`/`brightness`
  0-100 (no unit); a "turn the lights off" may reach it, which is harmless.
- Door commands (lot 12 decision for toggle pulses, as gladys-opengarage):
  closing pulses the opener as opening does, so BOTH need `allow_open`
  ("Allow opening and closing the garage doors"), checked on arrival, after
  the read and in `beforeSend`. Every command is decided on a status read
  just now (MAC checked, firmware checked): "open" only from "close", "close"
  only from "open"; already there: nothing sent (success); unknown, missing
  door, `disabled` or `lockup` not exactly 0: refused (as gotailwind, which
  refuses locked out and disabled doors).
- Close is protective (brief of lot 14): it cancels, on arrival, the
  openings of its door not sent yet (queued ones included; their read is
  aborted at once, a read changes nothing on the device); a 429/5xx pause or
  a refused key never holds it: one try (one read + one command), never
  retried. An opening is held by both. A close is still refused while the
  guard of a previous command of its door holds (a second pulse would stop
  or reverse the moving door).
- Queue: one per controller (the controller is a small device: one command
  at a time), bound at sendBy - 200 ms; flights, guards and pending openings
  per door. The LED is never in the door queue (one LED command at a time
  per controller, refused otherwise), so it never delays a close.
- Guard (per door, `<mac>-<index>` in `/data`): set in `beforeSend` (before
  the first byte, saved at once) with its start state, expected state, `at`
  and a request number (memory only); removed only when the controller
  surely did nothing (`Fail`, `token fail`, HTTP 4xx, not sent). Any command
  of that door is refused until a read whose request left AFTER the command
  shows the expected state at least 15 s after it, or 45 s. One command in
  flight per door.
- Success of a door command = the controller answered `OK`: the door then
  moves for 10-30 s, longer than the 5 s ack; reads follow at 5, 15, 30,
  50 s and the guard covers the travel. Documented. The LED (instant) is
  confirmed only by a read back equal to the value asked, else "sent,
  without confirmation".
- Deadlines: sent within 3.5 s of the click or refused unsent; answered by
  4.3 s; a request that may have left is "sent, without confirmation"; never
  retried. The ack never waits for a publication.
- Local control key: one secret for every controller of the account ("Ce
  champ est gardé par Gladys dans sa base, jamais réaffiché"), trimmed,
  printable ASCII without spaces (it travels in the `TOKEN` header, plain
  HTTP on the LAN), never in a log, status, error or `/data`. Needed for the
  reads too: without it nothing is read.
- Refused key (`token fail`, lot 12 lesson: an authentication error that is
  not clearly transient is final): per address, persisted as an HMAC of the
  refused key with a random salt of `/data`; that address is not read again
  with that key, automatically never; another key is tried once the interval
  has passed; "Check the controllers" reads it once (never sooner than the
  interval) and only a success lifts the refusal. A key that worked on any
  controller is never fingerprinted in `/data` (its refusals stay in memory).
- Reads never sooner than the interval: one status per typed address when
  due; `connected`, a configuration saved again, the scan and the "Check"
  action only read due addresses; a reconnection during a read shares it;
  after a restart, if `/data` `lastTry` (written at most once a minute) is
  within interval + 1 min, a whole interval is waited; meanwhile the status
  counts an address whose last read kept in `/data` succeeded as answering.
  Failures: 30 s, 1, 2, 5 min (never sooner than the interval); a new
  generation (key or addresses) resets that to the interval. 429/5xx: a
  pause of 1 min to 6 h (Retry-After, else doubling), persisted and capped
  when read back.
- Identity: an answer without a readable `dev_id` is a failed read ("not a
  Tailwind controller" in the status), never another controller. Another MAC
  at a record's address moves the record off it (until seen elsewhere); the
  same MAC at two typed addresses: only its own address is used. A firmware
  older than 10.10 (gotailwind's minimum) is a failed read, said in the
  status.
- After a restart, the controllers come from `/data`: a door can be closed
  before the first poll (the command reads the status itself).
- Units: none (binary sensors, buttons, a 0-100 brightness).
- Answers: 16 KB at most, parsed once with `JSON.parse`, own properties only
  (`Object.hasOwn`), at most 8 door entries looked at, every value checked;
  texts stripped of control characters and cut.
- No Bluetooth, no cloud call, no discovery by network capture.
