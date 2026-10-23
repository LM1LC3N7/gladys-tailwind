// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, the
// Tailwind local API words, limits and timings.
// -----------------------------------------------------------------------------

/** The external id type: `gladys.externalIds('tailwind', <MAC>)`. Frozen. */
export const EXTERNAL_ID_TYPE = 'tailwind';

/** Manifest `actions` keys. */
export const ACTIONS = {
  CHECK: 'check_controllers',
};

// Gladys core enums (server/utils/constants.js), not exported by the SDK.
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** The door states of the integration (`status` of a door: "open" / "close"). */
export const DOOR = { CLOSED: 0, OPEN: 1 };

/** A controller has up to three doors (iQ3), indexed 0 to 2 by the API. */
export const MAX_DOORS = 3;

/** `result` of every answer (gotailwind TailwindResponseResult). */
export const RESULT = { OK: 'OK', FAIL: 'Fail', TOKEN_FAIL: 'token fail' };

/**
 * The oldest firmware the local API is known to work with (gotailwind
 * MIN_REQUIRED_FIRMWARE_VERSION): an older one is said in the status, never read.
 */
export const MIN_FIRMWARE = [10, 10];

/** The LED brightness bounds (`status_led`). */
export const LED = { min: 0, max: 100 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Controllers handled (each one is polled over HTTP). */
  addresses: 20,
  /** Body of a controller answer (a status is a few hundred bytes). */
  responseBytes: 16 * 1024,
  /** Entries of `data` looked at in a status (three doors at most). */
  doorEntries: 8,
};

export const TIMINGS = {
  /** One HTTP request of the polling. */
  requestTimeout: 5000,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** Measurements of a feature are spaced by this much (none today: kept for later). */
  measureInterval: 60_000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** Saving /data waits this long for more changes. */
  persistDelay: 1000,
  /** The time of the last read is written to /data at most this often. */
  lastTrySave: 60_000,
  /**
   * A command leaves within this many ms of its arrival, or is refused
   * unsent: Gladys gives up waiting for the ack after 5 s.
   */
  commandSendBy: 3500,
  /** The ack is given by then: past it, "sent, without confirmation". */
  commandAnswerBy: 4300,
  /** Reads after a command (a garage door moves for 10 to 30 s). */
  followUps: [5000, 15_000, 30_000, 50_000],
  /**
   * After a door command that may have left, no other one for that door
   * until it is read in the state the command aimed at, or this long after
   * it: the controller pulses the opener, and a second pulse would stop or
   * reverse a moving door.
   */
  doorGuard: 45_000,
  /**
   * The expected state lifts the guard only this long after the command.
   * After an opening, the end of the longest travel (30 s): the sensor reads
   * "open" as soon as the door leaves its closed position, so "open" says
   * nothing of the end of travel before that. After a closing, 15 s: "close"
   * is only read at the end of travel.
   */
  doorGuardMinOpen: 30_000,
  doorGuardMinClose: 15_000,
  /**
   * A command of the same kind on the same door within this time after one
   * that sent nothing (already there, or refused on its read) gets the same
   * answer without a new read: a scene pressing in a loop never reads the
   * controller more than once every 5 s per door and kind.
   */
  commandReuse: 5000,
  /** LED commands of a controller are at least this far apart. */
  ledSpacing: 2000,
  /** Transient failures: the next reads, never sooner than the interval. */
  backoff: [30_000, 60_000, 120_000, 300_000],
  /** HTTP 429 or 5xx: a pause within these bounds. */
  pauseMin: 60_000,
  pauseMax: 6 * 60 * 60_000,
};

/**
 * The fingerprint of a refused key kept in /data: the first 2 hex digits (8
 * bits) of a salted HMAC. A six-digit key could be found back from a full
 * fingerprint and the salt in the same file; 8 bits leave ~3,900 candidates.
 * A collision only costs a press on "Check the controllers".
 */
export const FINGERPRINT_HEX = 2;

/** Configuration bounds (mirrored by the manifest). */
export const POLL_INTERVAL = { default: 10, min: 5, max: 300 };
