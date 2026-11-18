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

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const;

/** One model's figures on a result line (modelUsage and model_usage_since_last_result have the same shape). */
export interface ModelFigures { inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUsd: number }

function figures(v: unknown): Record<string, ModelFigures> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, ModelFigures> = {};
  for (const [model, u] of Object.entries(v as Record<string, Record<string, unknown> | null>)) {
    const f = {} as ModelFigures;
    for (const k of TOKEN_KEYS) f[k] = Number(u?.[k]) || 0;
    f.costUsd = Number(u?.costUSD) || 0;
    out[model] = f;
  }
  return out;
}

/**
 * What a step's process reported about cost. In a resumed session these are not the step's own figures:
 * total_cost_usd and modelUsage go on from the total the session's transcript saved, so a step's last result
 * carries every step so far (measured in the first session of this scenario: each step's cache-read count in
 * modelUsage was the sum of the streams of the steps up to it; Claude Code 2.1.326 describes the field so too).
 */
export interface Reported {
  /** total_cost_usd of the process's last result line; 0 without one. */
  totalUsd: number;
  /** modelUsage of the same line. */
  modelUsage: Record<string, ModelFigures> | null;
  /**
   * The cost in model_usage_since_last_result, added over ALL the process's result lines (a process that waits
   * for background workers writes several): what this process itself counted. Null when no line carries the
   * field (it is optional). Calls that end after the last result line are not in it.
   */
  sinceLastResultUsd: number | null;
}

export function reported(lines: readonly StreamLine[], result: Record<string, unknown> | null): Reported {
  let since: number | null = null;
  for (const l of lines) {
    if (l.m.type !== 'result') continue;
    const f = figures(l.m.model_usage_since_last_result);
    if (f) since = (since ?? 0) + Object.values(f).reduce((a, u) => a + u.costUsd, 0);
  }
  return { totalUsd: Number(result?.total_cost_usd) || 0, modelUsage: figures(result?.modelUsage), sinceLastResultUsd: since === null ? null : round6(since) };
}

/** Round trips of the lead over the step: num_turns of a result line counts one turn, and a process woken by its background workers writes a result per turn. */
export function leadTurns(lines: readonly StreamLine[]): number | null {
  const results = lines.filter(l => l.m.type === 'result');
  return results.length ? results.reduce((a, l) => a + (Number(l.m.num_turns) || 0), 0) : null;
}

/**
 * How a step's cost was taken from its reported total:
 * - 'first': nothing was reported before it, the total is the step's.
 * - 'difference': the total minus the total of the step before (the usual case in a resumed session).
 * - 'own-total': the total did not go on from the step before, so it is the step's own. A total below the one
 *   before cannot be a running total; and where the process's own since-last-result figures add up to the
 *   total rather than to the difference, the process started counting at zero (a transcript without a saved
 *   total, a /clear).
 * - 'none': no result line, or one without a total (a process that was killed, a startup error): no cost is
 *   known for the step, and the next step's difference is taken from the last total there was.
 */
export type CostBasis = 'first' | 'difference' | 'own-total' | 'none';

export interface StepCost {
  /** The step's own cost: see costBasis. The budget counts this. */
  costUsd: number;
  costBasis: CostBasis;
  /** total_cost_usd as the step's last result line had it (in a resumed session: every step so far). */
  reportedTotalUsd: number;
  /** The step's own per-model tokens and cost, taken from modelUsage the same way as costUsd; models with nothing in the step are left out. */
  usage: Record<string, ModelFigures> | null;
  /** The per-model costs of `usage`, added up. */
  usageCostUsd: number | null;
  /** What the process itself counted (Reported.sinceLastResultUsd): a second reading of the step's cost, not used for it. */
  sinceLastResultUsd: number | null;
  /** The input side of every message in THIS process's stream at list price: what the step paid to read and write context, without any output. */
  streamInputUsd: number;
  streamInputLeadUsd: number;
  streamInputWorkersUsd: number;
  /** Messages whose model has no price here (their tokens are not in the stream figures). */
  unpricedMessages: number;
}

function basisOf(now: Reported, before: Reported | null): CostBasis {
  if (!(now.totalUsd > 0)) return 'none';
  if (!before || !(before.totalUsd > 0)) return 'first';
  if (now.totalUsd < before.totalUsd) return 'own-total';
  const since = now.sinceLastResultUsd;
  if (since !== null && Math.abs(since - now.totalUsd) < Math.abs(since - (now.totalUsd - before.totalUsd))) return 'own-total';
  return 'difference';
}

/**
 * A step's cost. `now` is what the step's process reported, `before` what the last step with a total reported
 * (null for the first step). The caller keeps `now` as the next step's `before` unless the basis is 'none'.
 */
export function stepCost(lines: readonly StreamLine[], now: Reported, before: Reported | null = null): StepCost {
  let lead = 0, workers = 0, unpriced = 0;
  for (const m of messages(lines)) {
    const usd = costUsd(m.model.replace(/\[.*$/, ''), { ...m.usage, output_tokens: 0 });
    if (usd === null) { unpriced++; continue; }
    if (m.lead) lead += usd; else workers += usd;
  }
  const basis = basisOf(now, before);
  const base = basis === 'difference' ? before : null;
  let usage: Record<string, ModelFigures> | null = null;
  // a difference needs both sides: after a step whose per-model usage is not known, this step's cannot be told apart
  if (now.modelUsage && basis !== 'none' && (!base || base.modelUsage)) {
    usage = {};
    for (const [model, f] of Object.entries(now.modelUsage)) {
      const b = base?.modelUsage?.[model];
      const own = {} as ModelFigures;
      for (const k of TOKEN_KEYS) own[k] = f[k] - (b?.[k] ?? 0);
      own.costUsd = round6(f.costUsd - (b?.costUsd ?? 0));
      if (own.costUsd !== 0 || TOKEN_KEYS.some(k => own[k] !== 0)) usage[model] = own;
    }
  }
  return {
    costUsd: basis === 'none' ? 0 : round6(now.totalUsd - (base?.totalUsd ?? 0)), costBasis: basis, reportedTotalUsd: now.totalUsd,
    usage, usageCostUsd: usage ? round6(Object.values(usage).reduce((a, u) => a + u.costUsd, 0)) : null, sinceLastResultUsd: now.sinceLastResultUsd,
    streamInputUsd: round6(lead + workers), streamInputLeadUsd: round6(lead), streamInputWorkersUsd: round6(workers), unpricedMessages: unpriced,
  };
}

/**
 * The session's cost: its steps' own costs added up. With every step a 'difference' on the one before, that is
 * the last step's reported total ('running-total'); 'mixed' says a later step's total started again.
 */
export function sessionCost(steps: ReadonlyArray<Pick<StepCost, 'costUsd' | 'costBasis' | 'reportedTotalUsd' | 'usage' | 'sinceLastResultUsd'>>): {
  costUsd: number; costReading: 'running-total' | 'mixed'; lastReportedTotalUsd: number; sinceLastResultUsd: number | null; usage: Record<string, ModelFigures>;
} {
  const usage: Record<string, ModelFigures> = {};
  for (const s of steps) for (const [model, f] of Object.entries(s.usage ?? {})) {
    const sum = usage[model] ??= { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
    for (const k of TOKEN_KEYS) sum[k] += f[k];
    sum.costUsd = round6(sum.costUsd + f.costUsd);
  }
  return {
    costUsd: round6(steps.reduce((a, s) => a + s.costUsd, 0)),
    costReading: steps.some((s, i) => i > 0 && s.costBasis === 'own-total') ? 'mixed' : 'running-total',
    lastReportedTotalUsd: round6(steps.findLast(s => s.costBasis !== 'none')?.reportedTotalUsd ?? 0),
    sinceLastResultUsd: steps.every(s => s.sinceLastResultUsd !== null) && steps.length ? round6(steps.reduce((a, s) => a + s.sinceLastResultUsd!, 0)) : null,
    usage,
  };
}

/** Where a step's stream is kept under the output folder (`stepKey` is scenario|arrangement|rep|step). */
export function streamFileOf(out: string, stepKey: string): string {
  return path.join(out, 'streams', `${stepKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
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
