#!/usr/bin/env node
// Self-check for the session scenarios (bench/tasks/sessions/*/scenario.json).
//
// A scenario is a list of requests put to one session, one after the other, on one fixture. Each step has
// hidden tests and an oracle: the files of a correct solution after that step, as an overlay on the fixture
// (so the oracle of step k holds everything the steps 1..k changed).
//
// For every scenario:
//   lint:   the shape of scenario.json, the files it names, step ids in order, hidden test names unique
//   chain:  the oracle of step k has every file the oracle of step k-1 has
//   after:  fixture + oracle k + the hidden tests of steps 1..k  -> the grade command passes, no failure
//   before: fixture + oracle k-1 (the bare fixture for step 1) + the hidden tests of step k alone
//           -> the fixture's own tests pass, and at least one hidden test of step k fails
// No model is called and nothing leaves the temp folder.
//
// Usage: node bench/tasks/sessions/_validate.mjs [--keep] [--verbose] [scenarioId ...]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SESSIONS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SESSIONS_DIR, '..', '..', 'fixtures');
const OWN_CMD = 'node --test --test-reporter=tap "test/**/*.test.ts"';
const HIDDEN_CMD = 'node --test --test-reporter=tap ".bench-hidden/*.test.ts"';
const LEVELS = ['L0', 'L1', 'L2', 'L3'];
const KINDS = ['feature', 'fix', 'extension', 'refactor'];
const STEP_KEYS = ['id', 'kind', 'level', 'title', 'prompt', 'hidden_tests', 'oracle', 'limits'];

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verbose = argv.includes('--verbose');
const only = argv.filter((a) => !a.startsWith('--'));

function filesUnder(dir, rel = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`]);
}

function lint(scenario, dirName, dir) {
  const errors = [];
  if (scenario.id !== dirName) errors.push(`id "${scenario.id}" is not the folder name`);
  if (typeof scenario.title !== 'string' || !scenario.title) errors.push('title is missing');
  if (!existsSync(join(FIXTURES_DIR, String(scenario.fixture), 'package.json'))) errors.push(`unknown fixture: ${scenario.fixture}`);
  if (typeof scenario.grade?.cmd !== 'string' || !scenario.grade.cmd.includes('.bench-hidden')) errors.push('grade.cmd must run the hidden tests');
  if (!Array.isArray(scenario.steps) || scenario.steps.length < 2) return [...errors, 'steps must list at least two steps'];
  const names = new Set();
  scenario.steps.forEach((s, i) => {
    const at = `step ${s.id ?? i + 1}`;
    for (const k of STEP_KEYS) if (s[k] === undefined) errors.push(`${at}: ${k} is missing`);
    for (const k of Object.keys(s)) if (!STEP_KEYS.includes(k)) errors.push(`${at}: unknown key ${k}`);
    if (s.id !== String(i + 1).padStart(2, '0')) errors.push(`${at}: id must be ${String(i + 1).padStart(2, '0')}`);
    if (!LEVELS.includes(s.level)) errors.push(`${at}: level ${s.level}`);
    if (!KINDS.includes(s.kind)) errors.push(`${at}: kind ${s.kind}`);
    if (typeof s.prompt !== 'string' || s.prompt.trim().length < 40) errors.push(`${at}: prompt is too short`);
    if (!(Number.isInteger(s.limits?.timeoutSec) && s.limits.timeoutSec > 0)) errors.push(`${at}: limits.timeoutSec`);
    if (!Array.isArray(s.hidden_tests) || s.hidden_tests.length === 0) errors.push(`${at}: hidden_tests is empty`);
    for (const h of s.hidden_tests ?? []) {
      if (!existsSync(join(dir, h))) errors.push(`${at}: hidden test not found: ${h}`);
      if (names.has(basename(h))) errors.push(`${at}: hidden test name used twice: ${basename(h)}`);
      names.add(basename(h));
    }
    const oracle = join(dir, String(s.oracle));
    if (!existsSync(oracle) || !statSync(oracle).isDirectory() || filesUnder(oracle).length === 0) errors.push(`${at}: oracle folder is missing or empty: ${s.oracle}`);
  });
  return errors;
}

/** TAP totals of a node --test run (without NODE_TEST_CONTEXT, with which it would report to a parent test runner and print no TAP). */
function run(cmd, cwd) {
  const { NODE_TEST_CONTEXT: _parentRunner, ...env } = process.env;
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: 300_000, env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const n = (k) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
  return { code: r.status, pass: n('pass'), fail: n('fail'), out };
}

function stage(scenario, dir, root, name, oracleStep, hiddenSteps) {
  const repo = join(root, name);
  cpSync(join(FIXTURES_DIR, scenario.fixture), repo, { recursive: true });
  if (oracleStep) cpSync(join(dir, oracleStep.oracle), repo, { recursive: true, force: true });
  const hidden = join(repo, '.bench-hidden');
  mkdirSync(hidden, { recursive: true });
  for (const s of hiddenSteps) for (const h of s.hidden_tests) cpSync(join(dir, h), join(hidden, basename(h)));
  return repo;
}

function check(dirName) {
  const dir = join(SESSIONS_DIR, dirName);
  const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  const problems = lint(scenario, dirName, dir);
  if (problems.length) return problems;
  const root = mkdtempSync(join(tmpdir(), `bench-session-${dirName}-`));
  const say = (text, r) => { problems.push(text); if (verbose && r) console.log(r.out); };
  try {
    scenario.steps.forEach((step, i) => {
      const before = scenario.steps[i - 1];
      if (before) {
        const have = new Set(filesUnder(join(dir, step.oracle)));
        for (const f of filesUnder(join(dir, before.oracle))) if (!have.has(f)) say(`step ${step.id}: the oracle lacks ${f}, which step ${before.id} changed`);
      }
      // after: the solution up to this step passes everything asked so far
      const after = run(scenario.grade.cmd.replace('node --test', 'node --test --test-reporter=tap'), stage(scenario, dir, root, `${step.id}-after`, step, scenario.steps.slice(0, i + 1)));
      if (after.code !== 0 || after.fail !== 0 || !(after.pass > 0)) say(`step ${step.id}: its oracle does not pass the tests of steps 01..${step.id} (pass ${after.pass}, fail ${after.fail})`, after);
      // before: the state the step starts from fails this step's tests, and only those
      const start = stage(scenario, dir, root, `${step.id}-before`, before, [step]);
      const own = run(OWN_CMD, start);
      if (own.code !== 0) say(`step ${step.id}: the fixture's own tests fail before the step (fail ${own.fail})`, own);
      const hidden = run(HIDDEN_CMD, start);
      if (hidden.code === 0 || !(hidden.fail > 0)) say(`step ${step.id}: its hidden tests already pass before the step`, hidden);
      console.log(`  step ${step.id} ${step.level} ${step.kind.padEnd(9)} after: pass ${after.pass} fail ${after.fail}   before: own pass ${own.pass}, hidden fail ${hidden.fail} of ${hidden.pass + hidden.fail}`);
    });
  } finally {
    if (keep) console.log(`  kept: ${root}`); else rmSync(root, { recursive: true, force: true });
  }
  return problems;
}

const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SESSIONS_DIR, d.name, 'scenario.json')))
  .map((d) => d.name).filter((n) => only.length === 0 || only.includes(n)).sort();
if (dirs.length === 0) { console.error('no scenario found'); process.exit(2); }
let bad = 0;
for (const d of dirs) {
  console.log(d);
  const problems = check(d);
  for (const p of problems) console.log(`  PROBLEM ${p}`);
  if (problems.length) bad++; else console.log('  ok');
}
process.exit(bad ? 1 : 0);
