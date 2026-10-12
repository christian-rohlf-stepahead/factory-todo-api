import path from 'node:path';
import { createServer } from './server.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.TODO_DB_PATH || path.join(process.cwd(), 'data', 'tasks.json');

const server = await createServer({ dbPath });
server.listen(port, () => {
  console.log(`Todo API listening on http://localhost:${port} (storing tasks in ${dbPath})`);
});
