import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore } from '../src/pgStore.js';
import { migrate } from '../src/migrate.js';
import { createFakeClient } from './helpers/fakePgClient.js';

test("AC2: Postgres-backed TaskStore creates a task with a unique id and not-done status, matching the JSON-backed store's documented behaviour", async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  const a = await store.create('Buy milk');
  const b = await store.create('Walk dog');

  assert.equal(a.title, 'Buy milk');
  assert.equal(a.completed, false);
  assert.equal(a.due, null);
  assert.ok(a.id);
  assert.notEqual(a.id, b.id);
});

test('AC2: Postgres-backed TaskStore lists tasks with id, title, completed, due, priority and tags', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  await store.create('Buy milk');
  const tasks = await store.list();

  assert.equal(tasks.length, 1);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['completed', 'due', 'id', 'priority', 'tags', 'title']);
});

test('AC2: Postgres-backed TaskStore defaults priority to normal and tags to an empty array', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  const task = await store.create('Buy milk');

  assert.equal(task.priority, 'normal');
  assert.deepEqual(task.tags, []);
});

test('AC2: Postgres-backed TaskStore marks a task complete and reopens it by id', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();
  const task = await store.create('Buy milk');

  const completed = await store.setCompleted(task.id, true);
  assert.equal(completed.completed, true);

  const reopened = await store.setCompleted(task.id, false);
  assert.equal(reopened.completed, false);
});

test('AC2: Postgres-backed TaskStore updates due date, priority and tags independently of completed', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();
  const task = await store.create('Buy milk');

  const updated = await store.update(task.id, { due: '2026-11-01', priority: 'high', tags: ['home'] });

  assert.equal(updated.due, '2026-11-01');
  assert.equal(updated.priority, 'high');
  assert.deepEqual(updated.tags, ['home']);
  assert.equal(updated.completed, false);
});

test('AC2: Postgres-backed TaskStore deletes a task by id', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();
  const task = await store.create('Buy milk');

  await store.delete(task.id);

  assert.deepEqual(await store.list(), []);
});

test('AC2: Postgres-backed TaskStore throws TaskNotFoundError for an unknown id', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  await assert.rejects(() => store.setCompleted('missing-id', true), { name: 'TaskNotFoundError' });
  await assert.rejects(() => store.delete('missing-id'), { name: 'TaskNotFoundError' });
});

test('AC1: Postgres-backed TaskStore list({ sort: "due" }) orders tasks by due date ascending, with undated tasks last', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  const late = await store.create('Late', '2026-03-01');
  const undated = await store.create('No due date');
  const early = await store.create('Early', '2026-01-01');

  const tasks = await store.list({ sort: 'due' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [early.id, late.id, undated.id],
  );
});

test('AC2: Postgres-backed TaskStore list({ sort: "priority" }) orders high before normal before low, tie-broken by due date ascending with undated last', async () => {
  const store = new TaskStore(createFakeClient());
  await store.load();

  const lowUndated = await store.create('Low undated', null, 'low');
  const highLate = await store.create('High late', '2026-03-01', 'high');
  const highEarly = await store.create('High early', '2026-01-01', 'high');
  const normal = await store.create('Normal', null, 'normal');

  const tasks = await store.list({ sort: 'priority' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [highEarly.id, highLate.id, normal.id, lowUndated.id],
  );
});

test('AC6: Postgres-backed TaskStore defaults note to an empty string', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();

  const task = await store.create('Buy milk');

  assert.equal(task.note, '');
});

test('AC3/AC5: Postgres-backed TaskStore sets and clears a note via update', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();
  const task = await store.create('Buy milk');

  const withNote = await store.update(task.id, { note: 'Ask Sam about the delivery window.' });
  assert.equal(withNote.note, 'Ask Sam about the delivery window.');

  const cleared = await store.update(task.id, { note: '' });
  assert.equal(cleared.note, '');
});

test('AC2: Postgres-backed TaskStore tasks persist across store instances sharing the same client, as a restart would against the same database', async () => {
  const client = createFakeClient();

  const first = new TaskStore(client);
  await first.load();
  const task = await first.create('Buy milk');
  await first.setCompleted(task.id, true);

  const second = new TaskStore(client);
  await second.load();
  const tasks = await second.list();

  assert.deepEqual(tasks, [
    { id: task.id, title: 'Buy milk', completed: true, due: null, priority: 'normal', tags: [] },
  ]);
});
