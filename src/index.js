import path from 'node:path';
import pg from 'pg';
import { createServer } from './server.js';
import { migrate } from './migrate.js';

const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;

let server;
if (databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await migrate(client);
  server = await createServer({ client });
  console.log(`Todo API listening on http://localhost:${port} (storing tasks in Postgres)`);
} else {
  const dbPath = process.env.TODO_DB_PATH || path.join(process.cwd(), 'data', 'tasks.json');
  server = await createServer({ dbPath });
  console.log(`Todo API listening on http://localhost:${port} (storing tasks in ${dbPath})`);
}

server.listen(port);
