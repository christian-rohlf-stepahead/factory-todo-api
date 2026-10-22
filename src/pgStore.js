// Postgres-backed TaskStore is not implemented yet; a later change makes this
// read and write tasks through the injected database client instead of
// throwing. Its public shape (load/list/create/update/setCompleted/delete)
// mirrors the JSON-backed TaskStore in ./store.js.
export class TaskStore {
  constructor(client) {
    this.client = client;
  }

  async load() {}

  async list() {
    return [];
  }

  async create() {
    throw new Error('Postgres-backed TaskStore is not implemented yet.');
  }

  async update() {
    throw new Error('Postgres-backed TaskStore is not implemented yet.');
  }

  async setCompleted(id, completed) {
    return this.update(id, { completed });
  }

  async delete() {
    throw new Error('Postgres-backed TaskStore is not implemented yet.');
  }
}
