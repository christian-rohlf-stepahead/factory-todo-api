# Todo API

An HTTP JSON API for a simple todo list. Tasks are persisted to a JSON file on
disk, so the list survives an API restart. There is no authentication; this
is a local proof-of-concept.

## Requirements

- Node.js 22 or later (uses only built-in modules — no dependencies to install)

## Running locally

```sh
npm start
```

By default the API listens on `http://localhost:3000` and stores tasks in
`./data/tasks.json` (created automatically on first write).

Configure these with environment variables:

- `PORT` — port to listen on (default `3000`)
- `TODO_DB_PATH` — path to the JSON file used for storage (default `./data/tasks.json`)

```sh
PORT=4000 TODO_DB_PATH=/tmp/tasks.json npm start
```

## Running the tests

```sh
npm test
```

## API

All request and response bodies are JSON. A task has the shape:

```json
{ "id": "...", "title": "...", "completed": false, "due": null }
```

`due` is an optional due date as an ISO `YYYY-MM-DD` string, or `null` if none
is set.

### `POST /tasks`

Create a task.

Request body: `{ "title": "Buy milk", "due": "2026-11-01" }` (`due` is
optional; omit it to leave the task with no due date)

Response: `201 Created` with the new task, including its generated `id`, or
`400 Bad Request` if `due` is present and isn't a valid `YYYY-MM-DD` date.

### `GET /tasks`

List all tasks.

Query parameters:

- `overdue` — when `true`, only return tasks that are not completed and have
  a due date strictly before today (UTC). Tasks with no due date, a due date
  of today or later, or that are completed, are excluded. Any other value, or
  omitting the parameter, returns all tasks.

Response: `200 OK` with an array of tasks.

### `PATCH /tasks/:id`

Update a task's `completed` status, `due` date, or both.

Request body: `{ "completed": true }` and/or `{ "due": "2026-11-01" }` (send
`due: null` to clear a due date; at least one of `completed` or `due` must be
present)

Response: `200 OK` with the updated task, `400 Bad Request` if `due` is
present, non-null, and not a valid `YYYY-MM-DD` date, or `404 Not Found` if
`:id` doesn't exist.

### `DELETE /tasks/:id`

Delete a task.

Response: `204 No Content`, or `404 Not Found` if `:id` doesn't exist.

### Errors

Errors are returned as `{ "error": "..." }` with a `4xx` status code, e.g. a
`404` for an unknown task ID or a `400` for a missing/invalid request body.
