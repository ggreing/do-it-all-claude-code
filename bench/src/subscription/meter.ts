// Meter readings and how two of them compare. A reading is one `/usage` call; its rows are kept as received. Between
// two readings each meter row gives a delta, valid unless its window reset in between (resets_at moved, or the window
// ended), the row vanished, or the value went down. The rule for a meter that moved more than the block's own tokens
// explain needs several blocks, so it is applied when the report is built (report.ts).
import fs from 'node:fs';
import type { ExecResult } from '../util.ts';
import { redact } from '../secrets.ts';
import type { Arm } from './isolation.ts';
import { loadoutProblems } from './isolation.ts';
import { parseStream, tokenTotal, type MeterRow, type StreamSummary } from './stream.ts';

export interface Reading {
  id: string;
  at: string;
  purpose: string;
  arm: Arm;
  blockId: string | null;
  /** usage_report present and the run on the subscription login, with the arm's loadout. */
  ok: boolean;
  problems: string[];
  rows: MeterRow[];
  extraUsageEnabled: boolean | null;
  /** What the /usage call itself cost (expected 0: no model request). */
  costUsd: number;
  tokens: number;
  models: string[];
  version: string | null;
  apiKeySource: string | null;
  /** Claude Code's built-in plugins this reading saw (a baseline both arms share), and the plugin entries as sent. */
  builtinPlugins: string[];
  plugins: Array<Record<string, string | number | boolean | null>>;
  durationMs: number;
  exitCode: number | null;
  /** The report's text, only when there was no usage_report (redacted, shortened). */
  text?: string;
}

export function readingFrom(r: ExecResult, s: StreamSummary, o: { id: string; at: Date; purpose: string; arm: Arm; blockId: string | null; builtinBaseline?: string[] | null }): Reading {
  const problems = loadoutProblems(s.init, o.arm, { builtinBaseline: o.builtinBaseline ?? null });
  if (!s.usageReport) problems.unshift(s.usageText ? 'no usage_report on the /usage answer (this login or version does not attach it)' : `no /usage answer (exit ${r.code}${r.timedOut ? ', timed out' : ''})`);
  const models = Object.keys(s.result?.modelUsage ?? {});
  return {
    id: o.id, at: o.at.toISOString(), purpose: o.purpose, arm: o.arm, blockId: o.blockId,
    ok: problems.length === 0, problems, rows: s.usageReport?.rows ?? [], extraUsageEnabled: s.usageReport?.extraUsageEnabled ?? null,
    costUsd: s.result?.costUsd ?? 0, tokens: tokenTotal(s.result?.usage ?? null) || models.reduce((n, m) => n + tokenTotal(s.result!.modelUsage[m]), 0), models,
    version: s.init?.version ?? null, apiKeySource: s.init?.apiKeySource ?? null,
    builtinPlugins: s.init?.builtinPlugins ?? [], plugins: s.init?.pluginEntries ?? [], durationMs: r.ms, exitCode: r.code,
    ...(s.usageReport ? {} : { text: redact(String(s.usageText ?? r.stderr ?? '')).slice(0, 500) }),
  };
}

export const parseReading = (r: ExecResult, o: Parameters<typeof readingFrom>[2]): Reading => readingFrom(r, parseStream(r.stdout), o);

export interface MeterDelta { from: number | null; to: number | null; delta: number | null; valid: boolean; reason?: string }

const resetMs = (s: string | null): number | null => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

/** Each meter row's change from `a` to `b`, with whether it counts. */
export function meterDeltas(a: Reading, b: Reading, toleranceSeconds = 60): Record<string, MeterDelta> {
  const out: Record<string, MeterDelta> = {};
  const keys = new Set([...a.rows.map(r => r.key), ...b.rows.map(r => r.key)]);
  for (const key of keys) {
    const x = a.rows.find(r => r.key === key), y = b.rows.find(r => r.key === key);
    if (!y) { out[key] = { from: x?.percent ?? null, to: null, delta: null, valid: false, reason: 'the meter was not in the second reading' }; continue; }
    if (!x) { out[key] = { from: 0, to: y.percent, delta: y.percent, valid: true, reason: 'the meter appeared (counted from 0)' }; continue; }
    const ra = resetMs(x.resetsAt), rb = resetMs(y.resetsAt);
    const d = Math.round((y.percent - x.percent) * 1e6) / 1e6;
    if (ra !== null && rb === null) out[key] = { from: x.percent, to: y.percent, delta: d, valid: false, reason: 'the window ended between the readings' };
    else if (ra !== null && rb !== null && Math.abs(rb - ra) > toleranceSeconds * 1000) out[key] = { from: x.percent, to: y.percent, delta: d, valid: false, reason: 'the window reset between the readings' };
    else if (d < 0) out[key] = { from: x.percent, to: y.percent, delta: d, valid: false, reason: 'the meter went down without a reset' };
    else out[key] = { from: x.percent, to: y.percent, delta: d, valid: true };
  }
  return out;
}

/** Whether two readings show the same value on every meter (the pilot's check that reading does not move it). */
export function sameMeters(a: Reading, b: Reading): boolean {
  if (a.rows.length !== b.rows.length) return false;
  return a.rows.every(r => b.rows.some(s => s.key === r.key && s.percent === r.percent));
}

/** The lines of a .jsonl record file (none when it does not exist). */
export function readJsonl<T>(file: string): T[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : [];
}

/** The session row (kind "session"), the 5-hour window. */
export const sessionRow = (r: Reading): MeterRow | undefined => r.rows.find(x => x.kind === 'session');
