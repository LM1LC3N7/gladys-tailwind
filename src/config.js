// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The local
// control key is kept here only: never logged, never in /data, never in a
// status or an error (only a salted fingerprint of a key a controller REFUSED
// is kept in /data, removed at the first success).
// -----------------------------------------------------------------------------

import { LIMITS, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  allow_open: false,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** The optional fields without a default in the manifest (the key is a secret). */
const OPTIONAL = { local_key: '' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/**
 * A local control key as Tailwind gives it (six digits today): printable
 * ASCII without spaces, so it always fits in an HTTP header.
 */
const KEY = /^[\x21-\x7e]{1,64}$/;

/** A text read from a controller, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * An address typed by the user: an IPv4 address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.30/json") is reduced to its
 * host; credentials in it are refused (the key belongs in its field).
 * @returns {string | undefined} `host` or `host:port` (port 80 dropped)
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  text = text.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (text.includes('@')) {
    return undefined;
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, host, portText] = match;
  const port = portText === undefined ? 80 : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  if (!valid) {
    return undefined;
  }
  return port === 80 ? host : `${host}:${port}`;
}

/** `host[:port]` -> { host, port }. */
export function splitAddress(address) {
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(address);
  return { host: match[1], port: match[2] === undefined ? 80 : Number(match[2]) };
}

/** The addresses list: separated by commas, semicolons, spaces or new lines. */
export function parseAddresses(raw) {
  const valid = [];
  const invalid = [];
  for (const entry of String(raw ?? '').split(/[\s,;]+/)) {
    if (entry === '') {
      continue;
    }
    const address = parseAddress(entry);
    if (!address) {
      // Shown in the status: cut at an '@' and at a query (a key may be pasted there).
      invalid.push(
        entry
          .replace(/^.*@/, '…@')
          .replace(/[?#].*$/, '…')
          .slice(0, 60),
      );
      continue;
    }
    if (!valid.includes(address) && valid.length < LIMITS.addresses) {
      valid.push(address);
    }
  }
  return { valid, invalid };
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const { valid, invalid } = parseAddresses(c.addresses);
  // Spaces around a pasted key are not part of it.
  const key = typeof c.local_key === 'string' ? c.local_key.trim() : '';
  let keyProblem;
  if (key === '') {
    keyProblem = 'missing';
  } else if (!KEY.test(key)) {
    keyProblem = 'invalid';
  }
  const interval = numberOf(c.poll_interval);
  return {
    addresses: valid,
    invalidAddresses: invalid,
    /** The local control key, or undefined (none, or unusable: said in the status). */
    key: keyProblem ? undefined : key,
    keyProblem,
    allowOpen: strictTrue(c.allow_open),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/**
 * What changes the controllers asked or the commands sent: a new value
 * starts a new generation (compared in memory only, never stored).
 */
export const generationKey = (config) => JSON.stringify([config.addresses, config.key ?? '']);
