// A minimal in-memory stand-in for a `pg`-style database client (an object
// with an async `query(text, params)` method returning `{ rows }`), so
// Postgres-backed code can be exercised in tests without a real Postgres
// server. It understands only the small, generic subset of SQL a
// single-table `tasks` store needs: CREATE TABLE, ALTER TABLE ... ADD COLUMN
// IF NOT EXISTS ... DEFAULT '...' (backfills existing rows missing the
// column, like Postgres does), INSERT (with optional ON CONFLICT ... DO
// NOTHING and RETURNING), SELECT (optionally filtered by `WHERE id = $n`),
// UPDATE ... SET ... WHERE id = $n, and DELETE FROM tasks WHERE id = $n.
//
// It tracks which columns exist, seeded with the columns this product's
// tasks table has always had, plus any a test adds via ALTER TABLE — same as
// Postgres, SELECT/UPDATE on an undeclared column throws. This lets a test
// tell a real migration apart from an app-layer stand-in: a column only
// pgStore.js knows about, that migrate() never declared, doesn't exist here
// either.

const BASELINE_COLUMNS = ['seq', 'id', 'title', 'completed', 'due', 'priority', 'tags'];

function resolveParam(placeholder, params) {
  const match = placeholder.match(/^\$(\d+)$/);
  if (!match) return undefined;
  return params[Number(match[1]) - 1];
}

function findWhereIdParamIndex(sql) {
  const match = sql.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
  return match ? Number(match[1]) - 1 : null;
}

function splitList(text) {
  return text.split(',').map((part) => part.trim()).filter(Boolean);
}

export function createFakeClient() {
  let tasks = [];
  const columns = new Set(BASELINE_COLUMNS);

  return {
    async query(text, params = []) {
      const sql = text.trim();

      if (/^CREATE TABLE/i.test(sql)) {
        return { rows: [] };
      }

      if (/^ALTER TABLE/i.test(sql)) {
        const match = sql.match(
          /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)\s+\w+(?:\([^)]*\))?(?:\s+NOT NULL)?\s+DEFAULT\s+'([^']*)'/i,
        );
        if (!match) throw new Error(`Unsupported ALTER TABLE in fake client: ${sql}`);
        const [, column, defaultValue] = match;
        columns.add(column);
        for (const task of tasks) {
          if (!(column in task)) task[column] = defaultValue;
        }
        return { rows: [] };
      }

      if (/^INSERT INTO tasks/i.test(sql)) {
        const match = sql.match(/\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (!match) throw new Error(`Unsupported INSERT in fake client: ${sql}`);
        const columns = match[1].split(',').map((c) => c.trim());
        const placeholders = match[2].split(',').map((p) => p.trim());
        const row = {};
        columns.forEach((col, i) => {
          row[col] = resolveParam(placeholders[i], params);
        });

        if (/ON CONFLICT/i.test(sql) && tasks.some((t) => t.id === row.id)) {
          return { rows: [] };
        }

        tasks.push(row);
        return { rows: /RETURNING/i.test(sql) ? [{ ...row }] : [] };
      }

      if (/^SELECT/i.test(sql) && /FROM tasks/i.test(sql)) {
        const columnsMatch = sql.match(/^SELECT\s+(.+?)\s+FROM\s+tasks/i);
        const requested = columnsMatch ? splitList(columnsMatch[1]) : ['*'];
        if (!requested.includes('*')) {
          for (const col of requested) {
            if (!columns.has(col)) throw new Error(`column "${col}" does not exist`);
          }
        }
        const idIdx = findWhereIdParamIndex(sql);
        const rows = idIdx === null ? tasks : tasks.filter((t) => t.id === params[idIdx]);
        return {
          rows: rows.map((t) =>
            requested.includes('*') ? { ...t } : Object.fromEntries(requested.map((col) => [col, t[col] ?? null])),
          ),
        };
      }

      if (/^UPDATE tasks/i.test(sql)) {
        const idIdx = findWhereIdParamIndex(sql);
        if (idIdx === null) throw new Error(`Unsupported UPDATE (no WHERE id) in fake client: ${sql}`);
        const task = tasks.find((t) => t.id === params[idIdx]);
        if (!task) return { rows: [] };

        const setClause = sql.match(/SET\s+(.+?)\s+WHERE/is);
        if (setClause) {
          for (const assignment of setClause[1].split(',')) {
            const [col, placeholder] = assignment.split('=').map((s) => s.trim());
            if (!columns.has(col)) throw new Error(`column "${col}" does not exist`);
            task[col] = resolveParam(placeholder, params);
          }
        }
        return { rows: /RETURNING/i.test(sql) ? [{ ...task }] : [] };
      }

      if (/^DELETE FROM tasks/i.test(sql)) {
        const idIdx = findWhereIdParamIndex(sql);
        if (idIdx === null) throw new Error(`Unsupported DELETE (no WHERE id) in fake client: ${sql}`);
        const before = tasks.length;
        tasks = tasks.filter((t) => t.id !== params[idIdx]);
        return { rows: [], rowCount: before - tasks.length };
      }

      throw new Error(`Unsupported query in fake client: ${sql}`);
    },
  };
}
