# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Tailwind garage door
controllers (local API, no cloud): a Node.js service (Node 22+, ESM, no build
step) that runs in its own sandboxed Docker container and talks to Gladys
through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template
and the structure of LM1LC3N7/gladys-opengarage, and ports gotailwind (MIT).
See `TODO.md` for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "guard"   # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> TailwindApp (shared with the tests)
src/app.js                        TailwindApp: reads, identity, pauses, refused keys, commands, guards
src/tailwind/http.js              one HTTP POST: deadline, size cap, sent flag, beforeSend
src/tailwind/client.js            POST /json (dev_st, door_op, status_led), results -> error kinds
src/tailwind/parse.js             status -> identity, layout, reading (pure)
src/model.js                      controllers -> Gladys devices and values (pure)
src/publisher.js                  states within the rate limit (250/min)
src/store.js                      /data/tailwind.json (controllers, pauses, refusals, guards), never a key
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and fake controllers
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `gladys.externalIds('tailwind', mac)`, never
  a label nor an address. Feature keys (`door<n>`, `door<n>_open`,
  `door<n>_close`, `led`), manifest keys and action keys are frozen too. A
  created device never loses a feature.
- **Safety.** A door is never a `switch` nor a commandable `binary`. The
  controller pulses the opener (a toggle): a command is decided on a status
  read just now (MAC checked), "open" only from closed, "close" only from
  open, never from an unknown, disabled or locked-out door. BOTH stay off by
  default (`allow_open`), checked on arrival, after the read and in
  `beforeSend`; one queue per controller, a close cancels the openings of its
  door not sent yet and is never held by a pause or a refused key (one try).
  A guard per door is set in `beforeSend` and lifted only by a read sent
  after the command, 15 s at least. Keep the tests that say so.
- **The local control key** is never logged, never in a status, an error or
  `/data` (it travels in the `TOKEN` header: never log headers). A `secret`
  field is kept by Gladys in its database, never shown again: never write
  that it is encrypted. A refused key is final: never retried automatically.
- **Reads** are never sooner than the interval (reconnection, saved config,
  scan, action, restart); a late answer of an older generation publishes
  nothing.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json`, `package-lock.json` or the manifest, nor the
  `docker_image` tag, by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }` objects. The catalog
  `description` holds 10 to 100 characters per language.
- **Units.** Only the ones the core lists for the category
  (`DEVICE_FEATURE_UNITS_BY_CATEGORY` in `server/utils/constants.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
- **Encoding.** Every file is UTF-8 without BOM; `test/encoding.test.js`
  refuses mojibake and control characters.
