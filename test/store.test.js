import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStore } from '../src/store.js';

async function tempDbPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-test-'));
  return path.join(dir, 'tasks.json');
}

test('creates a task with a unique id and not-done status', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const a = await store.create('Buy milk');
  const b = await store.create('Walk dog');

  assert.equal(a.title, 'Buy milk');
  assert.equal(a.completed, false);
  assert.equal(a.due, null);
  assert.ok(a.id);
  assert.notEqual(a.id, b.id);
});

test('creates a task with a due date', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Renew passport', '2026-11-01');

  assert.equal(task.due, '2026-11-01');
});

test('creates a task with a default priority of normal', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk');

  assert.equal(task.priority, 'normal');
});

test('creates a task with an explicit priority', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk', null, 'high');

  assert.equal(task.priority, 'high');
});

test('lists all tasks with id, title, completion status and due date', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  await store.create('Buy milk');
  await store.create('Walk dog');
  const tasks = store.list();

  assert.equal(tasks.length, 2);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['completed', 'due', 'id', 'priority', 'title']);
});

test('marks a task complete and reopens it by id', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  const completed = await store.setCompleted(task.id, true);
  assert.equal(completed.completed, true);

  const reopened = await store.setCompleted(task.id, false);
  assert.equal(reopened.completed, false);
});

test('deletes a task by id', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  await store.delete(task.id);

  assert.deepEqual(store.list(), []);
});

test('sets and clears a due date independently of completed', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  const withDue = await store.update(task.id, { due: '2026-11-01' });
  assert.equal(withDue.due, '2026-11-01');
  assert.equal(withDue.completed, false);

  const completedToo = await store.update(task.id, { completed: true });
  assert.equal(completedToo.completed, true);
  assert.equal(completedToo.due, '2026-11-01');

  const cleared = await store.update(task.id, { due: null });
  assert.equal(cleared.due, null);
  assert.equal(cleared.completed, true);
});

test('sets a priority independently of completed and due', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  const updated = await store.update(task.id, { priority: 'low' });
  assert.equal(updated.priority, 'low');
  assert.equal(updated.completed, false);
  assert.equal(updated.due, null);
});

test('lists only overdue tasks when asked: not completed and due strictly before today', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const overdue = await store.create('Overdue', '2020-01-01');
  await store.create('Due today', new Date().toISOString().slice(0, 10));
  await store.create('Due in the future', '2099-01-01');
  await store.create('No due date');
  const completedOverdue = await store.create('Completed overdue', '2020-01-01');
  await store.setCompleted(completedOverdue.id, true);

  const tasks = store.list({ overdue: true });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [overdue.id],
  );
});

test('throws a TaskNotFoundError for an unknown id', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  await assert.rejects(() => store.setCompleted('missing-id', true), {
    name: 'TaskNotFoundError',
  });
  await assert.rejects(() => store.delete('missing-id'), {
    name: 'TaskNotFoundError',
  });
});

test('persists tasks to the JSON file so they survive a restart', async () => {
  const dbPath = await tempDbPath();

  const first = new TaskStore(dbPath);
  await first.load();
  const task = await first.create('Buy milk');
  await first.setCompleted(task.id, true);

  const onDisk = JSON.parse(await readFile(dbPath, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].completed, true);

  const second = new TaskStore(dbPath);
  await second.load();
  assert.deepEqual(second.list(), [
    { id: task.id, title: 'Buy milk', completed: true, due: null, priority: 'normal' },
  ]);
});

test('loads pre-existing tasks written before due dates existed, defaulting due to null', async () => {
  const dbPath = await tempDbPath();
  await writeFile(dbPath, JSON.stringify([{ id: 'legacy-1', title: 'Buy milk', completed: false }]));

  const store = new TaskStore(dbPath);
  await store.load();

  assert.deepEqual(store.list(), [
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal' },
  ]);
});

test('loads pre-existing tasks written before priorities existed, defaulting priority to normal', async () => {
  const dbPath = await tempDbPath();
  await writeFile(
    dbPath,
    JSON.stringify([{ id: 'legacy-1', title: 'Buy milk', completed: false, due: null }]),
  );

  const store = new TaskStore(dbPath);
  await store.load();

  assert.deepEqual(store.list(), [
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal' },
  ]);
});
