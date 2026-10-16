import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('GET /tasks lists all tasks with id, title, status and due date', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const res = await request(ctx.socketPath, { path: '/tasks' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.equal(body.length, 1);
  assert.deepEqual(Object.keys(body[0]).sort(), ['completed', 'due', 'id', 'priority', 'tags', 'title']);
  assert.equal(body[0].due, null);
  assert.equal(body[0].priority, 'normal');
  assert.deepEqual(body[0].tags, []);
});

test('GET /tasks ignores unrecognized query parameters', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Renew passport', due: '2020-01-01' },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?anything=else&foo=bar' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.equal(body.length, 2);
});

test('GET /tasks?overdue=true returns only incomplete tasks with a due date strictly before today', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const overdue = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue', due: '2020-01-01' },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Due today', due: new Date().toISOString().slice(0, 10) },
  });
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Due in the future', due: '2099-01-01' },
  });
  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'No due date' } });
  const completedOverdue = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Completed overdue', due: '2020-01-01' },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${completedOverdue.id}`,
    body: { completed: true },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?overdue=true' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [overdue.id],
  );
});

test('GET /tasks?tag=<tag> returns only tasks with that tag', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const home = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Mow lawn', tags: ['home'] },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Write report', tags: ['work'] },
  });
  await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'No tags' } });

  const res = await request(ctx.socketPath, { path: '/tasks?tag=home' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [home.id],
  );
});

test('GET /tasks?tag=<tag>&overdue=true narrows both filters together (AND)', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const overdueHome = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue home', due: '2020-01-01', tags: ['home'] },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Overdue work', due: '2020-01-01', tags: ['work'] },
  });
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Future home', due: '2099-01-01', tags: ['home'] },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?tag=home&overdue=true' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [overdueHome.id],
  );
});

test('AC1: GET /tasks?sort=priority returns high-priority tasks before normal, and normal before low', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const low = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Low', priority: 'low' } })
  ).json();
  const high = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'High', priority: 'high' } })
  ).json();
  const normal = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Normal', priority: 'normal' },
    })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [high.id, normal.id, low.id],
  );
});

test('AC2: GET /tasks?sort=priority orders tasks within a tier by due date ascending', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const late = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Late', priority: 'high', due: '2026-03-01' },
    })
  ).json();
  const early = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Early', priority: 'high', due: '2026-01-01' },
    })
  ).json();
  const mid = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Mid', priority: 'high', due: '2026-02-01' },
    })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [early.id, mid.id, late.id],
  );
});

test('AC3: GET /tasks?sort=priority returns undated tasks after dated tasks within a tier', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const undated = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'No due date', priority: 'high' },
    })
  ).json();
  const dated = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Has a due date', priority: 'high', due: '2026-01-01' },
    })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [dated.id, undated.id],
  );
});

test('AC4: GET /tasks with an unrecognised sort value returns a 400 naming the accepted value(s)', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { path: '/tasks?sort=bogus' });
  const body = res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /priority/);
});

test('AC5: GET /tasks?sort=priority&overdue=true applies the overdue filter, then sorts by priority', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const overdueLow = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue low', priority: 'low', due: '2020-01-02' },
    })
  ).json();
  const overdueHigh = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue high', priority: 'high', due: '2020-01-01' },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Future high', priority: 'high', due: '2099-01-01' },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority&overdue=true' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [overdueHigh.id, overdueLow.id],
  );
});

test('AC5: GET /tasks?sort=priority&tag=<tag> applies the tag filter, then sorts by priority', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const homeLow = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Home low', priority: 'low', tags: ['home'] },
    })
  ).json();
  const homeHigh = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Home high', priority: 'high', tags: ['home'] },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Work high', priority: 'high', tags: ['work'] },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority&tag=home' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [homeHigh.id, homeLow.id],
  );
});

test('AC5: GET /tasks?sort=priority&overdue=true&tag=<tag> applies both filters, then sorts by priority', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const overdueHomeLow = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue home low', priority: 'low', due: '2020-01-02', tags: ['home'] },
    })
  ).json();
  const overdueHomeHigh = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Overdue home high', priority: 'high', due: '2020-01-01', tags: ['home'] },
    })
  ).json();
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Overdue work high', priority: 'high', due: '2020-01-01', tags: ['work'] },
  });
  await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Future home high', priority: 'high', due: '2099-01-01', tags: ['home'] },
  });

  const res = await request(ctx.socketPath, { path: '/tasks?sort=priority&overdue=true&tag=home' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [overdueHomeHigh.id, overdueHomeLow.id],
  );
});

test('AC6: GET /tasks without a sort parameter keeps returning tasks in insertion order', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const a = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'First', priority: 'low' } })
  ).json();
  const b = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Second', priority: 'high' } })
  ).json();
  const c = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Third', priority: 'normal' },
    })
  ).json();

  const res = await request(ctx.socketPath, { path: '/tasks' });
  const body = res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(
    body.map((t) => t.id),
    [a.id, b.id, c.id],
  );
});

test('AC7: README documents the sort query parameter and its ordering rules', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const start = readme.indexOf('### `GET /tasks`');
  const end = readme.indexOf('### `PATCH /tasks/:id`');
  assert.ok(start !== -1 && end !== -1 && start < end, 'README must have a GET /tasks section');
  const section = readme.slice(start, end);

  assert.match(section, /`sort`/);
  assert.match(section, /priority/i);
  assert.match(section, /high.*normal.*low/is);
  assert.match(section, /ascending/i);
  assert.match(section, /(undated|no due date)/i);
  assert.match(section, /400/);
});

test('POST /tasks accepts an optional due date and returns it', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Renew passport', due: '2026-11-01' },
  });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.equal(body.due, '2026-11-01');
});

test('POST /tasks without a due date returns it as null', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.equal(body.due, null);
});

test('POST /tasks rejects an invalid due date and creates no task', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Buy milk', due: 'not-a-date' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.deepEqual(list, []);
});

test('POST /tasks without a priority defaults it to normal', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.equal(body.priority, 'normal');
});

test('POST /tasks accepts a priority and returns it', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Buy milk', priority: 'high' },
  });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.equal(body.priority, 'high');
});

test('POST /tasks rejects an invalid priority and creates no task', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Buy milk', priority: 'urgent' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.deepEqual(list, []);
});

test('POST /tasks accepts an optional tags array and returns it', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Buy milk', tags: ['home', 'urgent'] },
  });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.deepEqual(body.tags, ['home', 'urgent']);
});

test('POST /tasks without tags defaults it to an empty array', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.deepEqual(body.tags, []);
});

test('POST /tasks dedupes repeated tags', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const res = await request(ctx.socketPath, {
    method: 'POST',
    path: '/tasks',
    body: { title: 'Buy milk', tags: ['home', 'home'] },
  });
  const body = res.json();

  assert.equal(res.status, 201);
  assert.deepEqual(body.tags, ['home']);
});

test('POST /tasks rejects an invalid tags value and creates no task', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  for (const tags of ['home', ['Home'], ['home-town'], ['home2'], ['']]) {
    const res = await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', tags },
    });
    assert.equal(res.status, 400, `expected 400 for tags: ${JSON.stringify(tags)}`);
    assert.ok(res.json().error);
  }

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.deepEqual(list, []);
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

test('PATCH /tasks/:id sets and clears a due date independently of completed', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const withDue = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { due: '2026-11-01' },
  });
  assert.equal(withDue.status, 200);
  assert.equal(withDue.json().due, '2026-11-01');
  assert.equal(withDue.json().completed, false);

  const completedToo = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { completed: true },
  });
  assert.equal(completedToo.json().completed, true);
  assert.equal(completedToo.json().due, '2026-11-01');

  const cleared = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { due: null },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json().due, null);
  assert.equal(cleared.json().completed, true);
});

test('PATCH /tasks/:id updates priority alone, or together with completed and due', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } })
  ).json();

  const priorityOnly = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { priority: 'high' },
  });
  assert.equal(priorityOnly.status, 200);
  assert.equal(priorityOnly.json().priority, 'high');
  assert.equal(priorityOnly.json().completed, false);

  const withOthers = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { priority: 'low', completed: true, due: '2026-11-01' },
  });
  assert.equal(withOthers.status, 200);
  assert.equal(withOthers.json().priority, 'low');
  assert.equal(withOthers.json().completed, true);
  assert.equal(withOthers.json().due, '2026-11-01');
});

test('PATCH /tasks/:id accepts tags and replaces the task\'s tag list', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', tags: ['home'] },
    })
  ).json();

  const res = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { tags: ['work', 'urgent'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().tags, ['work', 'urgent']);

  const cleared = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { tags: [] },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json().tags, []);
});

test('PATCH /tasks/:id rejects an invalid tags value and makes no change', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', tags: ['home'] },
    })
  ).json();

  const res = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { tags: ['Not Valid'] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.deepEqual(list[0].tags, ['home']);
});

test('PATCH /tasks/:id rejects an invalid priority and makes no change', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', priority: 'high' },
    })
  ).json();

  const res = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { priority: 'urgent' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.equal(list[0].priority, 'high');
});

test('PATCH /tasks/:id rejects an invalid, non-null due date and makes no change', async (t) => {
  const ctx = await startTestServer();
  t.after(() => stop(ctx));

  const created = (
    await request(ctx.socketPath, {
      method: 'POST',
      path: '/tasks',
      body: { title: 'Buy milk', due: '2026-11-01' },
    })
  ).json();

  const res = await request(ctx.socketPath, {
    method: 'PATCH',
    path: `/tasks/${created.id}`,
    body: { due: 'not-a-date' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json().error);

  const list = (await request(ctx.socketPath, { path: '/tasks' })).json();
  assert.equal(list[0].due, '2026-11-01');
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
    assert.deepEqual(list, [
      { id: created.id, title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [] },
    ]);
  } finally {
    second.closeAllConnections();
    await new Promise((resolve) => second.close(resolve));
  }
});
