// -----------------------------------------------------------------------------
// TailwindApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), fake controllers behind the client's `request`, a memory
// store and a hand-driven clock. No network, no timers running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TailwindApp } from '../src/app.js';
import { TailwindClient } from '../src/tailwind/client.js';
import { TailwindError } from '../src/tailwind/errors.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { KEY, MACS, fakeNetwork } from './helpers/fakeTailwind.js';

const SELECTOR = 'tailwind';
const A = '192.168.1.60';
const B = '192.168.1.61';
const id = (mac, key) => `ext:${SELECTOR}:tailwind:${mac}${key ? `:${key}` : ''}`;
const guardOf = (app, mac, index = 0) => app.data.guards[`${mac}-${index}`];

/** Timers that never fire: the tests drive the polling and the flushes. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
};
const realTimers = {
  ...timers,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * The wall clock and a monotonic clock: `advance` moves both (time passing),
 * `jump` only the wall clock (NTP, a change by hand).
 */
function clock(start = 1_800_000_000_000) {
  let current = start;
  let elapsed = 0;
  const now = () => current;
  now.mono = () => elapsed;
  now.advance = (ms) => {
    current += ms;
    elapsed += ms;
  };
  now.jump = (ms) => {
    current += ms;
  };
  return now;
}

async function setup(
  t,
  {
    config = {},
    net = fakeNetwork(),
    store = new MemoryStore(),
    devices = [],
    now = clock(),
    appTimers = timers,
  } = {},
) {
  const fullConfig = { addresses: `${A}, ${B}`, local_key: KEY, ...config };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new TailwindApp({
    gladys,
    logger,
    client: new TailwindClient({ request: net.request, now }),
    store,
    timers: appTimers,
    now,
    mono: now.mono,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { gladys, app, net, logs, store, now, config: fullConfig };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, mac) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(mac));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

async function press(gladys, mac, key, value = 1) {
  const device = deviceOf(gladys, mac);
  return gladys.fake.setValue(device, featureOf(device, key), value);
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('the typed addresses become the devices of the Discovery tab, by MAC', async (t) => {
  const { gladys } = await setup(t);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(devices.map((d) => d.name).sort(), [
    'Tailwind iQ3 6d2184',
    'Tailwind iQ3 6d2185',
  ]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /2 of 2 Tailwind controller/);
  assert.match(gladys.fake.connectionStatus.message.fr, /2 contrôleur\(s\) Tailwind sur 2/);
  const a = deviceOf(gladys, MACS.a);
  assert.deepEqual(
    a.features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.min, f.max]),
    [
      ['door1', 'opening-sensor', 'binary', 0, 1],
      ['door1_open', 'button', 'push', 0, 1],
      ['door1_close', 'button', 'push', 0, 1],
      ['door2', 'opening-sensor', 'binary', 0, 1],
      ['door2_open', 'button', 'push', 0, 1],
      ['door2_close', 'button', 'push', 0, 1],
      ['led', 'light', 'brightness', 0, 100],
    ],
  );
  assert.equal(a.features.find((f) => f.name === 'Porte de garage 1')?.read_only, true);
  assert.deepEqual(
    a.params.map((p) => [p.name, p.value]),
    [
      ['IP_ADDRESS', A],
      ['MAC', MACS.a],
      ['MODEL', 'iQ3'],
      ['FIRMWARE', '10.10'],
    ],
  );
  assert.equal(deviceOf(gladys, MACS.b).features.length, 4);
});

test('a garage door is never a switch nor a commandable binary', async (t) => {
  const { gladys } = await setup(t);
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.notEqual(feature.category, 'switch', feature.external_id);
      assert.ok(feature.type !== 'binary' || feature.read_only, feature.external_id);
      assert.ok(
        feature.read_only || feature.type === 'push' || feature.external_id.endsWith(':led'),
        feature.external_id,
      );
    }
  }
});

test('states: only for the created devices, the last values when created', async (t) => {
  const { gladys, app, net } = await setup(t);
  await app.publisher.flush();
  assert.equal(gladys.fake.states.length, 0);
  net.door(A, 1).status = 'open';
  await createAll(gladys);
  await app.publisher.flush();
  const last = (mac, key) => gladys.fake.lastState(id(mac, key));
  assert.equal(last(MACS.a, 'door1'), 1, 'closed');
  assert.equal(last(MACS.a, 'led'), 100);
  assert.equal(last(MACS.b, 'door1'), 1);
  const now = app.now;
  now.advance(11_000);
  await app.tick();
  await app.publisher.flush();
  assert.equal(last(MACS.a, 'door2'), 0, 'open');
});

test('open AND close are refused by default, nothing read nor sent', async (t) => {
  const { gladys, net } = await setup(t);
  assert.match(gladys.fake.connectionStatus.message.fr, /Commandes des portes désactivées/);
  net.door(A, 0).status = 'open';
  const before = net.calls.length;
  const open = await press(gladys, MACS.a, 'door1_open');
  assert.equal(open.success, false);
  assert.match(open.error, /désactivée dans la configuration/);
  const close = await press(gladys, MACS.a, 'door1_close');
  assert.equal(close.success, false);
  assert.match(close.error, /Fermer envoie une impulsion/);
  assert.equal(net.calls.length, before);
});

test('the option turned off during the read, or right before sending: nothing leaves', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_open: true } });
  net.door(A, 0).status = 'open';
  const release = net.hold(A, 'status');
  const pending = press(gladys, MACS.a, 'door1_close');
  await tick();
  app.config.allowOpen = false;
  release();
  const during = await pending;
  assert.match(during.error, /Fermer envoie une impulsion/);
  app.config.allowOpen = true;
  // Off between the connection and the first byte (beforeSend).
  const request = app.client.request;
  app.client.request = (options) => {
    if (options.body.includes('door_op')) app.config.allowOpen = false;
    return request(options);
  };
  const late = await press(gladys, MACS.a, 'door1_close');
  assert.match(late.error, /Fermer envoie une impulsion/);
  assert.equal(net.commands().length, 0);
  assert.equal(guardOf(app, MACS.a), undefined);
});

test('open: decided on a status read just now, one command, the door guarded', async (t) => {
  const { gladys, net, now, app } = await setup(t, { config: { allow_open: true } });
  net.table[A].moves = false;
  const before = net.calls.length;
  const ack = await press(gladys, MACS.a, 'door1_open');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    net.calls.slice(before).map((c) => c.kind),
    ['status', 'door'],
  );
  assert.deepEqual(JSON.parse(net.commands()[0].body), {
    version: '0.1',
    data: { type: 'set', name: 'door_op', value: { door_idx: 0, cmd: 'open' } },
  });
  assert.equal(net.commands()[0].headers.TOKEN, KEY);
  // The door is still read closed (it has not moved yet): another command
  // would stop it, whatever the button.
  for (const key of ['door1_open', 'door1_close']) {
    const again = await press(gladys, MACS.a, key);
    assert.equal(again.success, false, key);
    assert.match(again.error, /vient d'être commandée/);
  }
  // The other door is not held.
  const other = await press(gladys, MACS.a, 'door2_open');
  assert.equal(other.success, true, other.error);
  assert.ok(guardOf(app, MACS.a, 1));
  assert.equal(net.commands().length, 2);
  now.advance(46_000);
  const later = await press(gladys, MACS.a, 'door1_open');
  assert.equal(later.success, true, later.error);
  assert.equal(net.commands().length, 3);
});

test('I2: the guard is lifted by the state aimed at, 30 s after an opening, 15 s after a closing', async (t) => {
  const { gladys, net, app, now } = await setup(t, { config: { allow_open: true } });
  net.table[A].moves = false;
  assert.equal((await press(gladys, MACS.a, 'door1_open')).success, true);
  // Young guard: refused at once, whatever is read (nothing read).
  const reads = net.reads().length;
  for (const status of ['x', undefined, 'close', 'open']) {
    net.door(A, 0).status = status;
    const ack = await press(gladys, MACS.a, 'door1_close');
    assert.equal(ack.success, false, `status ${status}`);
  }
  assert.equal(net.reads().length, reads);
  // Read "open" 16 s and 29 s after the opening: the door may still travel
  // (the sensor reads it open as soon as it leaves closed): kept.
  for (const step of [16_000, 13_000]) {
    now.advance(step);
    assert.match((await press(gladys, MACS.a, 'door1_close')).error, /vient d'être commandée/);
  }
  // 30 s: an unknown state does not lift it.
  now.advance(1000);
  net.door(A, 0).status = 'x';
  assert.equal((await press(gladys, MACS.a, 'door1_close')).success, false);
  assert.ok(guardOf(app, MACS.a));
  now.advance(5000);
  net.door(A, 0).status = 'open';
  const ack = await press(gladys, MACS.a, 'door1_close');
  assert.equal(ack.success, true, ack.error);
  assert.equal(net.commands().length, 2);
  assert.equal(guardOf(app, MACS.a).expect, 0);
  // After a closing, "close" is only read at the end of travel: 15 s.
  net.door(A, 0).status = 'close';
  now.advance(14_000);
  assert.equal((await press(gladys, MACS.a, 'door1_open')).success, false);
  now.advance(1000);
  const open = await press(gladys, MACS.a, 'door1_open');
  assert.equal(open.success, true, open.error);
  assert.equal(net.commands().length, 3);
});

test('H3: a close 16 s after an opening, door read open, is never sent', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  assert.equal((await press(gladys, MACS.a, 'door1_open')).success, true);
  now.advance(16_000);
  assert.equal((await press(gladys, MACS.a, 'door1_close')).success, false);
  assert.equal(net.commands().length, 1);
});

test('an answer generated before the command never lifts its guard', async (t) => {
  for (const [start, key] of [
    ['open', 'door1_close'],
    ['close', 'door1_open'],
  ]) {
    const { gladys, net, app, now } = await setup(t, { config: { allow_open: true } });
    net.table[A].moves = false;
    net.door(A, 0).status = start === 'open' ? 'close' : 'open';
    now.advance(11_000);
    // A poll leaves while the door is still in the state the command will aim at.
    const release = net.freeze(A);
    const polling = app.tick();
    await tick();
    // The remote moves it; the command leaves.
    net.door(A, 0).status = start;
    const first = await press(gladys, MACS.a, key);
    assert.equal(first.success, true, `${key}: ${first.error}`);
    // The late answer says the expected state, long after the command.
    now.advance(20_000);
    release();
    await polling;
    assert.ok(guardOf(app, MACS.a), `${key}: the guard is kept`);
    const second = await press(gladys, MACS.a, key);
    assert.equal(second.success, false, `${key}: no second command`);
    assert.equal(net.commands().length, 1);
  }
});

test('close: only to a door read open; already closed sends nothing', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  const closed = await press(gladys, MACS.a, 'door1_close');
  assert.equal(closed.success, true, closed.error);
  assert.equal(net.commands().length, 0);
  net.door(A, 0).status = 'open';
  // The same press within 5 s: answered without a read, nothing sent.
  const reads = net.reads().length;
  assert.match((await press(gladys, MACS.a, 'door1_close')).error, /il y a un instant/);
  assert.equal(net.reads().length, reads);
  now.advance(5000);
  const ack = await press(gladys, MACS.a, 'door1_close');
  assert.equal(ack.success, true, ack.error);
  assert.equal(net.commands().length, 1);
  assert.equal(net.door(A, 0).status, 'close');
});

test('an unknown, disabled or locked out door is never commanded', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  const cases = [
    [{ status: 'opening' }, /n'est pas lue/],
    [{ status: undefined }, /n'est pas lue/],
    [{ disabled: 1, status: 'open' }, /désactivée dans l'application/],
    [{ lockup: 1, status: 'open' }, /bloquée par le contrôleur/],
    [{ lockup: 'x', status: 'open' }, /pas pu être lu/],
  ];
  for (const [change, error] of cases) {
    // Past the 5 s in which the same press gets the same answer.
    now.advance(5000);
    Object.assign(net.door(A, 0), { status: 'close', lockup: 0, disabled: 0 }, change);
    for (const key of ['door1_open', 'door1_close']) {
      const ack = await press(gladys, MACS.a, key);
      if (change.status === 'open' && key === 'door1_open') {
        // Already open: nothing to send (and nothing sent) whatever the flags.
        continue;
      }
      assert.equal(ack.success, false, `${key} ${JSON.stringify(change)}`);
      assert.match(ack.error, error, `${key} ${JSON.stringify(change)}`);
    }
  }
  // A door that disappeared from the status.
  now.advance(5000);
  delete net.table[A].status.data.door1;
  assert.match((await press(gladys, MACS.a, 'door1_close')).error, /pas pu être lu/);
  assert.equal(net.commands().length, 0);
});

test('a button value other than 1 is refused; read-only features too', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_open: true } });
  for (const value of [0, '', null, true, 2]) {
    const ack = await press(gladys, MACS.a, 'door1_open', value);
    assert.equal(ack.success, false, String(value));
  }
  const device = deviceOf(gladys, MACS.a);
  const ack = await gladys.fake.setValue(device, featureOf(device, 'door1'), 1);
  assert.equal(ack.success, false);
  assert.equal(net.commands().length, 0);
});

test('without a local control key nothing is read and nothing sent', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { local_key: '', allow_open: true } });
  assert.match(gladys.fake.connectionStatus.message.fr, /Pas de clé de contrôle local/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(net.calls.length, 0);
  const check = await gladys.fake.action('check_controllers');
  assert.match(JSON.stringify(check), /clé de contrôle local|control key/);
  app.now.advance(60_000);
  await app.tick();
  assert.equal(net.calls.length, 0);
});

test('a refused key: final for that address, persisted, never replayed; Check reads once', async (t) => {
  const net = fakeNetwork();
  net.table[A].key = 'other';
  const { gladys, app, store, now } = await setup(t, {
    net,
    config: { addresses: A, allow_open: true },
  });
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /Clé de contrôle local refusée par 192\.168\.1\.60/,
  );
  const readsOf = () => net.reads().filter((c) => c.address === A).length;
  assert.equal(readsOf(), 1);
  // Never read again on its own, whatever the time.
  for (let i = 0; i < 5; i += 1) {
    now.advance(10 * 60_000);
    await app.tick();
  }
  assert.equal(readsOf(), 1);
  await app.stop();
  const saved = JSON.stringify(store.data);
  assert.ok(!saved.includes(KEY));
  // I3: 8 bits only, the key can never be found back from /data.
  assert.match(saved, /"authBlocks":\{"192\.168\.1\.60":\{"fingerprint":"[0-9a-f]{2}"/);
  const { salt } = store.data;
  const fingerprint = store.data.authBlocks[A].fingerprint;
  let candidates = 0;
  for (let i = 0; i < 1_000_000; i += 1) {
    const guess = String(i).padStart(6, '0');
    if (createHmac('sha256', salt).update(guess).digest('hex').startsWith(fingerprint)) {
      candidates += 1;
    }
  }
  assert.ok(candidates > 1000, `${candidates} keys match the fingerprint`);
  // "Check the controllers": one read, still refused.
  await gladys.fake.action('check_controllers');
  assert.equal(readsOf(), 2);
  await gladys.fake.action('check_controllers');
  assert.equal(readsOf(), 2, 'never sooner than the interval');
  // Fixed on the controller: the next Check reads it and lifts the refusal.
  net.table[A].key = KEY;
  now.advance(60_000);
  await app.tick();
  assert.equal(readsOf(), 2, 'still not read on its own');
  await gladys.fake.action('check_controllers');
  assert.equal(readsOf(), 3);
  assert.deepEqual(app.data.authBlocks, {});
  assert.doesNotMatch(gladys.fake.connectionStatus.message.fr, /refusée/);
});

test('a new key is read at the next due time; no fingerprint of a working key in /data', async (t) => {
  const net = fakeNetwork();
  const { gladys, app, store, now, config } = await setup(t, {
    net,
    config: { local_key: '654321' },
  });
  assert.equal(Object.keys(app.data.authBlocks).length, 2);
  // Saving the right key: tried once the interval has passed.
  await gladys.fake.configUpdated({ ...config, local_key: KEY });
  const reads = net.reads().length;
  now.advance(10_000);
  await app.tick();
  assert.equal(net.reads().length, reads + 2);
  assert.deepEqual(app.data.authBlocks, {});
  // A refuses this key now, B still takes it: A's refusal stays in memory only.
  net.table[A].key = 'changed';
  now.advance(10_000);
  await app.tick();
  await app.stop();
  assert.deepEqual(store.data.authBlocks, {}, 'a key known to work is never fingerprinted');
  assert.ok(app.authBlockOf(A));
});

test('a close cancels the openings of its door still waiting to leave', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_open: true } });
  const release = net.hold(A, 'status');
  const first = press(gladys, MACS.a, 'door1_open');
  await tick();
  const second = press(gladys, MACS.a, 'door1_open');
  await tick();
  net.door(A, 0).status = 'open';
  const started = Date.now();
  const close = await press(gladys, MACS.a, 'door1_close');
  assert.ok(Date.now() - started < 1000, 'the read of the opening is dropped at once');
  const [a, b] = await Promise.all([first, second]);
  release();
  assert.match(a.error, /Annulée/);
  assert.match(b.error, /Annulée/);
  assert.equal(close.success, true, close.error);
  assert.deepEqual(
    net.commands().map((c) => JSON.parse(c.body).data.value.cmd),
    ['close'],
  );
});

test('a close cancels an opening of its door whose connection is not up yet', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_open: true } });
  const release = net.hold(A, 'door');
  const open = press(gladys, MACS.a, 'door1_open');
  await tick(20);
  net.door(A, 0).status = 'open';
  const close = await press(gladys, MACS.a, 'door1_close');
  release();
  assert.match((await open).error, /Annulée/);
  assert.equal(close.success, true, close.error);
  assert.deepEqual(
    net.commands().map((c) => JSON.parse(c.body).data.value.cmd),
    ['close'],
  );
});

test('a 429/5xx pause holds an opening, never a close (one try)', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_open: true } });
  net.fail(A, 'status', { status: 503 });
  const open = await press(gladys, MACS.a, 'door1_open');
  assert.equal(open.success, false);
  assert.match(open.error, /demandé d'attendre/);
  assert.ok(app.blockOf(A));
  assert.match(gladys.fake.connectionStatus.message.fr, /Demande d'attendre/);
  const again = await press(gladys, MACS.a, 'door1_open');
  assert.match(again.error, /demandé d'attendre/);
  net.door(A, 0).status = 'open';
  const reads = net.reads().length;
  const close = await press(gladys, MACS.a, 'door1_close');
  assert.equal(close.success, true, close.error);
  assert.equal(net.reads().length, reads + 1);
  assert.equal(net.commands().length, 1);
});

test('a refused key never holds a close (one try)', async (t) => {
  const { gladys, app, net, now } = await setup(t, { config: { allow_open: true } });
  net.table[A].key = 'other';
  now.advance(11_000);
  await app.tick();
  assert.ok(app.authBlockOf(A));
  const calls = net.calls.length;
  const open = await press(gladys, MACS.a, 'door1_open');
  assert.match(open.error, /refusé la clé/);
  assert.equal(net.calls.length, calls, 'an opening is refused without a request');
  net.door(A, 0).status = 'open';
  const close = await press(gladys, MACS.a, 'door1_close');
  assert.match(close.error, /refusé la clé/);
  assert.equal(net.calls.length, calls + 1, 'one try');
  // Fixed on the controller meanwhile: the close goes and lifts the refusal.
  net.table[A].key = KEY;
  const again = await press(gladys, MACS.a, 'door1_close');
  assert.equal(again.success, true, again.error);
  assert.equal(net.commands().length, 1);
  assert.equal(app.authBlockOf(A), undefined);
});

test('the key is never in a log, a status, an error nor /data', async (t) => {
  const { gladys, net, app, logs, store } = await setup(t, { config: { allow_open: true } });
  net.fail(A, 'door', new TailwindError('timeout', { sent: true }));
  const errors = [];
  errors.push((await press(gladys, MACS.a, 'door1_open')).error);
  net.fail(B, 'door', new TailwindError('unreachable'), { before: true });
  errors.push((await press(gladys, MACS.b, 'door1_open')).error);
  net.table[A].key = 'other';
  net.door(A, 1).status = 'open';
  errors.push((await press(gladys, MACS.a, 'door2_close')).error);
  await app.stop();
  const all = JSON.stringify([logs, errors, store.data, gladys.fake.connectionStatus]);
  assert.ok(!all.includes(KEY), 'key');
  assert.match(errors[0], /envoyée, sans confirmation/);
  assert.match(errors[1], /non envoyée/);
  assert.match(errors[2], /refusé la clé/);
});

test('a command that may have left is guarded; one that never left is not', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_open: true } });
  net.fail(A, 'door', new TailwindError('unreachable'), { before: true });
  assert.equal((await press(gladys, MACS.a, 'door1_open')).success, false);
  assert.equal(guardOf(app, MACS.a), undefined);
  net.fail(A, 'door', { status: 200, body: 'not json' });
  const ack = await press(gladys, MACS.a, 'door1_open');
  assert.match(ack.error, /sans confirmation/);
  assert.deepEqual(
    { from: guardOf(app, MACS.a).from, expect: guardOf(app, MACS.a).expect },
    { from: 0, expect: 1 },
  );
  // "Fail": the controller did nothing, no guard.
  net.fail(A, 'door', { status: 200, body: '{"result":"Fail","Info":"x"}' });
  const fail = await press(gladys, MACS.a, 'door2_open');
  assert.match(fail.error, /refusé la commande/);
  assert.equal(guardOf(app, MACS.a, 1), undefined);
});

test('a command that cannot leave within 3.5 s is refused unsent', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  const release = net.hold(A, 'status');
  const pending = press(gladys, MACS.a, 'door1_open');
  await tick();
  now.advance(4000);
  release();
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /rien n'a été envoyé/);
  assert.equal(net.commands().length, 0);
});

test('the controller is identified before every command (DHCP swap)', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_open: true } });
  // Unreadable: refused, never "another controller".
  net.table[A].status.dev_id = 'garbage';
  const unreadable = await press(gladys, MACS.a, 'door1_open');
  assert.match(unreadable.error, /pas pu être lu/);
  assert.equal(app.data.devices[MACS.a].address, A);
  // Another controller at the address: refused, the record loses it.
  net.table[A].status.dev_id = '_3c_e9_e_0_0_99_';
  const other = await press(gladys, MACS.a, 'door1_open');
  assert.match(other.error, /plus à son adresse/);
  assert.equal(app.data.devices[MACS.a].address, '');
  assert.equal(net.commands().length, 0);
});

test('a controller that moved to another typed address keeps its device', async (t) => {
  const net = fakeNetwork();
  const { gladys, app, now } = await setup(t, { net });
  [net.table[A], net.table[B]] = [net.table[B], net.table[A]];
  for (let i = 0; i < 2; i += 1) {
    now.advance(11_000);
    await app.tick();
  }
  assert.equal(app.data.devices[MACS.a].address, B);
  assert.equal(app.data.devices[MACS.b].address, A);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

test('never read sooner than the interval: reconnection, same config, scan, check', async (t) => {
  const { gladys, app, net, now, config } = await setup(t);
  const reads = () => net.reads().length;
  const before = reads();
  assert.equal(before, 2);
  await app.start(await gladys.getConfig());
  await gladys.fake.configUpdated(config);
  await gladys.fake.scanRequest();
  const check = await gladys.fake.action('check_controllers');
  assert.equal(check.success, true, check.error);
  assert.equal(reads(), before);
  now.advance(9000);
  await app.tick();
  assert.equal(reads(), before);
  now.advance(1000);
  await app.tick();
  assert.equal(reads(), before + 2);
});

test('the status and the Discovery tab are published again at every connection', async (t) => {
  const { gladys, app } = await setup(t);
  const status = gladys.fake.connectionStatus;
  gladys.fake.discoveredDevices.length = 0;
  await app.start(await gladys.getConfig());
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.deepEqual(gladys.fake.connectionStatus, status);
});

test('a restart soon after a read waits a whole interval', async (t) => {
  const now = clock();
  const data = emptyData();
  data.lastTry = now() - 2000;
  const net = fakeNetwork();
  const { app, gladys } = await setup(t, { store: new MemoryStore(data, now), net, now });
  assert.equal(net.reads().length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Waiting for the first read/);
  now.advance(9000);
  await app.tick();
  assert.equal(net.reads().length, 0);
  now.advance(1000);
  await app.tick();
  assert.equal(net.reads().length, 2);
});

test('after a restart a door can be closed before the first read; the guard is kept', async (t) => {
  const now = clock();
  const store = new MemoryStore(emptyData(), now);
  const net = fakeNetwork();
  const first = await setup(t, { store, net, now, config: { allow_open: true } });
  net.table[A].moves = false;
  assert.equal((await press(first.gladys, MACS.a, 'door1_open')).success, true);
  await first.app.stop();
  now.advance(2000);
  const second = await setup(t, {
    store,
    net,
    now,
    config: { allow_open: true },
    devices: first.gladys.fake.discoveredDevices,
  });
  const reads = net.reads().length;
  const refused = await press(second.gladys, MACS.a, 'door1_open');
  assert.match(refused.error, /vient d'être commandée/);
  net.door(A, 0).status = 'open';
  // 30 s after the opening: its guard may be lifted by the door read open.
  now.advance(28_000);
  const close = await press(second.gladys, MACS.a, 'door1_close');
  assert.equal(close.success, true, close.error);
  assert.equal(net.reads().length, reads + 1, 'only the read of the close');
});

test('a restart while a command is out keeps its guard (set in beforeSend)', async (t) => {
  const now = clock();
  const store = new MemoryStore(emptyData(), now);
  const net = fakeNetwork();
  const first = await setup(t, { store, net, now, config: { allow_open: true } });
  net.table[A].moves = false;
  const request = first.app.client.request;
  let onDiskAtSend;
  first.app.client.request = (options) => {
    if (options.body.includes('door_op')) {
      options.beforeSend?.();
      // http.js writes the request synchronously right after beforeSend:
      // the guard must be in the store already, not in a save to come.
      onDiskAtSend = Boolean(store.data.guards[`${MACS.a}-0`]);
      return new Promise(() => {});
    }
    return request(options);
  };
  void press(first.gladys, MACS.a, 'door1_open');
  await tick();
  assert.equal(onDiskAtSend, true, 'H4: written before the first byte');
  now.advance(1500);
  const second = await setup(t, {
    store,
    net,
    now,
    config: { allow_open: true },
    devices: first.gladys.fake.discoveredDevices,
  });
  const again = await press(second.gladys, MACS.a, 'door1_open');
  assert.match(again.error, /vient d'être commandée/);
  assert.equal(net.commands().length, 0);
});

test('a restart soon after a successful read stays connected', async (t) => {
  const now = clock();
  const first = await setup(t, { now, config: { poll_interval: 300 } });
  await first.app.stop();
  const data = structuredClone(first.store.data);
  assert.equal(data.lastReads[A].ok, true);
  now.advance(2000);
  const second = await setup(t, {
    now,
    store: new MemoryStore(data, now),
    config: { poll_interval: 300 },
    devices: first.gladys.fake.discoveredDevices,
  });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.match(second.gladys.fake.connectionStatus.message.en, /2 of 2 .* last read before/);
  assert.equal(second.net.reads().length, 0);
});

test('a late read of an older configuration publishes nothing', async (t) => {
  const { gladys, app, net, now, config } = await setup(t);
  await createAll(gladys);
  await app.publisher.flush();
  const states = gladys.fake.states.length;
  now.advance(11_000);
  const release = net.hold(A, 'status');
  const polling = app.tick();
  await tick();
  const updating = gladys.fake.configUpdated({ ...config, addresses: B });
  await tick();
  net.door(A, 0).status = 'open';
  release();
  await polling;
  await updating;
  await app.publisher.flush();
  const doorStates = gladys.fake.states
    .slice(states)
    .filter((s) => s.device_feature_external_id === id(MACS.a, 'door1'));
  assert.deepEqual(doorStates, []);
  assert.match(gladys.fake.connectionStatus.message.en, /1 of 1/);
});

test('failures: spaced reads, never faster than the interval', async (t) => {
  const { app, net, now } = await setup(t);
  now.advance(11_000);
  net.fail(A, 'status', new TailwindError('timeout', { sent: true }));
  await app.tick();
  const reads = net.reads().length;
  now.advance(11_000);
  await app.tick();
  assert.equal(net.reads().filter((c) => c.address === A).length, 2, 'A waits 30 s');
  now.advance(20_000);
  await app.tick();
  assert.ok(net.reads().length > reads);
});

test('a created device never loses a feature', async (t) => {
  const kept = {
    name: 'Porte de garage 3',
    external_id: id(MACS.a, 'door3'),
    category: 'opening-sensor',
    type: 'binary',
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
  const devices = [{ external_id: id(MACS.a), name: 'Garage', features: [kept] }];
  const { gladys } = await setup(t, { devices });
  const garage = deviceOf(gladys, MACS.a);
  assert.ok(featureOf(garage, 'door3'));
  assert.ok(featureOf(garage, 'door1'));
});

test('no device id, or a firmware older than 10.10: said in the status, never added', async (t) => {
  const net = fakeNetwork();
  delete net.table[B].status.dev_id;
  net.table[A].status.fw_ver = '9.97';
  const { gladys } = await setup(t, { net });
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /Not a Tailwind controller/);
  assert.match(gladys.fake.connectionStatus.message.en, /Firmware too old/);
});

test('LED: no permission needed, confirmed only by the value read back', async (t) => {
  const { gladys, net, now } = await setup(t);
  const ack = await press(gladys, MACS.a, 'led', 40);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    net.calls.slice(-3).map((c) => c.kind),
    ['status', 'led', 'status'],
  );
  assert.equal(JSON.parse(net.leds()[0].body).data.value.brightness, 40);
  // H9: a slider or a loop: at most one LED command every 2 s, nothing read.
  const calls = net.calls.length;
  assert.match((await press(gladys, MACS.a, 'led', 41)).error, /moins de 2 s/);
  assert.equal(net.calls.length, calls);
  now.advance(2000);
  // Already at that value: nothing sent.
  assert.equal((await press(gladys, MACS.a, 'led', 40)).success, true);
  assert.equal(net.leds().length, 1);
  // Not read back at the value: sent, without confirmation.
  now.advance(2000);
  net.table[A].ledSticks = true;
  const stuck = await press(gladys, MACS.a, 'led', 10);
  assert.match(stuck.error, /sans confirmation/);
  for (const value of [-1, 101, '', null, 'x']) {
    assert.equal((await press(gladys, MACS.a, 'led', value)).success, false, String(value));
  }
  assert.equal(net.leds().length, 2);
});

test('H9: a scene pressing a button every second reads at most once per 5 s', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  const before = net.reads().length;
  for (let i = 0; i < 60; i += 1) {
    now.advance(1000);
    await press(gladys, MACS.a, 'door1_close');
  }
  assert.ok(net.reads().length - before <= 12, `${net.reads().length - before} reads`);
  assert.equal(net.commands().length, 0);
});

test('H8: a key pasted in the addresses field never shows in the status', async (t) => {
  const { gladys } = await setup(t, { config: { addresses: `${A}:${KEY}0, ${KEY}, ${B}` } });
  const all = JSON.stringify(gladys.fake.connectionStatus);
  assert.ok(!all.includes(KEY), all);
  assert.match(gladys.fake.connectionStatus.message.fr, /2 entrée\(s\) du champ des adresses/);
});

test('a close behind a command that LEFT is refused at once, "just commanded"', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_open: true } });
  const request = app.client.request;
  app.client.request = (options) => {
    if (options.body.includes('door_op')) {
      options.beforeSend?.();
      return new Promise(() => {});
    }
    return request(options);
  };
  void press(gladys, MACS.a, 'door1_open');
  await tick();
  net.door(A, 0).status = 'open';
  const started = Date.now();
  const close = await press(gladys, MACS.a, 'door1_close');
  assert.ok(Date.now() - started < 3500, `${Date.now() - started} ms`);
  assert.equal(close.success, false);
  assert.match(close.error, /vient d'être commandée/);
});

test('openings: one queue per door, the wait ends by 3.3 s (real timer) with its reason', async (t) => {
  const { gladys, net } = await setup(t, {
    config: { allow_open: true },
    appTimers: realTimers,
  });
  // A second opening of the SAME door waits behind the first one's slow read.
  const release = net.hold(A, 'status');
  const first = press(gladys, MACS.a, 'door1_open');
  await tick();
  const started = Date.now();
  const second = await press(gladys, MACS.a, 'door1_open');
  const waited = Date.now() - started;
  assert.ok(waited >= 3000 && waited < 3500, `${waited} ms`);
  assert.match(second.error, /autre ouverture de cette porte est encore en cours/);
  release();
  await first;
  assert.equal(net.commands().length, 1, 'only the first one left');
});

test('B1/H1: an opening of door 2 or a close of door 2 never waits behind door 1', async (t) => {
  const { gladys, net } = await setup(t, {
    config: { allow_open: true },
    appTimers: realTimers,
  });
  const release = net.hold(A, 'status');
  const open1 = press(gladys, MACS.a, 'door1_open');
  await tick();
  const started = Date.now();
  const [open2, close2] = await Promise.all([
    press(gladys, MACS.a, 'door2_open'),
    (async () => {
      await tick(5);
      net.door(A, 1).status = 'close';
      return press(gladys, MACS.a, 'door2_close');
    })(),
  ]);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
  assert.equal(open2.success, true, open2.error);
  assert.equal(close2.success, false, 'door 2 was just opened: guarded');
  assert.match(close2.error, /vient d'être commandée/);
  release();
  await open1;
});

test('B1/B2/H2: three closes at once on a slow controller: three sent', async (t) => {
  const { gladys, net, app } = await setup(t, {
    config: { allow_open: true },
    appTimers: realTimers,
  });
  net.table[A].status.door_num = 3;
  net.table[A].status.data.door3 = { index: 2, status: 'open', lockup: 0, disabled: 0 };
  app.data.devices[MACS.a].layout.doors = [0, 1, 2];
  await app.publishDevices();
  net.door(A, 0).status = 'open';
  net.door(A, 1).status = 'open';
  // Every read answers in 1.2 s, every command in 2 s (one at a time would
  // take 3 x 3.2 s: only the first close would leave in time).
  const request = app.client.request;
  app.client.request = async (options) => {
    const command = options.body.includes('door_op');
    await new Promise((resolve) => setTimeout(resolve, command ? 0 : 1200));
    if (command) {
      options.beforeSend?.();
      const answer = request({ ...options, beforeSend: undefined });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return answer;
    }
    return request(options);
  };
  const started = Date.now();
  const acks = await Promise.all(
    ['door1_close', 'door2_close', 'door3_close'].map((key) => press(gladys, MACS.a, key)),
  );
  assert.ok(Date.now() - started < 4300, `${Date.now() - started} ms`);
  for (const ack of acks) {
    assert.equal(ack.success, true, ack.error);
  }
  assert.deepEqual(
    net
      .commands()
      .map((c) => JSON.parse(c.body).data.value.door_idx)
      .sort(),
    [0, 1, 2],
  );
});

test('H7: a wall clock set forward or back never shortens nor lengthens a guard', async (t) => {
  const { gladys, net, now } = await setup(t, { config: { allow_open: true } });
  net.table[A].moves = false;
  net.door(A, 0).status = 'open';
  assert.equal((await press(gladys, MACS.a, 'door1_close')).success, true);
  now.jump(46_000);
  assert.match((await press(gladys, MACS.a, 'door1_close')).error, /vient d'être commandée/);
  now.jump(-600_000);
  net.door(A, 0).status = 'close';
  now.advance(15_000);
  const ack = await press(gladys, MACS.a, 'door1_open');
  assert.equal(ack.success, true, ack.error);
  assert.equal(net.commands().length, 2);
});
