# Todo API

An HTTP JSON API for a simple todo list. Tasks are persisted to Postgres, so
the list survives an API restart. There is no authentication; this is a local
proof-of-concept.

## Requirements

- Node.js 22 or later
- A Postgres database, when running against Postgres (see below)

## Running locally

```sh
npm start
```

By default — with no `DATABASE_URL` set — the API listens on
`http://localhost:3000` and stores tasks in `./data/tasks.json` (created
automatically on first write), for local development without a database.

Configure these with environment variables:

- `PORT` — port to listen on (default `3000`)
- `DATABASE_URL` — a Postgres connection string (e.g.
  `postgres://user:pass@localhost:5432/todo`). When set, the API connects to
  Postgres, runs its migration (creating the schema and, on a fresh database,
  seeding three example todos) on startup, and stores tasks there instead of
  the JSON file.
- `TODO_DB_PATH` — path to the JSON file used for storage when `DATABASE_URL`
  is not set (default `./data/tasks.json`)

```sh
PORT=4000 DATABASE_URL=postgres://user:pass@localhost:5432/todo npm start
```

## Running the tests

```sh
npm test
```

## API

All request and response bodies are JSON. A task has the shape:

```json
{ "id": "...", "title": "...", "completed": false, "due": null, "priority": "normal", "tags": [] }
```

`due` is an optional due date as an ISO `YYYY-MM-DD` string, or `null` if none
is set.

`priority` is one of `"low"`, `"normal"`, or `"high"`, defaulting to
`"normal"`.

`tags` is an array of lowercase-letter strings (`a`-`z` only, e.g. `"home"`),
defaulting to `[]`. Duplicate tags given for the same task are silently
reduced to their distinct set.

### `POST /tasks`

Create a task.

Request body: `{ "title": "Buy milk", "due": "2026-11-01", "priority": "high", "tags": ["home"] }`
(`due`, `priority`, and `tags` are all optional; omit `due` to leave the task
with no due date, omit `priority` to default it to `"normal"`, and omit
`tags` to default it to `[]`)

Response: `201 Created` with the new task, including its generated `id`, or
`400 Bad Request` if `due` is present and isn't a valid `YYYY-MM-DD` date, if
`priority` is present and isn't `"low"`, `"normal"`, or `"high"`, or if `tags`
is present and isn't an array of lowercase-letter strings.

### `GET /tasks`

List all tasks.

Query parameters:

- `overdue` — when `true`, only return tasks that are not completed and have
  a due date strictly before today (UTC). Tasks with no due date, a due date
  of today or later, or that are completed, are excluded. Any other value, or
  omitting the parameter, returns all tasks.
- `tag` — only return tasks whose `tags` include this value. Omitting the
  parameter returns tasks regardless of tag.
- `sort` — when `priority`, order results by priority: `high` tasks first,
  then `normal`, then `low`. Within a priority tier, tasks are ordered by
  `due` date ascending (soonest first); undated tasks come after all dated
  tasks in that tier. Omitting the parameter keeps insertion order. Any other
  value returns `400 Bad Request` naming the accepted value (`priority`).

`overdue` and `tag` narrow the list (AND) before `sort` orders what remains.

Response: `200 OK` with an array of tasks, `400 Bad Request` if `sort` is
present and isn't `"priority"`.

### `PATCH /tasks/:id`

Update a task's `completed` status, `due` date, `priority`, `tags`, or any
combination of the four.

Request body: `{ "completed": true }` and/or `{ "due": "2026-11-01" }`
and/or `{ "priority": "high" }` and/or `{ "tags": ["home"] }` (send
`due: null` to clear a due date; sending `tags` replaces the task's whole tag
list, it does not merge with the existing one; at least one of `completed`,
`due`, `priority`, or `tags` must be present)

Response: `200 OK` with the updated task, `400 Bad Request` if `due` is
present, non-null, and not a valid `YYYY-MM-DD` date, if `priority` is
present and isn't `"low"`, `"normal"`, or `"high"`, if `tags` is present and
isn't an array of lowercase-letter strings, or `404 Not Found` if `:id`
doesn't exist.

### `DELETE /tasks/:id`

Delete a task.

Response: `204 No Content`, or `404 Not Found` if `:id` doesn't exist.

### Errors

Errors are returned as `{ "error": "..." }` with a `4xx` status code, e.g. a
`404` for an unknown task ID or a `400` for a missing/invalid request body.
