// -----------------------------------------------------------------------------
// The pure parts: configuration, status parsing, the model, /data sanitizing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseAddress, parseAddresses } from '../src/config.js';
import { buildDevice, commandOf, valuesOf } from '../src/model.js';
import {
  firmwareSupported,
  identityOf,
  layoutOf,
  macOf,
  mergeLayout,
  readingOf,
} from '../src/tailwind/parse.js';
import { emptyData, sanitize } from '../src/store.js';

/** The fixtures of gotailwind (tests/fixtures), as the firmware answers. */
const FIXTURE = {
  result: 'OK',
  product: 'iQ3',
  dev_id: '_3c_e9_e_6d_21_84_',
  proto_ver: '0.1',
  door_num: 2,
  night_mode_en: 0,
  fw_ver: '10.10',
  led_brightness: 100,
  data: {
    door1: { index: 0, status: 'close', lockup: 0, disabled: 0 },
    door2: { index: 1, status: 'open', lockup: 1, disabled: 0 },
  },
};

test('addresses: IPv4 or host names, a pasted URL reduced, credentials refused', () => {
  assert.equal(parseAddress('192.168.1.60'), '192.168.1.60');
  assert.equal(parseAddress('http://192.168.1.60/json'), '192.168.1.60');
  assert.equal(parseAddress('tailwind-iq3.local:8080'), 'tailwind-iq3.local:8080');
  for (const bad of ['', 'user:pw@192.168.1.60', '999.1.1.1', 'a b', '1.2.3', 'host:0']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const { valid, invalid } = parseAddresses('192.168.1.60, 192.168.1.60; bad@@x x:99999');
  assert.deepEqual(valid, ['192.168.1.60']);
  assert.ok(invalid.every((entry) => !entry.includes('bad@')));
});

test('configuration: doors off unless exactly true, the key checked, the interval bounded', () => {
  const base = normalizeConfig({});
  assert.equal(base.allowOpen, false);
  assert.equal(base.key, undefined);
  assert.equal(base.keyProblem, 'missing');
  assert.equal(base.pollInterval, 10);
  for (const value of ['yes', 1, 'TRUE', null]) {
    assert.equal(normalizeConfig({ allow_open: value }).allowOpen, false, String(value));
  }
  assert.equal(normalizeConfig({ allow_open: 'true' }).allowOpen, true);
  for (const bad of ['12 34', 'a\nb', 'é'.repeat(3)]) {
    assert.equal(normalizeConfig({ local_key: bad }).keyProblem, 'invalid', bad);
  }
  assert.equal(normalizeConfig({ local_key: ' 123456 ' }).key, '123456');
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 5);
  assert.equal(normalizeConfig({ poll_interval: '9999' }).pollInterval, 300);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 10);
  assert.equal(normalizeConfig({ __proto__: { allow_open: true } }).allowOpen, false);
});

test('status: dev_id identifies, an odd one is unreadable (never another controller)', () => {
  assert.equal(macOf('_3c_e9_e_6d_21_84_'), '3ce90e6d2184');
  assert.equal(macOf('3C:E9:0E:6D:21:84'), '3ce90e6d2184');
  for (const bad of ['', '_0_0_0_0_0_0_', '_ff_ff_ff_ff_ff_ff_', '_3c_e9_', '_3c_e9_e_6d_21_zz_']) {
    assert.equal(macOf(bad), undefined, bad);
  }
  assert.equal(macOf(42), undefined);
  assert.deepEqual(identityOf(FIXTURE), {
    id: '3ce90e6d2184',
    product: 'iQ3',
    firmware: '10.10',
  });
  assert.equal(identityOf(JSON.parse('{"__proto__": {"dev_id": "_1_2_3_4_5_6_"}}')).id, undefined);
  assert.equal(identityOf({ dev_id: '_1_2_3_4_5_6_', product: 'i\u0000Q3\u0085' }).product, 'iQ3');
});

test('firmware: 10.10 or later only', () => {
  for (const ok of ['10.10', '10.11', '10.10.1', '11.0', '10.100']) {
    assert.equal(firmwareSupported(ok), true, ok);
  }
  for (const old of ['9.97', '10.9', '10', '', 'x', undefined, '10.10a']) {
    assert.equal(firmwareSupported(old), false, String(old));
  }
});

test('status: doors by index, every value checked, a missing one undefined', () => {
  const reading = readingOf(FIXTURE);
  assert.deepEqual(
    [...reading.doors],
    [
      [0, { state: 0, disabled: false, lockedOut: false }],
      [1, { state: 1, disabled: false, lockedOut: true }],
    ],
  );
  assert.equal(reading.led, 100);
  const odd = readingOf({
    led_brightness: 140,
    data: {
      a: { index: 5, status: 'open' },
      b: { index: '1', status: 'opening', lockup: 2 },
      c: { index: 1, status: 'close' },
      d: 'x',
    },
  });
  assert.equal(odd.led, undefined);
  assert.deepEqual(
    [...odd.doors],
    [[1, { state: undefined, disabled: undefined, lockedOut: undefined }]],
    'the first entry of an index wins',
  );
  assert.deepEqual(readingOf('nope').doors.size, 0);
  assert.deepEqual(layoutOf(FIXTURE), { doors: [0, 1], led: true });
  assert.deepEqual(mergeLayout({ doors: [2], led: false }, { doors: [0, 9, 'x'], led: true }), {
    doors: [0, 2],
    led: true,
  });
  // Bounded: a huge door table is not walked.
  const many = { data: {} };
  for (let i = 0; i < 1000; i += 1) many.data[`d${i}`] = { index: 0, status: 'open' };
  assert.equal(readingOf(many).doors.size, 1);
});

test('model: frozen keys, nothing for an unknown door, the commands of a key', () => {
  const record = { id: '3ce90e6d2184', product: 'iQ3', layout: { doors: [0, 1], led: true } };
  const values = Object.fromEntries(valuesOf(record, readingOf(FIXTURE)));
  assert.deepEqual(values, { door1: 1, door2: 0, led: 100 });
  const unknown = readingOf({ data: { door1: { index: 0, status: 'x' } } });
  assert.deepEqual(Object.fromEntries(valuesOf(record, unknown)), {});
  assert.deepEqual(commandOf('door2_close'), { kind: 'close', index: 1 });
  assert.deepEqual(commandOf('door1_open'), { kind: 'open', index: 0 });
  assert.deepEqual(commandOf('led'), { kind: 'led' });
  for (const key of ['door1', 'door4_open', 'door0_close', undefined, 'door1_open_x']) {
    assert.equal(commandOf(key), undefined, String(key));
  }
  const gladys = createFakeGladys({ selector: 'tailwind' });
  const device = buildDevice(gladys, { ...record, address: '', firmware: '' }, { language: 'en' });
  assert.equal(device.name, 'Tailwind iQ3 6d2184');
  assert.deepEqual(
    device.params.map((p) => p.name),
    ['MAC', 'MODEL'],
  );
  assert.equal(device.features[0].name, 'Garage door 1');
});

test('units: none outside the ones the core lists (none needed here)', () => {
  const gladys = createFakeGladys({ selector: 'tailwind' });
  const record = { id: '3ce90e6d2184', layout: { doors: [0, 1, 2], led: true } };
  const device = buildDevice(gladys, record, { language: 'fr' });
  assert.ok(device.features.every((f) => f.unit === undefined));
  const constants = readFileSync(new URL('../src/model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(constants, /DEVICE_FEATURE_UNITS/);
});

test('/data: checked when read back, bounded, never a key', () => {
  const now = 1_000_000;
  const data = sanitize(
    {
      salt: 'not hex',
      lastTry: now + 99_999,
      devices: {
        '3ce90e6d2184': {
          id: '3ce90e6d2184',
          address: '192.168.1.60',
          layout: { doors: [0, 7], led: 1 },
        },
        __proto__: { id: '__proto__', address: '' },
        '3ce90e6d2185': { id: 'other', address: '' },
        '3ce90e6d2186': { id: '3ce90e6d2186', address: 'http://x' },
      },
      blocks: {
        '192.168.1.60': { kind: 'pause', until: now + 10 ** 12, failures: 3 },
        'bad address!': { kind: 'pause', until: now + 1 },
        '192.168.1.61': { kind: 'auth', until: now + 1 },
      },
      authBlocks: {
        '192.168.1.60': { fingerprint: 'a'.repeat(64), at: now + 10 ** 12 },
        '192.168.1.61': { fingerprint: '123456' },
      },
      guards: {
        '3ce90e6d2184-0': { from: 0, expect: 1, until: now + 10 ** 12 },
        '3ce90e6d2184-1': { from: 0, expect: 0, until: now + 1 },
        '3ce90e6d2184-5': { from: 0, expect: 1, until: now + 1 },
      },
    },
    now,
  );
  assert.match(data.salt, /^[0-9a-f]{32}$/);
  assert.equal(data.lastTry, now);
  assert.deepEqual(Object.keys(data.devices), ['3ce90e6d2184']);
  assert.deepEqual(data.devices['3ce90e6d2184'].layout, { doors: [0], led: true });
  assert.deepEqual(Object.keys(data.blocks), ['192.168.1.60']);
  assert.equal(data.blocks['192.168.1.60'].until, now + 6 * 60 * 60_000);
  assert.deepEqual(data.authBlocks, { '192.168.1.60': { fingerprint: 'a'.repeat(64), at: now } });
  assert.deepEqual(Object.keys(data.guards), ['3ce90e6d2184-0']);
  assert.equal(data.guards['3ce90e6d2184-0'].until, now + 45_000);
  assert.deepEqual(Object.keys(sanitize(null)), Object.keys(emptyData()));
});

test('/data keeps the most recent last reads within the limit', () => {
  const now = 1_000_000;
  const lastReads = {};
  for (let i = 0; i < 30; i += 1) {
    lastReads[`192.168.1.${i + 1}`] = { ok: false, at: now - 100_000 + i * 1000 };
  }
  const kept = Object.keys(sanitize({ lastReads }, now).lastReads);
  assert.equal(kept.length, 20);
  assert.ok(kept.includes('192.168.1.30'), 'the latest is kept');
  assert.ok(!kept.includes('192.168.1.1'), 'the oldest is dropped');
});
