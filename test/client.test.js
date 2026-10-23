// -----------------------------------------------------------------------------
// The HTTP client against a real server on the loopback: the POST body and
// the TOKEN header, the `result` words, the statuses, the size cap, the
// deadline, `sendWithin` and `beforeSend` (nothing written when they refuse),
// a read dropped at any time, and the key never in an error. One connection
// per request (no agent, no keep-alive).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BODIES, TailwindClient, retryAfterOf } from '../src/tailwind/client.js';

async function server(t, handler) {
  const received = [];
  let connections = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        token: req.headers.token,
        body,
      });
      handler(req, res, body);
    });
  });
  srv.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  return { address: `127.0.0.1:${srv.address().port}`, received, connections: () => connections };
}

const json = (res, value, status = 200, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
};

test('the bodies are the ones of gotailwind; odd commands never built', () => {
  assert.deepEqual(JSON.parse(BODIES.status()), {
    version: '0.1',
    data: { type: 'get', name: 'dev_st' },
  });
  assert.deepEqual(JSON.parse(BODIES.door(2, 'close')).data, {
    type: 'set',
    name: 'door_op',
    value: { door_idx: 2, cmd: 'close' },
  });
  assert.deepEqual(JSON.parse(BODIES.led(55)).data.value, { brightness: 55 });
  assert.throws(() => BODIES.door(3, 'open'), { kind: 'invalid' });
  assert.throws(() => BODIES.door(0, 'reboot'), { kind: 'invalid' });
  assert.throws(() => BODIES.led(101), { kind: 'invalid' });
  assert.throws(() => BODIES.led(1.5), { kind: 'invalid' });
});

test('a status and a command: POST /json, the key in the TOKEN header, one connection each', async (t) => {
  const srv = await server(t, (req, res, body) =>
    body.includes('dev_st')
      ? json(res, { result: 'OK', dev_id: '_1_2_3_4_5_6_' })
      : json(res, { result: 'OK' }),
  );
  const client = new TailwindClient();
  assert.equal((await client.status(srv.address, '123456')).dev_id, '_1_2_3_4_5_6_');
  await client.door(srv.address, '123456', 0, 'open');
  assert.deepEqual(
    srv.received.map((r) => [r.method, r.url, r.token]),
    [
      ['POST', '/json', '123456'],
      ['POST', '/json', '123456'],
    ],
  );
  assert.equal(srv.connections(), 2);
});

test('"token fail" and "Fail" are their own kinds; the key is never in an error', async (t) => {
  let answer = 0;
  const { address } = await server(t, (req, res) => {
    answer += 1;
    if (answer === 1) json(res, { result: 'token fail' });
    else if (answer === 2) json(res, { result: 'Fail', Info: 'secretkey' });
    else json(res, { result: 'maybe' });
  });
  const client = new TailwindClient();
  await assert.rejects(client.status(address, 'secretkey'), (err) => {
    assert.equal(err.kind, 'token');
    assert.ok(err.sent);
    assert.ok(!JSON.stringify({ ...err, m: err.message }).includes('secretkey'));
    return true;
  });
  await assert.rejects(client.door(address, 'secretkey', 0, 'open'), (err) => {
    assert.equal(err.kind, 'fail');
    assert.ok(!JSON.stringify({ ...err, m: err.message }).includes('secretkey'));
    return true;
  });
  await assert.rejects(client.status(address, 'k'), { kind: 'invalid', sent: true });
});

test('statuses: 503 is a pause with Retry-After, 404 an HTTP refusal', async (t) => {
  let answer = 0;
  const { address } = await server(t, (req, res) => {
    answer += 1;
    if (answer === 1) json(res, 'busy', 503, { 'retry-after': '120' });
    else if (answer === 2) json(res, 'no', 404);
    else json(res, '[1,2]');
  });
  const client = new TailwindClient();
  await assert.rejects(client.door(address, 'k', 0, 'close'), (err) => {
    assert.equal(err.kind, 'busy');
    assert.equal(err.retryAfter, 120_000);
    assert.ok(err.sent);
    return true;
  });
  await assert.rejects(client.door(address, 'k', 0, 'close'), { kind: 'http', status: 404 });
  await assert.rejects(client.status(address, 'k'), { kind: 'invalid' });
});

test('an answer too large or too slow fails', async (t) => {
  const { address } = await server(t, (req, res) => {
    res.writeHead(200);
    res.end('x'.repeat(64 * 1024));
  });
  const client = new TailwindClient();
  await assert.rejects(client.status(address, 'k'), { kind: 'tooLarge' });
  const silent = await server(t, () => {});
  await assert.rejects(client.status(silent.address, 'k', { timeout: 200 }), {
    kind: 'timeout',
    sent: true,
  });
});

test('a read is dropped at any time; a command already sent never is', async (t) => {
  const silent = await server(t, () => {});
  const client = new TailwindClient();
  const controller = new AbortController();
  const reading = client.status(silent.address, 'k', { timeout: 3000, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  controller.abort();
  await assert.rejects(reading, { kind: 'cancelled' });
  assert.ok(Date.now() - started < 100);
  const command = new AbortController();
  const sending = client.door(silent.address, 'k', 0, 'close', {
    timeout: 300,
    signal: command.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  command.abort();
  await assert.rejects(sending, { kind: 'timeout', sent: true });
});

test('beforeSend refusing: nothing written; a closed port: unreachable, not sent', async (t) => {
  const { address, received } = await server(t, (req, res) => json(res, { result: 'OK' }));
  const client = new TailwindClient();
  const refusal = new Error('refused');
  await assert.rejects(
    client.door(address, 'k', 0, 'open', {
      beforeSend: () => {
        throw refusal;
      },
    }),
    (err) => err === refusal && err.beforeSend === true && err.sent === false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(received, []);
  await assert.rejects(client.status('127.0.0.1:1', 'k', { timeout: 2000 }), {
    kind: 'unreachable',
    sent: false,
  });
});

test('Retry-After: seconds or a date, bounded input', () => {
  assert.equal(retryAfterOf('30'), 30_000);
  assert.equal(
    retryAfterOf('Thu, 01 Jan 2099 00:00:10 GMT', Date.parse('2099-01-01T00:00:00Z')),
    10_000,
  );
  assert.equal(retryAfterOf('x'.repeat(100)), undefined);
  assert.equal(retryAfterOf(undefined), undefined);
});
