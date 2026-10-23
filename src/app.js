// -----------------------------------------------------------------------------
// The integration: the Tailwind controllers at the typed addresses, polled
// over their local API (POST /json, `dev_st`), the Gladys devices built from
// them, and the door and LED commands sent back. index.js only wires the SDK
// handlers to it (src/handlers.js).
//
// Reads:
//   - one status per typed address and interval, with the local control key
//     (the controller answers nothing without it); its `dev_id` (the MAC)
//     says which controller answers, so the identity is checked at every read
//     (a new DHCP lease moves a controller, never its device); an answer
//     without a readable id is a failed read, never "another controller"; a
//     firmware older than 10.10 is said in the status, never used;
//   - never sooner than the interval: not on a reconnection to Gladys, a
//     configuration saved unchanged, the Discovery scan or the "Check" button,
//     nor after a restart (the time of the last read is kept in /data); a
//     reconnection during a read shares it;
//   - failures: 30 s, 1, 2, 5 min, never sooner than the interval; HTTP 429
//     or 5xx: a pause of 1 min to 6 h persisted in /data;
//   - key refused ("token fail"): final for that address and that key,
//     persisted (8 bits of a salted fingerprint: the key cannot be found back
//     from it; never for a key that works anywhere):
//     no automatic read again until another key is saved or "Check the
//     controllers" reads it successfully (never sooner than the interval);
//   - a read of an older configuration that ends late publishes nothing and
//     sets no status (the generation is checked after every await).
//
// Door commands (open, close: buttons, never a switch). The controller
// pulses the wall-button input of the garage door opener, which is a TOGGLE
// on most openers: a pulse given to a door that moved since it was read could
// stop or reverse it. So:
//   - every command is decided on a status read just now, after checking the
//     id: "open" only to a door read closed, "close" only to a door read open;
//     already there: nothing sent; unknown, disabled or locked out: refused;
//   - BOTH need "Allow opening and closing the garage doors" (allow_open, off
//     by default), checked on arrival, after the fresh read and right before
//     the request leaves (beforeSend);
//   - openings: one queue per DOOR; a close is in NO queue: it never waits
//     behind a read or a slow answer of any command (its door's guard and
//     flight refuse it at once when another pulse would stop the door); it
//     cancels, on arrival, the openings of its door not sent yet (queued ones
//     included, their read dropped at once); a close is never held by a
//     429/5xx pause nor by a refused key (one try, never retried), an
//     opening is;
//   - a guard per door is set in beforeSend (written to /data synchronously
//     before the first byte, with the time the command left) and refuses
//     any other command of that door until a read STARTED after it shows the
//     door where it was sent, at least 30 s after an opening (the sensor
//     reads "open" as soon as the door leaves closed) or 15 s after a
//     closing, or 45 s; measured on a monotonic clock in memory (a wall
//     clock set forward never lifts it); never lifted on an unknown or
//     unchanged state; removed only when the controller surely did nothing
//     (Fail, token fail, 4xx, not sent);
//   - a press of the same kind on the same door within 5 s of one that sent
//     nothing gets the same answer without a new read (a scene in a loop);
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s; a
//     request that may have reached the controller is never answered "not
//     sent": "sent, without confirmation", then reads; never retried;
//   - the ack never waits for a publication to Gladys; the key is never in a
//     log line, a status, an error or /data.
//
// LED brightness (light / brightness, 0-100): not a sensitive command, never
// queued with the doors; identity read first, then the value, then a read
// back: success only when the LED is read at the value asked; one at a time
// per controller, 2 s apart at least.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { generationKey, normalizeConfig, numberOf } from './config.js';
import {
  BUTTON_PUSH,
  DOOR,
  EXTERNAL_ID_TYPE,
  FINGERPRINT_HEX,
  LED,
  LIMITS,
  TIMINGS,
} from './constants.js';
import { ERRORS, T, join, word } from './i18n.js';
import { buildDevice, commandOf, featuresOf, valuesOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { FileStore, emptyData } from './store.js';
import { TailwindClient } from './tailwind/client.js';
import { TailwindError, reasonOf } from './tailwind/errors.js';
import {
  firmwareSupported,
  identityOf,
  layoutOf,
  mergeLayout,
  readingOf,
} from './tailwind/parse.js';

/** Runs `task` over `items`, `limit` at a time. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A command value, strictly: a finite number or its exact text ('' and null are not 0). */
const strictNumber = (value) => (typeof value === 'boolean' ? undefined : numberOf(value));

/** The id of a door: its guard, its flight, its pending openings. */
const doorId = (record, index) => `${record.id}-${index}`;

export class TailwindApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'tailwind' }),
    client = new TailwindClient(),
    store = new FileStore(),
    now = Date.now,
    // A monotonic clock (ms) for the guards in memory: a wall clock set
    // forward (NTP, by hand) never shortens a guard.
    mono = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.mono = mono;
    this.timers = timers;
    this.config = undefined;
    this.data = undefined;
    /** Bumped when the addresses or the key change: a late answer of before is dropped. */
    this.generation = 0;
    this.generationKey = undefined;
    this.publisher = new StatePublisher({
      gladys,
      logger,
      now,
      timers,
      interval: TIMINGS.measureInterval,
    });
    /** address -> { lastTry, next, failures, id?, error? } */
    this.addresses = new Map();
    /** No read before this time (a restart soon after the last read). */
    this.notBefore = 0;
    this.lastTrySaved = -Infinity;
    /** id -> reachable */
    this.reachable = new Map();
    /** address -> [previous id, new id] */
    this.moved = new Map();
    /** id -> addresses answering with it, besides its own */
    this.duplicates = new Map();
    /** deviceId -> transport badge last published */
    this.transports = new Map();
    /** featureId -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** featureId -> { id, key } of the published devices */
    this.features = new Map();
    /** door id -> tail of its queue of openings (a close is in no queue) */
    this.queues = new Map();
    /** `${door id}:${kind}` -> { at (mono), error? } of the last command that sent nothing */
    this.recentCommands = new Map();
    /** controller id -> when (mono) its last LED command started */
    this.lastLed = new Map();
    /** door id -> tickets of the openings not sent yet */
    this.tickets = new Map();
    /** door id -> the command between its plan and its answer */
    this.flights = new Map();
    /** controller ids with a LED command in progress */
    this.ledBusy = new Set();
    /** id -> handles of the reads after its last command */
    this.followUps = new Map();
    /** address -> the read in progress (a poll and a follow-up share it) */
    this.reads = new Map();
    this.polling = undefined;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.saving = Promise.resolve();
    this.lastStatus = undefined;
    this.warned = new Set();
    /** Fingerprints (memory only) of the keys a controller accepted. */
    this.goodKeys = new Set();
    /** address -> refusal of a key that works elsewhere (never in /data) */
    this.memoryAuthBlocks = new Map();
    /** Every request gets a number: a guard is lifted only by a read sent after its command. */
    this.sequence = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  async start(raw = {}) {
    const first = !this.data;
    if (first) {
      this.data = await this.store.load().catch(() => emptyData());
      // A guard kept across a restart goes on the monotonic clock from now,
      // with the age its wall-clock time gives (never in the future).
      for (const guard of Object.values(this.data.guards)) {
        guard.monoAt = this.mono() - Math.max(0, this.now() - guard.at);
      }
    }
    this.config = normalizeConfig(raw);
    if (first && this.data.lastTry !== undefined) {
      // The last read may be later than the one written (once a minute): a
      // whole interval from now is never sooner than the interval.
      if (this.now() - this.data.lastTry < this.interval + TIMINGS.lastTrySave) {
        this.notBefore = this.now() + this.interval;
      }
    }
    const key = generationKey(this.config);
    if (key !== this.generationKey) {
      this.generationKey = key;
      this.generation += 1;
      // The addresses no longer typed are forgotten; the others keep their
      // last try (a configuration saved again never reads sooner).
      for (const [address, status] of this.addresses) {
        if (!this.config.addresses.includes(address)) {
          this.addresses.delete(address);
        } else if (status.lastTry !== undefined) {
          // A new key or address list is tried once the interval has passed,
          // not after the backoff of the previous one.
          status.next = status.lastTry + this.interval;
        }
      }
      // The outcome of the last read and the refusals are only kept for the typed addresses.
      for (const table of [this.data.lastReads, this.data.authBlocks]) {
        for (const address of Object.keys(table)) {
          if (!this.config.addresses.includes(address)) {
            delete table[address];
            this.persist();
          }
        }
      }
      this.reads.clear();
    }
    // Gladys keeps the status and the Discovery tab in memory: sent again at every start.
    this.lastStatus = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.publisher.start();
    await this.publishDevices();
    await this.publishAllTransports();
    this.schedule();
    this.updateStatus();
    const changed = await this.poll();
    if (changed) {
      await this.publishDevices();
    }
    this.updateStatus();
  }

  stop() {
    this.publisher.stop();
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.save();
    }
    return this.saving;
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    // The timer only looks: each address is read when due.
    this.pollTimer = this.timers.setInterval(() => this.tick(), Math.min(this.interval, 5000));
  }

  tick() {
    return this.poll()
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${reasonOf(err)}`));
  }

  /** Saves /data now, one write at a time. */
  save() {
    this.saving = this.saving
      .then(() => this.store.save(this.data))
      .catch(() => this.logger.warn('Could not save /data'));
    return this.saving;
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, TIMINGS.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get records() {
    return Object.values(this.data?.devices ?? {});
  }

  // --- Pauses (429, 5xx) and refused keys -----------------------------------

  blockOf(address) {
    const block = this.data.blocks[address];
    return block && block.until > this.now() ? block : undefined;
  }

  /** A failure of an address: a pause asked by the controller is persisted. */
  onFailure(address, err) {
    if (!(err instanceof TailwindError) || err.kind !== 'busy' || !address) {
      return;
    }
    const previous = this.data.blocks[address];
    const failures = previous ? previous.failures + 1 : 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    this.logger.warn(`${address}: ${err.message}, paused for ${Math.round(wait / 1000)} s`);
    this.data.blocks[address] = { kind: 'pause', failures, until: this.now() + wait };
    this.persist();
    this.updateStatus();
  }

  onSuccess(address) {
    if (this.data.blocks[address]) {
      delete this.data.blocks[address];
      this.persist();
    }
  }

  /**
   * A short salted fingerprint of a key (8 bits), only ever kept for a key a
   * controller refused: a six-digit key can never be found back from it.
   */
  fingerprint(key) {
    return createHmac('sha256', this.data.salt).update(key).digest('hex').slice(0, FINGERPRINT_HEX);
  }

  /** The refusal of the current key at an address, if any (final until another key or a success). */
  authBlockOf(address) {
    const block = this.data.authBlocks[address] ?? this.memoryAuthBlocks.get(address);
    if (!block || !this.config.key) {
      return undefined;
    }
    return block.fingerprint === this.fingerprint(this.config.key) ? block : undefined;
  }

  onKeyRefused(address, key) {
    const fingerprint = this.fingerprint(key);
    const block = { fingerprint, at: this.now() };
    if (this.goodKeys.has(fingerprint)) {
      // The same key works on another controller: its fingerprint never
      // goes to /data, the refusal stays in memory.
      delete this.data.authBlocks[address];
      this.memoryAuthBlocks.set(address, block);
    } else {
      this.data.authBlocks[address] = block;
    }
    this.warnOnce(`key:${address}:${fingerprint}`, `${address}: local control key refused`);
    this.save();
    this.updateStatus();
  }

  /** A key accepted by any controller: no fingerprint of it is kept in /data. */
  onKeyAccepted(address, key) {
    const fingerprint = this.fingerprint(key);
    this.goodKeys.add(fingerprint);
    this.memoryAuthBlocks.delete(address);
    let changed = false;
    for (const [other, block] of Object.entries(this.data.authBlocks)) {
      if (other === address || block.fingerprint === fingerprint) {
        delete this.data.authBlocks[other];
        if (other !== address) {
          this.memoryAuthBlocks.set(other, block);
        }
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  // --- Reads -----------------------------------------------------------------

  statusOf(address) {
    let status = this.addresses.get(address);
    if (!status) {
      status = { lastTry: undefined, next: 0, failures: 0 };
      this.addresses.set(address, status);
    }
    return status;
  }

  /** `retryRefused`: "Check the controllers" may read once an address that refused the key. */
  isDue(address, { retryRefused = false } = {}) {
    if (!this.config.key || this.now() < this.notBefore || this.blockOf(address)) {
      return false;
    }
    if (!retryRefused && this.authBlockOf(address)) {
      return false;
    }
    const status = this.addresses.get(address);
    return !status || status.lastTry === undefined || this.now() >= status.next;
  }

  /** The time of the last read, written to /data at most once a minute. */
  markTry() {
    this.data.lastTry = this.now();
    if (this.now() - this.lastTrySaved >= TIMINGS.lastTrySave) {
      this.lastTrySaved = this.now();
      this.persist();
    }
  }

  /** One polling round: the typed addresses that are due. */
  poll(options = {}) {
    if (!this.polling) {
      this.polling = this.doPoll(options).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  async doPoll(options) {
    const generation = this.generation;
    const due = this.config.addresses.filter((address) => this.isDue(address, options));
    const results = await mapLimit(due, 4, (address) => this.read(address, generation));
    if (generation !== this.generation) {
      return false;
    }
    // A controller known at an address no longer typed is not read any more.
    for (const record of this.records) {
      if (!record.address || !this.config.addresses.includes(record.address)) {
        this.setReachable(record, false);
      }
    }
    return results.some(Boolean);
  }

  /**
   * Reads one address and records what answers there; true when a Gladys
   * device changes. A read already running for the address is shared.
   */
  read(address, generation = this.generation) {
    const running = this.reads.get(address);
    if (running) {
      return running;
    }
    const promise = this.doRead(address, generation).finally(() => {
      if (this.reads.get(address) === promise) {
        this.reads.delete(address);
      }
    });
    this.reads.set(address, promise);
    return promise;
  }

  async doRead(address, generation) {
    const key = this.config.key;
    if (!key) {
      return false;
    }
    const status = this.statusOf(address);
    status.lastTry = this.now();
    this.markTry();
    // When this request left: it can only lift a guard of a command sent before it.
    const origin = { seq: this.nextSequence(), at: this.now(), mono: this.mono() };
    let data;
    try {
      data = await this.client.status(address, key);
    } catch (err) {
      // A late answer of an older configuration: nothing kept, no status.
      if (generation !== this.generation) {
        return false;
      }
      if (err.kind === 'token') {
        this.onKeyRefused(address, key);
      } else {
        this.onFailure(address, err);
      }
      this.failed(address, status, err.kind ?? 'error');
      this.logger.debug(`${address}: ${reasonOf(err)}`);
      return false;
    }
    if (generation !== this.generation) {
      return false;
    }
    this.onSuccess(address);
    this.onKeyAccepted(address, key);
    const identity = identityOf(data);
    if (!identity.id) {
      // Unreadable: a failed read, never "another controller".
      this.failed(address, status, 'notController');
      this.warnOnce(`notController:${address}`, `${address}: no device id in the status`);
      return false;
    }
    if (!firmwareSupported(identity.firmware)) {
      this.failed(address, status, 'oldFirmware');
      this.warnOnce(`firmware:${address}`, `${address}: firmware older than 10.10`);
      return false;
    }
    status.failures = 0;
    status.next = status.lastTry + this.interval;
    status.error = undefined;
    status.id = identity.id;
    this.rememberRead(address, { ok: true, id: identity.id, at: status.lastTry });
    const changed = this.remember(identity, address, layoutOf(data));
    const record = this.data.devices[identity.id];
    if (record?.address !== address) {
      // The same controller at another typed address: only its own is used.
      return changed;
    }
    const reading = readingOf(data);
    this.liftGuards(record, reading, origin);
    this.recordValues(record, reading);
    this.setReachable(record, true);
    return changed;
  }

  /**
   * The outcome of the last read of an address, kept in /data with lastTry
   * (the status after a restart, before the first read): written with the
   * once-a-minute save, or at once when it changes.
   */
  rememberRead(address, outcome) {
    const previous = this.data.lastReads[address];
    this.data.lastReads[address] = outcome;
    if (previous?.ok !== outcome.ok || previous?.id !== outcome.id) {
      this.persist();
    }
  }

  failed(address, status, error) {
    status.failures += 1;
    status.error = error;
    status.id = undefined;
    this.rememberRead(address, { ok: false, at: status.lastTry });
    const wait = TIMINGS.backoff[Math.min(status.failures, TIMINGS.backoff.length) - 1];
    status.next = status.lastTry + Math.max(wait, this.interval);
    for (const record of this.records) {
      if (record.address === address) {
        this.setReachable(record, false);
      }
    }
  }

  /** Adds or updates a known controller; true when its Gladys device changes. */
  remember(identity, address, layout) {
    const devices = this.data.devices;
    const existing = devices[identity.id];
    if (!existing && Object.keys(devices).length >= LIMITS.addresses * 2) {
      this.warnOnce('devices', 'Too many controllers: the next ones are ignored');
      return false;
    }
    if (
      existing?.address &&
      existing.address !== address &&
      this.config.addresses.includes(existing.address) &&
      this.addresses.get(existing.address)?.id === identity.id
    ) {
      // Still answering at its own address: this one is a second way to it.
      const others = this.duplicates.get(identity.id) ?? new Set();
      others.add(address);
      this.duplicates.set(identity.id, others);
      return false;
    }
    this.duplicates.delete(identity.id);
    let changed = false;
    // One address, one controller: another one known at this address has moved.
    for (const other of this.records) {
      if (other.id !== identity.id && other.address === address) {
        this.logger.warn(`${address}: ${other.id} was known there, ${identity.id} answers now`);
        this.moved.set(address, [other.id, identity.id]);
        other.address = '';
        this.setReachable(other, false);
        changed = true;
      }
    }
    for (const [at, ids] of this.moved) {
      if (ids[0] === identity.id) {
        this.moved.delete(at);
      }
    }
    const record = {
      id: identity.id,
      address,
      product: identity.product || existing?.product || '',
      firmware: identity.firmware || existing?.firmware || '',
      layout: mergeLayout(existing?.layout, layout),
    };
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      if (existing && existing.address !== address) {
        this.logger.info(`Tailwind ${record.id} is now at ${address}`);
      }
      if (existing) {
        // The same object: a command running for it sees the change.
        Object.assign(existing, record);
      } else {
        devices[identity.id] = record;
      }
      changed = true;
      this.persist();
    }
    return changed;
  }

  recordValues(record, reading) {
    const ids = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
    for (const [key, value] of valuesOf(record, reading)) {
      const featureId = ids.feature(key);
      const entry = { state: value };
      this.lastValues.set(featureId, entry);
      if (this.created.has(featureId)) {
        this.publisher.push(featureId, entry);
      }
    }
  }

  setReachable(record, reachable) {
    const previous = this.reachable.get(record.id);
    this.reachable.set(record.id, reachable);
    if (previous !== reachable) {
      this.publishTransport(this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id).device).catch(
        (err) => this.logger.warn(`Transport badge failed: ${reasonOf(err)}`),
      );
    }
  }

  // --- Gladys devices ----------------------------------------------------------

  /**
   * The Discovery tab. A created device never loses a feature: the features
   * it has that the controller no longer gives are published as they are
   * (Gladys would otherwise mark it changed, and "Update" would drop their
   * history).
   */
  async publishDevices() {
    const devices = [];
    this.features.clear();
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const record of this.records) {
      const device = buildDevice(this.gladys, record, { language: this.config.language });
      const ids = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
      for (const { key } of featuresOf(record)) {
        this.features.set(ids.feature(key), { id: record.id, key });
      }
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created.get(device.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of [
            'name',
            'external_id',
            'category',
            'type',
            'min',
            'max',
            'unit',
            'read_only',
            'has_feedback',
            'keep_history',
          ]) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
          const key = feature.external_id.slice(ids.device.length + 1);
          this.features.set(feature.external_id, { id: record.id, key });
        }
      }
      devices.push(device);
    }
    this.publisher.configure({ throttled: new Set(), events: new Set() });
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the discovered devices failed: ${reasonOf(err)}`),
      );
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const feature of device?.features ?? []) {
      const value = this.lastValues.get(feature.external_id);
      if (value) {
        this.publisher.push(feature.external_id, value);
      }
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  recordOf(deviceId) {
    return this.records.find(
      (record) => this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id).device === deviceId,
    );
  }

  transportOf(record) {
    return this.reachable.get(record.id) === false
      ? DEVICE_TRANSPORTS.UNREACHABLE
      : DEVICE_TRANSPORTS.LOCAL;
  }

  async publishTransport(deviceId) {
    const record = this.recordOf(deviceId);
    if (!record || !this.reachable.has(record.id) || !this.createdDevices().has(deviceId)) {
      return;
    }
    const transport = this.transportOf(record);
    if (this.transports.get(deviceId) === transport) {
      return;
    }
    this.transports.set(deviceId, transport);
    await this.gladys.publishTransports([{ external_id: deviceId, transport }]);
  }

  async publishAllTransports() {
    const created = this.createdDevices();
    const entries = [];
    for (const record of this.records) {
      const deviceId = this.gladys.externalIds(EXTERNAL_ID_TYPE, record.id).device;
      if (!this.reachable.has(record.id) || !created.has(deviceId)) {
        continue;
      }
      const transport = this.transportOf(record);
      if (this.transports.get(deviceId) !== transport) {
        this.transports.set(deviceId, transport);
        entries.push({ external_id: deviceId, transport });
      }
    }
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries)
        .catch((err) => this.logger.warn(`Transport badges failed: ${reasonOf(err)}`));
    }
  }

  updateStatus() {
    const typed = this.config.addresses;
    const parts = [];
    let connected = false;
    if (typed.length === 0) {
      parts.push(T.noAddress);
    } else if (this.config.key) {
      const answering = typed.filter((a) => this.addresses.get(a)?.id).length;
      const tried = typed.filter((a) => this.addresses.get(a)?.lastTry !== undefined).length;
      if (tried > 0) {
        connected = answering > 0;
        parts.push(T.status(answering, typed.length));
      } else {
        // After a restart, before the first read (never sooner than the
        // interval): the outcome of the last read kept in /data.
        const restored = typed.filter(
          (a) => this.data.lastReads[a]?.ok && !this.authBlockOf(a),
        ).length;
        connected = restored > 0;
        parts.push(
          restored > 0 ? T.restored(restored, typed.length, this.config.pollInterval) : T.waiting,
        );
      }
      if (!this.config.allowOpen) {
        parts.push(T.doorsOff);
      }
    }
    const { invalidAddresses, keyProblem } = this.config;
    if (invalidAddresses.length > 0) {
      // Only their number: a key pasted in the wrong field is never shown.
      parts.push(T.invalidAddresses(invalidAddresses.length));
    }
    if (keyProblem && typed.length > 0) {
      parts.push(T.key[keyProblem]);
    }
    const refused = typed.filter((a) => this.authBlockOf(a));
    if (refused.length > 0) {
      parts.push(T.keyRefused(refused));
    }
    const paused = typed.filter((a) => this.blockOf(a));
    if (paused.length > 0) {
      parts.push(T.paused(paused));
    }
    const errorOf = (a) => this.addresses.get(a)?.error;
    const odd = typed.filter((a) => errorOf(a) === 'notController');
    if (odd.length > 0) {
      parts.push(T.notController(odd));
    }
    const old = typed.filter((a) => errorOf(a) === 'oldFirmware');
    if (old.length > 0) {
      parts.push(T.oldFirmware(old));
    }
    for (const [id, others] of this.duplicates) {
      const own = this.data.devices[id]?.address;
      if (own) {
        parts.push(T.sameController(id, [own, ...others]));
      }
    }
    for (const [address, [previous, next]] of this.moved) {
      parts.push(T.moved(address, previous, next));
    }
    const message = join(parts);
    // Last guard: the key never appears in the status, whatever put it there
    // (an address typed with it as a port, for example).
    if (this.config.key) {
      for (const lang of Object.keys(message)) {
        message[lang] = message[lang].split(this.config.key).join('•••');
      }
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${reasonOf(err)}`));
  }

  /** The Discovery tab scan: the due addresses only, then the devices. */
  async scan() {
    await this.poll();
    await this.publishDevices();
    this.updateStatus();
  }

  /**
   * "Check the controllers": what each address answered, read again only
   * when due; an address that refused the key is read once more (still never
   * sooner than the interval), its refusal lifted only by a success.
   */
  async checkControllers() {
    const typed = this.config.addresses;
    if (typed.length === 0) {
      return T.check.none;
    }
    if (!this.config.key) {
      return T.check.noKey;
    }
    if (await this.poll({ retryRefused: true })) {
      await this.publishDevices();
    }
    this.updateStatus();
    const age = (status) => Math.max(0, Math.round((this.now() - status.lastTry) / 1000));
    const lines = typed.map((address) => {
      const status = this.addresses.get(address);
      if (this.authBlockOf(address) && !status?.id) {
        return T.check.refused(address);
      }
      if (!status || status.lastTry === undefined) {
        return T.check.pending(address);
      }
      if (status.id) {
        return T.check.ok(address, status.id, age(status));
      }
      return T.check.failed(address, status.error ?? 'error', age(status));
    });
    lines.push(T.check.interval(this.config.pollInterval));
    return T.check.result(lines);
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config?.language ?? 'fr'));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    // Before the first start, or a feature not published: a refusal, never a
    // publication awaited by the ack.
    const target = this.data && this.config && this.features.get(feature?.external_id);
    const record = target && this.data.devices[target.id];
    if (!record) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const command = commandOf(target.key);
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (command.kind === 'led') {
      return this.setLed(record, value, received);
    }
    if (strictNumber(value) !== BUTTON_PUSH.PRESSED) {
      throw this.refusal(ERRORS.badValue);
    }
    if (!(record.layout?.doors ?? []).includes(command.index)) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const action =
      command.kind === 'open'
        ? this.openAction(record, command.index)
        : this.closeAction(record, command.index);
    this.checkOption(action);
    const ticket = {
      action,
      cancelled: false,
      sent: false,
      generation: this.generation,
      abort: new AbortController(),
    };
    const door = action.door;
    if (action.protective) {
      // The openings of this door still waiting to leave are cancelled on
      // arrival, queued ones included; their read is dropped at once.
      // Cancelling never sends anything.
      for (const pending of this.tickets.get(door) ?? []) {
        if (!pending.sent) {
          pending.cancelled = true;
          pending.abort.abort();
        }
      }
    }
    // A command that cannot leave is refused at once, with its real reason:
    // one already left for this door (a second pulse would stop or reverse
    // it), or a guard younger than its minimum (no read can lift it yet).
    this.checkJustCommanded(door);
    // The same press on the same door a moment ago sent nothing: the same
    // answer, without reading the controller again (a scene in a loop).
    this.checkRecent(action);
    if (action.protective) {
      // A close is in no queue: it never waits behind the read or the slow
      // answer of any other command (other doors included). Two closes of
      // the same door: the flight and the guard refuse the second at once.
      return this.run(record, action, received, ticket);
    }
    if (!this.tickets.has(door)) {
      this.tickets.set(door, new Set());
    }
    this.tickets.get(door).add(ticket);
    // One queue of openings per DOOR: an opening waits behind another
    // opening of its door in progress, never beside it, and never delays
    // another door. The wait ends by sendBy - 200 ms, with its real reason.
    const previous = this.queues.get(door) ?? Promise.resolve();
    let timer;
    const turn = new Promise((resolve, reject) => {
      previous.then(resolve, resolve);
      timer = this.timers.setTimeout(
        () => {
          const flying = this.flights.get(door);
          reject(this.refusal(flying?.sent ? ERRORS.justCommanded : ERRORS.doorBusy));
        },
        Math.max(0, received + TIMINGS.commandSendBy - 200 - this.now()),
      );
    }).finally(() => this.timers.clearTimeout(timer));
    const run = turn.then(() => this.run(record, action, received, ticket));
    // The next opening waits for this one AND everything before it.
    const tail = Promise.allSettled([previous, run]).then(() => {});
    this.queues.set(door, tail);
    try {
      return await run;
    } finally {
      this.tickets.get(door)?.delete(ticket);
      // The entry leaves the queue only once everything before it has
      // settled too: a command refused by the wait bound never lets a later
      // one run beside an earlier one still running.
      tail.then(() => {
        if (this.queues.get(door) === tail) {
          this.queues.delete(door);
        }
      });
    }
  }

  /** The age of a guard (ms), on the monotonic clock. */
  guardAge(guard) {
    return this.mono() - guard.monoAt;
  }

  /** How long the expected state must wait before it lifts a guard. */
  guardMin(guard) {
    return guard.expect === DOOR.OPEN ? TIMINGS.doorGuardMinOpen : TIMINGS.doorGuardMinClose;
  }

  /** Refuses at once a command while another one of the door has left or a young guard holds. */
  checkJustCommanded(door) {
    if (this.flights.get(door)?.sent) {
      throw this.refusal(ERRORS.justCommanded);
    }
    const guard = this.data.guards[door];
    if (guard && this.guardAge(guard) < this.guardMin(guard)) {
      throw this.refusal(ERRORS.justCommanded);
    }
  }

  recentKey(action) {
    return `${action.door}:${action.kind}`;
  }

  /** The same press, on the same door, within 5 s of one that sent nothing: its answer again. */
  checkRecent(action) {
    const recent = this.recentCommands.get(this.recentKey(action));
    if (
      !recent ||
      recent.generation !== this.generation ||
      this.mono() - recent.at >= TIMINGS.commandReuse
    ) {
      return;
    }
    const error = new Error(recent.message ?? word(ERRORS.tooSoon, this.config.language));
    error.refusal = true;
    throw error;
  }

  /** Remembers a command that sent nothing (already there, or refused on its read). */
  rememberRecent(action, message) {
    this.recentCommands.set(this.recentKey(action), {
      at: this.mono(),
      generation: this.generation,
      message,
    });
  }

  /** The permission of a command, read now from the current configuration. */
  checkOption(action) {
    if (!this.config.allowOpen) {
      // Closing pulses the opener as opening does: both need the permission.
      throw this.refusal(action.kind === 'open' ? ERRORS.openDisabled : ERRORS.closeDisabled);
    }
    if (!this.config.key) {
      throw this.refusal(ERRORS.noKey);
    }
  }

  /** The door of a reading, refused when it cannot be commanded. */
  doorOf(reading, index) {
    const door = reading.doors.get(index);
    if (!door) throw this.refusal(ERRORS.unknownState);
    if (door.disabled !== false) {
      throw this.refusal(door.disabled ? ERRORS.doorDisabled : ERRORS.unknownState);
    }
    if (door.lockedOut !== false) {
      throw this.refusal(door.lockedOut ? ERRORS.doorLockedOut : ERRORS.unknownState);
    }
    return door;
  }

  /** Open: only a door read closed. */
  openAction(record, index) {
    const door = doorId(record, index);
    return {
      kind: 'open',
      name: `open door ${index + 1}`,
      index,
      door,
      plan: (reading, origin) => {
        this.checkGuard(door, reading, origin);
        const { state } = this.doorOf(reading, index);
        if (state === DOOR.OPEN) return { unchanged: true };
        if (state !== DOOR.CLOSED) throw this.refusal(ERRORS.notClosed);
        return { from: DOOR.CLOSED, expect: DOOR.OPEN, command: 'open' };
      },
    };
  }

  /** Close: only a door read open; protective, it cancels the pending openings of its door. */
  closeAction(record, index) {
    const door = doorId(record, index);
    return {
      kind: 'close',
      name: `close door ${index + 1}`,
      index,
      door,
      protective: true,
      plan: (reading, origin) => {
        this.checkGuard(door, reading, origin);
        const { state } = this.doorOf(reading, index);
        if (state === DOOR.CLOSED) return { unchanged: true };
        if (state !== DOOR.OPEN) throw this.refusal(ERRORS.notOpen);
        return { from: DOOR.OPEN, expect: DOOR.CLOSED, command: 'close' };
      },
    };
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * Whether a read lifts the guard: it shows the door where the command sent
   * it, it LEFT after the command (an answer generated before it says
   * nothing of it), and the door had the time to finish its travel: 30 s
   * after an opening (the sensor reads "open" as soon as the door leaves
   * closed), 15 s after a closing. The guard also ends 45 s after the
   * command. Ages on the monotonic clock: a wall clock set forward or back
   * changes nothing.
   */
  guardLifted(guard, door, origin) {
    const age = this.guardAge(guard);
    if (age >= TIMINGS.doorGuard) {
      return true;
    }
    // In memory, the request numbers; after a restart (no number), the times.
    const after = guard.seq === undefined ? origin.mono > guard.monoAt : origin.seq > guard.seq;
    return after && door?.state === guard.expect && age >= this.guardMin(guard);
  }

  /** Before a command: refused while the guard of the previous one of the door holds. */
  checkGuard(door, reading, origin) {
    const guard = this.data.guards[door];
    if (!guard) {
      return;
    }
    const index = Number(door.slice(-1));
    if (this.guardLifted(guard, reading.doors.get(index), origin)) {
      delete this.data.guards[door];
      this.persist();
      return;
    }
    throw this.refusal(ERRORS.justCommanded);
  }

  /** A read (polling, follow-up) may lift the guards of the controller, by the same rule. */
  liftGuards(record, reading, origin) {
    for (const index of record.layout?.doors ?? []) {
      const door = doorId(record, index);
      const guard = this.data.guards[door];
      if (guard && this.guardLifted(guard, reading.doors.get(index), origin)) {
        delete this.data.guards[door];
        this.persist();
      }
    }
  }

  /**
   * The guard of a command, set right before it leaves (beforeSend) and
   * written to /data SYNCHRONOUSLY, before the first byte: an abrupt stop
   * right after the request left keeps it. `at` / `until` (wall clock) are
   * for /data and a restart; `monoAt` and `seq` are for this process only.
   */
  guardDoor(door, plan) {
    const guard = {
      from: plan.from,
      expect: plan.expect,
      at: this.now(),
      until: this.now() + TIMINGS.doorGuard,
      seq: this.nextSequence(),
      monoAt: this.mono(),
    };
    this.data.guards[door] = guard;
    try {
      this.store.saveSync(this.data);
    } catch {
      // The guard still holds in memory; the regular save tries again.
      this.logger.warn('Could not write the guard to /data before the command');
      this.save();
    }
    return guard;
  }

  /** The controller surely did nothing (a refusal): the guard of this command goes. */
  unguardDoor(door, guard) {
    if (guard && this.data.guards[door] === guard) {
      delete this.data.guards[door];
      this.save();
    }
  }

  /** One command: the fresh read with the identity, the plan, the request. */
  async run(record, action, received, ticket) {
    try {
      return await this.runCommand(record, action, received, ticket);
    } finally {
      if (this.flights.get(action.door) === ticket) {
        this.flights.delete(action.door);
      }
    }
  }

  /**
   * The read of a command: the status with the identity checked (a DHCP
   * lease may have given the address to another controller; an unreadable
   * id is not "another"). Refusals carry their reason.
   */
  async commandRead(record, address, key, { ticket, generation, left }) {
    let data;
    const origin = { seq: this.nextSequence(), at: this.now(), mono: this.mono() };
    try {
      if (left() <= 0) throw this.refusal(ERRORS.tooSlow);
      data = await this.client.status(address, key, {
        timeout: left(),
        signal: ticket?.abort?.signal,
      });
    } catch (err) {
      if (err.refusal) throw err;
      if (err.kind === 'cancelled' || ticket?.cancelled) throw this.refusal(ERRORS.cancelled);
      if (err.kind === 'token') {
        if (generation === this.generation) this.onKeyRefused(address, key);
        throw this.refusal(ERRORS.keyRefused);
      }
      this.onFailure(address, err);
      if (err.kind === 'busy') throw this.refusal(ERRORS.blocked);
      throw this.refusal(
        err.kind === 'timeout' && left() <= 0 ? ERRORS.tooSlow : ERRORS.unknownState,
      );
    }
    const identity = identityOf(data);
    if (!identity.id) {
      throw this.refusal(ERRORS.unknownState);
    }
    if (identity.id !== record.id) {
      if (generation === this.generation && record.address === address) {
        this.logger.warn(`${address} no longer answers as ${record.id}`);
        this.moved.set(address, [record.id, identity.id]);
        record.address = '';
        this.setReachable(record, false);
        this.persist();
      }
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!firmwareSupported(identity.firmware)) {
      throw this.refusal(ERRORS.oldFirmware);
    }
    if (generation === this.generation) {
      this.onSuccess(address);
      this.onKeyAccepted(address, key);
    }
    return { reading: readingOf(data), origin };
  }

  async runCommand(record, action, received, ticket) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => {
      if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
      if (ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
      this.checkOption(action);
      if (!record.address || this.data.devices[record.id] !== record) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      // A pause asked by the controller (429, 5xx) and a refused key hold an
      // opening; a close is protective: one try, never held.
      if (!action.protective && this.blockOf(record.address)) throw this.refusal(ERRORS.blocked);
      if (!action.protective && this.authBlockOf(record.address)) {
        throw this.refusal(ERRORS.keyRefused);
      }
      if (this.now() > sendBy) throw this.refusal(ERRORS.tooSlow);
    };
    check();
    const address = record.address;
    // Taken now: a key changed later starts a new generation, refused in beforeSend.
    const key = this.config.key;
    const { reading, origin } = await this.commandRead(record, address, key, {
      ticket,
      generation: ticket.generation,
      left: () => sendBy - this.now() - 200,
    });
    if (ticket.generation === this.generation) {
      // Shown in the background: the ack never waits for Gladys.
      this.recordValues(record, reading);
    }
    // Cancelled or no longer allowed while it read: said so before any other reason.
    check();
    // One command at a time per door: a second pulse would stop or reverse
    // it, and the state just read does not show a command still in flight.
    // An opening this close cancelled before it left never sends (its
    // beforeSend refuses a cancelled ticket): it does not hold the close.
    const flying = this.flights.get(action.door);
    if (flying && flying !== ticket && !(flying.cancelled && !flying.sent)) {
      throw this.refusal(ERRORS.justCommanded);
    }
    let plan;
    try {
      plan = action.plan(reading, origin);
    } catch (err) {
      // Refused on what was read: the same press within 5 s gets this answer
      // again without a new read.
      if (err.refusal) this.rememberRecent(action, err.message);
      throw err;
    }
    if (plan.unchanged) {
      // Already there: nothing sent.
      this.rememberRecent(action, undefined);
      return;
    }
    this.flights.set(action.door, ticket);
    check();
    this.logger.info(`Tailwind ${record.id}: ${action.name}`);
    let guard;
    try {
      await this.client.door(address, key, action.index, plan.command, {
        timeout: Math.max(100, answerBy - this.now()),
        signal: ticket.abort?.signal,
        sendWithin: sendBy - this.now(),
        // The very last check, right before the request leaves; the guard
        // is set (and saved) before the first byte.
        beforeSend: () => {
          check();
          ticket.sent = true;
          guard = this.guardDoor(action.door, plan);
        },
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      if (!err.sent) {
        this.unguardDoor(action.door, guard);
        this.logger.warn(`Tailwind ${record.id}: ${action.name} NOT sent (${reason})`);
        if (err.kind === 'cancelled' || ticket.cancelled) throw this.refusal(ERRORS.cancelled);
        throw this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === 'token') {
        this.unguardDoor(action.door, guard);
        if (ticket.generation === this.generation) this.onKeyRefused(address, key);
        throw this.refusal(ERRORS.keyRefusedNow);
      }
      if (err.kind === 'fail') {
        this.unguardDoor(action.door, guard);
        this.logger.warn(`Tailwind ${record.id}: ${action.name} refused (Fail)`);
        this.followUp(record);
        throw this.refusal(ERRORS.refused);
      }
      this.onFailure(address, err);
      this.followUp(record);
      if (err.kind === 'http' && err.status >= 400 && err.status <= 499) {
        this.unguardDoor(action.door, guard);
        this.logger.warn(`Tailwind ${record.id}: ${action.name} refused (${reason})`);
        throw this.refusal(ERRORS.refusedHttp(reason));
      }
      // A silence, a dropped connection, a 5xx, an odd answer: the command
      // may have reached the controller, the guard stays.
      this.logger.warn(`Tailwind ${record.id}: ${action.name} sent, NOT confirmed (${reason})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.followUp(record);
  }

  /**
   * The status LED: the identity read first, the brightness, then a read
   * back; success only when the LED is read at the value asked. One LED
   * command at a time per controller, never in the door queue.
   */
  async setLed(record, value, received) {
    const number = strictNumber(value);
    const brightness = number === undefined ? undefined : Math.round(number);
    if (brightness === undefined || brightness < LED.min || brightness > LED.max) {
      throw this.refusal(ERRORS.badValue);
    }
    if (!record.layout?.led) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (this.ledBusy.has(record.id)) {
      throw this.refusal(ERRORS.ledBusy);
    }
    // A slider dragged or a scene in a loop: at most one LED command (three
    // requests) every 2 s per controller.
    const last = this.lastLed.get(record.id);
    if (last !== undefined && this.mono() - last < TIMINGS.ledSpacing) {
      throw this.refusal(ERRORS.ledTooSoon);
    }
    this.lastLed.set(record.id, this.mono());
    this.ledBusy.add(record.id);
    try {
      return await this.runLed(record, brightness, received);
    } finally {
      this.ledBusy.delete(record.id);
    }
  }

  async runLed(record, brightness, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation) throw this.refusal(ERRORS.configChanged);
      if (!this.config.key) throw this.refusal(ERRORS.noKey);
      if (!record.address || this.data.devices[record.id] !== record) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (this.blockOf(record.address)) throw this.refusal(ERRORS.blocked);
      if (this.authBlockOf(record.address)) throw this.refusal(ERRORS.keyRefused);
      if (this.now() > sendBy) throw this.refusal(ERRORS.tooSlow);
    };
    check();
    const address = record.address;
    const key = this.config.key;
    const { reading } = await this.commandRead(record, address, key, {
      generation,
      left: () => sendBy - this.now() - 200,
    });
    check();
    if (reading.led === brightness) {
      return;
    }
    try {
      await this.client.led(address, key, brightness, {
        timeout: Math.max(100, answerBy - this.now()),
        sendWithin: sendBy - this.now(),
        beforeSend: check,
      });
    } catch (err) {
      if (err.beforeSend) throw err;
      const reason = reasonOf(err);
      if (!err.sent) {
        throw this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.kind === 'token') {
        if (generation === this.generation) this.onKeyRefused(address, key);
        throw this.refusal(ERRORS.keyRefused);
      }
      if (err.kind === 'fail') throw this.refusal(ERRORS.refusedHttp('Fail'));
      this.onFailure(address, err);
      if (err.kind === 'http' && err.status >= 400 && err.status <= 499) {
        throw this.refusal(ERRORS.refusedHttp(reason));
      }
      this.followUp(record);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    // Confirmed only by the value read back, within the time of the ack.
    let back;
    try {
      const left = answerBy - this.now() - 100;
      if (left > 0) {
        back = readingOf(await this.client.status(address, key, { timeout: left }));
      }
    } catch {
      back = undefined;
    }
    if (back && generation === this.generation) {
      this.recordValues(record, back);
    }
    if (back?.led !== brightness) {
      this.followUp(record);
      throw this.refusal(ERRORS.ledUnconfirmed);
    }
  }

  /**
   * Reads after a command, spaced: a garage door moves for a while. One
   * series per controller: a new command replaces the reads of the previous
   * one, and a read shares the one of the polling if it runs. Never during a
   * pause, after a refused key, nor sooner than a backoff.
   */
  followUp(record) {
    for (const handle of this.followUps.get(record.id) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = TIMINGS.followUps.map((delay) =>
      this.timers.setTimeout(() => {
        const address = record.address;
        const status = this.addresses.get(address);
        if (
          this.data.devices[record.id] !== record ||
          !address ||
          !this.config.addresses.includes(address) ||
          this.blockOf(address) ||
          this.authBlockOf(address) ||
          (status?.failures > 0 && this.now() < status.next)
        ) {
          return;
        }
        this.read(address)
          .then((changed) => (changed ? this.publishDevices() : undefined))
          .then(() => this.updateStatus())
          .catch(() => this.logger.warn('Read after a command failed'));
      }, delay),
    );
    this.followUps.set(record.id, handles);
  }
}
