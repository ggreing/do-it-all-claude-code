// Reproduce first (decisions 175, 177, 179): for a bug fix or a new behavior the coder writes a test that
// fails because of the problem, before it changes anything else. The router runs that test when the file is
// written (from the PostToolUse hook, while the tree is still "start state plus tests"), records that it
// failed, and at the subagent's stop runs it again: it must pass, and the file must be the one seen failing.
//
// What the router runs is its own command: a template chosen here (or from the project's verify.json at the
// start commit), filled with the test file's repo-relative path as one quoted word. A subagent names nothing.
import fs from 'node:fs';
import path from 'node:path';
import type { VerifySignal } from '@do-it-all-claude-code/core';
import { relativeWithin } from './canonical.ts';
import { verifyEnv } from './env.ts';
import { fileFingerprint, showFile } from './git.ts';
import { tailText } from './payload.ts';
import { zeroTestsRan, type Shell } from './shell.ts';
import { existsInTree, missingTool, runCommand, testCounts, validTreePath } from './verify.ts';
import { PROJECT_VERIFY_FILE } from './verify-source.ts';

export type ReproMode = 'on' | 'observe' | 'off';
/** Until the measurement of decision 175 has chosen the release default, nothing changes unless it is set. */
export const DEFAULT_REPRODUCE_FIRST: ReproMode = 'off';
export const reproMode = (c: { reproduceFirst?: ReproMode } | undefined): ReproMode => c?.reproduceFirst ?? DEFAULT_REPRODUCE_FIRST;

/** One run of a test file; outside verify's own limits. A run that hits it is "not checked", not a failure. */
export const REPRO_TIMEOUT_MS = 60_000;
/** All runs at one stop. */
export const REPRO_STOP_TIMEOUT_MS = 90_000;
/** Runs from the PostToolUse hook per subtask attempt; further test edits are not run. */
export const MAX_REPRO_RUNS = 6;
export const MAX_REPRO_FILES = 3;

export const OFF_REASONS = ['refactor', 'docs', 'config', 'no-tests', 'not-testable'] as const;
export const NONE_REASONS = ['no-tests', 'not-testable', 'cannot-reproduce'] as const;

/** How the test failed on the unfixed code. `load` and `unknown` are accepted (the unchanged test must pass
 *  afterwards) and labelled; such a result is never an easy pass. */
export type FailureKind = 'body' | 'load' | 'unknown';

export interface ReproFile { fingerprint: string; kind: FailureKind; failed?: number }

/** Kept with the subtask (ledger column `repro`): paths, fingerprints and numbers only, no output. */
export interface ReproRecord {
  /** Whether this subtask must reproduce. */
  required: boolean;
  /** Who decided: the lead's `[repro: …]` line or the router's default. */
  by: 'lead' | 'router';
  /** Why it is off, or why it ended unconfirmed. */
  reason?: string;
  /**
   * pending      required, no test seen failing yet
   * confirmed    a test was seen failing on the unfixed code
   * reproduced   that test, unchanged, passes at the stop
   * failed       that test still fails at the stop (or is gone)
   * unconfirmed  could not be shown; the reason says why
   */
  state?: 'pending' | 'confirmed' | 'reproduced' | 'failed' | 'unconfirmed';
  /** Only recorded (config `observe`): nothing is failed for it. */
  observe?: boolean;
  files?: Record<string, ReproFile>;
  runs?: number;
  /** The last run at a stop. */
  after?: { ok: boolean; exitCode: number | null; durationMs: number; failed?: number };
}

// ------------------------------------------------------------------ the lead's tag line

const REPRO_LINE = /^\s*\[repro:\s*(required|off)\b\s*([a-z-]*)\s*\]\s*$/i;

export type ReproTag = { ok: true; required: boolean; reason?: string } | { ok: false; reason: string };

/** `[repro: required]` or `[repro: off <reason>]` on the second or third prompt line; undefined without one. */
export function parseReproTag(prompt: string | undefined): ReproTag | undefined {
  const lines = (prompt ?? '').split(/\r?\n/, 4).slice(1, 3);
  for (const l of lines) {
    if (!/^\s*\[repro:/i.test(l)) continue;
    const m = REPRO_LINE.exec(l);
    if (!m) return { ok: false, reason: `the [repro: ...] line must be "[repro: required]" or "[repro: off <reason>]" with a reason of ${OFF_REASONS.join(', ')}` };
    if (m[1]!.toLowerCase() === 'required') return { ok: true, required: true };
    const reason = m[2]!.toLowerCase();
    if (!(OFF_REASONS as readonly string[]).includes(reason)) {
      return { ok: false, reason: `"[repro: off ...]" needs a reason: ${OFF_REASONS.join(', ')}` };
    }
    return { ok: true, required: false, reason };
  }
  return undefined;
}

const DOC_GLOB = /\.(md|mdx|txt|rst|adoc|json|ya?ml|toml|ini|cfg|conf|lock|svg|png|jpe?g|gif|css|scss|html?)$|(^|\/)(docs?|\.github)\/|(^|\/)(LICENSE|README|CHANGELOG)[^/]*$/i;

/**
 * The router's default for a coder subtask without the tag line: required for a bug fix, a new behavior or
 * an unclassified change, unless every scope glob names documentation or configuration; off for a refactor.
 */
export function defaultRepro(taskType: string, scope: readonly string[], unscoped: boolean): { required: boolean; reason?: string } {
  if (taskType === 'refactor') return { required: false, reason: 'refactor' };
  if (taskType === 'question' || taskType === 'design') return { required: false, reason: 'not-testable' };
  if (!unscoped && scope.length && scope.every(g => DOC_GLOB.test(g))) return { required: false, reason: /\.(md|mdx|txt|rst|adoc)$|docs?\//i.test(scope[0]!) ? 'docs' : 'config' };
  return { required: true };
}

// ------------------------------------------------------------------ the coder's report line

const NONE_LINE = /(?:^|[\s>*_`~|-])repro[*_`]*\s*:\s*[*_`]*\s*none\b[\s(*_`:-]*([a-z-]+)?/gi;

/** The reason of a `Repro: none (<reason>)` line in a coder's report, or undefined. An echoed list of reasons says nothing. */
export function reportedNone(lastMessage: unknown): string | undefined {
  if (typeof lastMessage !== 'string' || !lastMessage) return undefined;
  const found = new Set<string>();
  for (const m of lastMessage.slice(0, 20_000).matchAll(NONE_LINE)) {
    const r = (m[1] ?? '').toLowerCase();
    found.add((NONE_REASONS as readonly string[]).includes(r) ? r : 'no-reason');
  }
  return found.size === 1 ? [...found][0] : undefined;
}

// ------------------------------------------------------------------ which files are tests

const TEST_NAME = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|tests?\.py|[^/]*\.(test|spec)\.[cm]?[jt]sx?|[^/]*_test\.go)$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|testdata|fixtures|__fixtures__|__snapshots__)\//i;
const CODE_EXT = /\.([cm]?[jt]sx?|py|go)$/;

/** A file the router may run as a reproduction: a test by its name, or a code file under a test folder. */
export function isTestFile(rel: string): boolean {
  if (/(^|\/)(conftest\.py|__init__\.py)$/.test(rel)) return false;
  return TEST_NAME.test(rel) || (TEST_DIR.test(rel) && CODE_EXT.test(rel) && !/(^|\/)(fixtures|__fixtures__|testdata|__snapshots__)\//i.test(rel));
}

/** A change that leaves the tree "start state plus tests": a test, or anything under a test folder. */
export const isTestSupport = (rel: string) => TEST_NAME.test(rel) || TEST_DIR.test(rel);

/** The repo-relative path (forward slashes) of a tool's file path, or undefined when it is outside the tree. */
export function treePath(root: string, cwd: string | undefined, file: string): string | undefined {
  // Git Bash spells a drive as /c/...; the edit tools take Windows paths, but a model may pass either
  const p = process.platform === 'win32' ? file.replace(/^\/([A-Za-z])\//, '$1:/') : file;
  return relativeWithin(root, path.resolve(cwd ?? root, p)) ?? undefined;
}

// ------------------------------------------------------------------ templates

export interface ReproTemplate {
  /** For the failure classification; any other name is "unknown". */
  runner?: string;
  /** `{reproFiles}`: the test file as one quoted word; `{reproPackages}`: its folder (`./dir`). */
  command: string;
  /** A regular expression the test file's path must match. */
  files?: string;
  ifExists?: string;
  ifAnyExists?: string[];
  /** A name in package.json's dependencies or devDependencies. */
  ifDependency?: string;
}

const JS = '\\.[cm]?[jt]sx?$';
export const DEFAULT_REPRO_TEMPLATES: readonly ReproTemplate[] = [
  { runner: 'pytest', files: '\\.py$', command: 'python -m pytest -q -x {reproFiles}', ifAnyExists: ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'] },
  { runner: 'vitest', files: JS, command: 'npx vitest run {reproFiles}', ifDependency: 'vitest' },
  { runner: 'jest', files: JS, command: 'npx jest {reproFiles}', ifDependency: 'jest' },
  { runner: 'node', files: JS, command: 'node --test {reproFiles}', ifExists: 'package.json' },
  { runner: 'go', files: '_test\\.go$', command: 'go test {reproPackages}', ifExists: 'go.mod' },
];

const PLACEHOLDERS = ['{reproFiles}', '{reproPackages}'];

function parseTemplate(x: unknown): ReproTemplate {
  if (!x || typeof x !== 'object' || typeof (x as { command?: unknown }).command !== 'string') throw new Error('each repro entry must be { command, files?, runner?, ifExists?, ifAnyExists?, ifDependency? }');
  const o = x as Record<string, unknown>;
  const command = (o.command as string).trim();
  if (!PLACEHOLDERS.some(p => command.includes(p))) throw new Error(`a repro command needs ${PLACEHOLDERS.join(' or ')}: ${command}`);
  const out: ReproTemplate = { command };
  if (o.runner !== undefined) { if (typeof o.runner !== 'string') throw new Error('runner must be a string'); out.runner = o.runner; }
  if (o.files !== undefined) {
    if (typeof o.files !== 'string') throw new Error('files must be a regular expression string');
    try { new RegExp(o.files); } catch { throw new Error(`files is not a regular expression: ${o.files}`); }
    out.files = o.files;
  }
  if (o.ifExists !== undefined) {
    if (typeof o.ifExists !== 'string' || !validTreePath(o.ifExists)) throw new Error(`ifExists must be a repo-relative path inside the repository: ${String(o.ifExists)}`);
    out.ifExists = o.ifExists;
  }
  if (o.ifAnyExists !== undefined) {
    if (!Array.isArray(o.ifAnyExists) || !o.ifAnyExists.length || o.ifAnyExists.some(p => typeof p !== 'string' || !validTreePath(p))) throw new Error('ifAnyExists must be a non-empty list of repo-relative paths inside the repository');
    out.ifAnyExists = o.ifAnyExists as string[];
  }
  if (o.ifDependency !== undefined) {
    if (typeof o.ifDependency !== 'string' || !o.ifDependency) throw new Error('ifDependency must be a package name');
    out.ifDependency = o.ifDependency;
  }
  return out;
}

/** The `repro` list of a verify.json document; undefined when it has none. Throws on a malformed list. */
export function projectReproTemplates(doc: unknown): ReproTemplate[] | undefined {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  const list = (doc as Record<string, unknown>).repro;
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new Error('"repro" must be a list');
  return list.map(parseTemplate);
}

/**
 * The templates for a work tree: the project's (verify.json at the commit the subagent started on, so a
 * subagent cannot choose what runs), else the defaults.
 */
export async function resolveReproTemplates(root: string, baseRef: string | undefined): Promise<{ templates: readonly ReproTemplate[]; warning?: string }> {
  try {
    const text = baseRef ? await showFile(root, baseRef, PROJECT_VERIFY_FILE) : readIfExists(path.join(root, PROJECT_VERIFY_FILE));
    if (text !== undefined) {
      const own = projectReproTemplates(JSON.parse(text));
      if (own) return { templates: own };
    }
  } catch (e) {
    return { templates: DEFAULT_REPRO_TEMPLATES, warning: `${PROJECT_VERIFY_FILE} "repro" ignored: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
  }
  return { templates: DEFAULT_REPRO_TEMPLATES };
}

function readIfExists(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function hasDependency(root: string, name: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies'].some(k => {
      const d = pkg[k];
      return !!d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, name);
    });
  } catch {
    return false;
  }
}

/** The first template that applies to this test file in this tree. */
export function pickTemplate(templates: readonly ReproTemplate[], root: string, rel: string): ReproTemplate | undefined {
  return templates.find(t => {
    if (t.files !== undefined && !new RegExp(t.files).test(rel)) return false;
    if (t.ifExists !== undefined && existsInTree(root, t.ifExists) !== true) return false;
    if (t.ifAnyExists !== undefined && !t.ifAnyExists.some(p => existsInTree(root, p) === true)) return false;
    if (t.ifDependency !== undefined && !hasDependency(root, t.ifDependency)) return false;
    return true;
  });
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command line for one test file: every placeholder becomes one single-quoted word that cannot be an option. */
export function reproCommand(t: ReproTemplate, rel: string): string {
  const file = rel.startsWith('-') ? `./${rel}` : rel;
  const dir = path.posix.dirname(rel);
  return t.command.split('{reproFiles}').join(shQuote(file)).split('{reproPackages}').join(shQuote(dir === '.' ? '.' : `./${dir}`));
}

// ------------------------------------------------------------------ one run

export type ReproOutcome =
  | { result: 'failed'; kind: FailureKind; failed?: number }
  | { result: 'passed' }
  | { result: 'no-tests'; what: string }
  | { result: 'not-checked'; why: string };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** What a finished run of a test file says. Only the runner's exit code and summary lines are read. */
export function classifyRun(runner: string | undefined, command: string, output: string, code: number | null, timedOut: boolean, aborted: boolean): ReproOutcome {
  if (aborted) return { result: 'not-checked', why: 'aborted' };
  if (timedOut) return { result: 'not-checked', why: `no result within ${Math.round(REPRO_TIMEOUT_MS / 1000)}s` };
  const text = output.replace(ANSI, '');
  const missing = code !== 0 ? missingTool(code, text) : undefined;
  if (missing) return { result: 'not-checked', why: missing };
  const zero = zeroTestsRan(command, text, code);
  if (zero) return { result: 'no-tests', what: zero };
  if (runner === 'go' && /\[no tests to run\]|no test files/.test(text) && !/--- FAIL/.test(text)) return { result: 'no-tests', what: 'go test: no tests to run' };
  if (code === 0) return { result: 'passed' };
  const failed = testCounts(text).testsFailed;
  const n = failed !== undefined ? { failed } : {};
  let kind: FailureKind = 'unknown';
  switch (runner) {
    case 'pytest':
      if (code === 2 || /\b\d+ errors?\b/.test(text) || /^(E\s+)?(ImportError|ModuleNotFoundError|SyntaxError)\b.*$/m.test(text) && !/\b\d+ failed\b/.test(text)) kind = 'load';
      else if (code === 1 && /\b\d+ failed\b/.test(text)) kind = 'body';
      break;
    case 'jest':
      if (/Test suite failed to run/.test(text)) kind = 'load';
      else if (/Tests:\s+\d+ failed/.test(text)) kind = 'body';
      break;
    case 'vitest':
      if (/Failed Suites|Failed to (load|resolve)|Cannot find (module|package)|SyntaxError/.test(text) && !/Tests\s+\d+ failed/.test(text)) kind = 'load';
      else if (/Tests\s+\d+ failed/.test(text)) kind = 'body';
      break;
    case 'node':
      if (/ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Cannot find (module|package)|SyntaxError|does not provide an export named/.test(text)) kind = 'load';
      else if ((failed ?? 0) > 0) kind = 'body';
      break;
    case 'go':
      if (/\[(build|setup) failed\]/.test(text)) kind = 'load';
      else if (/^\s*--- FAIL/m.test(text)) kind = 'body';
      break;
    default:
  }
  return { result: 'failed', kind, ...n };
}

export interface ReproRun {
  root: string;
  rel: string;
  template: ReproTemplate;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  shell?: Shell;
  signal?: AbortSignal;
  secrets?: string[];
}

export interface ReproRunResult { command: string; outcome: ReproOutcome; exitCode: number | null; durationMs: number; tail: string }

export async function runRepro(r: ReproRun): Promise<ReproRunResult> {
  const command = reproCommand(r.template, r.rel);
  const t0 = Date.now();
  // a daemon started from a test runner must not hand its reporter channel to the run (node --test would then report to the parent and exit 0)
  const { NODE_TEST_CONTEXT: _ctx, ...env } = r.env ?? verifyEnv();
  const res = await runCommand(command, r.root, r.timeoutMs ?? REPRO_TIMEOUT_MS, r.signal, { env, ...(r.shell ? { shell: r.shell } : {}) });
  const outcome = classifyRun(r.template.runner, command, res.output, res.code, res.timedOut, res.aborted);
  return { command, outcome, exitCode: res.code, durationMs: Date.now() - t0, tail: tailText(res.output, 800, r.secrets) };
}

// ------------------------------------------------------------------ at the stop

export interface StopCheck {
  record: ReproRecord;
  /** A `repro` signal for the stop's verification; absent under `observe` and when nothing ran. */
  signal?: VerifySignal;
  spentMs: number;
}

/**
 * The stop of a subtask that must reproduce. A confirmed test is run again: it must pass and be unchanged.
 * Nothing confirmed: the result is unconfirmed, with the coder's own reason when its report gives one.
 */
export async function checkAtStop(
  rec: ReproRecord, lastMessage: unknown,
  ctx: { root: string; templates: readonly ReproTemplate[]; env?: NodeJS.ProcessEnv; shell?: Shell; signal?: AbortSignal; secrets?: string[] },
): Promise<StopCheck> {
  const files = Object.entries(rec.files ?? {});
  if (rec.state !== 'confirmed' && rec.state !== 'failed' && rec.state !== 'reproduced' || !files.length) {
    if (rec.state === 'unconfirmed') return { record: rec, spentMs: 0 };
    return { record: { ...rec, state: 'unconfirmed', reason: reportedNone(lastMessage) ?? rec.reason ?? 'no-test' }, spentMs: 0 };
  }
  const t0 = Date.now();
  const deadline = t0 + REPRO_STOP_TIMEOUT_MS;
  let failed: { rel: string; run: ReproRunResult } | undefined;
  let notChecked: string | undefined;
  let last: ReproRunResult | undefined;
  for (const [rel] of files) {
    const template = pickTemplate(ctx.templates, ctx.root, rel);
    if (!template) { notChecked = 'no test command applies any more'; break; }
    const left = deadline - Date.now();
    if (left <= 1000) { notChecked = 'time limit'; break; }
    const run = await runRepro({ root: ctx.root, rel, template, timeoutMs: Math.min(REPRO_TIMEOUT_MS, left), ...pick(ctx) });
    last = run;
    if (run.outcome.result === 'not-checked') { notChecked = run.outcome.why; break; }
    if (run.outcome.result !== 'passed') { failed = { rel, run }; break; }
  }
  const spentMs = Date.now() - t0;
  const after = last ? { ok: !failed && !notChecked, exitCode: last.exitCode, durationMs: spentMs, ...(last.outcome.result === 'failed' && last.outcome.failed !== undefined ? { failed: last.outcome.failed } : {}) } : undefined;
  const base: ReproRecord = { ...rec, ...(after ? { after } : {}) };
  if (failed) {
    const gone = !fs.existsSync(path.join(ctx.root, failed.rel));
    const what = gone ? 'the test file is gone' : failed.run.outcome.result === 'no-tests' ? `no tests ran (${failed.run.outcome.what})` : `exit ${failed.run.exitCode}`;
    const signal: VerifySignal = {
      kind: 'repro', ok: false, exitCode: failed.run.exitCode, durationMs: failed.run.durationMs,
      ...(failed.run.outcome.result === 'failed' && failed.run.outcome.failed !== undefined ? { testsFailed: failed.run.outcome.failed } : {}),
      detail: `${failed.run.command}: the reproduction test ${failed.rel} still fails after the change (${what})${failed.run.tail ? `\n${failed.run.tail}` : ''}`,
    };
    return { record: { ...base, state: 'failed' }, ...(rec.observe ? {} : { signal }), spentMs };
  }
  if (notChecked) return { record: { ...base, state: 'unconfirmed', reason: `not-checked: ${notChecked}`.slice(0, 120) }, spentMs };
  const changed = files.filter(([rel, f]) => fileFingerprint(ctx.root, rel) !== f.fingerprint).map(([rel]) => rel);
  if (changed.length) return { record: { ...base, state: 'unconfirmed', reason: 'test-changed' }, spentMs };
  const signal: VerifySignal = {
    kind: 'repro', ok: true, exitCode: 0, durationMs: spentMs,
    detail: `${files.map(([rel]) => rel).join(', ')}: failed before the change, passes after it, unchanged`,
  };
  return { record: { ...base, state: 'reproduced' }, ...(rec.observe ? {} : { signal }), spentMs };
}

function pick(c: { env?: NodeJS.ProcessEnv; shell?: Shell; signal?: AbortSignal; secrets?: string[] }) {
  return { ...(c.env ? { env: c.env } : {}), ...(c.shell ? { shell: c.shell } : {}), ...(c.signal ? { signal: c.signal } : {}), ...(c.secrets ? { secrets: c.secrets } : {}) };
}

// ------------------------------------------------------------------ words

/** For a coder whose subtask must reproduce, at its start. */
export const REPRO_START_NOTE = '[do-it-all-claude-code] This subtask needs a reproduction first. Before you change any other file, write one test file that fails because of the problem (or because the new behavior is missing), and install the dependencies first if they are missing. '
  + 'The router runs that file when you save it and tells you what it saw. After it was seen failing, make the change and leave that test file as it is; put further tests in another file. '
  + 'If the problem cannot be shown by a test, write "Repro: none (no-tests | not-testable | cannot-reproduce)" in your report.';

const kindNote = (k: FailureKind) => k === 'body' ? '' : k === 'load'
  ? ' It failed while loading, not in a test body: if that is a mistake in the test, correct the test now, before you change anything else; if the code it needs does not exist yet, go on.'
  : ' The router could not tell how it failed; make sure it fails for the reported reason.';

/** What the coder is told after a run from the PostToolUse hook. */
export function editNote(subtaskId: string, rel: string, run: ReproRunResult): string {
  const head = `[do-it-all-claude-code] reproduction for subtask ${subtaskId}:`;
  const o = run.outcome;
  switch (o.result) {
    case 'failed':
      return `${head} ${rel} fails on the unchanged code${o.failed !== undefined ? ` (${o.failed} failed)` : ''}, as a reproduction should.${kindNote(o.kind)} Now make the change. Do not edit ${rel} again; put further tests in another file. The router runs it again when you finish: it must pass then.`;
    case 'passed':
      return `${head} ${rel} passes on the unchanged code, so it does not show the problem. Change it so that it fails for the reported reason before you change anything else, or, if the problem cannot be reproduced, say "Repro: none (cannot-reproduce)" in your report.`;
    case 'no-tests':
      return `${head} ${run.command} ran no tests (${o.what}). Make ${rel} a test file the runner picks up before you change anything else.`;
    default:
      return `${head} the router could not run ${rel} (${o.why}); the reproduction stays unconfirmed. Go on with the change.`;
  }
}

/** One clause for the lead's result line; empty when the subtask did not have to reproduce. */
export function leadNote(rec: ReproRecord | null | undefined): string {
  if (!rec?.required || !rec.state || rec.state === 'pending' || rec.state === 'confirmed') return '';
  const files = Object.keys(rec.files ?? {}).join(', ');
  const kinds = [...new Set(Object.values(rec.files ?? {}).map(f => f.kind))].filter(k => k !== 'body');
  const label = kinds.length ? ` (how it failed before: ${kinds.join(', ')})` : '';
  switch (rec.state) {
    case 'reproduced':
      return ` Reproduction: ${files} failed before the change and passes after it, unchanged${label}.`;
    case 'failed':
      return rec.observe ? ` Reproduction (recorded only): ${files} still fails after the change.` : '';
    default: {
      const why = rec.reason === 'test-changed' ? `${files} was changed after it was seen failing`
        : rec.reason === 'cannot-reproduce' ? 'the coder could not make a test fail on the unchanged code'
        : rec.reason === 'changed-first' ? 'other files were changed before a test was seen failing'
        : rec.reason === 'shared-tree' ? 'another subtask was changing files in the same work tree'
        : rec.reason === 'no-test' ? 'no test was seen failing before the change'
        : rec.reason ?? 'not shown';
      return ` Reproduction unconfirmed (${why}): the reported problem was not seen failing first, so this result does not show that it is gone. If that matters here, say so to the user or dispatch a check.`;
    }
  }
}
