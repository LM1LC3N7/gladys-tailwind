// -----------------------------------------------------------------------------
// Status answers -> identity, layout and reading (pure). After gotailwind
// (models.py): `dev_id` identifies the controller (its MAC written
// "_3c_e9_e_6d_21_84_"), `fw_ver` its firmware ("10.10"), `product` its model
// ("iQ3"), `led_brightness` the status LED (0-100), and `data` its doors:
// `{ "door1": { "index": 0, "status": "open" | "close", "lockup": 0 | 1,
// "disabled": 0 | 1 } ... }`. Own properties only, every value checked: a
// missing or odd value is undefined, never 0 nor "closed".
// -----------------------------------------------------------------------------

import { cleanText } from '../config.js';
import { DOOR, LED, LIMITS, MAX_DOORS, MIN_FIRMWARE } from '../constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (data, key) => (isObject(data) && Object.hasOwn(data, key) ? data[key] : undefined);

/** An integer (or its exact text) within bounds, else undefined. */
export function boundedInteger(value, min, max) {
  let number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && /^\s*-?\d{1,6}\s*$/.test(value)) {
    number = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

/** 0 / 1 (or false / true) -> a boolean; anything else undefined. */
const flag = (value) => {
  if (value === true || value === false) return value;
  const number = boundedInteger(value, 0, 1);
  return number === undefined ? undefined : number === 1;
};

/** "_3c_e9_e_6d_21_84_" -> "3ce90e6d2184"; anything else undefined. */
export function macOf(value) {
  if (typeof value !== 'string' || value.length > 40) {
    return undefined;
  }
  const parts = value
    .trim()
    .split(/[_:-]/)
    .filter((part) => part !== '');
  if (parts.length !== 6 || !parts.every((part) => /^[0-9a-f]{1,2}$/i.test(part))) {
    return undefined;
  }
  const mac = parts.map((part) => part.padStart(2, '0').toLowerCase()).join('');
  // An unset or broadcast address identifies nothing.
  return mac === '000000000000' || mac === 'ffffffffffff' ? undefined : mac;
}

/** "10.10" -> [10, 10]; anything else undefined. */
export function versionOf(value) {
  if (typeof value !== 'string' || !/^\d{1,4}(\.\d{1,4}){0,3}$/.test(value.trim())) {
    return undefined;
  }
  return value.trim().split('.').map(Number);
}

/** Whether a firmware is at least the one the local API needs; unknown: false. */
export function firmwareSupported(value) {
  const version = versionOf(value);
  if (!version) {
    return false;
  }
  for (let i = 0; i < Math.max(version.length, MIN_FIRMWARE.length); i += 1) {
    const a = version[i] ?? 0;
    const b = MIN_FIRMWARE[i] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/**
 * The identity of a controller: `{ id, product, firmware }`, `id` undefined
 * when the answer does not say it (unreadable: never "another controller").
 */
export function identityOf(data) {
  const firmware = own(data, 'fw_ver');
  return {
    id: macOf(own(data, 'dev_id')),
    product: cleanText(own(data, 'product'), 32),
    firmware: typeof firmware === 'string' && versionOf(firmware) ? firmware.trim() : '',
  };
}

/** The doors of an answer: index -> { state, disabled, lockedOut }, each maybe undefined. */
function doorsOf(data) {
  const doors = new Map();
  const entries = own(data, 'data');
  if (!isObject(entries)) {
    return doors;
  }
  for (const key of Object.keys(entries).slice(0, LIMITS.doorEntries)) {
    const door = entries[key];
    const index = boundedInteger(own(door, 'index'), 0, MAX_DOORS - 1);
    if (index === undefined || doors.has(index)) {
      continue;
    }
    const status = own(door, 'status');
    let state;
    if (status === 'open') state = DOOR.OPEN;
    else if (status === 'close') state = DOOR.CLOSED;
    doors.set(index, {
      state,
      disabled: flag(own(door, 'disabled')),
      lockedOut: flag(own(door, 'lockup')),
    });
  }
  return doors;
}

/** The features a controller has: its door indexes and the LED (a created feature is kept by the app). */
export function layoutOf(data) {
  return {
    doors: [...doorsOf(data).keys()].sort((a, b) => a - b),
    led: boundedInteger(own(data, 'led_brightness'), LED.min, LED.max) !== undefined,
  };
}

/** A layout never loses a feature: once seen, kept. */
export function mergeLayout(previous = {}, next = {}) {
  const doors = new Set();
  for (const list of [previous.doors, next.doors]) {
    for (const index of Array.isArray(list) ? list.slice(0, MAX_DOORS) : []) {
      if (Number.isInteger(index) && index >= 0 && index < MAX_DOORS) {
        doors.add(index);
      }
    }
  }
  return {
    doors: [...doors].sort((a, b) => a - b),
    led: Boolean(previous.led || next.led),
  };
}

/**
 * The values of an answer: `{ doors, led, firmware }`, `doors` a Map of the
 * doors it lists; every value undefined when missing or out of range.
 */
export function readingOf(data) {
  const firmware = own(data, 'fw_ver');
  return {
    doors: doorsOf(data),
    led: boundedInteger(own(data, 'led_brightness'), LED.min, LED.max),
    firmware: typeof firmware === 'string' ? firmware.trim().slice(0, 16) : undefined,
  };
}
