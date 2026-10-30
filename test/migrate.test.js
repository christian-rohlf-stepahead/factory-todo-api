import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { TaskStore } from '../src/pgStore.js';
import { createFakeClient } from './helpers/fakePgClient.js';

test('AC1: migrate() seeds exactly three example todos on a fresh database', async () => {
  const client = createFakeClient();

  await migrate(client);

  const store = new TaskStore(client);
  await store.load();
  const tasks = await store.list();

  assert.equal(tasks.length, 3);
});

test('AC1: the seeded todos exercise every displayed field: an overdue high-priority tagged todo, a completed low-priority todo, and a plain open todo with a future due date', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();
  const tasks = await store.list();
  const today = new Date().toISOString().slice(0, 10);

  const overdueHigh = tasks.find(
    (t) => t.priority === 'high' && !t.completed && t.due !== null && t.due < today,
  );
  assert.ok(overdueHigh, 'expected an overdue, high-priority, not-completed seeded todo');
  assert.ok(Array.isArray(overdueHigh?.tags) && overdueHigh.tags.length > 0, 'expected it to have tags');

  const completedLow = tasks.find((t) => t.completed && t.priority === 'low');
  assert.ok(completedLow, 'expected a completed, low-priority seeded todo');

  const futurePlain = tasks.find((t) => !t.completed && t.due !== null && t.due > today);
  assert.ok(futurePlain, 'expected a plain open seeded todo with a future due date');
});

test("AC1: every seeded todo has a non-empty title and a generated id, and uses no real person's data", async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();
  const tasks = await store.list();

  assert.equal(tasks.length, 3);
  for (const task of tasks) {
    assert.ok(task.id, 'expected every seeded todo to have an id');
    assert.equal(typeof task.title, 'string');
    assert.ok(task.title.trim().length > 0, 'expected every seeded todo to have a non-empty title');
    assert.ok(!/@/.test(task.title), "seed titles must not look like a real person's e-mail address");
  }
});

test('AC1: migrate() creates the schema so tasks created afterwards persist and round-trip every field', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();

  const created = await store.create('Buy milk', '2026-11-01', 'high', ['home']);
  const tasks = await store.list();
  const found = tasks.find((t) => t.id === created.id);

  assert.ok(found, 'expected the newly created task to be stored');
  assert.equal(found.title, 'Buy milk');
  assert.equal(found.completed, false);
  assert.equal(found.due, '2026-11-01');
  assert.equal(found.priority, 'high');
  assert.deepEqual(found.tags, ['home']);
});

test('AC4: migrate() seeds exactly the three todos the intent and its browser tests rely on: "Renew the parking permit" (overdue), "Water the office plants" (done, no due date), and "Plan the team offsite" (due in future)', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();
  const tasks = await store.list();
  const today = new Date().toISOString().slice(0, 10);

  assert.equal(tasks.length, 3);

  const parkingPermit = tasks.find((t) => t.title === 'Renew the parking permit');
  assert.ok(parkingPermit, 'expected a seeded todo titled "Renew the parking permit"');
  assert.equal(parkingPermit.completed, false);
  assert.ok(parkingPermit.due !== null && parkingPermit.due < today, 'expected it to be overdue');

  const officePlants = tasks.find((t) => t.title === 'Water the office plants');
  assert.ok(officePlants, 'expected a seeded todo titled "Water the office plants"');
  assert.equal(officePlants.completed, true);
  assert.equal(officePlants.due, null);

  const teamOffsite = tasks.find((t) => t.title === 'Plan the team offsite');
  assert.ok(teamOffsite, 'expected a seeded todo titled "Plan the team offsite"');
  assert.equal(teamOffsite.completed, false);
  assert.ok(teamOffsite.due !== null && teamOffsite.due > today, 'expected it to be due in the future');
});

test('AC9: migrate() itself adds a note column to the database and backfills a pre-existing row with an empty note', async () => {
  const client = createFakeClient();
  await client.query(
    'INSERT INTO tasks (id, title, completed, due, priority, tags) VALUES ($1, $2, $3, $4, $5, $6)',
    ['legacy-1', 'Buy milk', false, null, 'normal', []],
  );

  await migrate(client);

  // Query the column directly, bypassing pgStore.js's row mapping: this can
  // only succeed if migrate() itself declared the column in the database, not
  // if some other layer merely defaults a missing `note` in application code.
  const { rows } = await client.query('SELECT note FROM tasks WHERE id = $1', ['legacy-1']);
  assert.equal(rows[0]?.note, '');
});

test('AC9: a note set through the Postgres-backed store after migrate() is actually stored in the column the migration added', async () => {
  const client = createFakeClient();
  await migrate(client);
  const store = new TaskStore(client);
  await store.load();
  const created = await store.create('Buy milk');

  await store.update(created.id, { note: 'Ask Sam about the delivery window.' });

  // Re-read the column directly from the database rather than trusting the
  // store's return value, so an implementation that only threads `note`
  // through in-memory objects without persisting it via the migrated column
  // cannot pass this.
  const { rows } = await client.query('SELECT note FROM tasks WHERE id = $1', [created.id]);
  assert.equal(rows[0]?.note, 'Ask Sam about the delivery window.');
});

test('AC1: migrate() is idempotent — running it again on an already-seeded database does not duplicate the seed todos', async () => {
  const client = createFakeClient();

  await migrate(client);
  await migrate(client);

  const store = new TaskStore(client);
  await store.load();
  const tasks = await store.list();

  assert.equal(tasks.length, 3, 'expected re-running the migration not to duplicate seed data');
});
