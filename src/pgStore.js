import { randomUUID } from 'node:crypto';
import { TaskNotFoundError } from './store.js';

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function compareDue(a, b) {
  if (a.due === null && b.due === null) return 0;
  if (a.due === null) return 1;
  if (b.due === null) return -1;
  return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
}

function dedupeTags(tags) {
  return [...new Set(tags)];
}

function toTask(row) {
  const task = {
    id: row.id,
    title: row.title,
    completed: row.completed,
    due: row.due ?? null,
    priority: row.priority,
    tags: row.tags ?? [],
  };
  if ('note' in row) task.note = row.note ?? '';
  return task;
}

const BASE_COLUMNS = 'id, title, completed, due, priority, tags';

// Postgres-backed TaskStore. Mirrors the JSON-backed TaskStore in ./store.js
// (load/list/create/update/setCompleted/delete), but every operation reads
// and writes through the injected database `client` instead of an in-memory
// array, so state lives in the database and is shared across instances.
export class TaskStore {
  constructor(client) {
    this.client = client;
    this.hasNote = false;
  }

  // Probes whether migrate() has added the `note` column yet, so the
  // store can keep working against a database (or test double) where it
  // hasn't: production always runs migrate() before serving traffic, so
  // this only matters for code exercising the store in isolation.
  async load() {
    try {
      await this.client.query('SELECT note FROM tasks LIMIT 1');
      this.hasNote = true;
    } catch {
      this.hasNote = false;
    }
  }

  #columns() {
    return this.hasNote ? `${BASE_COLUMNS}, note` : BASE_COLUMNS;
  }

  async list({ overdue, tag, sort } = {}) {
    const { rows } = await this.client.query(
      `SELECT ${this.#columns()} FROM tasks ORDER BY seq ASC`,
    );
    let tasks = rows.map(toTask);

    const today = new Date().toISOString().slice(0, 10);
    if (overdue) {
      tasks = tasks.filter((task) => !task.completed && task.due !== null && task.due < today);
    }
    if (tag !== undefined) {
      tasks = tasks.filter((task) => task.tags.includes(tag));
    }
    if (sort === 'priority') {
      tasks = [...tasks].sort((a, b) => {
        const priorityDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return compareDue(a, b);
      });
    } else if (sort === 'due') {
      tasks = [...tasks].sort(compareDue);
    }
    return tasks;
  }

  async create(title, due = null, priority = 'normal', tags = [], note = '') {
    const task = { id: randomUUID(), title, completed: false, due, priority, tags: dedupeTags(tags) };
    if (this.hasNote) {
      task.note = note;
      await this.client.query(
        'INSERT INTO tasks (id, title, completed, due, priority, tags, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [task.id, task.title, task.completed, task.due, task.priority, task.tags, note],
      );
    } else {
      await this.client.query(
        'INSERT INTO tasks (id, title, completed, due, priority, tags) VALUES ($1, $2, $3, $4, $5, $6)',
        [task.id, task.title, task.completed, task.due, task.priority, task.tags],
      );
    }
    return { ...task };
  }

  async #find(id) {
    const { rows } = await this.client.query(
      `SELECT ${this.#columns()} FROM tasks WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) throw new TaskNotFoundError(id);
    return toTask(rows[0]);
  }

  async setCompleted(id, completed) {
    return this.update(id, { completed });
  }

  async update(id, { completed, due, priority, tags, note } = {}) {
    const task = await this.#find(id);
    if (completed !== undefined) task.completed = completed;
    if (due !== undefined) task.due = due;
    if (priority !== undefined) task.priority = priority;
    if (tags !== undefined) task.tags = dedupeTags(tags);
    if (note !== undefined && this.hasNote) task.note = note;

    if (this.hasNote) {
      await this.client.query(
        'UPDATE tasks SET title = $2, completed = $3, due = $4, priority = $5, tags = $6, note = $7 WHERE id = $1',
        [task.id, task.title, task.completed, task.due, task.priority, task.tags, task.note],
      );
    } else {
      await this.client.query(
        'UPDATE tasks SET title = $2, completed = $3, due = $4, priority = $5, tags = $6 WHERE id = $1',
        [task.id, task.title, task.completed, task.due, task.priority, task.tags],
      );
    }
    return { ...task };
  }

  async delete(id) {
    await this.#find(id);
    await this.client.query('DELETE FROM tasks WHERE id = $1', [id]);
  }
}
