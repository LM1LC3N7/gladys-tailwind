// -----------------------------------------------------------------------------
// Fake Tailwind controllers behind the `request` of TailwindClient
// (src/tailwind/http.js replaced): status answers shaped like gotailwind's
// fixtures, door_op moving the door, status_led, the TOKEN header checked, a
// log of every call, and hooks to make a request slow, fail or answer late.
// No network.
// -----------------------------------------------------------------------------

import { TailwindError } from '../../src/tailwind/errors.js';

export const KEY = '123456';
export const MACS = {
  a: '3ce90e6d2184',
  b: '3ce90e6d2185',
};
/** "3ce90e6d2184" -> "_3c_e9_e_6d_21_84_", as the firmware writes it. */
export const devId = (mac) =>
  `_${mac
    .match(/../g)
    .map((part) => part.replace(/^0/, ''))
    .join('_')}_`;

/** The state of each fake controller, changed by its commands. */
export function controllers() {
  const make = (mac, doors) => ({
    status: {
      result: 'OK',
      product: 'iQ3',
      dev_id: devId(mac),
      proto_ver: '0.1',
      door_num: doors,
      night_mode_en: 0,
      fw_ver: '10.10',
      led_brightness: 100,
      data: Object.fromEntries(
        Array.from({ length: doors }, (_, i) => [
          `door${i + 1}`,
          { index: i, status: 'close', lockup: 0, disabled: 0 },
        ]),
      ),
    },
    key: KEY,
  });
  return {
    '192.168.1.60': make(MACS.a, 2),
    '192.168.1.61': make(MACS.b, 1),
  };
}

/** The kind of a request from its body: status, door or led. */
export function kindOf(body) {
  const name = JSON.parse(body).data.name;
  return { dev_st: 'status', door_op: 'door', status_led: 'led' }[name] ?? name;
}

/** Waits for `promise` like a connection: late after `sendWithin`, cancelled on abort. */
function waitConnection(promise, { sendWithin, signal }) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => done(new TailwindError('cancelled'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    if (sendWithin !== undefined) {
      timer = setTimeout(() => done(new TailwindError('late')), Math.max(0, sendWithin));
    }
    promise.then(() => done());
  });
}

/**
 * The `request` of TailwindClient over the fake controllers.
 * - `hold(address, kind)`: the next request of that kind waits for `release()`;
 * - `freeze(address)`: the next status answers, on release, the state it had
 *   when it left (a late answer);
 * - `fail(address, kind, error | { status, headers, body })`: the next one
 *   fails; `{ before: true }`: before the connection (nothing sent).
 * A door command moves the door at once unless `moves` is false.
 */
export function fakeNetwork(table = controllers()) {
  const calls = [];
  const holds = [];
  const failures = [];
  const matches = (entry, address, kind) =>
    entry.address === address && entry.kind === kind && !entry.used;
  const json = (value) => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify(value)),
  });
  const request = async (options) => {
    const { host, port, body, headers, beforeSend, signal, abortAnyTime } = options;
    const address = port === 80 ? host : `${host}:${port}`;
    const kind = kindOf(body);
    const hold = holds.find((h) => matches(h, address, kind));
    if (hold) {
      hold.used = true;
      if (hold.snapshot) {
        // A late answer: the state when the request LEFT, delivered on release.
        const snapshot = structuredClone(table[address].status);
        calls.push({ address, kind, body, headers });
        await waitConnection(hold.promise, { signal: abortAnyTime ? signal : undefined });
        return json(headers.TOKEN === table[address].key ? snapshot : { result: 'token fail' });
      }
      // A connection that does not come up: as http.js, 'late' after
      // `sendWithin` (real time) and 'cancelled' on the signal, nothing sent.
      await waitConnection(hold.promise, options);
    }
    const device = table[address];
    if (!device) {
      throw new TailwindError('unreachable');
    }
    const early = failures.find((f) => matches(f, address, kind) && f.before);
    if (early) {
      early.used = true;
      throw early.error;
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        err.sent = false;
        throw err;
      }
    }
    calls.push({ address, kind, body, headers });
    const failure = failures.find((f) => matches(f, address, kind) && !f.before);
    if (failure) {
      failure.used = true;
      if (failure.error) {
        throw failure.error;
      }
      return {
        status: failure.status ?? 200,
        headers: failure.headers ?? {},
        body: Buffer.from(failure.body ?? ''),
      };
    }
    if (headers.TOKEN !== device.key) {
      return json({ result: 'token fail' });
    }
    const data = JSON.parse(body).data;
    if (kind === 'status') {
      return json(device.status);
    }
    if (kind === 'door') {
      const door = Object.values(device.status.data).find((d) => d.index === data.value.door_idx);
      if (!door || door.disabled || door.lockup) {
        return json({ result: 'Fail', Info: 'door' });
      }
      if (device.moves !== false) {
        door.status = data.value.cmd === 'open' ? 'open' : 'close';
      }
      return json({ result: 'OK' });
    }
    if (kind === 'led') {
      if (device.ledSticks !== true) {
        device.status.led_brightness = data.value.brightness;
      }
      return json({ result: 'OK' });
    }
    return json({ result: 'Fail' });
  };
  return {
    request,
    calls,
    table,
    /** The door of a controller by its index. */
    door(address, index) {
      return Object.values(table[address].status.data).find((d) => d.index === index);
    },
    hold(address, kind) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      holds.push({ address, kind, promise });
      return release;
    },
    /** The next status answers the state of its departure, on release. */
    freeze(address) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      holds.push({ address, kind: 'status', promise, snapshot: true });
      return release;
    },
    fail(address, kind, failure, { before = false } = {}) {
      failures.push({
        address,
        kind,
        before,
        ...(failure instanceof Error ? { error: failure } : failure),
      });
    },
    commands: () => calls.filter((c) => c.kind === 'door'),
    leds: () => calls.filter((c) => c.kind === 'led'),
    reads: () => calls.filter((c) => c.kind === 'status'),
  };
}
