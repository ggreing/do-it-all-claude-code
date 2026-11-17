// The subscription measurement's plan: the pilot (one block of four mixed tasks, the direct arm, with a reading after
// each task), or the full run (single-level blocks, so results can be read per level; the two arms paired in one
// window with alternating order: direct, router, router, direct, ...). Also the estimate --dry-run prints.
import fs from 'node:fs';
import path from 'node:path';
import type { Level, RunConfig, Task } from '../types.ts';
import { BENCH, readJson } from '../util.ts';
import { loadTasks } from '../tasks.ts';
import { loadBudget, loadMatrix } from '../plan.ts';
import type { Arm } from './isolation.ts';

export interface SubConfig {
  pilotTasks: string[];
  lead: string;
  lagSeconds: number;
  lateSeconds: number;
  readGapSeconds: number;
  maxPercent: number;
  minPointsPerArm: number;
  resetToleranceSeconds: number;
  windowMarginFactor: number;
  outlierFactor: number;
  bootstrapResamples: number;
  priorSessionPointsPerTask: Record<Level, number>;
  priorMinutesPerTask: Record<Level, number>;
}
export const loadSubConfig = (): SubConfig => readJson<SubConfig>(path.join(BENCH, 'config', 'subscription.json'));

export interface PlannedBlock {
  id: string;
  kind: 'pilot' | 'block' | 'calibration';
  pair: number | null;
  /** 1 or 2 within its pair. */
  order: number;
  level: Level | 'mixed';
  arm: Arm;
  tasks: Task[];
}

export interface SubPlan { kind: 'pilot' | 'full'; lead: RunConfig; blocks: PlannedBlock[] }

export function leadConfig(id: string): RunConfig {
  const c = loadMatrix().configs.find(x => x.id === id);
  if (!c) throw new Error(`no config ${id} in bench/config/matrix.json`);
  return c;
}

export function pilotPlan(cfg: SubConfig, leadId = cfg.lead): SubPlan {
  const tasks = loadTasks({ ids: cfg.pilotTasks, sources: ['custom'] });
  if (tasks.length !== cfg.pilotTasks.length) throw new Error(`pilot tasks missing: ${cfg.pilotTasks.filter(id => !tasks.some(t => t.id === id)).join(', ')}`);
  return { kind: 'pilot', lead: leadConfig(leadId), blocks: [{ id: 'pilot', kind: 'pilot', pair: null, order: 1, level: 'mixed', arm: 'direct', tasks }] };
}

/**
 * Full run: for each pair index, each selected level gets a pair of blocks. The first arm alternates pair by pair
 * within each level (direct, router, router, direct, ...), and between levels, so no level always starts the same way.
 */
export function fullPlan(cfg: SubConfig, o: { levels?: string[]; tasks?: string[]; pairs: number; arms?: Arm[]; leadId?: string }): SubPlan {
  const tasks = loadTasks({ ...(o.levels ? { levels: o.levels } : {}), ...(o.tasks ? { ids: o.tasks } : {}), sources: ['custom'] });
  const byLevel = new Map<Level, Task[]>();
  for (const t of tasks) byLevel.set(t.level, [...(byLevel.get(t.level) ?? []), t]);
  const levels = [...byLevel.keys()].sort();
  const arms = o.arms ?? ['direct', 'router'];
  const blocks: PlannedBlock[] = [];
  for (let p = 1; p <= o.pairs; p++) {
    for (const [li, level] of levels.entries()) {
      const order = arms.length === 2 && (p - 1 + li) % 2 === 1 ? [...arms].reverse() : arms;
      order.forEach((arm, i) => blocks.push({ id: `${level}-p${p}-${arm}`, kind: 'block', pair: p, order: i + 1, level, arm, tasks: byLevel.get(level)! }));
    }
  }
  return { kind: 'full', lead: leadConfig(o.leadId ?? cfg.lead), blocks };
}

/**
 * The meter a measurement is planned and judged on: the 5-hour ("session") row when the account has one, else the
 * all-models weekly row, else the first row. An account may have no 5-hour row at all (Max 20x on 2.1.323 had only
 * weekly_all and a model-scoped weekly row).
 */
export function primaryMeter(keys: string[]): string | null {
  if (keys.includes('session')) return 'session';
  if (keys.includes('weekly_all')) return 'weekly_all';
  return keys[0] ?? null;
}

/**
 * How many tasks it takes to move a meter by `target` points, from a measured move of `delta` points over `tasks`
 * tasks on a meter that shows `decimals` decimals. Each reading is rounded to that resolution, so the true move lies
 * within one step either side; the range says what that leaves. A meter that did not move gives a lower bound only.
 */
export function tasksToMove(delta: number, tasks: number, target: number, decimals: number): { perTask: number | null; needed: number | null; low: number | null; high: number | null; text: string } {
  const step = 10 ** -decimals;
  if (tasks <= 0) return { perTask: null, needed: null, low: null, high: null, text: 'no tasks measured' };
  if (delta <= 0) {
    const low = Math.ceil((target * tasks) / step);
    return { perTask: null, needed: null, low, high: null, text: `it did not move over ${tasks} task(s): at least ${low} tasks to move it ${target} points` };
  }
  const needed = Math.ceil((target * tasks) / delta);
  const low = Math.ceil((target * tasks) / (delta + step));
  const high = delta - step > 0 ? Math.ceil((target * tasks) / (delta - step)) : null;
  return { perTask: delta / tasks, needed, low, high, text: `about ${needed} tasks to move it ${target} points (${low} to ${high ?? 'many more'} with its ${step}-point resolution)` };
}

export interface PilotMeasured {
  /** The meter the estimates are on, and its points per task by level (from the pilot's points per API-priced dollar). */
  meter: string;
  pointsPerTask: Partial<Record<Level, number>>;
  minutesPerTask: Partial<Record<Level, number>>;
  at: string;
}

/** The pilot's per-task points (on its primary meter) and minutes, when it has been run (they replace the priors). */
export function loadPilotMeasured(resultsDir: string): PilotMeasured | null {
  const p = path.join(resultsDir, 'pilot.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = readJson<{ at?: string; primaryMeter?: string; meters?: Record<string, { pointsPerTaskByLevel?: Partial<Record<Level, number>> }>; perTask?: Array<{ level: Level; minutes: number }> }>(p);
    if (!j.primaryMeter || !j.meters?.[j.primaryMeter]) return null;
    const out: PilotMeasured = { meter: j.primaryMeter, pointsPerTask: { ...(j.meters[j.primaryMeter]!.pointsPerTaskByLevel ?? {}) }, minutesPerTask: {}, at: j.at ?? '' };
    for (const t of j.perTask ?? []) if (typeof t.minutes === 'number') out.minutesPerTask[t.level] = t.minutes;
    return out;
  } catch { return null; }
}

/** The meters the last recorded reading showed (what the account has), or null before any reading. */
export function lastKnownMeters(resultsDir: string): { at: string; rows: Array<{ key: string; percent: number; resetsAt: string | null }> } | null {
  const f = path.join(resultsDir, 'readings.jsonl');
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).reverse();
  for (const l of lines) {
    try {
      const r = JSON.parse(l) as { at: string; rows: Array<{ key: string; percent: number; resetsAt: string | null }> };
      if (Array.isArray(r.rows) && r.rows.length) return { at: r.at, rows: r.rows.map(x => ({ key: x.key, percent: x.percent, resetsAt: x.resetsAt })) };
    } catch { /* skip */ }
  }
  return null;
}

export interface BlockEstimate { points: number; minutes: number; apiUsd: number; measured: boolean }

/**
 * A block's estimated points (on the pilot's primary meter once measured; before that, the 5-hour prior, which
 * overstates a weekly meter: conservative), minutes, and API-priced cost (the client-side estimate, from the API
 * bench's means).
 */
export function estimateBlock(b: PlannedBlock, cfg: SubConfig, lead: RunConfig, measured: PilotMeasured | null): BlockEstimate {
  const est = readJson<{ measured?: Record<string, Partial<Record<Level, number>>> }>(path.join(BENCH, 'config', 'estimates.json'));
  const caps = loadBudget().perRunCapUsd;
  let points = 0, minutes = 0, apiUsd = 0, all = true;
  for (const t of b.tasks) {
    const mp = measured?.pointsPerTask[t.level];
    if (mp === undefined) all = false;
    points += mp ?? cfg.priorSessionPointsPerTask[t.level];
    minutes += measured?.minutesPerTask[t.level] ?? cfg.priorMinutesPerTask[t.level];
    apiUsd += est.measured?.[lead.id]?.[t.level] ?? caps[t.level];
  }
  return { points, minutes, apiUsd, measured: !!measured && all };
}

/** Meter readings a block takes: before and after (the pilot: three to start, one after each task, one late). */
export const readingsFor = (b: PlannedBlock): number => (b.kind === 'pilot' ? 3 + b.tasks.length + 1 : 2);

export function formatPlan(plan: SubPlan, cfg: SubConfig, o: { measured: PilotMeasured | null; account: string; command: string; known?: ReturnType<typeof lastKnownMeters> }): string[] {
  const lines: string[] = [];
  const lead = plan.lead;
  let points = 0, minutes = 0, apiUsd = 0, reads = 0;
  const perArm: Record<string, { points: number; blocks: number }> = {};
  lines.push(plan.kind === 'pilot' ? 'Subscription pilot: DRY RUN (nothing runs; claude is not called)' : 'Subscription measurement: DRY RUN (nothing runs; claude is not called)');
  lines.push(`  account: ${o.account}   lead: ${lead.label} (${lead.model}, effort ${lead.effort})`);
  const knownKeys = o.known?.rows.map(r => r.key) ?? [];
  const meter = o.measured?.meter ?? primaryMeter(knownKeys) ?? 'session';
  const meterName = meter === 'session' ? 'the 5-hour (session) meter' : meter;
  if (o.known) {
    lines.push(`  meters at the last reading (${o.known.at}): ${o.known.rows.map(r => `${r.key} ${r.percent}%${r.resetsAt ? ` (resets ${r.resetsAt})` : ''}`).join(', ')}`);
    if (!knownKeys.includes('session')) lines.push(`  no 5-hour (session) row on this account: the estimates and the judgement are on ${meter}`);
  }
  for (const b of plan.blocks) {
    const e = estimateBlock(b, cfg, lead, o.measured);
    const waits = b.kind === 'pilot' ? (b.tasks.length * cfg.lagSeconds + cfg.lateSeconds + 2 * cfg.readGapSeconds) / 60 : cfg.lagSeconds / 60;
    points += e.points; minutes += e.minutes + waits; apiUsd += e.apiUsd; reads += readingsFor(b);
    const a = (perArm[b.arm] ??= { points: 0, blocks: 0 });
    a.points += e.points; a.blocks++;
    lines.push(`  ${b.id.padEnd(14)} ${b.arm.padEnd(6)} ${String(b.level).padEnd(5)} ${b.tasks.map(t => t.id).join(', ')}   ~${e.points.toFixed(1)} points, ~${Math.round(e.minutes + waits)} min${e.measured ? '' : ' (prior)'}`);
  }
  if (plan.kind === 'pilot') {
    lines.push('  checks: /usage under -p gives usage_report on this account (reading 1); reading it does not move the meter (readings 1-3, and their cost);');
    lines.push('          the status line does not run under -p (a recording status line is set; its file must stay empty)');
    lines.push(`  after each task: a ${cfg.lagSeconds} s wait, then a reading; ${cfg.lateSeconds} s after the last, a late reading (meter lag)`);
  } else {
    lines.push(`  blocks: ${plan.blocks.length} (${Object.entries(perArm).map(([arm, x]) => `${arm} ${x.blocks}, ~${x.points.toFixed(1)} points`).join('; ')}); the first arm alternates pair by pair`);
    lines.push('  each block: a reading, the tasks one after another (fresh sessions), a wait, a reading; a pair starts only with room for both blocks in the 5-hour window');
  }
  lines.push(`  meter readings: ${reads} (each a /usage call that Claude Code answers itself: no model request expected; the pilot checks it)`);
  lines.push(`  estimated limit spend: ~${points.toFixed(1)} points of ${meterName}${o.measured ? ' (per-task points measured by the pilot)' : ` (a conservative prior, the 5-hour meter's${meter === 'session' ? '' : ', so it overstates a weekly meter'}: the pilot measures it)`}`);
  const window = Math.max(1, cfg.maxPercent - 10);
  if (plan.kind === 'full' && meter === 'session') lines.push(`  windows: at least ${Math.ceil(points / window)} five-hour window(s) at up to ${window} points each (the run stops at ${cfg.maxPercent}% and resumes later)`);
  if (plan.kind === 'full' && meter !== 'session') {
    const now = o.known?.rows.find(r => r.key === meter)?.percent;
    lines.push(`  ${meter} has room for ~${now !== undefined ? Math.max(0, cfg.maxPercent - now) : '?'} points before the ${cfg.maxPercent}% guard${now !== undefined && cfg.maxPercent - now < points ? `: not enough for this plan in one week (it resumes after the weekly reset)` : ''}`);
  }
  if (!o.measured && meter === 'session') lines.push('  weekly meters: not estimated before the pilot (it reads how they move; an integer-percent meter needs many tasks to move measurably)');
  if (!o.measured && meter !== 'session') lines.push(`  (the real ${meter} cost is unknown until the pilot: it moves in whole points, and the pilot says how many tasks a measurable move takes)`);
  lines.push(`  wall time: ~${Math.round(minutes)} min   API-priced estimate (client-side, for comparison only): ~$${apiUsd.toFixed(2)}`);
  lines.push(`  guards: stops before a block when a meter would pass ${cfg.maxPercent}%, when the window has too little time left, when Claude Code's version changes,`);
  lines.push('          or when a run is not on the subscription login (apiKeySource must be "none"), and after a rate-limit warning');
  lines.push('  keep the account quiet for the whole run: no other use of this login (claude.ai, other Claude Code sessions, other devices)');
  lines.push(`  to run it: ${o.command}`);
  return lines;
}
