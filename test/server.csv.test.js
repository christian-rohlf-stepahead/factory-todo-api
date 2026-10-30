import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../src/server.js';
import { createFakeClient } from './helpers/fakePgClient.js';

// Drives the server over a Unix domain socket, as the existing server tests
// do: this sandbox's network namespace drops TCP loopback connections, but
// http.Server.listen() accepts a path, so this exercises the same
// request-handling code a TCP client would.

async function startJsonTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  const dbPath = path.join(dir, 'tasks.json');
  const socketPath = path.join(dir, 'server.sock');
  const server = await createServer({ dbPath });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { server, socketPath, dir };
}

async function startPgTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  const socketPath = path.join(dir, 'server.sock');
  const client = createFakeClient();
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
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Builds the exact CSV-encoded form of a field, per RFC 4180: wrap in double
// quotes and double any embedded double quote when the field contains a
// comma, a double quote, or a line break. Used only to build the expected
// value in assertions below, never by the server itself.
function csvField(value) {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const HEADER_ROW = 'id,title,completed,due,priority,tags,note';

test('AC1: GET /tasks.csv responds 200 OK with Content-Type text/csv; charset=utf-8', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
});

test('AC2/AC10: GET /tasks.csv\'s first line is the header row id,title,completed,due,priority,tags,note', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  const firstLine = res.text.split('\n')[0];
  assert.equal(firstLine, HEADER_ROW);
});

test('AC3/AC10: GET /tasks.csv includes a data row with a todo\'s id, title, completed, due, priority, tags and note', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: {
        title: 'Buy milk',
        due: '2026-11-01',
        priority: 'high',
        tags: ['home', 'urgent'],
        note: 'Ask Sam about the delivery window.',
      },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { completed: true },
  });

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  const expectedRow = [
    created.id,
    csvField('Buy milk'),
    'true',
    '2026-11-01',
    'high',
    'home;urgent',
    csvField('Ask Sam about the delivery window.'),
  ].join(',');
  assert.ok(res.text.includes(expectedRow), `expected body to include row: ${expectedRow}\ngot:\n${res.text}`);
});

test('AC3: GET /tasks.csv renders an unset due date, tags and note as empty fields, and completed as false', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  const expectedRow = [created.id, 'Buy milk', 'false', '', 'normal', '', ''].join(',');
  assert.ok(res.text.includes(expectedRow), `expected body to include row: ${expectedRow}\ngot:\n${res.text}`);
});

test('AC4: GET /tasks.csv lists rows in the same order GET /tasks returns with no query parameters applied', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const a = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'First', priority: 'low' } })
  ).json();
  const b = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Second', priority: 'high' } })
  ).json();
  const c = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Third', priority: 'normal' } })
  ).json();

  const jsonOrder = (await request(ctx.socketPath, { path: '/tasks' })).json().map((task) => task.id);
  const res = await request(ctx.socketPath, { path: '/tasks.csv' });
  const csvOrder = res.text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(',')[0]);

  assert.deepEqual(jsonOrder, [a.id, b.id, c.id]);
  assert.deepEqual(csvOrder, jsonOrder);
});

test('AC4: GET /tasks.csv ignores query parameters and always exports the full, unfiltered list', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const overdue = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue', due: '2020-01-01', tags: ['home'] },
    })
  ).json();
  const future = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Future', due: '2099-01-01', tags: ['work'] },
    })
  ).json();

  const res = await request(ctx.socketPath, {
    path: '/tasks.csv?overdue=true&tag=home&sort=priority',
  });

  const ids = res.text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(',')[0]);
  assert.deepEqual(ids.sort(), [overdue.id, future.id].sort());
});

test('AC5/AC10: GET /tasks.csv quotes and escapes a title containing a comma, a double quote, and a line break', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const title = 'Buy milk, "whole" and\nsoy';
  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title } })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  const expectedRow = [created.id, csvField(title), 'false', '', 'normal', '', ''].join(',');
  assert.ok(res.text.includes(expectedRow), `expected body to include row: ${expectedRow}\ngot:\n${res.text}`);
});

test('AC5/AC10: GET /tasks.csv quotes and escapes a note containing a comma, a double quote, and a line break', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const note = 'Ask Sam, he said "no rush" but\ncheck anyway';
  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk', note } })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  const expectedRow = [created.id, 'Buy milk', 'false', '', 'normal', '', csvField(note)].join(',');
  assert.ok(res.text.includes(expectedRow), `expected body to include row: ${expectedRow}\ngot:\n${res.text}`);
});

test('AC6/AC10: GET /tasks.csv responds 200 OK with only the header row when there are no todos', async (t) => {
  const ctx = await startJsonTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.text.split('\n').filter((line) => line.length > 0),
    [HEADER_ROW],
  );
});

test('AC7: GET /tasks.csv reflects the same todos GET /tasks returns when the API is backed by Postgres', async (t) => {
  const ctx = await startPgTestServer();
  t.after(() => stop(ctx));

  const a = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', due: '2026-11-01', priority: 'high', tags: ['home'], note: 'From Postgres' },
    })
  ).json();
  const b = (await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Walk dog' } })).json();

  const jsonList = (await request(ctx.socketPath, { path: '/tasks' })).json();
  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
  const lines = res.text.trim().split('\n');
  assert.equal(lines[0], HEADER_ROW);
  assert.equal(lines.length, 1 + jsonList.length);

  const expectedRowA = [a.id, 'Buy milk', 'false', '2026-11-01', 'high', 'home', 'From Postgres'].join(',');
  const expectedRowB = [b.id, 'Walk dog', 'false', '', 'normal', '', ''].join(',');
  assert.ok(res.text.includes(expectedRowA));
  assert.ok(res.text.includes(expectedRowB));
});

test('AC7: GET /tasks.csv reflects a deletion made through the API immediately, when backed by Postgres', async (t) => {
  const ctx = await startPgTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();
  await request(ctx.socketPath, { method: 'DELETE', path: `/tasks/${created.id}` });

  const res = await request(ctx.socketPath, { path: '/tasks.csv' });

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.text.split('\n').filter((line) => line.length > 0),
    [HEADER_ROW],
  );
});

test('AC8: csv-stringify is listed as a dependency in package.json and is used to build the CSV body', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(
    typeof pkg.dependencies?.['csv-stringify'] === 'string',
    'expected "csv-stringify" to be listed under dependencies in package.json',
  );

  const srcDir = new URL('../src/', import.meta.url);
  const srcFiles = await readdir(srcDir);
  const srcContents = await Promise.all(
    srcFiles.filter((name) => name.endsWith('.js')).map((name) => readFile(new URL(name, srcDir), 'utf8')),
  );
  assert.ok(
    srcContents.some((contents) => /from\s+['"]csv-stringify/.test(contents)),
    'expected a file under src/ to build the CSV body with the csv-stringify package',
  );
});

test('AC9: README documents GET /tasks.csv, its content type and header columns, alongside the existing endpoints', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('### `GET /tasks.csv`');
  assert.ok(start !== -1, 'README must document GET /tasks.csv in its own section');

  const nextSection = readme.indexOf('\n### `', start + 1);
  const section = nextSection === -1 ? readme.slice(start) : readme.slice(start, nextSection);

  assert.match(section, /GET/);
  assert.match(section, /\/tasks\.csv/);
  assert.match(section, /text\/csv/);
  assert.match(section, /id,\s*title,\s*completed,\s*due,\s*priority,\s*tags,\s*note/);
});
