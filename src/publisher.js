// -----------------------------------------------------------------------------
// The states sent to Gladys, within its 300 states per minute.
//
// The publisher keeps the LAST value of each feature, sends the pending ones
// every second within a per-minute budget, skips the unchanged ones
// (publishChangedStates) and spaces the measurements of a same feature
// (none today). The doors are never delayed, only budgeted. Taken from
// LM1LC3N7/gladys-ikea (same author, Apache-2.0), through gladys-mystrom,
// gladys-blebox and gladys-opengarage.
// -----------------------------------------------------------------------------

import { LIMITS, TIMINGS } from './constants.js';

export class StatePublisher {
  constructor({
    gladys,
    logger,
    now = Date.now,
    timers = globalThis,
    budget = LIMITS.statesPerMinute,
    interval = TIMINGS.measureInterval,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.budget = budget;
    this.interval = interval;
    /** featureId -> { state } */
    this.pending = new Map();
    /** featureId -> last send time */
    this.lastSent = new Map();
    /** send times of the last minute */
    this.window = [];
    this.throttled = new Set();
    this.events = new Set();
    this.timer = undefined;
    this.flushing = undefined;
  }

  configure({ throttled, events }) {
    this.throttled = throttled ?? new Set();
    this.events = events ?? new Set();
  }

  start() {
    this.stop();
    this.timer = this.timers.setInterval(() => {
      this.flush().catch((err) => this.logger.warn(`Sending the states failed: ${err.message}`));
    }, TIMINGS.flushInterval);
  }

  stop() {
    if (this.timer) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  push(featureId, value) {
    this.pending.set(featureId, value);
  }

  /** Forgets a device (deleted): its pending values are dropped. */
  forget(deviceId) {
    for (const map of [this.pending, this.lastSent]) {
      for (const key of map.keys()) {
        if (key.startsWith(`${deviceId}:`)) {
          map.delete(key);
        }
      }
    }
  }

  flush() {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  async doFlush() {
    const now = this.now();
    this.window = this.window.filter((t) => now - t < 60_000);
    let room = this.budget - this.window.length;
    if (room <= 0 || this.pending.size === 0) {
      return 0;
    }
    const batch = [];
    // The doors first: when the budget runs out, the
    // measurements wait for the next round, never the other way round.
    const ordered = [...this.pending].sort(
      ([a], [b]) => Number(this.throttled.has(a)) - Number(this.throttled.has(b)),
    );
    for (const [featureId, value] of ordered) {
      if (room <= 0) {
        break;
      }
      const last = this.lastSent.get(featureId);
      if (this.throttled.has(featureId) && last !== undefined && now - last < this.interval) {
        continue;
      }
      this.pending.delete(featureId);
      if (this.events.has(featureId)) {
        // A second identical press is a press too: never deduplicated.
        this.gladys.forgetPublishedStates(featureId);
      }
      batch.push({ device_feature_external_id: featureId, ...value });
      room -= 1;
    }
    if (batch.length === 0) {
      return 0;
    }
    try {
      const result = await this.gladys.publishChangedStates(batch, {
        heartbeat: TIMINGS.stateHeartbeat,
      });
      for (const entry of batch) {
        this.lastSent.set(entry.device_feature_external_id, now);
      }
      const count = result?.count ?? batch.length;
      for (let i = 0; i < count; i += 1) {
        this.window.push(now);
      }
      return count;
    } catch (err) {
      // Keep the values for the next round, unless a newer one arrived meanwhile.
      for (const { device_feature_external_id: id, ...value } of batch) {
        if (!this.pending.has(id)) {
          this.pending.set(id, value);
        }
      }
      throw err;
    }
  }
}
