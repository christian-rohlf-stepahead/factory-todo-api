import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStore, isValidTags, isValidSort } from '../src/store.js';

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
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['completed', 'due', 'id', 'priority', 'tags', 'title']);
});

test('creates a task with a default tags of an empty array', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk');

  assert.deepEqual(task.tags, []);
});

test('creates a task with explicit tags', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk', null, 'normal', ['home', 'urgent']);

  assert.deepEqual(task.tags, ['home', 'urgent']);
});

test('dedupes repeated tags on create', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk', null, 'normal', ['home', 'home', 'urgent']);

  assert.deepEqual(task.tags, ['home', 'urgent']);
});

test('replaces a task\'s tags on update', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk', null, 'normal', ['home']);

  const updated = await store.update(task.id, { tags: ['work', 'urgent'] });

  assert.deepEqual(updated.tags, ['work', 'urgent']);
});

test('dedupes repeated tags on update', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  const updated = await store.update(task.id, { tags: ['work', 'work'] });

  assert.deepEqual(updated.tags, ['work']);
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

test('lists only tasks with the given tag', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const home = await store.create('Mow lawn', null, 'normal', ['home']);
  await store.create('Write report', null, 'normal', ['work']);
  await store.create('No tags');

  const tasks = store.list({ tag: 'home' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [home.id],
  );
});

test('combines tag and overdue filters with AND', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const overdueHome = await store.create('Overdue home', '2020-01-01', 'normal', ['home']);
  await store.create('Overdue work', '2020-01-01', 'normal', ['work']);
  await store.create('Future home', '2099-01-01', 'normal', ['home']);

  const tasks = store.list({ tag: 'home', overdue: true });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [overdueHome.id],
  );
});

test('AC1: store.list({ sort: "priority" }) orders high before normal before low', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const low = await store.create('Low priority task', null, 'low');
  const high = await store.create('High priority task', null, 'high');
  const normal = await store.create('Normal priority task', null, 'normal');

  const tasks = store.list({ sort: 'priority' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [high.id, normal.id, low.id],
  );
});

test('AC2: store.list({ sort: "priority" }) orders tasks within a tier by due date ascending', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const late = await store.create('Late', '2026-03-01', 'high');
  const early = await store.create('Early', '2026-01-01', 'high');
  const mid = await store.create('Mid', '2026-02-01', 'high');

  const tasks = store.list({ sort: 'priority' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [early.id, mid.id, late.id],
  );
});

test('AC3: store.list({ sort: "priority" }) sorts undated tasks after dated tasks within a tier', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const undated = await store.create('No due date', null, 'high');
  const dated = await store.create('Has a due date', '2026-01-01', 'high');

  const tasks = store.list({ sort: 'priority' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [dated.id, undated.id],
  );
});

test('AC5: store.list({ sort: "priority", overdue: true }) filters by overdue first, then sorts by priority', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const overdueLow = await store.create('Overdue low', '2020-01-02', 'low');
  const overdueHigh = await store.create('Overdue high', '2020-01-01', 'high');
  await store.create('Future high', '2099-01-01', 'high');

  const tasks = store.list({ sort: 'priority', overdue: true });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [overdueHigh.id, overdueLow.id],
  );
});

test('AC5: store.list({ sort: "priority", tag }) filters by tag first, then sorts by priority', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const homeLow = await store.create('Home low', null, 'low', ['home']);
  const homeHigh = await store.create('Home high', null, 'high', ['home']);
  await store.create('Work high', null, 'high', ['work']);

  const tasks = store.list({ sort: 'priority', tag: 'home' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [homeHigh.id, homeLow.id],
  );
});

test('AC5: store.list({ sort: "priority", overdue: true, tag }) applies both filters, then sorts by priority', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const overdueHomeLow = await store.create('Overdue home low', '2020-01-02', 'low', ['home']);
  const overdueHomeHigh = await store.create('Overdue home high', '2020-01-01', 'high', ['home']);
  await store.create('Overdue work high', '2020-01-01', 'high', ['work']);
  await store.create('Future home high', '2099-01-01', 'high', ['home']);

  const tasks = store.list({ sort: 'priority', overdue: true, tag: 'home' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [overdueHomeHigh.id, overdueHomeLow.id],
  );
});

test('AC6: store.list() without a sort option keeps insertion order', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const a = await store.create('First', null, 'low');
  const b = await store.create('Second', null, 'high');
  const c = await store.create('Third', null, 'normal');

  const tasks = store.list();

  assert.deepEqual(
    tasks.map((t) => t.id),
    [a.id, b.id, c.id],
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
    { id: task.id, title: 'Buy milk', completed: true, due: null, priority: 'normal', tags: [] },
  ]);
});

test('loads pre-existing tasks written before due dates existed, defaulting due to null', async () => {
  const dbPath = await tempDbPath();
  await writeFile(dbPath, JSON.stringify([{ id: 'legacy-1', title: 'Buy milk', completed: false }]));

  const store = new TaskStore(dbPath);
  await store.load();

  assert.deepEqual(store.list(), [
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [] },
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
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [] },
  ]);
});

test('loads pre-existing tasks written before tags existed, defaulting tags to an empty array', async () => {
  const dbPath = await tempDbPath();
  await writeFile(
    dbPath,
    JSON.stringify([
      { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal' },
    ]),
  );

  const store = new TaskStore(dbPath);
  await store.load();

  assert.deepEqual(store.list(), [
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [] },
  ]);
});

test('AC1: isValidSort accepts "due" in addition to "priority"', () => {
  assert.equal(isValidSort('due'), true);
  assert.equal(isValidSort('priority'), true);
  assert.equal(isValidSort('bogus'), false);
});

test('AC1: store.list({ sort: "due" }) orders tasks by due date ascending', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const late = await store.create('Late', '2026-03-01');
  const early = await store.create('Early', '2026-01-01');
  const mid = await store.create('Mid', '2026-02-01');

  const tasks = store.list({ sort: 'due' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [early.id, mid.id, late.id],
  );
});

test('AC1: store.list({ sort: "due" }) places undated tasks after all dated tasks', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const undated = await store.create('No due date');
  const dated = await store.create('Has a due date', '2026-01-01');

  const tasks = store.list({ sort: 'due' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [dated.id, undated.id],
  );
});

test('AC1: store.list({ sort: "due" }) keeps insertion order among tasks with equal due dates, and among undated tasks, while still grouping dated before undated', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const firstUndated = await store.create('First undated');
  const firstSameDate = await store.create('First same date', '2026-01-01');
  const secondUndated = await store.create('Second undated');
  const secondSameDate = await store.create('Second same date', '2026-01-01');

  const tasks = store.list({ sort: 'due' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [firstSameDate.id, secondSameDate.id, firstUndated.id, secondUndated.id],
  );
});

test('AC1: store.list({ sort: "due", overdue: true }) filters by overdue first, then sorts by due date ascending', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const overdueLate = await store.create('Overdue late', '2020-01-02');
  const overdueEarly = await store.create('Overdue early', '2020-01-01');
  await store.create('Future', '2099-01-01');

  const tasks = store.list({ sort: 'due', overdue: true });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [overdueEarly.id, overdueLate.id],
  );
});

test('AC2: store.list({ sort: "priority" }) still orders by priority tier, then due date ascending with undated last, now that "due" is also a valid sort value', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const lowUndated = await store.create('Low undated', null, 'low');
  const highLate = await store.create('High late', '2026-03-01', 'high');
  const highEarly = await store.create('High early', '2026-01-01', 'high');
  const highUndated = await store.create('High undated', null, 'high');
  const normal = await store.create('Normal', null, 'normal');

  const tasks = store.list({ sort: 'priority' });

  assert.deepEqual(
    tasks.map((t) => t.id),
    [highEarly.id, highLate.id, highUndated.id, normal.id, lowUndated.id],
  );
});

test('AC6: creates a task with a default note of an empty string', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();

  const task = await store.create('Buy milk');

  assert.equal(task.note, '');
});

test('AC3/AC5: sets and clears a note independently of completed', async () => {
  const store = new TaskStore(await tempDbPath());
  await store.load();
  const task = await store.create('Buy milk');

  const withNote = await store.update(task.id, { note: 'Ask Sam about the delivery window.' });
  assert.equal(withNote.note, 'Ask Sam about the delivery window.');
  assert.equal(withNote.completed, false);

  const cleared = await store.update(task.id, { note: '' });
  assert.equal(cleared.note, '');
});

test('AC7: loads pre-existing tasks written before notes existed, defaulting note to an empty string', async () => {
  const dbPath = await tempDbPath();
  await writeFile(
    dbPath,
    JSON.stringify([
      { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [] },
    ]),
  );

  const store = new TaskStore(dbPath);
  await store.load();

  assert.deepEqual(store.list(), [
    { id: 'legacy-1', title: 'Buy milk', completed: false, due: null, priority: 'normal', tags: [], note: '' },
  ]);
});

test('AC8: persists a note to the JSON file so it survives a restart', async () => {
  const dbPath = await tempDbPath();

  const first = new TaskStore(dbPath);
  await first.load();
  const task = await first.create('Buy milk');
  await first.update(task.id, { note: 'Ask Sam about the delivery window.' });

  const second = new TaskStore(dbPath);
  await second.load();
  assert.equal(second.list()[0].note, 'Ask Sam about the delivery window.');
});

test('isValidTags accepts only arrays of lowercase-letter strings', () => {
  assert.equal(isValidTags([]), true);
  assert.equal(isValidTags(['home', 'urgent']), true);
  assert.equal(isValidTags('home'), false);
  assert.equal(isValidTags(['Home']), false);
  assert.equal(isValidTags(['home-town']), false);
  assert.equal(isValidTags(['home2']), false);
  assert.equal(isValidTags([' home']), false);
  assert.equal(isValidTags(['']), false);
  assert.equal(isValidTags([1]), false);
  assert.equal(isValidTags(null), false);
});
