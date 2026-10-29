// A minimal in-memory stand-in for a `pg`-style database client (an object
// with an async `query(text, params)` method returning `{ rows }`), so
// Postgres-backed code can be exercised in tests without a real Postgres
// server. It understands only the small, generic subset of SQL a
// single-table `tasks` store needs: CREATE TABLE, ALTER TABLE ... ADD COLUMN
// IF NOT EXISTS ... DEFAULT '...' (backfills existing rows missing the
// column, like Postgres does), INSERT (with optional ON CONFLICT ... DO
// NOTHING and RETURNING), SELECT (optionally filtered by `WHERE id = $n`),
// UPDATE ... SET ... WHERE id = $n, and DELETE FROM tasks WHERE id = $n.

function resolveParam(placeholder, params) {
  const match = placeholder.match(/^\$(\d+)$/);
  if (!match) return undefined;
  return params[Number(match[1]) - 1];
}

function findWhereIdParamIndex(sql) {
  const match = sql.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
  return match ? Number(match[1]) - 1 : null;
}

export function createFakeClient() {
  let tasks = [];

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
        const idIdx = findWhereIdParamIndex(sql);
        const rows = idIdx === null ? tasks : tasks.filter((t) => t.id === params[idIdx]);
        return { rows: rows.map((t) => ({ ...t })) };
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
