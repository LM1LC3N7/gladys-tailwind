// -----------------------------------------------------------------------------
// Known controllers -> Gladys devices and values (pure).
//
// A known controller (a record of `devices` in /data, see src/store.js)
// becomes one Gladys device whose external ids are built from its MAC:
// `gladys.externalIds('tailwind', mac)`, whatever its address. Feature keys
// are frozen (n is the door number, the API index + 1):
//
//   door<n>                     opening sensor (read only)
//   door<n>_open, door<n>_close BUTTONS (push), never a switch
//   led                         status LED brightness, 0-100 (light / brightness)
//
// A door is never a switch nor a commandable binary: a "turn everything
// off/on" (voice assistants, HomeKit, scenes on switches) must never reach a
// garage door.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DOOR, EXTERNAL_ID_TYPE, LED, OPENING_SENSOR_STATE } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';

const doorSensor = () => ({
  category: C.OPENING_SENSOR,
  type: T.SENSOR.BINARY,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});
const led = () => ({
  category: C.LIGHT,
  type: T.LIGHT.BRIGHTNESS,
  min: LED.min,
  max: LED.max,
  read_only: false,
  has_feedback: true,
  keep_history: false,
});

/** The feature keys of a door (`index` 0 to 2). Frozen. */
export const doorKeys = (index) => ({
  state: `door${index + 1}`,
  open: `door${index + 1}_open`,
  close: `door${index + 1}_close`,
});

/**
 * What a feature key commands: `{ kind: 'open' | 'close' | 'led', index? }`,
 * or undefined (a read-only or unknown key).
 */
export function commandOf(key) {
  if (key === 'led') {
    return { kind: 'led' };
  }
  const match = /^door([1-3])_(open|close)$/.exec(String(key ?? ''));
  return match ? { kind: match[2], index: Number(match[1]) - 1 } : undefined;
}

/** The features of a known controller: `[{ key, spec, name }]`, in a stable order. */
export function featuresOf(record) {
  const layout = record.layout ?? {};
  const out = [];
  for (const index of layout.doors ?? []) {
    const keys = doorKeys(index);
    out.push(
      { key: keys.state, spec: doorSensor(), name: FEATURE_NAMES.door(index + 1) },
      { key: keys.open, spec: button(), name: FEATURE_NAMES.open(index + 1) },
      { key: keys.close, spec: button(), name: FEATURE_NAMES.close(index + 1) },
    );
  }
  if (layout.led) {
    out.push({ key: 'led', spec: led(), name: FEATURE_NAMES.led });
  }
  return out;
}

export function deviceName(record) {
  return `Tailwind ${record.product || 'iQ3'} ${record.id.slice(-6)}`.slice(0, 100);
}

/** The Gladys device of a known controller. */
export function buildDevice(gladys, record, { language }) {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, record.id);
  const features = featuresOf(record).map(({ key, spec, name }) => ({
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    ...spec,
  }));
  const params = [
    { name: 'IP_ADDRESS', value: record.address ?? '' },
    { name: 'MAC', value: record.id },
    { name: 'MODEL', value: record.product ?? '' },
    { name: 'FIRMWARE', value: record.firmware ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: deviceName(record),
    external_id: ids.device,
    features,
    params,
    should_poll: false,
  };
}

/**
 * featureKey -> value from a reading (readingOf), only for the features the
 * controller has; a missing value is skipped, never 0, never NaN.
 */
export function valuesOf(record, reading) {
  const values = new Map();
  const keys = new Set(featuresOf(record).map((f) => f.key));
  const set = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value) && keys.has(key)) {
      values.set(key, value);
    }
  };
  for (const [index, door] of reading.doors ?? new Map()) {
    if (door.state === DOOR.CLOSED) {
      set(doorKeys(index).state, OPENING_SENSOR_STATE.CLOSE);
    } else if (door.state === DOOR.OPEN) {
      set(doorKeys(index).state, OPENING_SENSOR_STATE.OPEN);
    }
  }
  set('led', reading.led);
  return values;
}
