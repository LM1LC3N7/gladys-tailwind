# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-23

### Added

- Tailwind garage door controllers (iQ3, Light) over their local API, without
  the cloud: added by IP address with the local control key, identified by
  their MAC at every read (a new address changes nothing); firmware 10.10 or
  later.
- The state of each garage door (open or closed; nothing published when
  unknown) and the brightness of the status LED (confirmed only by the value
  read back).
- Open and Close buttons for each door, never a switch. The controller pulses
  the opener (a toggle on most openers), so every command is decided on the
  door read just now: "Open" only to a closed door, "Close" only to an open
  one; unknown, disabled or locked out is refused. Both are off by default
  ("Allow opening and closing the garage doors"). Openings of a door go one
  at a time; a close never waits behind another command (closing three doors
  at once sends three commands), cancels the pending openings of its door
  and is never held by a pause asked by the controller nor by a refused key
  (one try).
- After a command, another one of that door waits until a read sent after it
  shows the door where it was sent: at least 30 s after an opening, 15 s after
  a closing, 45 s at most. The guard is written to `/data` before the first
  byte leaves, so a restart keeps it, and a change of the system time never
  shortens it.
- An opening pressed again within 5 s of one that sent nothing is refused
  without reading the controller again; a close always reads the door again.
  The LED changes once every 2 s at most. A guard that could not be written
  to `/data` is said in the status.
- Commands sent within 3.5 s or refused unsent, "sent, without confirmation"
  when no answer came back.
- Key refused ("token fail"): final for that controller, never replayed; read
  again only with another key or by "Check the controllers" (never sooner
  than the interval). The key is never logged, stored nor shown in the status
  (an entry of the addresses field that is not an address is only counted);
  `/data` keeps only 8 bits of a salted fingerprint of a refused key, never
  for a key that works on any controller.
- Never read sooner than the refresh interval, after a restart included (the
  status then shows the outcome of the last read); HTTP 429 or 5xx: a pause
  of 1 min to 6 h; other failures: 30 s to 5 min.
- "Check the controllers" action; reachability on the transport badge; states
  within the Gladys rate limit.

[Unreleased]: https://github.com/LM1LC3N7/gladys-tailwind/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-tailwind/releases/tag/v0.1.1
