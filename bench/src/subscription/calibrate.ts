// `sub --calibrate`: does the subscription's weekly meter follow API prices across models? Two single-model blocks
// on the custom bench tasks (by default Opus 5.5 high, then Haiku 5.5 high: the same effort, so a similar token mix),
// each run until the meter has moved about `targetPoints` (or a cap is reached), give points per API-priced dollar
// for each model. Their ratio says whether a cheaper model's dollars count the same on the meter (ratio ~1) or more.
// The meter shows whole points, so each block's move is known to ±1 point; the ranges carry that through.
//
// Guards: at most maxTotalPoints weekly points for the whole calibration; no block that would take weekly_all past
// the 80% guard, or that cannot end resetMarginMinutes before the weekly reset; the loadout and login checks of every
// run. A block runs tasks in turn through the 15 custom tasks (repeating them), `concurrency` at a time.
import fs from 'node:fs';
import path from 'node:path';
import type { Level, RunConfig, Task } from '../types.ts';
import { BENCH, readJson } from '../util.ts';
import { loadBudget } from '../plan.ts';
import { loadTasks } from '../tasks.ts';
import { redactDeep } from '../secrets.ts';
import { meterDeltas, readJsonl, type MeterDelta, type Reading } from './meter.ts';
import { lastKnownMeters, leadConfig, primaryMeter, type PlannedBlock, type SubConfig } from './plan.ts';
import { Session, runSpoils, type SubDeps, type SubOptions, type SubRun } from './run.ts';
import { decimalsOf } from './stream.ts';

export interface CalConfig {
  configs: string[];
  concurrency: Record<string, number>;
  targetPoints: number;
  maxTotalPoints: number;
  readEverySeconds: number;
  resetMarginMinutes: number;
  caps: Record<string, { usd: number; tasks: number; minutes: number }>;
  /** The claim under test: the router's API-priced cost per passed task is (1 - claim) of the lead alone's. */
  claim: number;
}
export const loadCalConfig = (): CalConfig => readJson<{ calibrate: CalConfig }>(path.join(BENCH, 'config', 'subscription.json')).calibrate;

export type Family = 'opus' | 'sonnet' | 'haiku' | 'other';
export const familyOf = (model: string): Family => (/opus/.test(model) ? 'opus' : /sonnet/.test(model) ? 'sonnet' : /haiku/.test(model) ? 'haiku' : 'other');

/** Every custom task, in id order: a block cycles through them. */
export const calibrationTasks = (): Task[] => loadTasks({ sources: ['custom'] });

interface TaskStat { usd: number; minutes: number; source: string }

/**
 * Mean API-priced dollars and minutes for one task of a level with a config: this measurement's own runs first (the
 * subscription runs: same isolation), then the API bench's local results, then estimates.json and the priors.
 */
export function taskStat(resultsDir: string, cfg: RunConfig, level: Level, sub: SubConfig): TaskStat {
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const fromFile = (file: string, match: (r: Record<string, unknown>) => boolean, source: string): TaskStat | null => {
    const rs = readJsonl<Record<string, unknown>>(file).filter(r => r.level === level && match(r) && typeof r.costUsd === 'number' && typeof r.durationMs === 'number');
    return rs.length ? { usd: mean(rs.map(r => r.costUsd as number)), minutes: mean(rs.map(r => (r.durationMs as number) / 60_000)), source } : null;
  };
  const own = fromFile(path.join(resultsDir, 'runs.jsonl'), r => r.model === cfg.model && r.effort === cfg.effort, 'this measurement\'s runs');
  if (own) return own;
  const api = fromFile(path.join(BENCH, 'results', 'runs.jsonl'), r => r.configId === cfg.id, 'the API bench\'s runs');
  if (api) return api;
  const est = readJson<{ measured?: Record<string, Partial<Record<Level, number>>> }>(path.join(BENCH, 'config', 'estimates.json'));
  return { usd: est.measured?.[cfg.id]?.[level] ?? loadBudget().perRunCapUsd[level], minutes: sub.priorMinutesPerTask[level], source: 'priors' };
}

/** The pilot's points per API-priced dollar on its primary meter, with the range ±1 resolution step leaves. */
export function pilotPointsPerDollar(resultsDir: string): { meter: string; points: number; usd: number; step: number; ppd: number; low: number; high: number } | null {
  const f = path.join(resultsDir, 'pilot.json');
  if (!fs.existsSync(f)) return null;
  try {
    const p = readJson<{ primaryMeter?: string; meters?: Record<string, { total: number | null; costUsd: number; decimals: number }> }>(f);
    const m = p.primaryMeter ? p.meters?.[p.primaryMeter] : undefined;
    if (!m || m.total === null || !(m.costUsd > 0)) return null;
    const step = 10 ** -m.decimals;
    return { meter: p.primaryMeter!, points: m.total, usd: m.costUsd, step, ppd: m.total / m.costUsd, low: Math.max(0, m.total - step) / m.costUsd, high: (m.total + step) / m.costUsd };
  } catch { return null; }
}

/** API price per output token of one model over another's (estimates.json): what "counted per token" would multiply by. */
export function priceRatio(a: string, b: string): number | null {
  const p = readJson<{ pricingPerMTok: Record<string, { output: number }> }>(path.join(BENCH, 'config', 'estimates.json')).pricingPerMTok;
  return p[a] && p[b] ? p[a]!.output / p[b]!.output : null;
}

export interface CalBlockPlan { config: RunConfig; concurrency: number; caps: { usd: number; tasks: number; minutes: number }; tasks: Task[]; meanUsd: number; meanMinutes: number; sources: string[] }

export function calibrationPlan(cal: CalConfig, sub: SubConfig, resultsDir: string): CalBlockPlan[] {
  const tasks = calibrationTasks();
  return cal.configs.map(id => {
    const config = leadConfig(id);
    const stats = tasks.map(t => taskStat(resultsDir, config, t.level, sub));
    return {
      config, concurrency: Math.max(1, cal.concurrency[id] ?? 1), caps: cal.caps[id] ?? { usd: 10, tasks: 100, minutes: 120 }, tasks,
      meanUsd: stats.reduce((a, s) => a + s.usd, 0) / stats.length, meanMinutes: stats.reduce((a, s) => a + s.minutes, 0) / stats.length,
      sources: [...new Set(stats.map(s => s.source))],
    };
  });
}

/** How a block would go at `ppd` points per dollar: tasks, dollars, minutes, points, and which limit ends it. */
export function blockOutlook(b: CalBlockPlan, ppd: number, target: number): { tasks: number; usd: number; minutes: number; points: number; endsAt: string } {
  const byTarget = ppd > 0 ? Math.ceil(target / (ppd * b.meanUsd)) : Infinity;
  const byUsd = Math.floor(b.caps.usd / b.meanUsd);
  const byTime = Math.floor((b.caps.minutes / b.meanMinutes) * b.concurrency);
  const tasks = Math.max(1, Math.min(byTarget, byUsd, byTime, b.caps.tasks));
  const endsAt = tasks === byTarget ? `the ${target}-point target` : tasks === b.caps.tasks ? `the ${b.caps.tasks}-task cap` : tasks === byUsd ? `the $${b.caps.usd} cap` : `the ${b.caps.minutes}-minute cap`;
  const usd = tasks * b.meanUsd;
  return { tasks, usd, minutes: (tasks * b.meanMinutes) / b.concurrency, points: usd * ppd, endsAt };
}

export function formatCalibrationPlan(cal: CalConfig, sub: SubConfig, resultsDir: string, o: { account: string; command: string }): string[] {
  const lines: string[] = ['Subscription calibration: DRY RUN (nothing runs; claude is not called)'];
  lines.push('  question: does the weekly meter follow API prices across models? Points per API-priced dollar, one block per model');
  const known = lastKnownMeters(resultsDir);
  const meter = primaryMeter(known?.rows.map(r => r.key) ?? []) ?? 'weekly_all';
  lines.push(`  account: ${o.account}${known ? `; meters at the last reading (${known.at}): ${known.rows.map(r => `${r.key} ${r.percent}%${r.resetsAt ? ` (resets ${r.resetsAt})` : ''}`).join(', ')}` : ''}`);
  const pilot = pilotPointsPerDollar(resultsDir);
  const ppd = pilot?.ppd ?? 0.5;
  lines.push(pilot
    ? `  from the pilot: ${pilot.meter} moved ${pilot.points} over $${pilot.usd.toFixed(2)} of ${cal.configs[0]} (${Math.max(0, pilot.points - pilot.step)} to ${pilot.points + pilot.step} with rounding): ~${pilot.ppd.toFixed(2)} points per API-priced dollar (${pilot.low.toFixed(2)} to ${pilot.high.toFixed(2)})`
    : '  no pilot yet: assuming 0.5 points per API-priced dollar for the estimates');
  const plan = calibrationPlan(cal, sub, resultsDir);
  let worstMinutes = 0, worstPoints = 0;
  plan.forEach((b, i) => {
    const family = familyOf(b.config.model);
    lines.push(`  block ${i + 1}  ${b.config.label}  concurrency ${b.concurrency}  ${b.tasks.length} custom tasks in turn ($${b.meanUsd.toFixed(4)}, ${b.meanMinutes.toFixed(1)} min each on average; from ${b.sources.join(', ')})`);
    lines.push(`           stops at ${cal.targetPoints} points on ${meter}, or at a cap: $${b.caps.usd} API-priced, ${b.caps.tasks} tasks, ${b.caps.minutes} min`);
    const scenarios: Array<[string, number]> = i === 0 || family === familyOf(plan[0]!.config.model)
      ? [[`at ${ppd.toFixed(2)} points/$`, ppd], ...(pilot && pilot.high !== pilot.ppd ? [[`at ${pilot.high.toFixed(2)} points/$ (the pilot's high side)`, pilot.high] as [string, number]] : []),
        ...(pilot ? [pilot.low > 0 ? [`at ${pilot.low.toFixed(2)} points/$ (the low side)`, pilot.low] as [string, number] : [`at ${(ppd / 2).toFixed(2)} points/$ (half: the pilot's low side is 0)`, ppd / 2] as [string, number]] : [])]
      : (() => {
        const k = priceRatio(plan[0]!.config.model, b.config.model);
        return [['if the meter follows API prices', ppd], ...(k ? [[`if it counted ${family} tokens like ${familyOf(plan[0]!.config.model)} tokens (${k.toFixed(0)}x per dollar)`, ppd * k] as [string, number]] : [])];
      })();
    for (const [label, x] of scenarios) {
      const s = blockOutlook(b, x, cal.targetPoints);
      lines.push(`           ${label}: ends at ${s.endsAt}: ~${s.tasks} tasks, ~$${s.usd.toFixed(2)}, ~${Math.round(s.minutes)} min, ~${s.points.toFixed(1)} points`);
    }
    const worst = scenarios.map(([, x]) => blockOutlook(b, x, cal.targetPoints));
    worstMinutes += Math.max(...worst.map(s => s.minutes));
    worstPoints += Math.min(cal.targetPoints + 1, Math.max(...worst.map(s => s.points)));
  });
  const reset = known?.rows.map(r => r.resetsAt).filter((x): x is string => !!x).sort()[0];
  lines.push(`  guards: at most ${cal.maxTotalPoints} weekly points in all (no new task once ${cal.maxTotalPoints - 1} are used, for the runs in flight); stops before ${meter} passes ${sub.maxPercent}%;`);
  lines.push(`          no block that cannot end ${cal.resetMarginMinutes} min before the weekly reset${reset ? ` (${reset})` : ''}; no task that could still run then; the loadout and login checks of every run`);
  lines.push(`  readings: before and after each block, and during a block after a task ends, at most once every ${cal.readEverySeconds} s (each free, as the pilot showed)`);
  lines.push(`  worst case: ~${Math.round(worstMinutes)} min, ~${worstPoints.toFixed(1)} weekly points (each block stops at its target)`);
  lines.push('  keep the account quiet for the whole run: no other use of this login (claude.ai, other Claude Code sessions, other devices)');
  lines.push(`  to run it: ${o.command}`);
  return lines;
}

// ------------------------------------------------------------------ running

export interface CalBlockRecord {
  blockId: string; config: string; model: string; effort: string; concurrency: number; account: string; version: string | null;
  startedAt: string; wallMs: number; before: string; after: string; runIds: string[]; tasks: number; completed: number; usd: number;
  /** API-priced dollars and tokens by model, from each run's modelUsage (a session can bill a helper model too). */
  perModel: Record<string, { runs: number; usd: number; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>;
  meters: Record<string, MeterDelta>;
  /** Each meter's resolution in this block (one step: the rounding a move carries). */
  steps: Record<string, number>;
  stopReason: string; discarded: string | null; builtinPlugins: string[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function runCalibration(d: SubDeps, o: SubOptions, cal: CalConfig): Promise<number> {
  const s = new Session(d, o);
  const file = path.join(o.resultsDir, 'calibration.jsonl');
  const done = readJsonl<CalBlockRecord>(file);
  d.out(`Subscription calibration: ${o.account}. Claude Code runs on this login; the harness never reads it.`);
  d.out('Keep the account quiet until this finishes: no other use of this login (claude.ai, other Claude Code sessions, other devices).');
  const version = await s.version();
  d.out(`  claude ${version ?? '(version unknown)'}`);
  const plan = calibrationPlan(cal, o.cfg, o.resultsDir);
  let used = done.reduce((a, r) => a + Math.max(0, r.meters[primaryMeter(Object.keys(r.meters)) ?? '']?.delta ?? 0), 0);
  let before: Reading | null = null;
  for (const b of plan) {
    const id = `cal-${b.config.id}`;
    if (done.some(r => r.blockId === id && !r.discarded)) { d.out(`skip ${id} (recorded)`); continue; }
    before ??= await s.read(`${id}-before`, 'direct', id);
    const meter = primaryMeter(before.rows.map(x => x.key));
    if (!meter) { d.out('STOP: the reading has no meters'); return 3; }
    // a block may start only with room for its target in the total, below the guard, and before the reset
    const est = blockOutlook(b, (pilotPointsPerDollar(o.resultsDir)?.ppd ?? 0.5), cal.targetPoints);
    const stop = !before.ok ? `the reading is not usable: ${before.problems.join('; ')}`
      : used + cal.targetPoints > cal.maxTotalPoints ? `${used} weekly points used so far: another ${cal.targetPoints} would pass the ${cal.maxTotalPoints}-point total`
      : s.guard(before, cal.targetPoints, Math.min(b.caps.minutes, est.minutes) + o.cfg.lagSeconds / 60 + cal.resetMarginMinutes / o.cfg.windowMarginFactor, version, meter);
    if (stop) { d.out(`STOP before ${id}: ${stop}`); return 3; }
    d.out(`${id}: ${b.config.label}, ${b.concurrency} at a time, until ${meter} moves ${cal.targetPoints} points or a cap ($${b.caps.usd}, ${b.caps.tasks} tasks, ${b.caps.minutes} min)`);
    const rec = await runBlock(s, d, o, cal, b, id, meter, before, used, version);
    used += Math.max(0, rec.meters[meter]?.delta ?? 0);
    fs.mkdirSync(o.resultsDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(redactDeep(rec)) + '\n');
    const m = rec.meters[meter];
    d.out(`  ${id}: ${rec.tasks} tasks (${rec.completed} passed), $${rec.usd.toFixed(3)} API-priced, ${meter} ${m?.from}→${m?.to}${m && !m.valid ? ` (not counted: ${m.reason})` : ''}; stopped: ${rec.stopReason}${rec.discarded ? `; DISCARDED: ${rec.discarded}` : ''}`);
    if (rec.discarded) return 3;
    before = null;                 // the next block starts from a fresh reading
  }
  d.out('');
  for (const l of calibrationSummary(readJsonl<CalBlockRecord>(file), cal)) d.out(l);
  d.out(`Recorded in ${o.resultsDir} (calibration.jsonl, readings.jsonl, runs.jsonl); the report: node bench/src/cli.ts sub-report`);
  return 0;
}

async function runBlock(s: Session, d: SubDeps, o: SubOptions, cal: CalConfig, b: CalBlockPlan, id: string, meter: string, before: Reading, usedBefore: number, version: string | null): Promise<CalBlockRecord> {
  const block: PlannedBlock = { id, kind: 'calibration', pair: null, order: 1, level: 'mixed', arm: 'direct', tasks: b.tasks };
  const startedAt = d.now();
  const resetAt = before.rows.map(r => (r.resetsAt ? Date.parse(r.resetsAt) : NaN)).filter(t => Number.isFinite(t) && t > startedAt.getTime()).sort((x, y) => x - y)[0];
  const longest = Math.max(...b.tasks.map(t => t.limits.timeoutSec)) * 1000;
  const deadline = resetAt !== undefined ? resetAt - cal.resetMarginMinutes * 60_000 - longest : Infinity;
  const runs: SubRun[] = [];
  let last = before, lastReadAt = d.now().getTime(), launched = 0, usd = 0;
  let stopReason: string | null = null, discarded: string | null = null;
  const moved = () => meterDeltas(before, last, o.cfg.resetToleranceSeconds)[meter];
  const shouldStop = (): boolean => {
    if (stopReason) return true;
    const m = moved();
    const now = d.now().getTime();
    const percent = last.rows.find(r => r.key === meter)?.percent ?? 0;
    if (m && !m.valid) stopReason = `the reading says: ${m.reason}`;
    else if (m && (m.delta ?? 0) >= cal.targetPoints) stopReason = `${meter} moved ${m.delta} points (the target is ${cal.targetPoints})`;
    else if (usedBefore + (m?.delta ?? 0) >= cal.maxTotalPoints - 1) stopReason = `the calibration has used ${usedBefore + (m?.delta ?? 0)} weekly points (no new task past ${cal.maxTotalPoints - 1} of ${cal.maxTotalPoints})`;
    else if (percent >= o.cfg.maxPercent - 1) stopReason = `${meter} is at ${percent}% (the guard is ${o.cfg.maxPercent}%)`;
    else if (usd >= b.caps.usd) stopReason = `the $${b.caps.usd} cap`;
    else if (launched >= b.caps.tasks) stopReason = `the ${b.caps.tasks}-task cap`;
    else if (now - startedAt.getTime() >= b.caps.minutes * 60_000) stopReason = `the ${b.caps.minutes}-minute cap`;
    else if (now >= deadline) stopReason = `the weekly reset is near (no task may still run ${cal.resetMarginMinutes} min before it)`;
    return stopReason !== null;
  };
  const free = Array.from({ length: b.concurrency }, (_, i) => i + 1);
  const inFlight = new Set<Promise<void>>();
  const launch = () => {
    const slot = free.shift()!;
    const task = b.tasks[launched % b.tasks.length]!;
    const n = ++launched;
    const p: Promise<void> = s.task(task, block, b.config, { slot, runId: `${id}__${String(n).padStart(4, '0')}__${task.id}` })
      .then(run => {
        runs.push(run);
        usd += run.costUsd;
        const spoil = runSpoils(run);
        if (spoil && !discarded) { discarded = spoil; stopReason = spoil; }
      })
      .catch((e: unknown) => { if (!stopReason) stopReason = `a run could not be completed: ${e instanceof Error ? e.message : String(e)}`; })
      .finally(() => { free.push(slot); inFlight.delete(p); });
    inFlight.add(p);
  };
  while (!shouldStop() || inFlight.size) {
    while (!shouldStop() && inFlight.size < b.concurrency) launch();
    if (!inFlight.size) break;
    await Promise.race(inFlight);
    if (!stopReason && d.now().getTime() - lastReadAt >= cal.readEverySeconds * 1000) {
      last = await s.read(`${id}-progress`, 'direct', id);
      lastReadAt = d.now().getTime();
      if (!last.ok && !stopReason) { discarded = `a reading during the block: ${last.problems.join('; ')}`; stopReason = discarded; }
    }
  }
  await d.sleep(o.cfg.lagSeconds * 1000);
  const after = await s.read(`${id}-after`, 'direct', id);
  if (!after.ok && !discarded) discarded = `the reading after the block: ${after.problems.join('; ')}`;
  const perModel: CalBlockRecord['perModel'] = {};
  for (const r of runs) for (const [model, u] of Object.entries(r.modelUsage)) {
    const m = (perModel[model] ??= { runs: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    m.runs++; m.usd += num(u.costUSD); m.inputTokens += num(u.inputTokens); m.outputTokens += num(u.outputTokens);
    m.cacheReadInputTokens += num(u.cacheReadInputTokens); m.cacheCreationInputTokens += num(u.cacheCreationInputTokens);
  }
  const meters = meterDeltas(before, after, o.cfg.resetToleranceSeconds);
  const steps = Object.fromEntries(Object.keys(meters).map(k => [k, 10 ** -decimalsOf(s.taken.flatMap(r => r.rows.filter(x => x.key === k).map(x => x.percent)))]));
  return {
    blockId: id, config: b.config.id, model: b.config.model, effort: b.config.effort, concurrency: b.concurrency, account: o.account, version,
    startedAt: startedAt.toISOString(), wallMs: d.now().getTime() - startedAt.getTime(), before: before.id, after: after.id, runIds: runs.map(r => r.runId),
    tasks: runs.length, completed: runs.filter(r => r.graded.pass).length, usd: Math.round(usd * 1e6) / 1e6, perModel, meters, steps,
    stopReason: stopReason ?? 'done', discarded, builtinPlugins: after.builtinPlugins,
  };
}

// ------------------------------------------------------------------ analysis

export interface PointsPerDollar { model: string; family: Family; points: number; step: number; usd: number; ppd: number; low: number; high: number }

/** A block's points per API-priced dollar on `meter`, with the range ±1 resolution step leaves; null when it does not count. */
export function blockPpd(r: CalBlockRecord, meter: string): PointsPerDollar | null {
  const m = r.meters[meter];
  if (r.discarded || !m?.valid || m.delta === null || !(r.usd > 0)) return null;
  const step = r.steps[meter] ?? 1;
  return { model: r.model, family: familyOf(r.model), points: m.delta, step, usd: r.usd, ppd: m.delta / r.usd, low: Math.max(0, m.delta - step) / r.usd, high: (m.delta + step) / r.usd };
}

export interface CalibrationResult {
  meter: string;
  blocks: PointsPerDollar[];
  /** Points per dollar of the second block's model over the first's, with the range from rounding. */
  ratio: { of: string; to: string; value: number | null; low: number; high: number } | null;
  /** With each block's dollars split by model (a helper model inside a session), the per-model rates solved jointly. */
  solved: { a: Family; b: Family; rateA: [number, number]; rateB: [number, number]; ratio: [number, number] } | null;
  implication: Array<{ share: number; atValue: number | null; low: number; high: number; breakEven: number }>;
}

const dollarsBy = (r: CalBlockRecord, f: Family) => Object.entries(r.perModel).filter(([m]) => familyOf(m) === f).reduce((a, [, u]) => a + u.usd, 0);

export function analyseCalibration(records: CalBlockRecord[], cal: Pick<CalConfig, 'claim'>): CalibrationResult | null {
  const usable = records.filter(r => !r.discarded);
  if (!usable.length) return null;
  const meter = primaryMeter(Object.keys(usable[0]!.meters)) ?? 'weekly_all';
  const blocks = usable.map(r => blockPpd(r, meter)).filter((x): x is PointsPerDollar => x !== null);
  const [x, y] = blocks;
  const ratio = x && y ? { of: y.family, to: x.family, value: x.ppd > 0 ? y.ppd / x.ppd : null, low: x.high > 0 ? y.low / x.high : 0, high: x.low > 0 ? y.high / x.low : Infinity } : null;
  // the joint solve: points = rateA * dollarsA + rateB * dollarsB in each block, at the corners of the ±step ranges
  let solved: CalibrationResult['solved'] = null;
  const [rx, ry] = usable;
  if (x && y && rx && ry && x.family !== y.family) {
    const a = x.family, bF = y.family;
    const ax = dollarsBy(rx, a), bx = dollarsBy(rx, bF), ay = dollarsBy(ry, a), by = dollarsBy(ry, bF);
    const det = ax * by - bx * ay;
    const mixed = bx > 0.01 * (ax + bx) || ay > 0.01 * (ay + by);
    if (mixed && Math.abs(det) > 1e-12) {
      const rates: Array<[number, number]> = [];
      for (const px of [Math.max(0, x.points - x.step), x.points + x.step]) for (const py of [Math.max(0, y.points - y.step), y.points + y.step]) {
        rates.push([(px * by - bx * py) / det, (ax * py - px * ay) / det]);
      }
      const ra = rates.map(r => r[0]), rb = rates.map(r => r[1]);
      const ratios = rates.filter(r => r[0] > 0).map(r => r[1] / r[0]);
      solved = { a, b: bF, rateA: [Math.min(...ra), Math.max(...ra)], rateB: [Math.min(...rb), Math.max(...rb)], ratio: ratios.length ? [Math.min(...ratios), Math.max(...ratios)] : [0, Infinity] };
    }
  }
  // the claim: the router's API-priced cost per passed task is (1 - claim) of direct's. If a share f of the router's
  // dollars goes to the cheaper model, whose dollars count r times an Opus dollar on the meter, its meter cost is
  // (1 - claim) * (1 - f + f r) of direct's; the saving is gone when r reaches 1 + (1 / (1 - claim) - 1) / f
  const implication = ratio ? [0.25, 0.5, 0.75].map(f => {
    const at = (r: number) => (1 - cal.claim) * (1 - f + f * r);
    return { share: f, atValue: ratio.value !== null ? at(ratio.value) : null, low: at(ratio.low), high: Number.isFinite(ratio.high) ? at(ratio.high) : Infinity, breakEven: 1 + (1 / (1 - cal.claim) - 1) / f };
  }) : [];
  return { meter, blocks, ratio, solved, implication };
}

const f2 = (v: number | null) => (v === null ? 'n/a' : Number.isFinite(v) ? v.toFixed(2) : 'unbounded');

export function calibrationSummary(records: CalBlockRecord[], cal: CalConfig): string[] {
  const a = analyseCalibration(records, cal);
  if (!a) return ['Calibration: no usable block yet.'];
  const lines = a.blocks.map(b => `${b.model}: ${b.points} points over $${b.usd.toFixed(2)} API-priced: ${b.ppd.toFixed(2)} points per dollar (${b.low.toFixed(2)} to ${f2(b.high)} with ±${b.step} rounding)`);
  if (a.ratio) lines.push(`${a.ratio.of} ÷ ${a.ratio.to}, points per API-priced dollar: ${f2(a.ratio.value)} (${f2(a.ratio.low)} to ${f2(a.ratio.high)}). About 1: the meter follows API prices; well above 1: ${a.ratio.of} counts for more than its price.`);
  if (a.solved) lines.push(`With each block's dollars split by model: ${a.solved.a} ${f2(a.solved.rateA[0])} to ${f2(a.solved.rateA[1])}, ${a.solved.b} ${f2(a.solved.rateB[0])} to ${f2(a.solved.rateB[1])} points per dollar; ratio ${f2(a.solved.ratio[0])} to ${f2(a.solved.ratio[1])}.`);
  for (const i of a.implication) lines.push(`If ${Math.round(i.share * 100)}% of the router's dollars go to ${a.ratio!.of}: its weekly-meter cost per passed task is ${f2(i.atValue)} of direct's (${f2(i.low)} to ${f2(i.high)}); the −${Math.round(cal.claim * 100)}% is gone at a ratio of ${i.breakEven.toFixed(2)}.`);
  return lines;
}

/** The report section (sub-report). */
export function calibrationReport(resultsDir: string, cal: CalConfig): string[] {
  const records = readJsonl<CalBlockRecord>(path.join(resultsDir, 'calibration.jsonl'));
  if (!records.length) return [];
  const lines = ['## Calibration: does the weekly meter follow API prices across models?', ''];
  const scoped = [...new Set(records.flatMap(r => Object.keys(r.meters)))].filter(k => k !== 'weekly_all' && k !== 'session');
  lines.push(`| block | model | tasks (passed) | at a time | API-priced $ | weekly_all | ${scoped.join(' | ')}${scoped.length ? ' | ' : ''}stopped because |`);
  lines.push(`|---|---|---|---|---|---|${scoped.map(() => '---|').join('')}---|`);
  for (const r of records) {
    const m = (k: string) => { const x = r.meters[k]; return x ? `${x.from}→${x.to}${x.valid ? '' : ' (not counted)'}` : '—'; };
    lines.push(`| ${r.blockId} | ${r.model} | ${r.tasks} (${r.completed}) | ${r.concurrency} | ${r.usd.toFixed(3)} | ${m('weekly_all')} | ${scoped.map(m).join(' | ')}${scoped.length ? ' | ' : ''}${r.discarded ? `discarded: ${r.discarded}` : r.stopReason} |`);
  }
  lines.push('', ...calibrationSummary(records, cal).map(l => `- ${l}`), '');
  lines.push('Dollars and tokens by model in each block (a session may bill a helper model besides its own):', '');
  lines.push('| block | model | runs | API-priced $ | input | output | cache read | cache write |', '|---|---|---|---|---|---|---|---|');
  for (const r of records) for (const [model, u] of Object.entries(r.perModel)) lines.push(`| ${r.blockId} | ${model} | ${u.runs} | ${u.usd.toFixed(3)} | ${u.inputTokens} | ${u.outputTokens} | ${u.cacheReadInputTokens} | ${u.cacheCreationInputTokens} |`);
  lines.push('', 'Sonnet is not calibrated here. The meter moves in whole points, so each block\'s move carries ±1 point; the ranges above include it.', '');
  return lines;
}
