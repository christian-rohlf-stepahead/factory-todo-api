// Static, sandbox-only checks of the deployment artefacts: the `api` Dockerfile,
// `.factory/environment.json`, and the Helm chart baked into the `deploy` image.
// These never shell out to `docker`, `helm` or a cluster (none are available in
// this sandbox); they read the files as text and pin the structure the chart
// must have so the three criteria below hold once it is deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
