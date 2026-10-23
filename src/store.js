// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume):
//   - the known controllers (by MAC), so a door can be closed after a restart
//     before the first poll, and a created device never loses a feature;
//   - the pauses asked by a controller (429/5xx), per address;
//   - the local control keys REFUSED by a controller ("token fail"), per
//     address: a salted fingerprint only (never the key, never a fingerprint
//     of a key that works on any controller). A refusal is final: that address
//     is not read again with that key until another key is saved or "Check
//     the controllers" succeeds, so a wrong key is never replayed in a loop;
//   - the guard of the last command of each door, with the time it left (a
//     restart never lets a second pulse stop a moving door);
//   - the time of the last read (written at most once a minute), so a
//     restart never reads sooner than the interval, and the outcome of the
//     last read of each address (the status until the first read).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAddress } from './config.js';
import { DOOR, LIMITS, TIMINGS } from './constants.js';
import { mergeLayout } from './tailwind/parse.js';

/** A controller id: its MAC, 12 lower-case hexadecimal digits. */
export const DEVICE_ID = /^[0-9a-f]{12}$/;
/** A door guard id: `<MAC>-<index>`. */
export const GUARD_ID = /^[0-9a-f]{12}-[0-2]$/;

export const newSalt = () => randomBytes(16).toString('hex');

export const emptyData = () => ({
  salt: newSalt(),
  lastTry: undefined,
  devices: {},
  blocks: {},
  authBlocks: {},
  guards: {},
  lastReads: {},
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const failuresOf = (value) => (Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : 1);
/** An address as the configuration gives it ("__proto__" is not one). */
const isAddress = (address) => parseAddress(address) === address;

/**
 * What a file holds, checked: unknown keys dropped, ids and addresses
 * checked, every end of a pause or a guard never later than its longest
 * bound from now (a clock that jumped, a file edited by hand).
 */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) {
    base.salt = data.salt;
  }
  if (Number.isFinite(data.lastTry)) {
    base.lastTry = Math.min(data.lastTry, now);
  }
  if (isObject(data.devices)) {
    for (const [id, record] of Object.entries(data.devices).slice(0, LIMITS.addresses * 2)) {
      if (
        !DEVICE_ID.test(id) ||
        !isObject(record) ||
        record.id !== id ||
        typeof record.address !== 'string' ||
        (record.address !== '' && !isAddress(record.address))
      ) {
        continue;
      }
      base.devices[id] = {
        id,
        address: record.address,
        product: text(record.product, 32),
        firmware: text(record.firmware, 16),
        layout: mergeLayout(isObject(record.layout) ? record.layout : {}, {}),
      };
    }
  }
  if (isObject(data.blocks)) {
    for (const [address, block] of Object.entries(data.blocks).slice(0, LIMITS.addresses)) {
      if (!isAddress(address) || !isObject(block) || block.kind !== 'pause') {
        continue;
      }
      const until = Number.isFinite(block.until)
        ? Math.min(block.until, now + TIMINGS.pauseMax)
        : now;
      base.blocks[address] = { kind: 'pause', until, failures: failuresOf(block.failures) };
    }
  }
  if (isObject(data.authBlocks)) {
    for (const [address, block] of Object.entries(data.authBlocks).slice(0, LIMITS.addresses)) {
      if (
        !isAddress(address) ||
        !isObject(block) ||
        typeof block.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(block.fingerprint)
      ) {
        continue;
      }
      base.authBlocks[address] = {
        fingerprint: block.fingerprint,
        at: Number.isFinite(block.at) ? Math.min(block.at, now) : now,
      };
    }
  }
  if (isObject(data.guards)) {
    for (const [id, guard] of Object.entries(data.guards).slice(0, LIMITS.addresses * 6)) {
      const states = [DOOR.CLOSED, DOOR.OPEN];
      if (
        !GUARD_ID.test(id) ||
        !isObject(guard) ||
        !states.includes(guard.from) ||
        guard.expect !== (guard.from === DOOR.CLOSED ? DOOR.OPEN : DOOR.CLOSED) ||
        !Number.isFinite(guard.until)
      ) {
        continue;
      }
      // `at`: when the command left (only a read sent after it lifts the
      // guard); unknown or in the future: now, the safe side. The request
      // numbers of before the restart mean nothing now: dropped.
      base.guards[id] = {
        from: guard.from,
        expect: guard.expect,
        at: Number.isFinite(guard.at) ? Math.min(guard.at, now) : now,
        until: Math.min(guard.until, now + TIMINGS.doorGuard),
      };
    }
  }
  if (isObject(data.lastReads)) {
    // The most recent ones first: a file holding more than the limit keeps
    // the addresses read lately.
    const entries = Object.entries(data.lastReads)
      .slice(0, LIMITS.addresses * 10)
      .filter(
        ([address, read]) => isAddress(address) && isObject(read) && typeof read.ok === 'boolean',
      )
      .sort(
        ([, a], [, b]) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0),
      )
      .slice(0, LIMITS.addresses);
    for (const [address, read] of entries) {
      const at = Number.isFinite(read.at) ? Math.min(read.at, now) : now;
      base.lastReads[address] =
        read.ok && typeof read.id === 'string' && DEVICE_ID.test(read.id)
          ? { ok: true, id: read.id, at }
          : { ok: false, at };
    }
  }
  return base;
}

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'tailwind.json',
    now = Date.now,
  } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
  }

  async load() {
    try {
      return sanitize(JSON.parse(await readFile(this.path, 'utf8')), this.now());
    } catch {
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), now = Date.now) {
    this.data = structuredClone(data);
    this.saves = 0;
    this.now = now;
  }

  async load() {
    return sanitize(structuredClone(this.data), this.now());
  }

  async save(data) {
    this.data = structuredClone(data);
    this.saves += 1;
  }
}
