import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';

// Integration tests drive the server over a Unix domain socket rather than a
// TCP port: this sandbox's network namespace drops TCP loopback connections,
// but the server is transport-agnostic (http.Server.listen() accepts a path),
// so this exercises the exact same request-handling code a TCP client would.

async function startTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  const dbPath = path.join(dir, 'tasks.json');
  const socketPath = path.join(dir, 'server.sock');
  const server = await createServer({ dbPath });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { server, socketPath, dbPath, dir };
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
          resolve({
            status: res.statusCode,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('POST /tasks creates a task with a title and unique id', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.equal(body.title, 'Buy milk');
  assert.equal(body.completed, false);
  assert.ok(body.id);
});

test('GET /tasks lists all tasks with id, title and status', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const res = await request(ctx.socketPath, { path: '/tasks' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.equal(body.length, 1);
  assert.deepEqual(Object.keys(body[0]).sort(), ['completed', 'id', 'title']);
});

test('PATCH /tasks/:id marks a task complete and reopens it', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const completeRes = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { completed: true },
  });
  assert.equal(completeRes.status, 200);
  assert.equal(completeRes.json().completed, true);

  const reopenRes = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { completed: false },
  });
  assert.equal(reopenRes.json().completed, false);
});

test('DELETE /tasks/:id removes the task', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const res = await request(ctx.socketPath, { method: 'DELETE', path: `/tasks/${created.id}` });
  assert.equal(res.status, 204);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.deepEqual(list, []);
});

test('referencing an unknown task id returns a clear error', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const patchRes = await request(ctx.socketPath, {
    method: 'PATCH',
    path: '/tasks/does-not-exist',
    body: { completed: true },
  });
  assert.equal(patchRes.status, 404);
  assert.match(patchRes.json().error, /does-not-exist/);

  const deleteRes = await request(ctx.socketPath, { method: 'DELETE', path: '/tasks/does-not-exist' });
  assert.equal(deleteRes.status, 404);
  assert.match(deleteRes.json().error, /does-not-exist/);
});

test('POST /tasks without a title returns a 400 error', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: {} });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);
});

test('tasks survive a server restart against the same JSON file', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  const dbPath = path.join(dir, 'tasks.json');
  const socketPath = path.join(dir, 'server.sock');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const first = await createServer({ dbPath });
  await new Promise((resolve) => first.listen(socketPath, resolve));
  const created = (
    await request(socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();
  first.closeAllConnections();
  await new Promise((resolve) => first.close(resolve));

  const socketPath2 = path.join(dir, 'server2.sock');
  const second = await createServer({ dbPath });
  await new Promise((resolve) => second.listen(socketPath2, resolve));
  try {
    const list = (await request(socketPath2, { path: '/tasks' })).json();
    assert.deepEqual(list, [{ id: created.id, title: 'Buy milk', completed: false }]);
  } finally {
    second.closeAllConnections();
    await new Promise((resolve) => second.close(resolve));
  }
});
