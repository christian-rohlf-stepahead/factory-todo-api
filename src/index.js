import path from 'node:path';
import pg from 'pg';
import { createServer } from './server.js';
import { migrate } from './migrate.js';

const port = Number(process.env.PORT) || 3000;
const databaseUrl = process.env.DATABASE_URL;

let server;
if (databaseUrl) {
  // A pool, not a single Client: the server handles concurrent requests, and
  // a lone Client rejects (and can crash the process on an unhandled 'error'
  // event) when a second query arrives while one is still in flight.
  const client = new pg.Pool({ connectionString: databaseUrl });
  // A Pool emits 'error' for a backend/network problem on an idle pooled
  // client, separately from any in-flight query's own rejection; with no
  // listener, Node's default EventEmitter behaviour is to crash the process.
  client.on('error', (err) => {
    console.error('Unexpected error on an idle Postgres client', err);
  });
  await migrate(client);
  server = await createServer({ client });
  console.log(`Todo API listening on http://localhost:${port} (storing tasks in Postgres)`);
} else {
  const dbPath = process.env.TODO_DB_PATH || path.join(process.cwd(), 'data', 'tasks.json');
  server = await createServer({ dbPath });
  console.log(`Todo API listening on http://localhost:${port} (storing tasks in ${dbPath})`);
}

server.listen(port);
