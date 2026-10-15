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

export const PRIORITIES = ['low', 'normal', 'high'];

export function isValidPriority(value) {
  return PRIORITIES.includes(value);
}

const TAG_RE = /^[a-z]+$/;

export function isValidTag(value) {
  return typeof value === 'string' && TAG_RE.test(value);
}

export function isValidTags(value) {
  return Array.isArray(value) && value.every(isValidTag);
}

function dedupeTags(tags) {
  return [...new Set(tags)];
}

export class TaskStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.tasks = [];
  }

  async load() {
    try {
      const raw = await readFile(this.dbPath, 'utf8');
      this.tasks = JSON.parse(raw).map((task) => ({ due: null, priority: 'normal', tags: [], ...task }));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.tasks = [];
    }
  }

  async #save() {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    await writeFile(this.dbPath, JSON.stringify(this.tasks, null, 2));
  }

  list({ overdue } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const tasks = overdue
      ? this.tasks.filter((task) => !task.completed && task.due !== null && task.due < today)
      : this.tasks;
    return tasks.map((task) => ({ ...task }));
  }

  async create(title, due = null, priority = 'normal', tags = []) {
    const task = { id: randomUUID(), title, completed: false, due, priority, tags: dedupeTags(tags) };
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

  async update(id, { completed, due, priority, tags } = {}) {
    const task = this.#find(id);
    if (completed !== undefined) task.completed = completed;
    if (due !== undefined) task.due = due;
    if (priority !== undefined) task.priority = priority;
    if (tags !== undefined) task.tags = dedupeTags(tags);
    await this.#save();
    return { ...task };
  }

  async delete(id) {
    this.#find(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.#save();
  }
}
