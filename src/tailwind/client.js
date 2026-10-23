// -----------------------------------------------------------------------------
// The local API of a Tailwind controller (plain HTTP on the LAN, no cloud),
// after gotailwind (MIT, the library of the Home Assistant integration):
//   POST /json, header TOKEN: <local control key>, a JSON body
//     {"version":"0.1","data":{"type":"get","name":"dev_st"}}      the status
//     {"version":"0.1","data":{"type":"set","name":"door_op",
//        "value":{"door_idx":0,"cmd":"open"|"close"}}}             a door command
//     {"version":"0.1","data":{"type":"set","name":"status_led",
//        "value":{"brightness":0-100}}}                           the status LED
// answered with JSON whose `result` is "OK", "Fail" or "token fail" (the key
// refused). Every answer is size-capped and parsed once. The key travels in a
// header only: never logged, never put in an error.
// -----------------------------------------------------------------------------

import { LIMITS, MAX_DOORS, RESULT, TIMINGS } from '../constants.js';
import { splitAddress } from '../config.js';
import { TailwindError } from './errors.js';
import { httpRequest } from './http.js';

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const DOOR_COMMANDS = new Set(['open', 'close']);

/** The request bodies, as gotailwind builds them. */
export const BODIES = {
  status: () => JSON.stringify({ version: '0.1', data: { type: 'get', name: 'dev_st' } }),
  door: (index, command) => {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_DOORS) {
      throw new TailwindError('invalid');
    }
    if (!DOOR_COMMANDS.has(command)) {
      throw new TailwindError('invalid');
    }
    return JSON.stringify({
      version: '0.1',
      data: { type: 'set', name: 'door_op', value: { door_idx: index, cmd: command } },
    });
  },
  led: (brightness) => {
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
      throw new TailwindError('invalid');
    }
    return JSON.stringify({
      version: '0.1',
      data: { type: 'set', name: 'status_led', value: { brightness } },
    });
  },
};

export class TailwindClient {
  constructor({ request = httpRequest, timeout = TIMINGS.requestTimeout, now = Date.now } = {}) {
    this.request = request;
    this.timeout = timeout;
    this.now = now;
  }

  /**
   * One exchange. `address` is host[:port].
   * @param {object} [options]
   * @param {number} [options.timeout] ms for the whole exchange
   * @param {number} [options.sendWithin] ms to start, else not sent ('late')
   * @param {() => void} [options.beforeSend]
   * @param {AbortSignal} [options.signal] drops an attempt not connected yet
   * @returns {Promise<object>} the JSON object answered, its `result` "OK"
   */
  async post(
    address,
    token,
    body,
    { timeout, sendWithin, beforeSend, signal, abortAnyTime = false } = {},
  ) {
    const { host, port } = splitAddress(address);
    const answer = await this.request({
      host,
      port,
      path: '/json',
      headers: { TOKEN: token },
      body,
      timeout: timeout ?? this.timeout,
      sendWithin,
      maxBytes: LIMITS.responseBytes,
      beforeSend,
      signal,
      abortAnyTime,
    });
    const { status } = answer;
    if (status === 429 || (status >= 500 && status <= 599)) {
      throw new TailwindError('busy', {
        status,
        sent: true,
        retryAfter: retryAfterOf(answer.headers?.['retry-after'], this.now()),
      });
    }
    if (status < 200 || status > 299) {
      throw new TailwindError('http', { status, sent: true });
    }
    let parsed;
    try {
      parsed = JSON.parse(answer.body.toString('utf8'));
    } catch {
      throw new TailwindError('invalid', { sent: true });
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TailwindError('invalid', { sent: true });
    }
    const result = Object.hasOwn(parsed, 'result') ? parsed.result : undefined;
    if (result === RESULT.OK) {
      return parsed;
    }
    if (result === RESULT.TOKEN_FAIL) {
      throw new TailwindError('token', { sent: true });
    }
    if (result === RESULT.FAIL) {
      throw new TailwindError('fail', { sent: true });
    }
    throw new TailwindError('invalid', { sent: true });
  }

  /** The status of the controller and its doors (a read: abortable at any time). */
  status(address, token, options = {}) {
    return this.post(address, token, BODIES.status(), { ...options, abortAnyTime: true });
  }

  /** Opens or closes one door (`index` 0 to 2). Resolves once the controller said "OK". */
  async door(address, token, index, command, options) {
    await this.post(address, token, BODIES.door(index, command), options);
  }

  /** Sets the brightness of the status LED (0 to 100). */
  async led(address, token, brightness, options) {
    await this.post(address, token, BODIES.led(brightness), options);
  }
}
