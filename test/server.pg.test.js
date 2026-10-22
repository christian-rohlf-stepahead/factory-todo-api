import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { migrate } from '../src/migrate.js';
import { createFakeClient } from './helpers/fakePgClient.js';

// Drives the server over a Unix domain socket, as the existing server tests
// do: this sandbox's network namespace drops TCP loopback connections, but
// http.Server.listen() accepts a path, so this exercises the same
// request-handling code a TCP client would.

async function startTestServer(client) {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  const socketPath = path.join(dir, 'server.sock');
  const server = await createServer({ client });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { server, socketPath, dir };
}

async function stop({ server, dir }) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
  await rm(dir, { recursive: true, force: true });
}

function request(socketPath, { method = 'GET', path: reqPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: reqPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('AC2/AC3: the HTTP API keeps its documented POST/GET/PATCH/DELETE behaviour when backed by Postgres via an injected client, with no Postgres server running', async (t) => {
  const client = createFakeClient();
  await migrate(client);
  const ctx = await startTestServer(client);
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', priority: 'high', tags: ['home'] },
    })
  ).json();
  assert.equal(created.title, 'Buy milk');
  assert.equal(created.completed, false);
  assert.equal(created.priority, 'high');
  assert.deepEqual(created.tags, ['home']);

  const listed = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.equal(listed.length, 4, 'expected the 3 seeded todos plus the one just created');

  const patched = (
    await request(ctx.socketPath, {
      method: 'PATCH',
      path: `/tasks/${created.id}`,
      body: { completed: true },
    })
  ).json();
  assert.equal(patched.completed, true);

  const deleteRes = await request(ctx.socketPath, { method: 'DELETE', path: `/tasks/${created.id}` });
  assert.equal(deleteRes.status, 204);

  const afterDelete = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.equal(afterDelete.length, 3);
});

test('AC3: a task created through the API is readable back through the same injected Postgres client, with no Postgres server running and no DATABASE_URL set', async (t) => {
  assert.equal(process.env.DATABASE_URL, undefined, 'expected no Postgres connection string to be configured');

  const client = createFakeClient();
  const ctx = await startTestServer(client);
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks' });

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json().map((t) => t.id),
    [created.id],
  );
});
