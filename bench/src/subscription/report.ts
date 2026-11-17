// The subscription report: meter points used per completed task, router ÷ direct, per meter and per level, with a
// bootstrap interval over the pairs (each pair is one block of each arm, same level, same 5-hour window). A block
// counts for a meter when its delta is valid (no reset in between, see meter.ts), the block was not discarded, and,
// for the 5-hour meter, it did not move more than the block's own tokens explain: its points per API-priced dollar
// above outlierFactor × the arm's median (with three or more blocks). Weekly meters move slowly, so they are compared
// as sums over each arm's blocks (the same ratio of sums) without the outlier rule.
import fs from 'node:fs';
import path from 'node:path';
import type { SubConfig } from './plan.ts';
import type { BlockRecord, SubRun } from './run.ts';
import { readJsonl } from './meter.ts';

export interface Counted { block: BlockRecord; delta: number }
export interface Excluded { block: BlockRecord; reason: string }

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/** The blocks that count for one meter, and the ones that do not (with why). */
export function countedBlocks(blocks: BlockRecord[], meter: string, cfg: Pick<SubConfig, 'outlierFactor'>): { counted: Counted[]; excluded: Excluded[] } {
  const counted: Counted[] = [], excluded: Excluded[] = [];
  for (const b of blocks.filter(x => x.kind === 'block')) {
    const m = b.meters[meter];
    if (b.discarded) excluded.push({ block: b, reason: b.discarded });
    else if (!m) continue;
    else if (!m.valid || m.delta === null) excluded.push({ block: b, reason: m.reason ?? 'not valid' });
    else if (m.delta > 0 && b.costUsd === 0) excluded.push({ block: b, reason: 'the meter moved but the block used no tokens of its own' });
    else counted.push({ block: b, delta: m.delta });
  }
  if (meter !== 'session') return { counted, excluded };
  // the 5-hour meter: a block that moved much more than its tokens explain (someone else used the account)
  const keep: Counted[] = [];
  for (const arm of ['direct', 'router']) {
    const mine = counted.filter(c => c.block.arm === arm);
    const ratios = mine.filter(c => c.block.costUsd > 0).map(c => c.delta / c.block.costUsd);
    const med = ratios.length >= 3 ? median(ratios) : 0;
    for (const c of mine) {
      if (med > 0 && c.block.costUsd > 0 && c.delta / c.block.costUsd > cfg.outlierFactor * med) excluded.push({ block: c.block, reason: `moved more than its tokens explain (${(c.delta / c.block.costUsd).toFixed(1)} points per API-priced dollar, the arm's median is ${med.toFixed(1)})` });
      else keep.push(c);
    }
  }
  return { counted: keep, excluded };
}

export interface Pair { pair: number; direct: Counted; router: Counted }

/** Pairs of one level where both blocks count for the meter. */
export function pairsFor(counted: Counted[], level: string): Pair[] {
  const out: Pair[] = [];
  const mine = counted.filter(c => c.block.level === level && c.block.pair !== null);
  for (const p of [...new Set(mine.map(c => c.block.pair!))].sort((a, b) => a - b)) {
    const direct = mine.find(c => c.block.pair === p && c.block.arm === 'direct');
    const router = mine.find(c => c.block.pair === p && c.block.arm === 'router');
    if (direct && router) out.push({ pair: p, direct, router });
  }
  return out;
}

/** Points per completed task in each arm, and router ÷ direct, over the given pairs (null when undefined). */
export function ratioOf(pairs: Pair[]): { direct: number | null; router: number | null; ratio: number | null } {
  const sum = (arm: 'direct' | 'router') => {
    const pts = pairs.reduce((a, p) => a + p[arm].delta, 0), done = pairs.reduce((a, p) => a + p[arm].block.completed, 0);
    return done > 0 ? pts / done : null;
  };
  const direct = sum('direct'), router = sum('router');
  return { direct, router, ratio: direct && router !== null && direct > 0 ? router / direct : null };
}

/** A seeded generator (mulberry32), so the interval is the same every time the report is built. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The 95% percentile bootstrap interval of the ratio, resampling pairs; null below three pairs. */
export function bootstrap(pairs: Pair[], resamples: number, seed = 168): { lo: number; hi: number } | null {
  if (pairs.length < 3) return null;
  const next = rng(seed);
  const xs: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample = pairs.map(() => pairs[Math.floor(next() * pairs.length)]!);
    const r = ratioOf(sample).ratio;
    if (r !== null && Number.isFinite(r)) xs.push(r);
  }
  if (xs.length < resamples / 2) return null;
  xs.sort((a, b) => a - b);
  return { lo: xs[Math.floor(xs.length * 0.025)]!, hi: xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.975))]! };
}

/** The note's stop rule: the interval clearly excludes 1, or lies within ±10% of it. */
export function decideLevel(blocks: BlockRecord[], level: string, meter: string, cfg: Pick<SubConfig, 'outlierFactor' | 'bootstrapResamples'>): { decided: boolean; text: string; pairs: number; ratio: number | null; interval: { lo: number; hi: number } | null } {
  const pairs = pairsFor(countedBlocks(blocks, meter, cfg).counted, level);
  const { ratio } = ratioOf(pairs);
  const interval = bootstrap(pairs, cfg.bootstrapResamples);
  if (!interval || ratio === null) return { decided: false, text: `${pairs.length} pair(s): not decided`, pairs: pairs.length, ratio, interval };
  const span = `ratio ${ratio.toFixed(2)} [${interval.lo.toFixed(2)}, ${interval.hi.toFixed(2)}]`;
  if (interval.hi < 1) return { decided: true, text: `${span}: the router uses less`, pairs: pairs.length, ratio, interval };
  if (interval.lo > 1) return { decided: true, text: `${span}: the router uses more`, pairs: pairs.length, ratio, interval };
  if (interval.lo >= 0.9 && interval.hi <= 1.1) return { decided: true, text: `${span}: no difference beyond ±10%`, pairs: pairs.length, ratio, interval };
  return { decided: false, text: `${span}: not decided yet`, pairs: pairs.length, ratio, interval };
}

const fmt = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function buildSubReport(resultsDir: string, cfg: SubConfig): string {
  const blocks = readJsonl<BlockRecord>(path.join(resultsDir, 'blocks.jsonl'));
  const runs = readJsonl<SubRun>(path.join(resultsDir, 'runs.jsonl'));
  const lines: string[] = ['# Subscription measurement report', ''];
  if (!blocks.length) return [...lines, 'No blocks recorded yet.'].join('\n');
  const full = blocks.filter(b => b.kind === 'block');
  lines.push(`Account: ${[...new Set(blocks.map(b => b.account))].join(', ')}. Lead: ${[...new Set(blocks.map(b => `${b.leadModel} (${b.leadEffort})`))].join(', ')}. Claude Code: ${[...new Set(blocks.map(b => b.version ?? '?'))].join(', ')}.`);
  lines.push(`Blocks: ${full.length} (${blocks.length - full.length} pilot), from ${blocks[0]!.startedAt.slice(0, 10)} to ${blocks[blocks.length - 1]!.startedAt.slice(0, 10)}.`, '');
  const pilotFile = path.join(resultsDir, 'pilot.json');
  if (fs.existsSync(pilotFile)) {
    const p = JSON.parse(fs.readFileSync(pilotFile, 'utf8')) as Record<string, any>;
    lines.push('## Pilot', '');
    lines.push(`- /usage under -p gives usage_report: ${p.usageReport?.ok ? 'yes' : 'no'} (${p.usageReport?.detail ?? ''})`);
    if (p.readingMovesMeter) lines.push(`- reading /usage leaves the meter as it was: ${p.readingMovesMeter.met ? 'yes' : 'no'} (same values: ${p.readingMovesMeter.sameValues}; no model request: ${p.readingMovesMeter.noModelRequest})`);
    if (p.statusLine) lines.push(`- the status line does not run under -p: ${p.statusLine.met ? 'yes' : 'no'} (${p.statusLine.detail})`);
    if (p.decimals !== undefined) lines.push(`- meter resolution: ${p.decimals} decimal(s)`);
    if (Array.isArray(p.perTask)) lines.push(`- 5-hour points per task: ${p.perTask.map((t: any) => `${t.taskId} ${t.sessionDelta ?? 'n/a'}${t.pass ? '' : ' (failed)'}`).join(', ')}`);
    if (p.lag) lines.push(`- lag: ${p.lag.moved ? `the meter moved within ${p.lag.lateSeconds} s after the last reading` : `no change within ${p.lag.lateSeconds} s`}`);
    if (p.stoppedAt) lines.push(`- stopped: ${p.stoppedAt}`);
    lines.push('');
  }
  if (full.length) {
    const meters = [...new Set(full.flatMap(b => Object.keys(b.meters)))].sort((a, b) => (a === 'session' ? -1 : b === 'session' ? 1 : a.localeCompare(b)));
    const levels = [...new Set(full.map(b => b.level))].sort();
    lines.push('## Meter points per completed task, router ÷ direct', '');
    lines.push('| level | meter | direct points/done | router points/done | router ÷ direct | 95% interval | pairs | reading |', '|---|---|---|---|---|---|---|---|');
    const excludedAll = new Map<string, string[]>();
    for (const meter of meters) {
      const { counted, excluded } = countedBlocks(blocks, meter, cfg);
      for (const e of excluded) excludedAll.set(e.block.blockId, [...(excludedAll.get(e.block.blockId) ?? []), `${meter}: ${e.reason}`]);
      for (const level of [...levels, 'all']) {
        const pairs = level === 'all' ? levels.flatMap(l => pairsFor(counted, l)) : pairsFor(counted, level);
        if (!pairs.length) continue;
        const r = ratioOf(pairs);
        const iv = bootstrap(pairs, cfg.bootstrapResamples);
        const v = level === 'all' ? null : decideLevel(blocks, level, meter, cfg);
        lines.push(`| ${level} | ${meter} | ${fmt(r.direct)} | ${fmt(r.router)} | ${fmt(r.ratio)} | ${iv ? `${fmt(iv.lo)} to ${fmt(iv.hi)}` : '(3+ pairs)'} | ${pairs.length} | ${v ? v.text.replace(/^ratio [^:]*: /, '') : 'mixed levels'} |`);
      }
    }
    lines.push('', 'Below 1 the router stretches the limit; above 1 it shortens it. Weekly rows move slowly: read them as sums over many blocks.', '');
    if (excludedAll.size) {
      lines.push('## Not counted', '');
      for (const [id, reasons] of excludedAll) lines.push(`- ${id}: ${[...new Set(reasons)].join('; ')}`);
      lines.push('');
    }
  }
  lines.push('## Per model (tokens from each run\'s result; the cost is Claude Code\'s client-side API-priced estimate, not what the plan charges)', '');
  lines.push('| arm | model | runs | input | output | cache read | cache write | estimate USD |', '|---|---|---|---|---|---|---|---|');
  const agg = new Map<string, { runs: number; i: number; o: number; cr: number; cw: number; usd: number }>();
  for (const r of runs) {
    for (const [model, u] of Object.entries(r.modelUsage ?? {})) {
      const k = `${r.arm}|${model}`;
      const a = agg.get(k) ?? { runs: 0, i: 0, o: 0, cr: 0, cw: 0, usd: 0 };
      a.runs++; a.i += num(u.inputTokens); a.o += num(u.outputTokens); a.cr += num(u.cacheReadInputTokens); a.cw += num(u.cacheCreationInputTokens); a.usd += num(u.costUSD);
      agg.set(k, a);
    }
  }
  for (const [k, a] of [...agg].sort()) { const [arm, model] = k.split('|'); lines.push(`| ${arm} | ${model} | ${a.runs} | ${a.i} | ${a.o} | ${a.cr} | ${a.cw} | ${a.usd.toFixed(3)} |`); }
  const samples = runs.reduce((n, r) => n + (r.statusLineSamples ?? 0), 0);
  lines.push('', `Status line cross-check: ${samples ? `${samples} status line run(s) recorded rate_limits (results statusline/)` : 'none (the status line does not run under -p)'}.`);
  lines.push('', 'Caveats: the meters are Anthropic\'s and can change; the task mix is this bench\'s; one account, one plan.');
  return lines.join('\n');
}

export function writeSubReport(resultsDir: string, cfg: SubConfig): string {
  const md = buildSubReport(resultsDir, cfg);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'report.md'), md + '\n');
  return md;
}
