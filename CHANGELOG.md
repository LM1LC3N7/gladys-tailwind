# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
  ("Allow opening and closing the garage doors"); one queue per controller, a
  close cancels the pending openings of its door and is never held by a
  pause asked by the controller nor by a refused key (one try).
- After a command, another one of that door waits until a read sent after it
  shows the door where it was sent, at least 15 s and at most 45 s after it.
  The guard is set and saved before the first byte leaves, so a restart keeps
  it.
- Commands sent within 3.5 s or refused unsent, "sent, without confirmation"
  when no answer came back.
- Key refused ("token fail"): final for that controller, never replayed; read
  again only with another key or by "Check the controllers" (never sooner
  than the interval). The key is never logged nor stored, and a key that works
  on any controller is never fingerprinted in `/data`.
- Never read sooner than the refresh interval, after a restart included (the
  status then shows the outcome of the last read); HTTP 429 or 5xx: a pause
  of 1 min to 6 h; other failures: 30 s to 5 min.
- "Check the controllers" action; reachability on the transport badge; states
  within the Gladys rate limit.

[Unreleased]: https://github.com/LM1LC3N7/gladys-tailwind/commits/main
