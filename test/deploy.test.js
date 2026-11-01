// Static, sandbox-only checks of the deployment artefacts: the `api` Dockerfile,
// `.factory/environment.json`, and the Helm chart baked into the `deploy` image.
// These never shell out to `docker`, `helm` or a cluster (none are available in
// this sandbox); they read the files as text and pin the structure the chart
// must have so the three criteria below hold once it is deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

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

function chartFiles() {
  return listFilesRecursive(path.join(CHART_DIR, 'templates')).filter((f) => /\.(ya?ml|tpl)$/.test(f));
}

// One "document" per template file, so that per-component checks (gating,
// security context, ...) look only at the resource(s) that file defines, not
// at every resource in the chart.
function chartDocuments() {
  return chartFiles().map((f) => ({
    file: path.relative(repoRoot, f),
    text: fs.readFileSync(f, 'utf8'),
  }));
}

function docsOfKind(docs, kind) {
  return docs.filter((d) => new RegExp(`kind:\\s*${kind}\\b`).test(d.text));
}

function conditionalBlock(text, valuesPath) {
  const escaped = valuesPath.replace(/\./g, '\\.');
  const re = new RegExp(
    String.raw`\{\{-?\s*if[^}]*\.Values\.${escaped}[^}]*-?\}\}([\s\S]*?)\{\{-?\s*end\s*-?\}\}`,
  );
  const m = text.match(re);
  return m ? m[1] : null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Expected apiVersion per kind, per the Kubernetes API this chart targets.
const EXPECTED_API_VERSION = {
  Deployment: 'apps/v1',
  Service: 'v1',
  Secret: 'v1',
  Ingress: 'networking.k8s.io/v1',
};

// Strips pure Go-template control-flow lines (if/end/else/range/with), then
// replaces each remaining {{ ... }} expression with a placeholder scalar, so
// the surrounding YAML's structure (indentation, required fields, apiVersion,
// ...) can be checked without a real Helm/Go-template engine (unavailable in
// this sandbox). Only simple single-value substitutions are safe to collapse
// this way: an expression that would render as multiple lines or pull in
// external content (nindent/indent/include/range/with/toYaml/toJson) is
// rejected outright rather than silently collapsed, since collapsing it would
// hide exactly the kind of indentation/rendering bug a real `helm template`
// would catch and this static check otherwise couldn't.
function renderForYamlValidation(text, label) {
  const withoutControlLines = text
    .split('\n')
    .filter((line) => !/^\s*\{\{-?\s*(if|end|else|range|with)\b.*-?\}\}\s*$/.test(line))
    .join('\n');

  for (const match of withoutControlLines.matchAll(/\{\{-?([\s\S]*?)-?\}\}/g)) {
    const expr = match[1].trim();
    assert.doesNotMatch(
      expr,
      /\b(nindent|indent|include|range|with|toYaml|toJson)\b/,
      `${label}: the Helm expression "${expr}" would render as multiple lines or external content; ` +
        'this static check can only validate simple single-value substitutions (no helm binary is available here to render it for real)',
    );
    const quotes = (expr.match(/"/g) || []).length;
    assert.equal(quotes % 2, 0, `${label}: unbalanced quotes in the Helm expression "${expr}"`);
    const openParens = (expr.match(/\(/g) || []).length;
    const closeParens = (expr.match(/\)/g) || []).length;
    assert.equal(openParens, closeParens, `${label}: unbalanced parentheses in the Helm expression "${expr}"`);
  }

  return withoutControlLines.replace(/\{\{-?[\s\S]*?-?\}\}/g, 'PLACEHOLDER');
}

// Finds the literal value feeding an env var named `envName`, whether it is
// set inline on a container (`name: X` / `value: Y`) or via a Secret's
// stringData (`X: Y`). Returns the raw right-hand side text, unresolved.
function extractEnvSource(allText, envName) {
  const inline = allText.match(new RegExp(`name:\\s*${envName}\\s*\\n\\s*value:\\s*(.+)`));
  if (inline) return inline[1].trim();
  const secretStyle = allText.match(new RegExp(`\\b${envName}:\\s*(.+)`));
  if (secretStyle) return secretStyle[1].trim();
  return null;
}

// Resolves a raw env-var source (from extractEnvSource) to its literal
// string value: unwraps a surrounding quoted literal, or follows a
// `{{ .Values.a.b }}` reference into the parsed values.yaml.
function resolveLiteral(source, values) {
  if (source == null) return null;
  const templated = source.match(/\{\{-?\s*(.+?)\s*-?\}\}/);
  if (!templated) return source.replace(/^["']|["']$/g, '');

  const valuesPath = templated[1].match(/^\.Values\.([\w.]+)/);
  if (!valuesPath) return null;
  let cur = values;
  for (const part of valuesPath[1].split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = cur[part];
  }
  return cur == null ? null : String(cur);
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
  assert.match(text, /drop:[\s\S]{0,20}ALL/, `${label}: must drop the ALL capability`);
  assert.match(text, /requests:/, `${label}: must set resource requests`);
  assert.match(text, /limits:/, `${label}: must set resource limits`);
}

test('AC1: .factory/environment.json declares the api image, a host check, and a deploy step running the chart from a deploy image', () => {
  const raw = readFile('.factory/environment.json');
  assert.ok(raw, '.factory/environment.json must exist');
  const env = JSON.parse(raw);

  assert.equal(env.version, 1);

  const imageNames = (env.images || []).map((i) => i.name);
  assert.ok(imageNames.includes('api'), 'declares an "api" image (the runtime API image)');
  assert.ok(imageNames.includes('deploy'), 'declares a "deploy" image (holds helm and the chart)');

  assert.ok(env.host && typeof env.host.path === 'string' && env.host.path.length > 0,
    'declares a `host` health check');

  assert.ok(env.deploy, 'declares a `deploy` step');
  assert.equal(env.deploy.image, 'deploy', 'the deploy step runs from the project\'s own "deploy" image');
  assert.ok(Array.isArray(env.deploy.command) && env.deploy.command.length > 0,
    'the deploy step has a non-empty command');
  if (env.deploy.timeoutSeconds !== undefined) {
    assert.ok(env.deploy.timeoutSeconds <= 900, 'the deploy step stays within the 15 minute ceiling');
  }

  let commandText = env.deploy.command.join(' ');
  for (const arg of env.deploy.command) {
    const scriptPath = path.join(repoRoot, 'deploy', arg);
    if (fs.existsSync(scriptPath) && fs.statSync(scriptPath).isFile()) {
      commandText += '\n' + fs.readFileSync(scriptPath, 'utf8');
    }
  }
  assert.match(commandText, /helm\s+upgrade/i, 'the deploy step runs `helm upgrade` against the chart');
});

test('AC1: the api image runs as a numeric non-root user and listens above 1024', () => {
  const dockerfile = readFile('Dockerfile');
  assert.ok(dockerfile, 'a root Dockerfile must exist, producing the "api" image');
  assert.match(dockerfile, /^USER 1001\s*$/m, 'must run as the numeric user 1001, not a named user');

  const exposeMatch = dockerfile.match(/^EXPOSE\s+(\d+)/m);
  if (exposeMatch) {
    assert.ok(Number(exposeMatch[1]) > 1024, 'the exposed port must be above 1024');
  }
  assert.doesNotMatch(dockerfile, /^ENV\s+PORT=([0-9]|[1-9][0-9]{1,2}|1024)\s*$/m,
    'must not pin PORT to a privileged port (<=1024)');
});

test('AC1: the deploy image also runs as a numeric non-root user', () => {
  const dockerfile = readFile('deploy/Dockerfile');
  assert.ok(dockerfile, 'deploy/Dockerfile must exist, producing the "deploy" image');
  assert.match(dockerfile, /^USER 1001\s*$/m, 'must run as the numeric user 1001, not a named user');
});

test('AC1: one Helm chart lives in deploy/chart, ready to be baked into the deploy image', () => {
  const chartYaml = readFile(path.join(CHART_DIR, 'Chart.yaml'));
  assert.ok(chartYaml, 'deploy/chart/Chart.yaml must exist');
  assert.match(chartYaml, /apiVersion:\s*v2/, 'the chart must declare apiVersion v2');

  assert.ok(chartFiles().length > 0, 'deploy/chart/templates must contain at least one template');
});

test('AC1: the chart deploys Postgres as a StatefulSet with a persistent volume claim', () => {
  const docs = chartDocuments();
  const statefulSets = docsOfKind(docs, 'StatefulSet');
  assert.ok(statefulSets.length > 0, 'the chart must define a StatefulSet for Postgres');
  assert.ok(
    statefulSets.some((d) => /postgres/i.test(d.text)),
    'the StatefulSet must be the Postgres workload',
  );
  assert.ok(
    statefulSets.some((d) => /volumeClaimTemplates\s*:/.test(d.text)),
    'the Postgres StatefulSet must claim a persistent volume (volumeClaimTemplates)',
  );
});

test('AC1: the chart deploys the API wired to Postgres, so the prior work item\'s migration and seed run on startup', () => {
  const docs = chartDocuments();
  const apiDeployments = docsOfKind(docs, 'Deployment').filter((d) =>
    /\.Values\.api\.image/.test(d.text),
  );
  assert.ok(apiDeployments.length === 1, 'exactly one Deployment must use .Values.api.image');
  const apiDoc = apiDeployments[0];

  assert.match(apiDoc.text, /name:\s*DATABASE_URL/,
    'the API deployment must set DATABASE_URL so the API connects to Postgres and runs its migration/seed on startup');
});

test('AC1: the chart deploys the web UI and the web terminal, pointing TODO_API_URL at the API\'s in-cluster service', () => {
  const docs = chartDocuments();

  const webDoc = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.web\.image/.test(d.text));
  assert.ok(webDoc, 'a Deployment must use .Values.web.image for the web UI');
  assert.match(webDoc.text, /name:\s*TODO_API_URL/, 'the web UI deployment must set TODO_API_URL');

  const terminalDoc = docsOfKind(docs, 'Deployment').find((d) =>
    /\.Values\.webTerminal\.image/.test(d.text),
  );
  assert.ok(terminalDoc, 'a Deployment must use .Values.webTerminal.image for the web terminal');
  assert.match(terminalDoc.text, /name:\s*TODO_API_URL/, 'the web terminal deployment must set TODO_API_URL');
});

test('AC2: the web UI and the web terminal are only deployed when their image values are present', () => {
  const docs = chartDocuments();

  const webDoc = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.web\.image/.test(d.text));
  assert.ok(webDoc, 'a Deployment must use .Values.web.image for the web UI');
  const webBlock = conditionalBlock(webDoc.text, 'web.image');
  assert.ok(webBlock, 'the web UI Deployment must be guarded by {{- if .Values.web.image }}');
  assert.match(webBlock, /kind:\s*Deployment/, 'the guarded block must contain the web Deployment');

  const terminalDoc = docsOfKind(docs, 'Deployment').find((d) =>
    /\.Values\.webTerminal\.image/.test(d.text),
  );
  assert.ok(terminalDoc, 'a Deployment must use .Values.webTerminal.image for the web terminal');
  const terminalBlock = conditionalBlock(terminalDoc.text, 'webTerminal.image');
  assert.ok(terminalBlock, 'the web terminal Deployment must be guarded by {{- if .Values.webTerminal.image }}');
  assert.match(terminalBlock, /kind:\s*Deployment/, 'the guarded block must contain the web terminal Deployment');
});

test('AC2: the chart deploys and the API answers on its host when only the API image is available', () => {
  const docs = chartDocuments();

  const statefulSets = docsOfKind(docs, 'StatefulSet');
  assert.ok(
    statefulSets.some((d) => !/\.Values\.web\b/.test(d.text) && !/\.Values\.webTerminal\b/.test(d.text)),
    'the Postgres StatefulSet must not depend on the web or web-terminal images being present',
  );

  const apiDoc = docsOfKind(docs, 'Deployment').find((d) => /\.Values\.api\.image/.test(d.text));
  assert.ok(apiDoc, 'a Deployment must use .Values.api.image for the API');
  assert.ok(
    !/\.Values\.web\b/.test(apiDoc.text) && !/\.Values\.webTerminal\b/.test(apiDoc.text),
    'the API Deployment must not depend on the web or web-terminal images being present',
  );

  const apiIngress = docsOfKind(docs, 'Ingress').find((d) => /\.Values\.api\.host/.test(d.text));
  assert.ok(apiIngress, 'an Ingress for the API must exist, routed at .Values.api.host');
  assert.ok(
    !/\.Values\.web\b/.test(apiIngress.text) && !/\.Values\.webTerminal\b/.test(apiIngress.text),
    'the API Ingress must not depend on the web or web-terminal images being present',
  );
});

test('AC3: the API, the web UI, and the web terminal each get a traefik Ingress at their own FACTORY_HOST_<PROJECT>-derived host', () => {
  const docs = chartDocuments();
  const ingresses = docsOfKind(docs, 'Ingress');

  const byHostValue = (valuesPath) =>
    ingresses.find((d) => new RegExp(`\\.Values\\.${valuesPath.replace('.', '\\.')}`).test(d.text));

  const apiIngress = byHostValue('api.host');
  const webIngress = byHostValue('web.host');
  const terminalIngress = byHostValue('webTerminal.host');

  assert.ok(apiIngress, 'an Ingress routed at .Values.api.host must exist for the API');
  assert.ok(webIngress, 'an Ingress routed at .Values.web.host must exist for the web UI');
  assert.ok(terminalIngress, 'an Ingress routed at .Values.webTerminal.host must exist for the web terminal');

  for (const [label, doc] of [['API', apiIngress], ['web UI', webIngress], ['web terminal', terminalIngress]]) {
    assert.match(doc.text, /traefik/i, `the ${label} Ingress must be routed through the traefik ingress class`);
  }

  // The web UI and web terminal routes only make sense once their component is deployed.
  assert.ok(conditionalBlock(webIngress.text, 'web.image'), 'the web UI Ingress must be guarded by {{- if .Values.web.image }}');
  assert.ok(
    conditionalBlock(terminalIngress.text, 'webTerminal.image'),
    'the web terminal Ingress must be guarded by {{- if .Values.webTerminal.image }}',
  );
});

test('AC1/AC2/AC3: every workload the chart creates follows the restricted Pod Security profile', () => {
  const docs = chartDocuments();
  const workloadKinds = ['StatefulSet', 'Deployment', 'Job', 'CronJob'];
  const workloads = docs.filter((d) => workloadKinds.some((kind) => new RegExp(`kind:\\s*${kind}\\b`).test(d.text)));

  assert.ok(workloads.length >= 3, 'expected at least the Postgres, API, and one more workload to be defined');

  for (const doc of workloads) {
    assertRestrictedPodSecurity(doc.text, doc.file);
  }
});

test('AC1: pgAdmin is deployed via its own Deployment, unconditionally, in every environment the chart deploys to', () => {
  const docs = chartDocuments();
  const pgadminDoc = docsOfKind(docs, 'Deployment').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDoc, 'a Deployment for pgAdmin must exist');

  // Unlike the web UI and web terminal (optional, gated on a built image being
  // available), pgAdmin has no image of its own to build and must come up in
  // every environment, so none of its chart resources may be wrapped in an
  // {{- if ... }} guard anywhere in their template (not just at the very top).
  const pgadminDocs = docs.filter((d) => /pgadmin/i.test(d.text));
  for (const doc of pgadminDocs) {
    assert.doesNotMatch(
      doc.text,
      /\{\{-?\s*if\b/,
      `${doc.file}: pgAdmin must not be gated behind an optional value the way the web UI and web terminal are`,
    );
  }
});

test('AC1: pgAdmin gets its own Service in the chart', () => {
  const docs = chartDocuments();
  const pgadminService = docsOfKind(docs, 'Service').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminService, 'a Service for pgAdmin must exist');
});

test('AC1: pgAdmin\'s Deployment sets the admin login it needs to start, matching the login documented in the README', () => {
  // AC1 only requires pgAdmin to come up; it needs PGADMIN_DEFAULT_EMAIL and
  // PGADMIN_DEFAULT_PASSWORD set to start at all (the dpage/pgadmin4 image
  // refuses to boot without them). How those values are supplied (Secret,
  // ConfigMap, or otherwise) is the work item's own plan, not something AC1,
  // AC2 or AC3 pins, so this checks the env vars are present, then resolves
  // their actual literal value (inline, via a Secret, or via values.yaml)
  // and cross-checks it against the README, so the "matching" claim in this
  // test's name can actually be falsified.
  const docs = chartDocuments();
  const pgadminDoc = docsOfKind(docs, 'Deployment').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDoc, 'a Deployment for pgAdmin must exist');
  assert.match(pgadminDoc.text, /name:\s*PGADMIN_DEFAULT_EMAIL/, 'the pgAdmin Deployment must set PGADMIN_DEFAULT_EMAIL');
  assert.match(pgadminDoc.text, /name:\s*PGADMIN_DEFAULT_PASSWORD/, 'the pgAdmin Deployment must set PGADMIN_DEFAULT_PASSWORD');

  const valuesYaml = loadYaml(readFile(path.join(CHART_DIR, 'values.yaml')));
  const allText = docs.map((d) => d.text).join('\n');

  const email = resolveLiteral(extractEnvSource(allText, 'PGADMIN_DEFAULT_EMAIL'), valuesYaml);
  const password = resolveLiteral(extractEnvSource(allText, 'PGADMIN_DEFAULT_PASSWORD'), valuesYaml);
  assert.ok(email, 'the hardcoded pgAdmin email must resolve to a literal value (inline, in a Secret, or in values.yaml)');
  assert.ok(password, 'the hardcoded pgAdmin password must resolve to a literal value (inline, in a Secret, or in values.yaml)');

  const readme = readFile('README.md');
  assert.ok(readme, 'README.md must exist');
  assert.ok(readme.includes(email), `README must document the same pgAdmin email the chart hardcodes ("${email}")`);
  assert.ok(readme.includes(password), `README must document the same pgAdmin password the chart hardcodes ("${password}")`);
});

test('AC1: the API host\'s ingress gains a /pgadmin/ path to pgAdmin, alongside its existing / path which stays unchanged', () => {
  const docs = chartDocuments();
  const apiHostIngresses = docsOfKind(docs, 'Ingress').filter((d) => /\.Values\.api\.host/.test(d.text));
  assert.ok(apiHostIngresses.length > 0, 'an Ingress routed at .Values.api.host must exist');
  const combined = apiHostIngresses.map((d) => d.text).join('\n');

  assert.match(combined, /path:\s*\/pgadmin\/?/, 'the API host must gain a path rule for /pgadmin/');

  // AC1 requires the path to reach pgAdmin's Service, but not any specific
  // naming convention for it: find whatever Service name the /pgadmin/ path
  // actually references, then confirm the chart defines that exact Service
  // and that it is pgAdmin's (not, say, the api or web Service by mistake).
  const pathBlockMatch = combined.match(/path:\s*\/pgadmin\/?[\s\S]{0,300}?backend:[\s\S]{0,200}?name:\s*(.+)/);
  assert.ok(pathBlockMatch, 'the /pgadmin/ path must have a backend.service.name');
  const backendServiceName = pathBlockMatch[1].trim();

  const services = docsOfKind(docs, 'Service');
  const backendService = services.find((d) =>
    new RegExp(`metadata:\\s*\\n\\s*name:\\s*${escapeRegExp(backendServiceName)}\\b`).test(d.text),
  );
  assert.ok(
    backendService,
    `the /pgadmin/ path's backend Service ("${backendServiceName}") must be a Service the chart actually defines`,
  );
  assert.match(
    backendService.text,
    /pgadmin/i,
    `the /pgadmin/ path's backend Service ("${backendServiceName}") must be pgAdmin's Service, not an unrelated one`,
  );

  // The existing root path, to the api Service on port 3000, must remain exactly as it was.
  assert.match(
    combined,
    /path:\s*\/\s*\n\s*pathType:\s*Prefix\s*\n\s*backend:\s*\n\s*service:\s*\n\s*name:\s*\{\{\s*\.Release\.Name\s*\}\}-api\s*\n\s*port:\s*\n\s*number:\s*3000/,
    'the existing / path to the api Service on port 3000 must stay untouched',
  );
});

test('AC1: adding pgAdmin does not modify the API\'s, the web UI\'s, or the web terminal\'s Deployment, Service, or Ingress templates', () => {
  const docs = chartDocuments();
  const pgadminDoc = docsOfKind(docs, 'Deployment').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDoc, 'a Deployment for pgAdmin must exist, deployed alongside the untouched components below');

  // Byte-for-byte snapshots of every template AC1 says must keep "working
  // exactly as before", taken before this work item's build starts. The
  // API's Ingress is excluded because AC1 requires it to gain the new
  // /pgadmin/ path rule; its unchanged / rule is pinned by the test above.
  const unchangedFiles = {
    'deploy/chart/templates/api-deployment.yaml':
      '846b2cfc19c94bd3149747ba2b1f78fed5a00e928cd7ecf59625b371d81925d5',
    'deploy/chart/templates/api-service.yaml':
      '6502e2a10de0c00d9e30e17a4f0f9e8322284de244ee14f4b75a44d53b389ddd',
    'deploy/chart/templates/web-deployment.yaml':
      'de74561b49b71ec7cf872c3ab714e41ccdde7fb95ac71e2c2a7fcc995a051983',
    'deploy/chart/templates/web-service.yaml':
      'a55fe5694f34349d4f40bbe383ccec4be04f6eeaf5abc567440b6016bfd6af67',
    'deploy/chart/templates/web-ingress.yaml':
      '2ff453076817e571c80b843ec5fbd853c865f0eb4911e0347e05f2334afe4b31',
    'deploy/chart/templates/webterminal-deployment.yaml':
      'bfc9059fd374840ce292acf2178649fb92c620aa309838898b8edea9eba21b3e',
    'deploy/chart/templates/webterminal-service.yaml':
      '49d41c129077f2402d966401987f320dffd635bb5a3854b084f9e33f040cb6ca',
    'deploy/chart/templates/webterminal-ingress.yaml':
      '8a597c109587e32b531a637a5f3e10e6b1ae0a371976ce66ed4fda8eebdafd22',
  };

  for (const [relPath, expectedHash] of Object.entries(unchangedFiles)) {
    const text = readFile(relPath);
    assert.ok(text, `${relPath} must still exist`);
    const actualHash = crypto.createHash('sha256').update(text).digest('hex');
    assert.equal(actualHash, expectedHash, `${relPath} must not change while adding pgAdmin`);
  }
});

test('AC2: README documents the pgAdmin URL and its hardcoded login, noting both must be replaced before any use beyond local testing/development', () => {
  const readme = readFile('README.md');
  assert.ok(readme, 'README.md must exist');

  const idx = readme.search(/pgadmin/i);
  assert.notEqual(idx, -1, 'README must document pgAdmin');
  const section = readme.slice(idx, idx + 2000);

  assert.match(section, /\/pgadmin\//, 'README must document the pgAdmin URL as the API host plus /pgadmin/');
  assert.match(section, /@/, 'README must document the hardcoded pgAdmin login (an email-style username)');
  assert.match(section, /password/i, 'README must document the hardcoded pgAdmin password');
  assert.match(
    section,
    /replac/i,
    'README must note the hardcoded login must be replaced before any use beyond local testing/development',
  );
  assert.match(
    section,
    /local\s+(?:testing(?:\s*(?:and|\/)\s*development)?|development)/i,
    'README must scope the note to local testing/development',
  );
});

test('AC3: pgAdmin\'s pod runs under the same restricted Pod Security profile as every other pod in the chart', () => {
  const docs = chartDocuments();
  const pgadminDoc = docsOfKind(docs, 'Deployment').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDoc, 'a Deployment for pgAdmin must exist');
  assertRestrictedPodSecurity(pgadminDoc.text, pgadminDoc.file);
});

test('AC3: pgAdmin listens on a port above 1024, per the namespace\'s restricted Pod Security rules', () => {
  const docs = chartDocuments();
  const pgadminDoc = docsOfKind(docs, 'Deployment').find((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDoc, 'a Deployment for pgAdmin must exist');

  const portMatch = pgadminDoc.text.match(/containerPort:\s*(\d+)/);
  assert.ok(portMatch, 'the pgAdmin container must declare a containerPort');
  assert.ok(Number(portMatch[1]) > 1024, 'pgAdmin must listen on a port above 1024, not its image\'s default of 80');
});

test('AC3: every chart template pgAdmin adds is syntactically valid YAML, using only simple Helm expressions this check can verify', () => {
  const docs = chartDocuments();
  const pgadminDocs = docs.filter((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDocs.length > 0, 'at least one chart template for pgAdmin must exist');

  for (const doc of pgadminDocs) {
    const rendered = renderForYamlValidation(doc.text, doc.file);
    assert.doesNotThrow(
      () => loadYaml(rendered),
      `${doc.file} must be syntactically valid YAML once its Helm template expressions are substituted out`,
    );
  }
});

test('AC3: pgAdmin\'s Kubernetes resources use the right apiVersion for their kind and carry the fields Kubernetes requires', () => {
  const docs = chartDocuments();
  const pgadminDocs = docs.filter((d) => /pgadmin/i.test(d.text));
  assert.ok(pgadminDocs.length > 0, 'at least one chart template for pgAdmin must exist');

  for (const doc of pgadminDocs) {
    const resource = loadYaml(renderForYamlValidation(doc.text, doc.file));
    assert.ok(resource && resource.kind, `${doc.file}: must declare a kind`);

    const expectedApiVersion = EXPECTED_API_VERSION[resource.kind];
    if (expectedApiVersion) {
      assert.equal(
        resource.apiVersion,
        expectedApiVersion,
        `${doc.file}: a ${resource.kind} must use apiVersion ${expectedApiVersion}, or the Kubernetes API rejects it`,
      );
    }
    assert.ok(resource.metadata && resource.metadata.name, `${doc.file}: must set metadata.name`);

    if (resource.kind === 'Deployment') {
      assert.ok(
        resource.spec && resource.spec.selector && resource.spec.selector.matchLabels,
        `${doc.file}: a Deployment must set spec.selector.matchLabels`,
      );
      assert.ok(
        resource.spec.template && resource.spec.template.metadata && resource.spec.template.metadata.labels,
        `${doc.file}: a Deployment must set spec.template.metadata.labels`,
      );
      // A real Kubernetes API server rejects a Deployment whose selector
      // doesn't match its own pod template's labels.
      assert.deepEqual(
        resource.spec.selector.matchLabels,
        resource.spec.template.metadata.labels,
        `${doc.file}: spec.selector.matchLabels must match spec.template.metadata.labels, or Kubernetes rejects the Deployment`,
      );

      const containers = resource.spec.template.spec && resource.spec.template.spec.containers;
      assert.ok(Array.isArray(containers) && containers.length > 0, `${doc.file}: a Deployment must define at least one container`);
      for (const container of containers) {
        assert.ok(container.name, `${doc.file}: every container must set a name`);
        assert.ok(container.image, `${doc.file}: every container must set an image`);
      }
    }

    if (resource.kind === 'Service') {
      assert.ok(
        resource.spec && resource.spec.selector && Object.keys(resource.spec.selector).length > 0,
        `${doc.file}: a Service must set spec.selector`,
      );
      assert.ok(
        Array.isArray(resource.spec.ports) && resource.spec.ports.length > 0,
        `${doc.file}: a Service must define at least one port`,
      );
    }
  }
});

test('AC3: pgAdmin\'s chart resources do not collide, in kind and name, with any existing resource, so `helm upgrade` can apply them', () => {
  const docs = chartDocuments();

  function kindAndName(text) {
    const kindMatch = text.match(/kind:\s*(\w+)/);
    const nameMatch = text.match(/metadata:\s*\n(?:.*\n)*?\s*name:\s*(.+)/);
    return kindMatch && nameMatch ? `${kindMatch[1]}/${nameMatch[1].trim()}` : null;
  }

  const allKeys = docs.map((d) => ({ file: d.file, key: kindAndName(d.text) })).filter((d) => d.key);
  const pgadminKeys = allKeys.filter((d) => /pgadmin/i.test(d.key));
  assert.ok(pgadminKeys.length > 0, 'at least one chart resource for pgAdmin must exist');

  const counts = new Map();
  for (const { key } of allKeys) counts.set(key, (counts.get(key) || 0) + 1);
  for (const { file, key } of pgadminKeys) {
    assert.equal(counts.get(key), 1, `${file}: ${key} must not collide with another chart resource of the same kind and name`);
  }
});
