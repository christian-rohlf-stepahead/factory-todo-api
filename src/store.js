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

export class TaskStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.tasks = [];
  }

  async load() {
    try {
      const raw = await readFile(this.dbPath, 'utf8');
      this.tasks = JSON.parse(raw);
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

  async create(title) {
    const task = { id: randomUUID(), title, completed: false };
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
    const task = this.#find(id);
    task.completed = completed;
    await this.#save();
    return { ...task };
  }

  async delete(id) {
    this.#find(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.#save();
  }
}
