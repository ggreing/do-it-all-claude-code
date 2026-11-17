// Runs the subscription measurement: the pilot, or the full run's paired blocks. Every effect (starting claude,
// waiting, the clock, preparing and grading a workspace) comes in through SubDeps, so the tests drive it with a fake
// claude. Records go to <resultsDir>: readings.jsonl, runs.jsonl, blocks.jsonl, pilot.json and the status line
// probe's files. A stopped run resumes: recorded blocks are skipped.
import fs from 'node:fs';
import path from 'node:path';
import type { GradeResult, Level, RunConfig, Task } from '../types.ts';
import type { ExecResult } from '../util.ts';
import { loadBudget } from '../plan.ts';
import { redact, redactDeep } from '../secrets.ts';
import { loadoutProblems, meterArgs, subscriptionEnv, taskArgs, workspaceRoot, type Arm } from './isolation.ts';
import { meterDeltas, parseReading, readJsonl, sameMeters, sessionRow, type MeterDelta, type Reading } from './meter.ts';
import { estimateBlock, fullPlan, loadPilotMeasured, pilotPlan, primaryMeter, tasksToMove, type PlannedBlock, type SubConfig, type SubPlan } from './plan.ts';
import { decideLevel } from './report.ts';
import { decimalsOf, parseStream, type RateLimitEvent } from './stream.ts';

export interface SubDeps {
  exec(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; input?: string; timeoutSec?: number }): Promise<ExecResult>;
  /** The claude command: "claude", or a test's fake (BENCH_CLAUDE_BIN). */
  claude: { cmd: string; prefix: string[] };
  sleep(ms: number): Promise<void>;
  now(): Date;
  prepare(task: Task, root: string): Promise<{ repo: string }>;
  grade(task: Task, repo: string): Promise<GradeResult>;
  /** The agent's changes, kept for a re-grade (best effort). */
  patch(repo: string): Promise<string>;
  /** Whether the router daemon answers its health route. */
  daemonHealthy(port: number): Promise<boolean>;
  out(line: string): void;
  env: NodeJS.ProcessEnv;
}

export interface SubOptions {
  resultsDir: string;
  account: string;
  cfg: SubConfig;
  leadId?: string;
  settingSources: string;
  /** Router arm: the effective plugin folder and the daemon's port; notes on non-default router settings. */
  router?: { pluginDir?: string; daemonPort?: number; notes: string[] };
  stopEarly: boolean;
}

export interface SubRun {
  runId: string; blockId: string; taskId: string; level: Level; arm: Arm; model: string; effort: string;
  startedAt: string; durationMs: number; exitCode: number | null; timedOut: boolean;
  costUsd: number; numTurns: number | null; isError: boolean; subtype: string | null;
  usage: Record<string, unknown> | null; modelUsage: Record<string, Record<string, unknown>>;
  loadoutProblems: string[]; builtinPlugins: string[]; rateLimitEvents: RateLimitEvent[]; statusLineSamples: number;
  version: string | null; graded: GradeResult; note?: string;
}

export interface BlockRecord {
  blockId: string; kind: 'pilot' | 'block' | 'calibration'; pair: number | null; order: number; level: string; arm: Arm;
  account: string; lead: string; leadModel: string; leadEffort: string; version: string | null;
  startedAt: string; wallMs: number; before: string; after: string; runIds: string[];
  tasks: number; completed: number; costUsd: number; meters: Record<string, MeterDelta>;
  /** Why the whole block does not count (a run off the login, a rate-limit event, ...); null when it counts. */
  discarded: string | null; notes: string[];
}

const appendJsonl = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(redactDeep(v)) + '\n'); };

export class Session {
  readonly files: { readings: string; runs: string; blocks: string; pilot: string; probe: string };
  #seq = 0;
  /** The readings this run took, in order. */
  readonly taken: Reading[] = [];
  /** Claude Code's built-in plugins as the first reading saw them: every later reading and run must show the same. */
  builtinBaseline: string[] | null = null;
  readonly d: SubDeps;
  readonly o: SubOptions;
  constructor(d: SubDeps, o: SubOptions) {
    this.d = d;
    this.o = o;
    const r = o.resultsDir;
    this.files = { readings: path.join(r, 'readings.jsonl'), runs: path.join(r, 'runs.jsonl'), blocks: path.join(r, 'blocks.jsonl'), pilot: path.join(r, 'pilot.json'), probe: path.join(r, 'statusline') };
    fs.mkdirSync(workspaceRoot(r), { recursive: true });
    fs.mkdirSync(this.files.probe, { recursive: true });
  }
  #id(prefix: string): string { return `${prefix}-${this.d.now().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${++this.#seq}`; }
  #arm(arm: Arm, probeOut: string) { return { arm, pluginDir: this.o.router?.pluginDir, settingSources: this.o.settingSources, probeOut }; }

  async version(): Promise<string | null> {
    const r = await this.d.exec(this.d.claude.cmd, [...this.d.claude.prefix, '--version'], { cwd: workspaceRoot(this.o.resultsDir), env: subscriptionEnv('direct', this.d.env), timeoutSec: 30 });
    return r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  }

  async read(purpose: string, arm: Arm, blockId: string | null): Promise<Reading> {
    const id = this.#id('read');
    const at = this.d.now();
    const r = await this.d.exec(this.d.claude.cmd, [...this.d.claude.prefix, ...meterArgs(this.#arm(arm, path.join(this.files.probe, `${id}.jsonl`)))], {
      cwd: workspaceRoot(this.o.resultsDir), env: subscriptionEnv(arm, this.d.env), timeoutSec: 120,
    });
    const reading = parseReading(r, { id, at, purpose, arm, blockId, builtinBaseline: this.builtinBaseline });
    appendJsonl(this.files.readings, reading);
    this.taken.push(reading);
    if (this.builtinBaseline === null && reading.version !== null) {
      this.builtinBaseline = reading.builtinPlugins;
      this.d.out(`  Claude Code's built-in plugins (a baseline, the same in both arms): ${reading.builtinPlugins.join(', ') || 'none'}`);
    }
    const s = sessionRow(reading);
    this.d.out(`  reading ${purpose.padEnd(16)} ${reading.ok ? reading.rows.map(x => `${x.key} ${x.percent}%`).join(', ') : `NOT USABLE: ${reading.problems.join('; ')}`}${s?.resetsAt ? `  (5-hour window resets ${s.resetsAt})` : ''}`);
    return reading;
  }

  /** One task in a fresh session. `slot` gives runs in parallel their own workspace; `runId` names a repeated task's run. */
  async task(task: Task, block: PlannedBlock, lead: RunConfig, opts: { slot?: number; runId?: string } = {}): Promise<SubRun> {
    const runId = opts.runId ?? `${block.id}__${task.id}`;
    const root = opts.slot === undefined ? workspaceRoot(this.o.resultsDir) : path.join(workspaceRoot(this.o.resultsDir), `slot-${opts.slot}`);
    const ws = await this.d.prepare(task, root);
    const probeOut = path.join(this.files.probe, `${runId}.jsonl`);
    const cap = loadBudget().perRunCapUsd[task.level];
    const startedAt = this.d.now();
    const r = await this.d.exec(this.d.claude.cmd, [...this.d.claude.prefix, ...taskArgs(this.#arm(block.arm, probeOut), lead, cap)], {
      cwd: ws.repo, env: subscriptionEnv(block.arm, this.d.env), input: task.prompt!, timeoutSec: task.limits.timeoutSec,
    });
    const s = parseStream(r.stdout);
    let patch = '';
    try { patch = await this.d.patch(ws.repo); } catch { /* kept best effort */ }
    if (patch) { fs.mkdirSync(path.join(this.o.resultsDir, 'patches'), { recursive: true }); fs.writeFileSync(path.join(this.o.resultsDir, 'patches', `${runId}.diff`), redact(patch)); }
    const graded = await this.d.grade(task, ws.repo);
    const samples = fs.existsSync(probeOut) ? fs.readFileSync(probeOut, 'utf8').split('\n').filter(Boolean).length : 0;
    const run: SubRun = {
      runId, blockId: block.id, taskId: task.id, level: task.level, arm: block.arm, model: lead.model, effort: lead.effort,
      startedAt: startedAt.toISOString(), durationMs: r.ms, exitCode: r.code, timedOut: r.timedOut,
      costUsd: s.result?.costUsd ?? 0, numTurns: s.result?.numTurns ?? null, isError: (s.result?.isError ?? true) || r.code !== 0, subtype: s.result?.subtype ?? null,
      usage: s.result?.usage ?? null, modelUsage: s.result?.modelUsage ?? {}, loadoutProblems: loadoutProblems(s.init, block.arm, { lead, builtinBaseline: this.builtinBaseline }),
      builtinPlugins: s.init?.builtinPlugins ?? [], rateLimitEvents: s.rateLimitEvents, statusLineSamples: samples, version: s.init?.version ?? null, graded,
      ...(s.result?.isError || r.code !== 0 ? { note: redact(r.stderr.slice(0, 300)) } : {}),
    };
    appendJsonl(this.files.runs, run);
    this.d.out(`    ${graded.pass ? 'PASS' : 'FAIL'} ${task.id.padEnd(8)} ${(r.ms / 1000).toFixed(0)}s  ~$${run.costUsd.toFixed(3)} (API-priced estimate)  ${graded.detail}${run.loadoutProblems.length ? `  LOADOUT: ${run.loadoutProblems.join('; ')}` : ''}`);
    return run;
  }

  /**
   * Why the next work may not start now (null when it may): headroom on every meter (the estimate counts on `meter`,
   * the primary one), time left before any window resets, the version.
   */
  guard(r: Reading, points: number, minutes: number, version: string | null, meter: string | null = primaryMeter(r.rows.map(x => x.key))): string | null {
    const cfg = this.o.cfg;
    if (!r.ok) return `the reading is not usable: ${r.problems.join('; ')}`;
    if (version && r.version && r.version !== version) return `Claude Code changed from ${version} to ${r.version}: the readings would not compare`;
    for (const row of r.rows) {
      const need = row.key === meter ? points : 0;
      if (row.percent + need > cfg.maxPercent) return `${row.key} is at ${row.percent}%${need ? ` and the next work needs about ${points.toFixed(1)} points` : ''}: the run stays below ${cfg.maxPercent}%. Run it again after the window resets${row.resetsAt ? ` (${row.resetsAt})` : ''}`;
    }
    const now = this.d.now().getTime();
    for (const row of r.rows) {
      const reset = row.resetsAt ? Date.parse(row.resetsAt) : NaN;
      if (Number.isFinite(reset) && reset > now && reset - now < minutes * cfg.windowMarginFactor * 60_000) {
        return `the ${row.kind === 'session' ? '5-hour' : row.key} window resets at ${row.resetsAt}, too soon for about ${Math.round(minutes)} min of work in one window: run it again after the reset`;
      }
    }
    return null;
  }

  block(b: PlannedBlock, lead: RunConfig, version: string | null, startedAt: Date, before: Reading, after: Reading, runs: SubRun[], discarded: string | null, notes: string[]): BlockRecord {
    const rec: BlockRecord = {
      blockId: b.id, kind: b.kind, pair: b.pair, order: b.order, level: String(b.level), arm: b.arm, account: this.o.account,
      lead: lead.id, leadModel: lead.model, leadEffort: lead.effort, version, startedAt: startedAt.toISOString(), wallMs: this.d.now().getTime() - startedAt.getTime(),
      before: before.id, after: after.id, runIds: runs.map(r => r.runId), tasks: runs.length, completed: runs.filter(r => r.graded.pass).length,
      costUsd: Math.round(runs.reduce((a, r) => a + r.costUsd, 0) * 1e6) / 1e6, meters: meterDeltas(before, after, this.o.cfg.resetToleranceSeconds),
      discarded, notes,
    };
    appendJsonl(this.files.blocks, rec);
    return rec;
  }
}

/** Why a finished run makes its block not count; null when it is fine. */
export function runSpoils(r: SubRun): string | null {
  if (r.loadoutProblems.length) return `${r.taskId}: ${r.loadoutProblems.join('; ')}`;
  const limited = r.rateLimitEvents.find(e => e.status !== 'allowed');
  if (limited) return `${r.taskId}: a rate-limit event (${limited.status})`;
  return null;
}

export function header(d: SubDeps, plan: SubPlan, o: SubOptions): void {
  d.out(`Subscription ${plan.kind === 'pilot' ? 'pilot' : 'measurement'}: ${o.account}, lead ${plan.lead.label}. Claude Code runs on this login; the harness never reads it.`);
  d.out('Keep the account quiet until this finishes: no other use of this login (claude.ai, other Claude Code sessions, other devices).');
}

export async function runPilot(d: SubDeps, o: SubOptions): Promise<number> {
  const plan = pilotPlan(o.cfg, o.leadId);
  const b = plan.blocks[0]!;
  const s = new Session(d, o);
  header(d, plan, o);
  const version = await s.version();
  d.out(`  claude ${version ?? '(version unknown)'}`);
  const findings: Record<string, unknown> = { at: d.now().toISOString(), account: o.account, lead: plan.lead.id, version };
  const writePilot = () => fs.writeFileSync(s.files.pilot, JSON.stringify(redactDeep(findings), null, 2) + '\n');
  const gap = o.cfg.readGapSeconds * 1000;
  const r1 = await s.read('pilot-1', 'direct', b.id);
  findings.usageReport = { ok: r1.ok, detail: r1.ok ? `${r1.rows.length} meter rows: ${r1.rows.map(x => x.key).join(', ')}` : r1.problems.join('; '), ...(r1.text ? { text: r1.text } : {}) };
  if (!r1.ok) {
    findings.stoppedAt = 'check 2 (usage_report under -p)';
    writePilot();
    d.out(`Check: /usage under -p gives usage_report: NOT MET (${r1.problems.join('; ')}). Nothing else was run.`);
    return 3;
  }
  await d.sleep(gap);
  const r2 = await s.read('pilot-2', 'direct', b.id);
  await d.sleep(gap);
  const r3 = await s.read('pilot-3', 'direct', b.id);
  const reads = [r1, r2, r3];
  const still = sameMeters(r1, r2) && sameMeters(r2, r3);
  const free = reads.every(r => r.costUsd === 0 && r.tokens === 0 && r.models.length === 0);
  findings.readingMovesMeter = { met: still && free, sameValues: still, noModelRequest: free, costs: reads.map(r => r.costUsd), tokens: reads.map(r => r.tokens) };
  if (r1.extraUsageEnabled) d.out('  note: usage credits are on for this account: past a limit, use would be charged. The run stops before any meter passes the guard.');
  // the meters this account has: the pilot runs on whichever exist and judges on the primary one
  const keys = r1.rows.map(x => x.key);
  const primary = primaryMeter(keys)!;
  findings.meterKeys = keys;
  findings.primaryMeter = primary;
  findings.noSessionRow = !keys.includes('session');
  d.out(`  meters on this account: ${keys.join(', ')}${keys.includes('session') ? '' : `; no 5-hour (session) row, so the pilot judges on ${primary}`}`);
  const est = estimateBlock(b, o.cfg, plan.lead, null);
  const stop = s.guard(r3, est.points, est.minutes + (b.tasks.length * o.cfg.lagSeconds + o.cfg.lateSeconds) / 60, version, primary);
  if (stop) { findings.stoppedAt = `before the tasks: ${stop}`; writePilot(); d.out(`STOP: ${stop}`); return 3; }
  const startedAt = d.now();
  const runs: SubRun[] = [];
  const perTask: Array<{ taskId: string; level: Level; pass: boolean; minutes: number; costUsd: number; delta: number | null; deltas: Record<string, MeterDelta> }> = [];
  let prev = r3;
  let spoiled: string | null = null;
  for (const t of b.tasks) {
    const run = await s.task(t, b, plan.lead);
    runs.push(run);
    await d.sleep(o.cfg.lagSeconds * 1000);
    const after = await s.read(`after-${t.id}`, 'direct', b.id);
    const deltas = meterDeltas(prev, after, o.cfg.resetToleranceSeconds);
    const p = deltas[primary];
    perTask.push({ taskId: t.id, level: t.level, pass: run.graded.pass, minutes: Math.round(run.durationMs / 600) / 100, costUsd: run.costUsd, delta: p?.valid ? p.delta : null, deltas });
    prev = after;
    spoiled = runSpoils(run) ?? (after.ok ? null : `reading after ${t.id}: ${after.problems.join('; ')}`);
    if (spoiled) break;
  }
  const lastAfter = prev;
  let late: Reading = lastAfter;
  if (!spoiled) {
    await d.sleep(o.cfg.lateSeconds * 1000);
    late = await s.read('late', 'direct', b.id);
  }
  const lag = meterDeltas(lastAfter, late, o.cfg.resetToleranceSeconds);
  const samples = runs.reduce((n, r) => n + r.statusLineSamples, 0);
  findings.statusLine = { met: samples === 0, samples, detail: samples === 0 ? 'the status line did not run under -p (its file stayed empty)' : `the status line ran under -p ${samples} time(s): its rate_limits are kept in statusline/ as a cross-check` };
  findings.decimals = decimalsOf(s.taken.flatMap(r => r.rows.map(x => x.percent)));
  findings.perTask = perTask;
  findings.lag = { lateSeconds: o.cfg.lateSeconds, deltas: lag, moved: Object.values(lag).some(x => (x.delta ?? 0) !== 0) };
  // per meter: what the tasks moved it by (before the late reading), its resolution, and how many tasks a measurable move takes
  const moved = meterDeltas(r3, lastAfter, o.cfg.resetToleranceSeconds);
  const cost = runs.reduce((a, r) => a + r.costUsd, 0);
  const meters: Record<string, unknown> = {};
  for (const key of keys) {
    const m = moved[key];
    const decimals = decimalsOf(s.taken.flatMap(r => r.rows.filter(x => x.key === key).map(x => x.percent)));
    const step = 10 ** -decimals;
    const total = m?.valid ? m.delta ?? 0 : null;
    const toMove = total === null ? null : tasksToMove(total, runs.length, o.cfg.minPointsPerArm, decimals);
    // points per API-priced dollar, on the high side (a meter that did not move may still have moved up to one step):
    // the per-level estimate the plan and its guards use, so they overstate rather than understate the spend
    const perDollarHigh = total !== null && cost > 0 ? (total + (total === 0 ? step : 0)) / cost : null;
    const pointsPerTaskByLevel: Partial<Record<Level, number>> = {};
    if (perDollarHigh !== null) for (const p of perTask) pointsPerTaskByLevel[p.level] = Math.round(perDollarHigh * p.costUsd * 1000) / 1000;
    const tasksByLevel: Partial<Record<Level, number | null>> = {};
    if (total && cost > 0) for (const p of perTask) tasksByLevel[p.level] = p.costUsd > 0 ? Math.ceil(o.cfg.minPointsPerArm / ((total / cost) * p.costUsd)) : null;
    meters[key] = { total, valid: m?.valid ?? false, reason: m?.reason, decimals, tasks: runs.length, costUsd: Math.round(cost * 1e6) / 1e6, perDollarHigh, pointsPerTaskByLevel, toMove, tasksForTargetByLevel: tasksByLevel };
  }
  findings.meters = meters;
  const prim = meters[primary] as { toMove: ReturnType<typeof tasksToMove> | null } | undefined;
  findings.recommendedTasksPerBlock = prim?.toMove?.needed ?? prim?.toMove?.low ?? null;
  const rec = s.block(b, plan.lead, version, startedAt, r3, late, runs, spoiled, []);
  findings.block = { completed: rec.completed, tasks: rec.tasks, costUsd: rec.costUsd, meters: rec.meters, discarded: rec.discarded };
  if (spoiled) findings.stoppedAt = spoiled;
  writePilot();
  d.out('');
  d.out(`Check: /usage under -p gives usage_report: met (${keys.join(', ')})`);
  d.out(`Check: reading /usage does not move the meter: ${still && free ? 'met' : 'NOT MET'} (same values: ${still}; cost ${reads.map(r => `$${r.costUsd}`).join(', ')}, tokens ${reads.map(r => r.tokens).join(', ')})`);
  d.out(`Check: the status line does not run under -p: ${samples === 0 ? 'met' : `NOT MET (${samples} status line runs recorded)`}`);
  if (findings.noSessionRow) d.out(`No 5-hour (session) row on this account: the results are on ${keys.join(', ')}, judged on ${primary}.`);
  d.out(`Per task on ${primary}: ${perTask.map(p => `${p.taskId} ${p.delta ?? 'n/a'}`).join(', ')} (API-priced ${perTask.map(p => `$${p.costUsd.toFixed(2)}`).join(', ')}).`);
  for (const key of keys) {
    const m = meters[key] as { total: number | null; decimals: number; reason?: string; toMove: ReturnType<typeof tasksToMove> | null; tasksForTargetByLevel: Partial<Record<Level, number | null>> };
    if (m.total === null) { d.out(`${key}: not usable (${m.reason ?? 'no valid delta'})`); continue; }
    const byLevel = Object.entries(m.tasksForTargetByLevel).map(([l, n]) => `${l} ${n ?? '?'}`).join(', ');
    d.out(`${key} (${m.decimals} decimal${m.decimals === 1 ? '' : 's'}): moved ${m.total} over ${runs.length} tasks ($${cost.toFixed(2)} API-priced); ${m.toMove!.text}${byLevel ? `; by level, tasks to move it ${o.cfg.minPointsPerArm}: ${byLevel}` : ''}.`);
  }
  d.out(`Lag: ${(findings.lag as { moved: boolean }).moved ? `the meter moved in the ${o.cfg.lateSeconds} s after the last reading (${Object.entries(lag).map(([k, v]) => `${k} ${v.delta}`).join(', ')})` : 'no change in the late reading'}.`);
  if (spoiled) d.out(`STOPPED: ${spoiled}`);
  d.out(`Recorded in ${o.resultsDir} (pilot.json, readings.jsonl, runs.jsonl, blocks.jsonl).`);
  return spoiled ? 3 : 0;
}

export async function runFull(d: SubDeps, o: SubOptions, plan: SubPlan): Promise<number> {
  const s = new Session(d, o);
  header(d, plan, o);
  if (plan.blocks.some(b => b.arm === 'router')) {
    const r = o.router;
    const problem = !r?.pluginDir ? 'the router arm needs the effective plugin folder: pass --plugin-dir, or run do-it-all-claude-code init first'
      : !fs.existsSync(path.join(r.pluginDir, '.claude-plugin', 'plugin.json')) ? `not a plugin folder: ${r.pluginDir}`
      : !r.daemonPort ? 'the router daemon\'s port is unknown (no router config.json)'
      : !(await d.daemonHealthy(r.daemonPort)) ? `the router daemon does not answer on 127.0.0.1:${r.daemonPort}: start it (do-it-all-claude-code start)` : null;
    if (problem) { d.out(`STOP: ${problem}`); return 2; }
    for (const n of r!.notes) d.out(`  note: ${n}`);
  }
  const version = await s.version();
  d.out(`  claude ${version ?? '(version unknown)'}`);
  const done = new Set(readJsonl<BlockRecord>(s.files.blocks).map(b => b.blockId));
  const measured = loadPilotMeasured(o.resultsDir);
  const pairs = new Map<string, PlannedBlock[]>();
  for (const b of plan.blocks) { const k = `${b.level}-p${b.pair}`; pairs.set(k, [...(pairs.get(k) ?? []), b]); }
  const decided = new Set<string>();
  let primary: string | null = null;
  for (const [key, blocks] of pairs) {
    const level = String(blocks[0]!.level);
    if (decided.has(level)) { d.out(`skip ${key}: the ${level} result is already decided (stop rule)`); continue; }
    const todo = blocks.filter(b => !done.has(b.id));
    if (!todo.length) { d.out(`skip ${key} (recorded)`); continue; }
    for (const [i, b] of todo.entries()) {
      d.out(`${b.id}: ${b.arm}, ${b.tasks.map(t => t.id).join(', ')}`);
      const startedAt = d.now();
      const before = await s.read('before', b.arm, b.id);
      primary ??= measured?.meter ?? primaryMeter(before.rows.map(x => x.key));
      const need = (i === 0 ? todo : [b]).map(x => estimateBlock(x, o.cfg, plan.lead, measured));
      const stop = s.guard(before, need.reduce((a, e) => a + e.points, 0), need.reduce((a, e) => a + e.minutes, 0) + need.length * o.cfg.lagSeconds / 60, version, primary);
      if (stop) { d.out(`STOP: ${stop}`); return 3; }
      const runs: SubRun[] = [];
      let spoiled: string | null = null;
      for (const t of b.tasks) {
        const run = await s.task(t, b, plan.lead);
        runs.push(run);
        spoiled = runSpoils(run);
        if (spoiled) break;
      }
      await d.sleep(o.cfg.lagSeconds * 1000);
      const after = await s.read('after', b.arm, b.id);
      if (!spoiled && !after.ok) spoiled = `the reading after the block: ${after.problems.join('; ')}`;
      const rec = s.block(b, plan.lead, version, startedAt, before, after, runs, spoiled, b.arm === 'router' ? o.router?.notes ?? [] : []);
      const sm = primary ? rec.meters[primary] : undefined;
      d.out(`  ${rec.blockId}: ${rec.completed}/${rec.tasks} done, ${primary ?? 'meter'} ${sm?.delta ?? 'n/a'} points${sm && !sm.valid ? ` (not counted: ${sm.reason})` : ''}${rec.discarded ? `; DISCARDED: ${rec.discarded}` : ''}`);
      if (spoiled) { d.out(`STOP: ${spoiled}`); return 3; }
    }
    if (o.stopEarly) {
      const v = decideLevel(readJsonl<BlockRecord>(s.files.blocks), level, primary ?? 'session', o.cfg);
      if (v.decided) { decided.add(level); d.out(`  ${level}: ${v.text} (stop rule: remaining ${level} pairs are skipped)`); }
    }
  }
  d.out(`Done. Recorded in ${o.resultsDir}; the report: node bench/src/cli.ts sub-report`);
  return 0;
}

export { fullPlan, pilotPlan };
