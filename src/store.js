import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class TaskNotFoundError extends Error {
  constructor(id) {
    super(`Task not found: ${id}`);
    this.name = 'TaskNotFoundError';
    this.id = id;
  }
}

const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDueDate(value) {
  if (typeof value !== 'string' || !DUE_DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export class TaskStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.tasks = [];
  }

  async load() {
    try {
      const raw = await readFile(this.dbPath, 'utf8');
      this.tasks = JSON.parse(raw).map((task) => ({ due: null, ...task }));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.tasks = [];
    }
  }

  async #save() {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, JSON.stringify(this.tasks, null, 2));
  }

  list() {
    return this.tasks.map((task) => ({ ...task }));
  }

  async create(title, due = null) {
    const task = { id: randomUUID(), title, completed: false, due };
    this.tasks.push(task);
    await this.#save();
    return { ...task };
  }

  #find(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  async setCompleted(id, completed) {
    return this.update(id, { completed });
  }

  async update(id, { completed, due } = {}) {
    const task = this.#find(id);
    if (completed !== undefined) task.completed = completed;
    if (due !== undefined) task.due = due;
    await this.#save();
    return { ...task };
  }

  async delete(id) {
    this.#find(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.#save();
  }
}
