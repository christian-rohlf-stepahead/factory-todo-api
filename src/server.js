import { createServer as createHttpServer } from 'node:http';
import { TaskStore, TaskNotFoundError } from './store.js';

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function createServer({ dbPath }) {
  const store = new TaskStore(dbPath);
  await store.load();

  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments[0] !== 'tasks') {
        sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
        return;
      }

      if (segments.length === 1 && req.method === 'GET') {
        sendJson(res, 200, store.list());
        return;
      }

      if (segments.length === 1 && req.method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          sendJson(res, 400, { error: 'A non-empty "title" is required.' });
          return;
        }
        const task = await store.create(title);
        sendJson(res, 201, task);
        return;
      }

      if (segments.length === 2 && req.method === 'PATCH') {
        const id = segments[1];
        const body = await readJsonBody(req);
        if (typeof body.completed !== 'boolean') {
          sendJson(res, 400, { error: '"completed" must be a boolean.' });
          return;
        }
        const task = await store.setCompleted(id, body.completed);
        sendJson(res, 200, task);
        return;
      }

      if (segments.length === 2 && req.method === 'DELETE') {
        const id = segments[1];
        await store.delete(id);
        res.writeHead(204);
        res.end();
        return;
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        sendJson(res, 404, { error: err.message });
        return;
      }
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  });
}
