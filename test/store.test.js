import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
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
  assert.ok(a.id);
  assert.notEqual(a.id, b.id);
});

test('lists all tasks with id, title and completion status', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  await store.create('Buy milk');
  await store.create('Walk dog');
  const tasks = store.list();

  assert.equal(tasks.length, 2);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['completed', 'id', 'title']);
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
    { id: task.id, title: 'Buy milk', completed: true },
  ]);
});
