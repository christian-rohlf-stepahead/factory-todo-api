// Fixed ids for the three seed todos, so re-running the migration against an
// already-seeded database is a no-op (ON CONFLICT (id) DO NOTHING) instead of
// duplicating them.
const SEED_IDS = {
  overdueHigh: '00000000-0000-4000-8000-000000000001',
  completedLow: '00000000-0000-4000-8000-000000000002',
  futurePlain: '00000000-0000-4000-8000-000000000003',
};

function isoDateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function seedTasks() {
  return [
    {
      id: SEED_IDS.overdueHigh,
      title: 'Renew the parking permit',
      completed: false,
      due: isoDateOffset(-7),
      priority: 'high',
      tags: ['errands'],
      note: '',
    },
    {
      id: SEED_IDS.completedLow,
      title: 'Water the office plants',
      completed: true,
      due: null,
      priority: 'low',
      tags: [],
      note: '',
    },
    {
      id: SEED_IDS.futurePlain,
      title: 'Plan the team offsite',
      completed: false,
      due: isoDateOffset(30),
      priority: 'normal',
      tags: [],
      note: '',
    },
  ];
}

// Creates the `tasks` schema if it doesn't exist yet, and seeds the three
// example todos every fresh deployment starts with. Safe to run on every
// startup: both the table creation and the seed inserts are no-ops when
// already applied.
export async function migrate(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      seq SERIAL PRIMARY KEY,
      id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      completed BOOLEAN NOT NULL DEFAULT false,
      due TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags TEXT[] NOT NULL DEFAULT '{}'
    )
  `);

  await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT ''`);

  for (const seed of seedTasks()) {
    await client.query(
      'INSERT INTO tasks (id, title, completed, due, priority, tags, note) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [seed.id, seed.title, seed.completed, seed.due, seed.priority, seed.tags, seed.note],
    );
  }
}
