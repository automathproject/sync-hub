import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const LOCAL_CONFIG = path.join(ROOT, '.sync-hub.local.json');
const DEFAULT_REPOS = {
  exercises: path.resolve(ROOT, '../Exercices'),
  exobase: path.resolve(ROOT, '../exobase'),
  openyourmath: path.resolve(ROOT, '../openyourmath-v2')
};
const PORT = Number(process.env.SYNC_HUB_PORT || 4317);
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const RUN_TTL_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const previews = new Map();
const runs = new Map();

async function loadRepositories() {
  let overrides = {};
  try {
    overrides = JSON.parse(await fs.readFile(LOCAL_CONFIG, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Configuration locale invalide : ${error.message}`);
  }

  const repositories = {};
  for (const [key, fallback] of Object.entries(DEFAULT_REPOS)) {
    const configured = overrides[key];
    repositories[key] = configured
      ? path.resolve(ROOT, configured)
      : fallback;
    try {
      await fs.access(repositories[key]);
    } catch {
      throw new Error(`Dépôt introuvable pour « ${key} » : ${repositories[key]}`);
    }
  }
  return repositories;
}

function run(command, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, shell: false, env: process.env });
    let output = '';
    let killedForSize = false;
    const append = chunk => {
      if (Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
        output += '\n\n[Sortie interrompue : taille maximale atteinte.]\n';
        killedForSize = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => resolve({ code: 3, output: `${output}\nErreur : ${error.message}\n` }));
    child.on('close', code => resolve({
      code: killedForSize ? 3 : (code ?? 3),
      output: output.trimEnd() || '(Aucune sortie.)'
    }));
  });
}

function sendRunEvent(run, event, payload) {
  for (const listener of run.listeners) listener(event, payload);
}

function startRun(command, args, cwd, onComplete = () => ({})) {
  const run = {
    id: randomUUID(),
    output: '',
    done: false,
    code: null,
    completion: null,
    listeners: new Set()
  };
  runs.set(run.id, run);

  const child = spawn(command, args, { cwd, shell: false, env: process.env });
  let killedForSize = false;
  const append = chunk => {
    if (run.done || Buffer.byteLength(run.output) >= MAX_OUTPUT_BYTES) return;
    const text = chunk.toString();
    run.output += text;
    sendRunEvent(run, 'output', { chunk: text });
    if (Buffer.byteLength(run.output) > MAX_OUTPUT_BYTES) {
      const warning = '\n\n[Sortie interrompue : taille maximale atteinte.]\n';
      run.output += warning;
      sendRunEvent(run, 'output', { chunk: warning });
      killedForSize = true;
      child.kill('SIGTERM');
    }
  };
  const finish = code => {
    if (run.done) return;
    run.done = true;
    run.code = killedForSize ? 3 : (code ?? 3);
    if (!run.output) run.output = '(Aucune sortie.)';
    run.completion = { code: run.code, ...onComplete({ code: run.code, output: run.output }) };
    sendRunEvent(run, 'complete', run.completion);
    setTimeout(() => runs.delete(run.id), RUN_TTL_MS).unref();
  };

  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', error => {
    append(`\nErreur : ${error.message}\n`);
    finish(3);
  });
  child.once('close', finish);
  return run;
}

function flowCommands(repositories) {
  return {
    'exercises-to-exobase': {
      title: 'Exercices → exobase',
      previewCodes: [0, 1],
      preview: [process.execPath, ['scripts/sync-exercices.mjs', '--check'], repositories.exobase],
      apply: [process.execPath, ['scripts/sync-exercices.mjs', '--apply'], repositories.exobase]
    },
    'openyourmath-to-exobase': {
      title: 'OpenYourMath → exobase',
      previewCodes: [0, 1],
      preview: ['pnpm', ['sync:exobase:push', '--check'], repositories.openyourmath],
      apply: ['pnpm', ['sync:exobase:push', '--apply'], repositories.openyourmath]
    },
    'exobase-to-openyourmath': {
      title: 'exobase → OpenYourMath',
      previewCodes: [0, 1],
      preview: ['pnpm', ['sync:exobase:check'], repositories.openyourmath],
      apply: ['pnpm', ['sync:exobase', '--apply'], repositories.openyourmath]
    },
    'metadata': {
      title: 'Métadonnées des exercices',
      previewCodes: [0],
      preview: ['pnpm', ['index:exercises', '--dry-run'], repositories.openyourmath],
      apply: ['pnpm', ['index:exercises'], repositories.openyourmath]
    },
    'release': {
      title: 'Release OpenYourMath',
      previewCodes: [0],
      preview: ['pnpm', ['release:content:check'], repositories.openyourmath],
      apply: ['pnpm', ['release:content'], repositories.openyourmath]
    }
  };
}

async function gitState(directory) {
  const [head, status] = await Promise.all([
    run('git', ['rev-parse', '--short', 'HEAD'], directory),
    run('git', ['status', '--porcelain'], directory)
  ]);
  const changes = status.output === '(Aucune sortie.)'
    ? 0
    : status.output.split('\n').filter(Boolean).length;
  return {
    path: directory,
    commit: head.code === 0 ? head.output.trim() : 'inconnu',
    clean: status.code === 0 && changes === 0,
    changes,
    status: status.code === 0 && changes > 0 ? status.output : ''
  };
}

function nextPatchVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`La version « ${version} » doit être au format x.y.z pour être incrémentée.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function readReleaseVersion(directory) {
  const packagePath = path.join(directory, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  return { packagePath, packageJson, current: packageJson.version, next: nextPatchVersion(packageJson.version) };
}

function cleanupPreviews() {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (preview.expiresAt < now) previews.delete(id);
  }
}

const app = Fastify({ logger: false });

app.get('/api/status', async () => {
  const repositories = await loadRepositories();
  const states = await Promise.all(Object.entries(repositories).map(async ([key, directory]) => {
    const state = await gitState(directory);
    return [key, state];
  }));
  return Object.fromEntries(states);
});

app.get('/api/flows', async () => {
  const repositories = await loadRepositories();
  return Object.entries(flowCommands(repositories)).map(([id, flow]) => ({ id, title: flow.title }));
});

app.get('/api/release/version', async () => {
  const repositories = await loadRepositories();
  const { current, next } = await readReleaseVersion(repositories.openyourmath);
  return { current, next };
});

app.post('/api/release/bump-patch', async (_request, reply) => {
  const repositories = await loadRepositories();
  const status = await run('git', ['status', '--porcelain', '--untracked-files=all'], repositories.openyourmath);
  if (status.code !== 0 || status.output !== '(Aucune sortie.)') {
    return reply.code(409).send({ error: 'OpenYourMath doit être propre avant de changer le numéro de release.' });
  }
  const branch = await run('git', ['branch', '--show-current'], repositories.openyourmath);
  if (branch.code !== 0 || branch.output.trim() !== 'main') {
    return reply.code(409).send({ error: 'Le numéro de release doit être changé depuis la branche main.' });
  }

  const version = await readReleaseVersion(repositories.openyourmath);
  version.packageJson.version = version.next;
  await fs.writeFile(version.packagePath, `${JSON.stringify(version.packageJson, null, 2)}\n`);
  return { previous: version.current, current: version.next, next: nextPatchVersion(version.next) };
});

app.get('/api/runs/:id/events', (request, reply) => {
  const run = runs.get(request.params.id);
  if (!run) return reply.code(404).send({ error: 'Exécution introuvable ou expirée.' });

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  });
  const write = (event, payload) => raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  write('snapshot', { output: run.output });
  if (run.done) {
    write('complete', run.completion);
    raw.end();
    return;
  }
  const listener = (event, payload) => write(event, payload);
  run.listeners.add(listener);
  request.raw.once('close', () => run.listeners.delete(listener));
});

app.post('/api/flows/:id/preview', async (request, reply) => {
  const repositories = await loadRepositories();
  const flow = flowCommands(repositories)[request.params.id];
  if (!flow) return reply.code(404).send({ error: 'Flux inconnu.' });
  const [command, args, cwd] = flow.preview;
  const run = startRun(command, args, cwd, result => {
    const canApply = flow.previewCodes.includes(result.code);
    cleanupPreviews();
    const previewId = canApply ? randomUUID() : null;
    if (previewId) previews.set(previewId, { flow: request.params.id, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return { previewId, canApply, expiresInSeconds: canApply ? PREVIEW_TTL_MS / 1000 : 0 };
  });
  return { runId: run.id };
});

app.post('/api/flows/:id/apply', async (request, reply) => {
  const repositories = await loadRepositories();
  const flow = flowCommands(repositories)[request.params.id];
  if (!flow) return reply.code(404).send({ error: 'Flux inconnu.' });
  cleanupPreviews();
  const preview = previews.get(request.body?.previewId);
  if (!preview || preview.flow !== request.params.id) {
    return reply.code(409).send({ error: 'Lancez un aperçu récent avant d’appliquer une synchronisation.' });
  }
  previews.delete(request.body.previewId);
  const [command, args, cwd] = flow.apply;
  const run = startRun(command, args, cwd);
  return { runId: run.id };
});

app.post('/api/build-content', async () => {
  const repositories = await loadRepositories();
  const run = startRun('pnpm', ['build:content'], repositories.openyourmath);
  return { runId: run.id };
});

await app.register(fastifyStatic, { root: path.join(ROOT, 'dist'), prefix: '/' });

app.listen({ port: PORT, host: '127.0.0.1' }).then(() => {
  console.log(`Sync Hub disponible sur http://127.0.0.1:${PORT}`);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
