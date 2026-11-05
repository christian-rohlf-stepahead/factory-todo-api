// Static, sandbox-only checks of the pgAdmin deployment artefacts this work item
// adds to the Helm chart: a Deployment, Service, Ingress and the servers.json
// ConfigMap that pre-lists the chart's existing Postgres. Like test/deploy.test.js,
// these never shell out to docker, helm or a cluster (none are available in this
// sandbox); they read the chart and deploy.sh as text and pin the structure they
// must have so the criteria below hold once pgAdmin is actually deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { migrate } from '../src/migrate.js';
import { createFakeClient } from './helpers/fakePgClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readFile(relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch {
    return null;
  }
}

function listFilesRecursive(relDir) {
  const abs = path.join(repoRoot, relDir);
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  walk(abs);
  return out;
}

const CHART_DIR = 'deploy/chart';

function chartDocuments() {
  return listFilesRecursive(path.join(CHART_DIR, 'templates'))
    .filter((f) => /\.(ya?ml|tpl)$/.test(f))
    .map((f) => ({ file: path.relative(repoRoot, f), text: fs.readFileSync(f, 'utf8') }));
}

function docsOfKind(docs, kind) {
  return docs.filter((d) => new RegExp(`kind:\\s*${kind}\\b`).test(d.text));
}

function pgadminDocs(docs) {
  return docs.filter((d) => /pgadmin/i.test(d.text));
}

function findPgadminDeployment(docs) {
  return docsOfKind(docs, 'Deployment').find((d) => /\.Values\.pgadmin\.image/.test(d.text));
}

function findServersConfigMap(docs) {
  return docsOfKind(docs, 'ConfigMap').find((d) => /"Servers"/.test(d.text));
}

// Pulls out a top-level values.yaml block (e.g. everything indented under `pgadmin:`).
function yamlBlock(text, topKey) {
  const re = new RegExp(`^${topKey}:[ \\t]*\\n((?:[ \\t]+[^\\n]*\\n?)+)`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}

function yamlValue(block, key) {
  if (!block) return null;
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(.+?)[ \\t]*$`, 'm');
  const m = block.match(re);
  return m ? m[1] : null;
}

function unquote(value) {
  return value ? value.replace(/^['"]|['"]$/g, '') : value;
}

// Drives the real HTTP server over a Unix domain socket, the same way
// test/server.test.js does, so AC8's test exercises actual endpoint behaviour
// rather than inspecting source files.
async function startTestServer() {
  const dir = await mkdtemp(path.join(tmpdir(), 'todo-api-pgadmin-test-'));
  const dbPath = path.join(dir, 'tasks.json');
  const socketPath = path.join(dir, 'server.sock');
  const server = await createServer({ dbPath });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return { server, socketPath, dir };
}

async function stopTestServer({ server, dir }) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
  await rm(dir, { recursive: true, force: true });
}

function request(socketPath, { method = 'GET', path: reqPath, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: reqPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertRestrictedPodSecurity(text, label) {
  assert.match(text, /runAsNonRoot:\s*true/, `${label}: must set runAsNonRoot: true`);
  assert.match(text, /runAsUser:\s*\d+/, `${label}: must set a numeric runAsUser`);
  assert.match(text, /seccompProfile:/, `${label}: must set a seccompProfile`);
  assert.match(text, /type:\s*RuntimeDefault/, `${label}: seccompProfile must be RuntimeDefault`);
  assert.match(
    text,
    /allowPrivilegeEscalation:\s*false/,
    `${label}: must set allowPrivilegeEscalation: false`,
  );
  assert.match(text, /drop:[\s\S]{0,30}ALL/, `${label}: must drop the ALL capability`);
  assert.match(text, /requests:/, `${label}: must set resource requests`);
  assert.match(text, /limits:/, `${label}: must set resource limits`);
}

test('AC1: pgAdmin is added to the chart as a Deployment, Service and Ingress, deployed unconditionally (like Postgres) rather than gated behind an optional image', () => {
  const docs = chartDocuments();

  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');
  assert.doesNotMatch(
    deployment.text,
    /\{\{-?\s*if\s+\.Values\.pgadmin\.image/,
    "pgAdmin must deploy every time the chart deploys, not only when its image value happens to be truthy (unlike the optional web/webTerminal components, whose images come from other repositories)",
  );

  const service = docsOfKind(docs, 'Service').find((d) => /pgadmin/i.test(d.text));
  assert.ok(service, 'a Service must exist for pgAdmin');
  assert.doesNotMatch(service.text, /\{\{-?\s*if\s+\.Values\.pgadmin\.image/, 'the pgAdmin Service must not be gated behind .Values.pgadmin.image');

  const ingress = docsOfKind(docs, 'Ingress').find((d) => /\.Values\.pgadmin\.host/.test(d.text));
  assert.ok(ingress, 'an Ingress routed at .Values.pgadmin.host must exist for pgAdmin');
  assert.doesNotMatch(ingress.text, /\{\{-?\s*if\s+\.Values\.pgadmin\.image/, 'the pgAdmin Ingress must not be gated behind .Values.pgadmin.image');

  const valuesYaml = readFile(path.join(CHART_DIR, 'values.yaml'));
  assert.ok(valuesYaml, 'deploy/chart/values.yaml must exist');
  const pgadminBlock = yamlBlock(valuesYaml, 'pgadmin');
  assert.ok(pgadminBlock, 'values.yaml must declare a top-level pgadmin: block');
  const imageDefault = unquote(yamlValue(pgadminBlock, 'image'));
  assert.ok(
    imageDefault,
    'pgadmin.image must default to a real image reference (not blank like the optional web/webTerminal images), so pgAdmin deploys in every environment without the deploy step having to supply one',
  );
});

test("AC1: pgAdmin points at the chart's existing Postgres instance and credentials, not a second database", () => {
  const docs = chartDocuments();
  const pgadmin = pgadminDocs(docs);
  assert.ok(pgadmin.length > 0, 'at least one chart template must reference pgadmin');

  const combinedText = pgadmin.map((d) => d.text).join('\n');
  assert.match(
    combinedText,
    /\{\{\s*\.Release\.Name\s*\}\}-postgres/,
    "pgAdmin's configuration must reference the chart's existing {{ .Release.Name }}-postgres Service, not a new one",
  );
  assert.match(combinedText, /\.Values\.postgres\.database/, "pgAdmin's configuration must reuse .Values.postgres.database");
  assert.match(combinedText, /\.Values\.postgres\.user/, "pgAdmin's configuration must reuse .Values.postgres.user");

  const secrets = docsOfKind(docs, 'Secret').filter((d) => /POSTGRES_PASSWORD/.test(d.text));
  assert.equal(secrets.length, 1, 'no second set of Postgres credentials (a Secret holding POSTGRES_PASSWORD) should be introduced for pgAdmin');

  const statefulSets = docsOfKind(docs, 'StatefulSet');
  assert.equal(statefulSets.length, 1, 'pgAdmin must not stand up a second Postgres StatefulSet');
});

test("AC2: pgAdmin gets its own traefik Ingress host, named the same way as the app's other hosts", () => {
  const docs = chartDocuments();
  const ingress = docsOfKind(docs, 'Ingress').find((d) => /\.Values\.pgadmin\.host/.test(d.text));
  assert.ok(ingress, 'an Ingress routed at .Values.pgadmin.host must exist for pgAdmin');
  assert.match(ingress.text, /traefik/i, 'the pgAdmin Ingress must be routed through the traefik ingress class, like the api/web/webTerminal Ingresses');
  assert.match(
    ingress.text,
    /host:\s*\{\{\s*\.Values\.pgadmin\.host/,
    'the Ingress rule host must come from .Values.pgadmin.host, the same way .Values.api.host, .Values.web.host and .Values.webTerminal.host already do',
  );

  const valuesYaml = readFile(path.join(CHART_DIR, 'values.yaml'));
  const pgadminBlock = yamlBlock(valuesYaml || '', 'pgadmin');
  assert.equal(
    unquote(yamlValue(pgadminBlock, 'host')),
    '',
    'pgadmin.host must default to an empty string in values.yaml, like api.host/web.host/webTerminal.host, to be filled in by deploy.sh',
  );
});

test("AC2: deploy.sh passes pgAdmin's image and a derived host through to the chart, the same --set pattern used for api/web/webTerminal", () => {
  const deploySh = readFile('deploy/deploy.sh');
  assert.ok(deploySh, 'deploy/deploy.sh must exist');
  assert.match(deploySh, /--set\s+"pgadmin\.image=/, 'deploy.sh must pass pgadmin.image through with --set, like api.image/web.image/webTerminal.image');
  assert.match(deploySh, /--set\s+"pgadmin\.host=/, 'deploy.sh must pass pgadmin.host through with --set, like api.host/web.host/webTerminal.host');

  // pgAdmin is not its own declared repository/project in .factory/environment.json, so the
  // factory never provides a FACTORY_HOST_PGADMIN (see the "one project per FACTORY_HOST_*"
  // convention); deploy.sh must derive pgAdmin's host itself from a host the factory does give it.
  const factoryHostUses = deploySh.match(/FACTORY_HOST_TODO_API/g) || [];
  assert.ok(
    factoryHostUses.length >= 2,
    'deploy.sh must derive pgadmin.host from an existing FACTORY_HOST_* variable it already receives (e.g. FACTORY_HOST_TODO_API), since the factory never sets FACTORY_HOST_PGADMIN',
  );
  assert.doesNotMatch(
    deploySh,
    /FACTORY_HOST_PGADMIN/,
    'FACTORY_HOST_PGADMIN is never set by the factory (pgAdmin is not its own declared project); deploy.sh must not depend on it',
  );
});

test("AC3: pgAdmin gets its own hardcoded login, separate from Postgres's, templated into its environment", () => {
  const docs = chartDocuments();
  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');

  assert.match(deployment.text, /name:\s*PGADMIN_DEFAULT_EMAIL/, "pgAdmin's login is set via its documented PGADMIN_DEFAULT_EMAIL environment variable");
  assert.match(
    deployment.text,
    /PGADMIN_DEFAULT_EMAIL[\s\S]{0,80}\.Values\.pgadmin\.user\b/,
    'PGADMIN_DEFAULT_EMAIL must come from a new .Values.pgadmin.user value, its own login separate from .Values.postgres.user',
  );
  assert.match(deployment.text, /name:\s*PGADMIN_DEFAULT_PASSWORD/, "pgAdmin's login is set via its documented PGADMIN_DEFAULT_PASSWORD environment variable");
  assert.match(
    deployment.text,
    /PGADMIN_DEFAULT_PASSWORD[\s\S]{0,80}\.Values\.pgadmin\.password\b/,
    'PGADMIN_DEFAULT_PASSWORD must come from a new .Values.pgadmin.password value, its own login separate from .Values.postgres.password',
  );

  const valuesYaml = readFile(path.join(CHART_DIR, 'values.yaml'));
  const pgadminBlock = yamlBlock(valuesYaml || '', 'pgadmin');
  assert.ok(unquote(yamlValue(pgadminBlock, 'user')), 'values.yaml must set a non-empty pgadmin.user');
  assert.ok(unquote(yamlValue(pgadminBlock, 'password')), 'values.yaml must set a non-empty pgadmin.password');
});

test("AC3: pgAdmin's Ingress adds no gate beyond pgAdmin's own login (no basic-auth or auth middleware)", () => {
  const docs = chartDocuments();
  const ingress = docsOfKind(docs, 'Ingress').find((d) => /\.Values\.pgadmin\.host/.test(d.text));
  assert.ok(ingress, 'an Ingress routed at .Values.pgadmin.host must exist for pgAdmin');
  assert.doesNotMatch(
    ingress.text,
    /auth/i,
    "the pgAdmin Ingress must not add a basic-auth (or other) gate in front of pgAdmin's own login page",
  );
  assert.doesNotMatch(
    ingress.text,
    /middlewares/i,
    'the pgAdmin Ingress must not attach a traefik middleware (e.g. for basic auth) in front of pgAdmin',
  );
});

test("AC4: the todo Postgres server is pre-listed in pgAdmin's tree via a mounted servers.json, with host, port and database filled in", () => {
  const docs = chartDocuments();
  const configMap = findServersConfigMap(docs);
  assert.ok(configMap, 'a ConfigMap holding a pgAdmin servers.json definition ("Servers": { ... }) must exist');

  assert.match(
    configMap.text,
    /\{\{\s*\.Release\.Name\s*\}\}-postgres/,
    "the pre-listed server's Host must be the chart's existing postgres Service, {{ .Release.Name }}-postgres",
  );
  assert.match(configMap.text, /"Port":\s*5432\b/, "the pre-listed server's Port must be 5432, the port Postgres listens on in this chart");
  assert.match(
    configMap.text,
    /"MaintenanceDB":\s*"?\{\{\s*\.Values\.postgres\.database/,
    "the pre-listed server's database must come from .Values.postgres.database",
  );

  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');
  assert.match(
    deployment.text,
    /\/pgadmin4\/servers\.json/,
    'the servers.json ConfigMap must be mounted at /pgadmin4/servers.json, the path pgAdmin loads pre-listed servers from on startup',
  );
  assert.match(
    deployment.text,
    /configMap:/,
    'servers.json must be mounted from a ConfigMap volume (supplied fresh by the chart every deploy), not baked into the image or read from a PVC',
  );
});

test("AC5: connecting to the pre-listed server reaches the role the API's migration runs as, with no stored password, and that role's tasks table already holds the migrated/seeded rows", async () => {
  const docs = chartDocuments();
  const configMap = findServersConfigMap(docs);
  assert.ok(configMap, 'a ConfigMap holding a pgAdmin servers.json definition must exist');

  // Criterion 4 pins Host/Port/MaintenanceDB being filled in; connecting also depends on
  // the Username pgAdmin offers, and on the Postgres password staying out of the
  // definition (typed in on first connect, not stored, per the spec's Q3 decision).
  assert.match(
    configMap.text,
    /"Username":\s*"?\{\{\s*\.Values\.postgres\.user/,
    "the pre-listed server's Username must come from .Values.postgres.user, the role the API's own migration runs as",
  );
  assert.doesNotMatch(
    configMap.text,
    /"Password"\s*:/,
    'the server definition must not store the Postgres password; pgAdmin must still prompt for it on first connect',
  );

  // That role's database is the one src/migrate.js runs its migration against on the
  // API's own startup, seeding three example todos into `tasks` on a fresh database
  // (see test/pgStore.test.js and test/server.pg.test.js for the same migration path).
  // Reproduce it against a Postgres stand-in to prove the table a person opens in
  // pgAdmin after connecting already has rows, not an empty schema.
  const client = createFakeClient();
  await migrate(client);
  const { rows } = await client.query('SELECT * FROM tasks');
  assert.ok(
    rows.length > 0,
    'the tasks table the pre-listed server points at must already hold rows once the migration has run, for pgAdmin to show them after connecting',
  );
});

test("AC6: pgAdmin's pod and container satisfy the restricted Pod Security profile", () => {
  const docs = chartDocuments();
  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');
  assertRestrictedPodSecurity(deployment.text, deployment.file);
  assert.doesNotMatch(deployment.text, /capabilities:\s*\n\s*add:/, 'no Linux capability may be added back for pgAdmin');
});

test('AC6: pgAdmin listens on a port above 1024', () => {
  const docs = chartDocuments();
  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');

  const portMatch = deployment.text.match(/containerPort:\s*(\d+)/);
  assert.ok(portMatch, 'the pgAdmin container must declare a containerPort');
  const port = Number(portMatch[1]);
  assert.ok(port > 1024, `pgAdmin's containerPort (${port}) must be above 1024, since it cannot bind a privileged port as a non-root user`);

  assert.match(
    deployment.text,
    /name:\s*PGADMIN_LISTEN_PORT/,
    "pgAdmin must be told to listen on that port via its documented PGADMIN_LISTEN_PORT environment variable (its image's default is port 80)",
  );
  assert.match(
    deployment.text,
    new RegExp(`PGADMIN_LISTEN_PORT[\\s\\S]{0,80}${port}`),
    'PGADMIN_LISTEN_PORT must be set to the same number as the declared containerPort',
  );

  const service = docsOfKind(docs, 'Service').find((d) => /pgadmin/i.test(d.text));
  assert.ok(service, 'a Service must exist for pgAdmin');
  assert.match(service.text, new RegExp(`targetPort:\\s*${port}\\b`), 'the pgAdmin Service must target the same port the container listens on');
});

test('AC7: pgAdmin keeps no persistent volume of its own', () => {
  const docs = chartDocuments();
  const deployment = findPgadminDeployment(docs);
  assert.ok(deployment, 'a Deployment must use .Values.pgadmin.image for pgAdmin');

  assert.doesNotMatch(
    deployment.text,
    /persistentVolumeClaim/,
    "pgAdmin's Deployment must not mount a PersistentVolumeClaim; its server list and settings must come from the chart's config fresh on every deploy",
  );
  assert.doesNotMatch(deployment.text, /volumeClaimTemplates/, 'pgAdmin must be a Deployment, not a StatefulSet with volumeClaimTemplates');

  const pvcs = docsOfKind(docs, 'PersistentVolumeClaim').filter((d) => /pgadmin/i.test(d.text));
  assert.equal(pvcs.length, 0, 'no PersistentVolumeClaim should be defined for pgAdmin');
});

test('AC8: every existing todo-api endpoint keeps its documented request/response shape once pgAdmin is added', async () => {
  const ctx = await startTestServer();
  try {
    const created = await request(ctx.socketPath, { method: 'POST', path: '/tasks', body: { title: 'Buy milk' } });
    assert.equal(created.status, 201);
    const task = created.json();
    assert.deepEqual(
      Object.keys(task).sort(),
      ['completed', 'due', 'id', 'note', 'priority', 'tags', 'title'],
      'POST /tasks must still return a task with exactly its documented fields',
    );
    assert.equal(task.completed, false);
    assert.equal(task.priority, 'normal');

    const list = await request(ctx.socketPath, { path: '/tasks' });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json()), 'GET /tasks must still return an array');

    const csv = await request(ctx.socketPath, { path: '/tasks.csv' });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers['content-type'], 'text/csv; charset=utf-8');
    assert.equal(
      csv.text.split('\n')[0],
      'id,title,completed,due,priority,tags,note',
      'GET /tasks.csv must still start with its documented header row',
    );

    const patched = await request(ctx.socketPath, {
      method: 'PATCH',
      path: `/tasks/${task.id}`,
      body: { completed: true },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json().completed, true);

    const deleted = await request(ctx.socketPath, { method: 'DELETE', path: `/tasks/${task.id}` });
    assert.equal(deleted.status, 204);

    const missing = await request(ctx.socketPath, { method: 'DELETE', path: `/tasks/${task.id}` });
    assert.equal(missing.status, 404, 'deleting an already-deleted task must still 404');
  } finally {
    await stopTestServer(ctx);
  }
});

test("AC8: pgAdmin runs as its own Deployment, so the existing API, web UI and web terminal Deployments keep exactly the single container and wiring they had before", () => {
  const docs = chartDocuments();

  const pgadminDeployment = findPgadminDeployment(docs);
  assert.ok(pgadminDeployment, 'a pgAdmin Deployment must exist alongside the API/web/webTerminal Deployments');

  const apiDeployment = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.api\.image/.test(d.text));
  assert.ok(apiDeployment, 'the API Deployment must still exist');
  assert.notEqual(apiDeployment.file, pgadminDeployment.file, "pgAdmin must not be merged into the API Deployment's own file/resource");
  assert.equal(
    (apiDeployment.text.match(/^\s*image:/gm) || []).length,
    1,
    'the API Deployment must still define exactly one container image, not share a pod with pgAdmin',
  );
  assert.match(apiDeployment.text, /name:\s*DATABASE_URL/, 'the API Deployment must still set DATABASE_URL');
  assert.match(apiDeployment.text, /containerPort:\s*3000/, 'the API must still listen on 3000');

  const webDeployment = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.web\.image/.test(d.text));
  assert.ok(webDeployment, 'the web UI Deployment must still exist');
  assert.notEqual(webDeployment.file, pgadminDeployment.file, "pgAdmin must not be merged into the web UI Deployment's own file/resource");
  assert.equal(
    (webDeployment.text.match(/^\s*image:/gm) || []).length,
    1,
    'the web UI Deployment must still define exactly one container image',
  );
  assert.match(
    webDeployment.text,
    /\{\{-?\s*if[^}]*\.Values\.web\.image[^}]*-?\}\}/,
    'the web UI Deployment must still be guarded by {{- if .Values.web.image }}',
  );

  const terminalDeployment = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.webTerminal\.image/.test(d.text));
  assert.ok(terminalDeployment, 'the web terminal Deployment must still exist');
  assert.notEqual(terminalDeployment.file, pgadminDeployment.file, "pgAdmin must not be merged into the web terminal Deployment's own file/resource");
  assert.equal(
    (terminalDeployment.text.match(/^\s*image:/gm) || []).length,
    1,
    'the web terminal Deployment must still define exactly one container image',
  );
  assert.match(
    terminalDeployment.text,
    /\{\{-?\s*if[^}]*\.Values\.webTerminal\.image[^}]*-?\}\}/,
    'the web terminal Deployment must still be guarded by {{- if .Values.webTerminal.image }}',
  );
});

test('AC9: README documents the hardcoded pgAdmin username and password as a temporary, local/dev-only credential', () => {
  const readme = readFile('README.md');
  assert.ok(readme, 'README.md must exist');

  const valuesYaml = readFile(path.join(CHART_DIR, 'values.yaml'));
  assert.ok(valuesYaml, 'deploy/chart/values.yaml must exist');
  const pgadminBlock = yamlBlock(valuesYaml, 'pgadmin');
  assert.ok(pgadminBlock, 'values.yaml must declare a top-level pgadmin: block');

  const user = unquote(yamlValue(pgadminBlock, 'user'));
  const password = unquote(yamlValue(pgadminBlock, 'password'));
  assert.ok(user, 'values.yaml must set pgadmin.user');
  assert.ok(password, 'values.yaml must set pgadmin.password');

  assert.ok(readme.includes(user), "README.md must document the exact pgAdmin username set in values.yaml's pgadmin.user");
  assert.ok(readme.includes(password), "README.md must document the exact pgAdmin password set in values.yaml's pgadmin.password");

  assert.match(readme, /pgAdmin/, 'README.md must mention pgAdmin');
  assert.match(
    readme,
    /temporary|local[\s-]?\/?\s*dev|development[\s-]only/i,
    'README.md must state plainly that the pgAdmin credential is temporary and local/dev-only',
  );
});
