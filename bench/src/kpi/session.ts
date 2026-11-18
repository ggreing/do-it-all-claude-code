// A session scenario (decision 221): several requests put to ONE session, one after the other, each building on
// the one before, run with the router on and off. What it adds to the single-request runs is the part a long
// session changes: the lead's context grows with every request, and what it costs to carry it.
//
// A step is one `claude -p` process: the first starts the session (--session-id), the others resume it
// (--resume). This file holds what does not need a process: the scenario, the figures read from a step's stream,
// and the grading of a step in a copy of the working tree.
import fs from 'node:fs';
import path from 'node:path';
import { costUsd, type Usage } from '../../../packages/core/src/pricing.ts';
import type { Level } from '../types.ts';
import { BENCH, exec, readJson } from '../util.ts';
import type { StreamLine } from './phases.ts';

export interface ScenarioStep {
  id: string;
  kind: 'feature' | 'fix' | 'extension' | 'refactor';
  level: Level;
  title: string;
  prompt: string;
  /** Paths under the scenario folder. */
  hidden_tests: string[];
  /** A correct solution after this step, as an overlay on the fixture (bench/tasks/sessions/_validate.mjs). */
  oracle: string;
  limits: { timeoutSec: number };
}
export interface Scenario { id: string; fixture: string; title: string; grade: { cmd: string }; steps: ScenarioStep[]; dir: string }

export const SESSIONS_DIR = path.join(BENCH, 'tasks', 'sessions');

export function loadScenario(id: string): Scenario | null {
  const dir = path.join(SESSIONS_DIR, id);
  const file = path.join(dir, 'scenario.json');
  return /^[A-Za-z0-9_.-]+$/.test(id) && fs.existsSync(file) ? { ...readJson<Omit<Scenario, 'dir'>>(file), dir } : null;
}

// ------------------------------------------------------------------ what a step's stream shows

export interface LeadContext {
  /** The lead's model calls in this step (messages, not the stream's one line per content block). */
  calls: number;
  /** Tokens the lead's first and last call of the step read (input + cache read + cache write), and the largest. */
  firstTokens: number | null;
  lastTokens: number | null;
  maxTokens: number | null;
  /** Of the first call: what came from the cache. A resumed step that reads nothing from it pays for the whole context again. */
  firstCacheReadTokens: number | null;
  /** Over the lead's calls of the step. */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  /** Times the session was compacted during the step. */
  compactions: number;
}

interface Message { lead: boolean; model: string; usage: Usage }

/**
 * The stream prints an assistant message once per content block, each line with the same id and usage. One entry
 * per message here, in order. The usage of such a line is the one the message started with: its input side
 * (input, cache read, cache write) is final, its output count is not (on the fair re-measure's streams the lines
 * of a run added up to 162 output tokens where the run's result reported 13,884). So these lines give the
 * context and the input-side cost, never the whole cost.
 */
function messages(lines: readonly StreamLine[]): Message[] {
  const seen = new Map<string, Message>();
  for (const l of lines) {
    if (l.m.type !== 'assistant') continue;
    const msg = l.m.message as { id?: unknown; model?: unknown; usage?: Usage } | undefined;
    if (!msg || typeof msg.id !== 'string' || typeof msg.model !== 'string' || !msg.usage || msg.model === '<synthetic>') continue;
    if (!seen.has(msg.id)) seen.set(msg.id, { lead: l.m.parent_tool_use_id === null || l.m.parent_tool_use_id === undefined, model: msg.model, usage: msg.usage });
  }
  return [...seen.values()];
}

const promptTokens = (u: Usage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

export function leadContext(lines: readonly StreamLine[]): LeadContext {
  const lead = messages(lines).filter(m => m.lead);
  const sizes = lead.map(m => promptTokens(m.usage));
  const sum = (f: (u: Usage) => number | undefined) => lead.reduce((a, m) => a + (f(m.usage) ?? 0), 0);
  return {
    calls: lead.length,
    firstTokens: sizes[0] ?? null,
    lastTokens: sizes.at(-1) ?? null,
    maxTokens: sizes.length ? Math.max(...sizes) : null,
    firstCacheReadTokens: lead[0] ? lead[0].usage.cache_read_input_tokens ?? 0 : null,
    cacheReadTokens: sum(u => u.cache_read_input_tokens),
    cacheWriteTokens: sum(u => u.cache_creation_input_tokens),
    inputTokens: sum(u => u.input_tokens),
    compactions: lines.filter(l => l.m.type === 'system' && l.m.subtype === 'compact_boundary').length,
  };
}

export interface StepCost {
  /** The result line's total_cost_usd. */
  costUsd: number;
  /** The same result's per-model usage, added up (its costUSD figures). */
  usageCostUsd: number | null;
  /** The input side of every message in THIS process's stream at list price: what the step paid to read and write context, without any output. */
  streamInputUsd: number;
  streamInputLeadUsd: number;
  streamInputWorkersUsd: number;
  /** Messages whose model has no price here (their tokens are not in the stream figures). */
  unpricedMessages: number;
}

export function stepCost(lines: readonly StreamLine[], result: Record<string, unknown> | null): StepCost {
  let lead = 0, workers = 0, unpriced = 0;
  for (const m of messages(lines)) {
    const usd = costUsd(m.model.replace(/\[.*$/, ''), { ...m.usage, output_tokens: 0 });
    if (usd === null) { unpriced++; continue; }
    if (m.lead) lead += usd; else workers += usd;
  }
  const perModel = result?.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage as Record<string, { costUSD?: unknown }>) : null;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    costUsd: Number(result?.total_cost_usd ?? 0),
    usageCostUsd: perModel ? round(perModel.reduce((a, u) => a + (Number(u?.costUSD) || 0), 0)) : null,
    streamInputUsd: round(lead + workers), streamInputLeadUsd: round(lead), streamInputWorkersUsd: round(workers), unpricedMessages: unpriced,
  };
}

/**
 * Whether the steps' totals are each process's own or run on over the session. A resumed `claude -p` is a new
 * process, and its total_cost_usd should be its own; that is not documented, so it is read off the numbers: a
 * total below the one before it cannot be cumulative. When the totals never go down, both readings stay open
 * and the session's cost is given both ways.
 */
export function sessionCost(stepTotals: readonly number[]): { reading: 'per-step' | 'undecided'; sumUsd: number; lastUsd: number } {
  const drops = stepTotals.some((c, i) => i > 0 && c < stepTotals[i - 1]!);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { reading: drops || stepTotals.length < 2 ? 'per-step' : 'undecided', sumUsd: round(stepTotals.reduce((a, b) => a + b, 0)), lastUsd: round(stepTotals.at(-1) ?? 0) };
}

/** The session id the process ran in, from its init line (a resume must stay in the session it was given). */
export function sessionIdSeen(lines: readonly StreamLine[]): string | null {
  const id = lines.find(l => l.m.type === 'system' && l.m.subtype === 'init')?.m.session_id;
  return typeof id === 'string' ? id : null;
}

// ------------------------------------------------------------------ grading a step

/** The working tree as it is after a step, copied without git data, tool settings and installed packages. */
export function snapshot(repo: string, dst: string): void {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(repo, dst, { recursive: true, filter: src => !/[\\/](\.git|\.claude|\.bench-hidden|node_modules)$/.test(src) });
}

export interface StepGrade {
  /** The fixture's tests, this step's hidden tests and every earlier step's all pass. */
  pass: boolean;
  /** This step's own hidden tests. */
  own: { pass: number; fail: number; ok: boolean };
  /** Earlier steps whose hidden tests fail in this state. */
  regressions: string[];
  /** The fixture's own tests fail. */
  fixtureFail: boolean;
  detail: string;
}

/** The environment of a grading run: without NODE_TEST_CONTEXT, which makes `node --test` report to a parent test runner instead of printing TAP. */
function gradeEnv(): Record<string, string> {
  const { NODE_TEST_CONTEXT: _parentRunner, ...env } = process.env;
  return env as Record<string, string>;
}

async function tap(cmd: string, cwd: string): Promise<{ ok: boolean; pass: number; fail: number }> {
  const r = await exec(cmd, [], { cwd, shell: true, timeoutSec: 300, env: gradeEnv() });
  const out = r.stdout + r.stderr;
  const n = (k: string) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, 'm'))?.[1] ?? NaN);
  const [pass, fail] = [n('pass'), n('fail')];
  return { ok: r.code === 0 && !r.timedOut && fail === 0 && pass > 0, pass: Number.isFinite(pass) ? pass : 0, fail: Number.isFinite(fail) ? fail : 0 };
}

/**
 * Grades step `index` (0-based) in `dir`, a snapshot of the working tree after that step: never in the session's
 * own repository, where the next step's model could read the hidden tests. Each step's hidden tests run on
 * their own, so a failure is either this step's or a regression of an earlier one.
 */
export async function gradeStep(scenario: Scenario, index: number, dir: string): Promise<StepGrade> {
  const hidden = path.join(dir, '.bench-hidden');
  fs.rmSync(hidden, { recursive: true, force: true });
  fs.mkdirSync(hidden, { recursive: true });
  const steps = scenario.steps.slice(0, index + 1);
  for (const s of steps) for (const h of s.hidden_tests) fs.copyFileSync(path.join(scenario.dir, h), path.join(hidden, path.basename(h)));
  const files = (s: ScenarioStep) => s.hidden_tests.map(h => `".bench-hidden/${path.basename(h)}"`).join(' ');
  const fixture = await tap('node --test --test-reporter=tap "test/**/*.test.ts"', dir);
  const regressions: string[] = [];
  let own = { pass: 0, fail: 0, ok: false };
  for (const s of steps) {
    const r = await tap(`node --test --test-reporter=tap ${files(s)}`, dir);
    if (s === steps.at(-1)) own = r; else if (!r.ok) regressions.push(s.id);
  }
  const pass = fixture.ok && own.ok && regressions.length === 0;
  const detail = `own pass=${own.pass} fail=${own.fail}${regressions.length ? `, regressions in ${regressions.join(',')}` : ''}${fixture.ok ? '' : ', fixture tests fail'}`;
  return { pass, own, regressions, fixtureFail: !fixture.ok, detail };
}

/**
 * How a step ended, given the steps before it: a step that fails after an earlier failure may only be paying for
 * that one (the session goes on with whatever state it has, as a user who did not notice would).
 */
export function stepStatus(passed: readonly boolean[], index: number): 'pass' | 'failed' | 'failed_after_failure' {
  if (passed[index]) return 'pass';
  return passed.slice(0, index).every(Boolean) ? 'failed' : 'failed_after_failure';
}

/** Files and lines that differ between two snapshots (git's no-index diff; the hidden tests are not counted). */
export async function snapshotDiff(before: string, after: string): Promise<{ changedFiles: number; linesAdded: number; linesRemoved: number }> {
  const r = await exec('git', ['diff', '--no-index', '--numstat', '--', before, after], { cwd: path.dirname(after) });
  let linesAdded = 0, linesRemoved = 0, changedFiles = 0;
  for (const l of r.stdout.split('\n').filter(Boolean)) {
    const [a, d, f] = l.split('\t');
    if (f && f.includes('.bench-hidden')) continue;
    changedFiles++; linesAdded += Number(a) || 0; linesRemoved += Number(d) || 0;
  }
  return { changedFiles, linesAdded, linesRemoved };
}
