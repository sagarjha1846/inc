/**
 * The GitHub Action.
 *
 * It is a composite action: a block of bash embedded in action.yml that builds
 * a command line, parses the JSON that comes back, and writes step outputs.
 * None of that is covered by importing a module — it only runs when GitHub
 * runs it, which meant a documented feature had never once been executed.
 *
 * These tests lift the real `run:` block out of action.yml, substitute inputs
 * the way GitHub does, and execute it against a local fixture with GITHUB_OUTPUT
 * and GITHUB_STEP_SUMMARY pointed at temporary files. Reading the script from
 * the YAML rather than copying it is the point: a copy would drift.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The step's `env:` mapping, as written in action.yml.
 *
 * An input can reach the CLI through the environment instead of the command
 * line — `key` becomes CITABLE_KEY that way — so a harness that runs only the
 * script is not running the action. Leaving this out made the key look broken
 * when it was the harness that was incomplete.
 */
async function actionEnv() {
  const yaml = await readFile(path.join(ROOT, 'action.yml'), 'utf8');
  const step = yaml.slice(yaml.indexOf('    - id: audit'));
  const start = step.indexOf('      env:\n');
  if (start === -1) return {};
  const body = step.slice(start + '      env:\n'.length);
  const env = {};
  for (const line of body.split('\n')) {
    const match = /^        ([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return env;
}

/** The bash body of the action's only step, as written in action.yml. */
async function actionScript() {
  const yaml = await readFile(path.join(ROOT, 'action.yml'), 'utf8');
  const marker = '      run: |\n';
  const start = yaml.indexOf(marker);
  assert.notEqual(start, -1, 'action.yml should contain a run block');
  return yaml
    .slice(start + marker.length)
    .split('\n')
    .map((line) => (line.startsWith('        ') ? line.slice(8) : line))
    .join('\n')
    .trimEnd();
}

/**
 * Run the action the way GitHub does: `${{ }}` expressions substituted, bash
 * invoked with the same flags, outputs written to files.
 */
async function runAction(inputs, { cwd }) {
  let script = await actionScript();
  script = script.replace(/\$\{\{\s*github\.action_path\s*\}\}/g, ROOT);
  script = script.replace(/\$\{\{\s*inputs\.([a-z-]+)\s*\}\}/g, (_, name) => inputs[name] ?? '');
  assert.doesNotMatch(script, /\$\{\{/, 'every expression should have been substituted');

  const outputPath = path.join(cwd, 'github_output');
  const summaryPath = path.join(cwd, 'step_summary');
  await writeFile(outputPath, '');
  await writeFile(summaryPath, '');
  const scriptPath = path.join(cwd, 'step.sh');
  await writeFile(scriptPath, script);

  // Substitute the step's env the same way, so an input routed through the
  // environment is exercised rather than silently dropped.
  const stepEnv = Object.fromEntries(
    Object.entries(await actionEnv()).map(([name, value]) => [
      name,
      value.replace(/\$\{\{\s*inputs\.([a-z-]+)\s*\}\}/g, (_, input) => inputs[input] ?? ''),
    ]),
  );

  const result = await new Promise((resolve) => {
    execFile(
      'bash',
      ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath],
      { cwd, env: { ...process.env, ...stepEnv, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath } },
      (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }),
    );
  });

  const outputs = Object.fromEntries(
    (await readFile(outputPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=').slice(0, 2)),
  );
  return { ...result, outputs, summary: await readFile(summaryPath, 'utf8') };
}

/** A fixture site whose robots.txt can change between audits. */
async function startSite() {
  let robots = 'User-agent: *\nAllow: /\n';
  const page = `<!doctype html><html lang="en"><head><title>How caching strategies work</title>
<meta name="description" content="A practical guide to caching strategies and when each one applies in production systems.">
</head><body><main><h1>How caching strategies work</h1>
<p>${'Caching decides what a server never computes twice. '.repeat(25)}</p>
<h2>What is stale-while-revalidate?</h2><p>${'It serves the cached copy while refreshing behind. '.repeat(25)}</p>
</main></body></html>`;

  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(robots);
    }
    if (req.url === '/llms.txt' || req.url === '/sitemap.xml') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    blockPerplexity: () => {
      robots = 'User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';
    },
    stop: () => server.close(),
  };
}

/** Somewhere to run, with the audit allowed to reach loopback. */
async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'citable-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ALLOW_PRIVATE = { CITABLE_ALLOW_PRIVATE: '1' };

test('the action runs, scores a page and writes its outputs', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  Object.assign(process.env, ALLOW_PRIVATE);
  const run = await runAction({ url: site.url, 'min-score': '', 'fail-on': '' }, { cwd });

  assert.equal(run.code, 0, `action failed: ${run.stderr}`);
  assert.match(run.outputs.score, /^\d+$/, 'score output should be a number');
  assert.ok(Number(run.outputs.score) > 0);
  assert.equal(run.outputs.regressed, 'false');
  assert.match(run.summary, /AI visibility score: \d+\/100/);

  // The artifact the workflow uploads has to be real JSON.
  const artifact = JSON.parse(await readFile(path.join(cwd, 'citable-result.json'), 'utf8'));
  assert.equal(typeof artifact.score, 'number');
});

test('the min-score gate fails the step', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  const pass = await runAction({ url: site.url, 'min-score': '1' }, { cwd });
  assert.equal(pass.code, 0);

  const fail = await runAction({ url: site.url, 'min-score': '100' }, { cwd });
  assert.notEqual(fail.code, 0, 'a score below the floor must fail the build');
  // Even when failing, the outputs still have to be written — a workflow may
  // read them in a later step with `if: always()`.
  assert.match(fail.outputs.score, /^\d+$/);
});

test('a regression against a baseline is detected and rendered', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  // Record a baseline while everything is allowed.
  const first = await runAction({ url: site.url }, { cwd });
  assert.equal(first.code, 0);
  await writeFile(path.join(cwd, 'baseline.json'), await readFile(path.join(cwd, 'citable-result.json'), 'utf8'));

  // Then take the site out of Perplexity, exactly the silent change the gate
  // exists to catch.
  site.blockPerplexity();
  const after = await runAction(
    { url: site.url, baseline: 'baseline.json', 'fail-on-regression': 'true' },
    { cwd },
  );

  assert.notEqual(after.code, 0, 'the regression must fail the build');
  assert.equal(after.outputs.regressed, 'true');
  assert.match(after.outputs.score, /^\d+$/, 'a comparison still reports the current score');
  assert.match(after.summary, /Perplexity/, 'the summary should name the engine that was lost');
});

test('the report input writes a second artifact', async (t) => {
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  const run = await runAction({ url: site.url, report: 'audit.md' }, { cwd });
  assert.equal(run.code, 0);
  const report = await readFile(path.join(cwd, 'audit.md'), 'utf8');
  assert.match(report, /# AI Visibility Audit/);
});

test('every input the action documents is actually wired up', async () => {
  // An input that nothing reads is a promise the action does not keep. Checked
  // against the whole step, not just its script: an input can reach the CLI
  // through the step's `env:` block instead of the command line, which is how
  // `key` becomes CITABLE_KEY.
  const yaml = await readFile(path.join(ROOT, 'action.yml'), 'utf8');
  const inputsBlock = yaml.slice(yaml.indexOf('\ninputs:'), yaml.indexOf('\noutputs:'));
  const declared = [...inputsBlock.matchAll(/^  ([a-z-]+):$/gm)].map((match) => match[1]);
  assert.ok(declared.length >= 5, 'expected the action to declare inputs');

  const step = yaml.slice(yaml.indexOf('    - id: audit'));
  for (const name of declared) {
    assert.ok(step.includes(`inputs.${name}`), `input "${name}" is declared but never used`);
  }
});

test('a Pro key passed to the action unlocks the paid output', async (t) => {
  // The key travels through the step's env rather than the argument list, so
  // nothing about the command line proves it arrives. This runs the real
  // script with a real signed key.
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  const secret = 'action-test-signing-secret-32-chars';
  const { issueKey } = await import('../src/core/license.js');
  const { key } = await issueKey({ email: 'buyer@test.co', secret, days: 30 });

  const previous = process.env.CITABLE_LICENSE_SECRET;
  process.env.CITABLE_LICENSE_SECRET = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.CITABLE_LICENSE_SECRET;
    else process.env.CITABLE_LICENSE_SECRET = previous;
  });

  const run = await runAction({ url: site.url, key }, { cwd });
  assert.equal(run.code, 0, run.stderr);

  const artifact = JSON.parse(await readFile(path.join(cwd, 'citable-result.json'), 'utf8'));
  assert.equal(artifact.tier, 'pro', 'the key should have reached the CLI through the step env');
  assert.ok(artifact.generated, 'pro results carry the generated fix files');
});

test('a licence problem never fails the build, and never passes silently', async (t) => {
  // The realistic customer setup: the key is a repository secret and nothing
  // else. A runner has no LICENSE_SECRET, and giving customers one would be
  // giving them the ability to mint keys — so the existing test above, which
  // sets a secret, describes a state no buyer is ever in. It could not have
  // caught the CLI refusing portable keys.
  //
  // What must hold regardless of how the deploy is configured: a key that
  // cannot be verified degrades to the free tier rather than exploding, and
  // says why. A CI gate that fails the build over a licence problem is worse
  // than one reporting a lower tier, and one that goes quiet is worse still —
  // that silence is exactly how a paying customer stayed on the free tier
  // without noticing.
  const site = await startSite();
  t.after(() => site.stop());
  const cwd = await workspace(t);

  const { generateSigningPair, issueKey } = await import('../src/core/license.js');
  const pair = await generateSigningPair();
  const { key } = await issueKey({ email: 'buyer@test.co', privateKey: pair.privateKey, days: 0 });
  assert.ok(key.startsWith('CTB2.'), 'the portable format is what a buyer receives');

  // This pair is not the one compiled into the package, so the key cannot
  // verify — which is precisely the case being checked.
  const previous = process.env.CITABLE_LICENSE_SECRET;
  delete process.env.CITABLE_LICENSE_SECRET;
  t.after(() => {
    if (previous !== undefined) process.env.CITABLE_LICENSE_SECRET = previous;
  });

  const run = await runAction({ url: site.url, key }, { cwd });
  assert.equal(run.code, 0, `an unverifiable key must not fail the build:\n${run.stderr}`);
  assert.match(run.stderr, /not accepted/, 'and it must say so rather than going quiet');

  const artifact = JSON.parse(await readFile(path.join(cwd, 'citable-result.json'), 'utf8'));
  assert.equal(artifact.tier, 'free');
  assert.ok(artifact.score >= 0, 'the audit itself still ran and is still useful');
});
