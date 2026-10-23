// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP POST to a
// Tailwind controller on node:http (its local API speaks no TLS). A deadline
// for the whole exchange, a size cap on the body, no redirect followed, no
// keep-alive, no agent (one fresh connection per request). Resolves
// { status, headers, body } for any status; rejects a TailwindError for the
// transport failures, with `sent` true as soon as the connection was up (the
// request may then have reached the controller). `sendWithin`: the
// connection must be up within this many ms, else nothing is written (a
// command never leaves late). `beforeSend`: the last check of a command, once
// connected, right before the first byte is written. The headers carry the
// local control key: they are never put in an error nor a log line. Adapted
// from LM1LC3N7/gladys-opengarage (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { TailwindError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new TailwindError('invalid', { sent });
  }
  // Only our own words: a system message may carry an address or a header.
  return new TailwindError('unreachable', { sent });
}

/**
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {Record<string, string>} [options.headers] extra request headers
 * @param {string} options.body the JSON text posted
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 * @param {AbortSignal} [options.signal] aborted before the connection is up:
 *   'cancelled', nothing sent; ignored once the request may have left,
 *   unless `abortAnyTime` (a read: dropping it changes nothing on the device)
 * @param {boolean} [options.abortAnyTime]
 */
export function httpRequest({
  host,
  port,
  path,
  headers = {},
  body,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
  signal,
  abortAnyTime = false,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // Until the connection is up, nothing of the request has left.
    let connected = false;
    const payload = Buffer.from(body ?? '', 'utf8');

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new TailwindError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new TailwindError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    // Cancelled while the connection is not up yet: nothing has left, the
    // attempt is dropped at once (a command already sent is never aborted; a
    // read may be: it changes nothing).
    const onAbort = () => {
      if (!connected || abortAnyTime) {
        finish(new TailwindError('cancelled', { sent: connected }));
      }
    };
    if (signal?.aborted) {
      finish(new TailwindError('cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      req.end(payload);
    };

    try {
      req = http.request({
        method: 'POST',
        host,
        port,
        path,
        agent: false,
        headers: {
          ...headers,
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': String(payload.length),
          host: port === 80 ? host : `${host}:${port}`,
          connection: 'close',
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new TailwindError('tooLarge', { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a path or a header it refuses: a failure, never a crash.
      finish(transportError(err, false));
    }
  });
}
