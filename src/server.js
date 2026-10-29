import { createServer as createHttpServer } from 'node:http';
import {
  TaskStore,
  TaskNotFoundError,
  isValidDueDate,
  isValidPriority,
  isValidTags,
  isValidSort,
  isValidNote,
} from './store.js';
import { TaskStore as PgTaskStore } from './pgStore.js';

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

export async function createServer({ dbPath, client } = {}) {
  const store = client ? new PgTaskStore(client) : new TaskStore(dbPath);
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
        const overdue = url.searchParams.get('overdue') === 'true';
        const tag = url.searchParams.get('tag') ?? undefined;
        const sort = url.searchParams.get('sort') ?? undefined;
        if (sort !== undefined && !isValidSort(sort)) {
          sendJson(res, 400, { error: '"sort" must be one of "priority", "due".' });
          return;
        }
        sendJson(res, 200, await store.list({ overdue, tag, sort }));
        return;
      }

      if (segments.length === 1 && req.method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
          sendJson(res, 400, { error: 'A non-empty "title" is required.' });
          return;
        }
        let due = null;
        if ('due' in body) {
          if (!isValidDueDate(body.due)) {
            sendJson(res, 400, { error: '"due" must be a valid "YYYY-MM-DD" date.' });
            return;
          }
          due = body.due;
        }
        let priority = 'normal';
        if ('priority' in body) {
          if (!isValidPriority(body.priority)) {
            sendJson(res, 400, { error: '"priority" must be one of "low", "normal", or "high".' });
            return;
          }
          priority = body.priority;
        }
        let tags = [];
        if ('tags' in body) {
          if (!isValidTags(body.tags)) {
            sendJson(res, 400, { error: '"tags" must be an array of lowercase-letter strings.' });
            return;
          }
          tags = body.tags;
        }
        let note = '';
        if ('note' in body) {
          if (!isValidNote(body.note)) {
            sendJson(res, 400, { error: '"note" must be a string of at most 500 characters.' });
            return;
          }
          note = body.note;
        }
        const task = await store.create(title, due, priority, tags, note);
        sendJson(res, 201, task);
        return;
      }

      if (segments.length === 2 && req.method === 'PATCH') {
        const id = segments[1];
        const body = await readJsonBody(req);
        const hasCompleted = 'completed' in body;
        const hasDue = 'due' in body;
        const hasPriority = 'priority' in body;
        const hasTags = 'tags' in body;
        const hasNote = 'note' in body;

        if (!hasCompleted && !hasDue && !hasPriority && !hasTags && !hasNote) {
          sendJson(res, 400, {
            error: 'At least one of "completed", "due", "priority", "tags", or "note" must be provided.',
          });
          return;
        }
        if (hasCompleted && typeof body.completed !== 'boolean') {
          sendJson(res, 400, { error: '"completed" must be a boolean.' });
          return;
        }
        if (hasDue && body.due !== null && !isValidDueDate(body.due)) {
          sendJson(res, 400, { error: '"due" must be a valid "YYYY-MM-DD" date, or null.' });
          return;
        }
        if (hasPriority && !isValidPriority(body.priority)) {
          sendJson(res, 400, { error: '"priority" must be one of "low", "normal", or "high".' });
          return;
        }
        if (hasTags && !isValidTags(body.tags)) {
          sendJson(res, 400, { error: '"tags" must be an array of lowercase-letter strings.' });
          return;
        }
        if (hasNote && !isValidNote(body.note)) {
          sendJson(res, 400, { error: '"note" must be a string of at most 500 characters.' });
          return;
        }
        const patch = {};
        if (hasCompleted) patch.completed = body.completed;
        if (hasDue) patch.due = body.due;
        if (hasPriority) patch.priority = body.priority;
        if (hasTags) patch.tags = body.tags;
        if (hasNote) patch.note = body.note;
        const task = await store.update(id, patch);
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
