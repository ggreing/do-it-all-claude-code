// The team office's Work, Savings and Team tabs (decisions 193, 194; docs/design/team-office.md section 8): pure
// reads over the ledger, served by the sealed metrics routes. No writes, no HTTP, no prompt text.
//
// Savings keeps two kinds of numbers apart. Measured: what the requests cost (counted by the API-mode proxy, or
// tokens from transcripts at list prices) and the status line's limits. Estimated: the workers' tokens at the lead
// model's list price (a counterfactual, with its assumptions as text), and the holdout comparison (real requests
// the lead handled alone against the teams, with how many there are and how many are needed).
import type { SQLInputValue } from 'node:sqlite';
import {
  CACHE_MULTIPLIER, DEFAULT_DELEGATE_FROM, DEFAULT_PRESETS, DIFFICULTIES, PRICING_PER_MTOK, PROFILE_LAYERS, ladderStep, leadModelClass, loadPresets, memberStartCell, profileDelegateFrom, profileOf,
  profilePresets, type Checkability, type Difficulty, type DifficultySource, type LadderId, type LeadModelClass, type Level, type Profile, type Role, type TeamPreset, type TriageResult,
} from '@do-it-all-claude-code/core';
import fs from 'node:fs';
import path from 'node:path';
import { checksByKind } from './checks.ts';
import type { ConfigFile } from './config.ts';
import type { Ledger, RequestRow, StepChangeRow, SubtaskFile, SubtaskRow } from './ledger.ts';
import { latestLimits, type SessionLimits } from './limits.ts';
import { metricsTriageReport, type TriageReport } from './metrics.ts';
import { PROJECT_TEAMS_FILE, TEAMS_FILE, workTreeRoot } from './presets.ts';
import { recordVerifyOk, routingHoldoutRate, routingMode, routingView, type RoutingView } from './routing.ts';

type Row = Record<string, SQLInputValue>;
const s = (v: unknown): string => String(v ?? '');
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const ms = (a: string | null | undefined, b: string | null | undefined): number | null => {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) ? Math.max(0, d) : null;
};
function parse<T>(v: unknown, fallback: T): T {
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

export type Period = '24h' | '7d' | '30d';
export const PERIODS: readonly Period[] = ['24h', '7d', '30d'];
const PERIOD_MS: Record<Period, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
export const isPeriod = (v: unknown): v is Period => (PERIODS as readonly unknown[]).includes(v);

export interface TabsContext {
  ledger: Ledger;
  /** The configuration the router runs on (the profile's values included). */
  config: ConfigFile;
  /** The router home, for the user's teams.yaml. */
  homeRoot?: string;
  /** config.json, for what the user set there (the source of a value). */
  configFile?: string;
  /** The folder a session works in, when the daemon has seen it. */
  sessionCwd?: (sessionId: string) => string | undefined;
  now?: () => Date;
}
const nowOf = (c: TabsContext): Date => (c.now ? c.now() : new Date());

interface RecordBlob {
  triage?: { kind?: string | null; level?: Level; confidence?: number; source?: string; rule?: string | null; taskType?: string };
  plan?: {
    level?: Level; preset?: string; leadDirect?: boolean; budgetUsd?: number; manualLevel?: Level | null; replannedFrom?: Level | null; forcedFrom?: Level | null;
    leadModel?: string | null; leadClass?: string | null; holdout?: string | null;
  };
  outcome?: string;
  changes?: { changedFiles: number; linesAdded: number; linesRemoved: number; newFiles: number; deletedFiles: number; approximate: boolean } | null;
  /** The changed files with the most changed lines (records written since schema v18). */
  files?: SubtaskFile[];
  time?: { durationMs?: number; activeMs?: number; awaitingMs?: number };
  subtasks?: Array<{ id: string; role: string; slot: number; step: string; upCount: number; status: string; verdict: string | null; attempts: number; costUsd: number; difficulty?: Difficulty; difficultySource?: DifficultySource }>;
  slots?: Array<{ role: string; slot: number; step: string; ups: number; downs: number }>;
  verifyFailures?: number;
  costs?: { subtaskUsd?: number; leadUsd?: number | null; totalUsd?: number; estimated?: boolean; unknown?: boolean; budgetExceeded?: boolean; source?: string };
}

// ------------------------------------------------------------------ Work: the list

export interface WorkRow {
  requestId: string;
  state: 'open' | 'awaiting_user' | 'closed';
  mine: boolean;
  createdAt: string; closedAt: string | null;
  kind: string | null;
  level: Level; finalLevel: Level;
  /** Decision 230: the request's difficulty and its source ('router' = the rule floor raised it), when set. */
  difficulty?: Difficulty; difficultySource?: DifficultySource;
  outcome: string | null;
  passed: boolean | null;
  acceptance: string | null;
  subtasks: number; verifyFailures: number; stepUps: number;
  changedFiles: number | null; linesAdded: number | null; linesRemoved: number | null;
  files: Array<{ path: string; added: number; removed: number }>;
  durationMs: number | null; activeMs: number | null;
  totalUsd: number; estimated: boolean; unknown: boolean; budgetExceeded: boolean;
}
export interface WorkList {
  open: WorkRow[];
  rows: WorkRow[];
  nextCursor: string | null;
  today: { done: number; failed: number; usd: number };
}

const MAX_OPEN = 10;
/** An open request older than this is a session that ended without closing it: not shown as running. */
const OPEN_MAX_AGE_MS = 24 * 3_600_000;

const cursorOf = (closedAt: string, requestId: string): string => Buffer.from(JSON.stringify([closedAt, requestId])).toString('base64url');
export function parseCursor(v: string | null | undefined): { closedAt: string; requestId: string } | null | undefined {
  if (!v) return null;
  try {
    const a = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(a) && typeof a[0] === 'string' && typeof a[1] === 'string') return { closedAt: a[0], requestId: a[1] };
  } catch { /* below */ }
  return undefined;   // not a cursor this code gave
}

/** The rules' own judgement of a request: not a manual level, not the re-plan (as its record keeps it). */
function judged(r: RequestRow): TriageResult & { kind?: string; rule?: string } {
  type J = TriageResult & { kind?: string; rule?: string };
  const all = [r.overriddenTriage, r.replannedFrom, r.triage].filter((x): x is TriageResult => !!x) as J[];
  return all.find(t => t.source !== 'manual' && !/^re-planned at L[23]/.test(t.rationale)) ?? (r.triage as J);
}

const topFiles = (files: ReadonlyArray<{ path: string; added: number; removed: number }>, n: number) =>
  [...files].sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path)).slice(0, n).map(f => ({ path: f.path, added: f.added, removed: f.removed }));

/** The files of a request's subtasks, one entry per path (a file two subtasks changed counts its larger numbers). */
function mergedFiles(subs: readonly SubtaskRow[]): SubtaskFile[] {
  const by = new Map<string, SubtaskFile>();
  for (const x of subs) {
    for (const f of x.changes?.files ?? []) {
      const had = by.get(f.path);
      if (!had || f.added + f.removed > had.added + had.removed) by.set(f.path, f);
    }
  }
  return [...by.values()].sort((a, b) => (b.added + b.removed) - (a.added + a.removed) || a.path.localeCompare(b.path));
}

const upsOf = (changes: readonly StepChangeRow[]): number => changes.filter(c => c.reason !== 'easy').length;

function openRow(ledger: Ledger, r: RequestRow, sessionId: string, now: Date): WorkRow {
  const subs = ledger.listSubtasks(r.id);
  const files = mergedFiles(subs);
  const flags = ledger.costFlags(r.id);
  const j = judged(r);
  return {
    requestId: r.id, state: r.status === 'awaiting_user' ? 'awaiting_user' : 'open', mine: r.sessionId === sessionId,
    createdAt: r.createdAt, closedAt: null, kind: j.kind ?? null, level: r.forcedFrom ?? j.level, finalLevel: r.level,
    ...(r.triage.difficulty ? { difficulty: r.triage.difficulty, difficultySource: r.triage.difficultySource ?? 'default' } : {}),
    outcome: r.outcome, passed: null, acceptance: null,
    subtasks: subs.length, verifyFailures: ledger.listAgents(r.id).reduce((a, x) => a + x.failCount, 0), stepUps: upsOf(ledger.listStepChanges({ requestId: r.id })),
    changedFiles: files.length ? files.length : null,
    linesAdded: files.length ? files.reduce((a, f) => a + f.added, 0) : null, linesRemoved: files.length ? files.reduce((a, f) => a + f.removed, 0) : null,
    files: topFiles(files, 3),
    durationMs: ms(r.createdAt, now.toISOString()), activeMs: null,
    totalUsd: round6(r.usedUsd + r.leadCostUsd), estimated: flags.estimated, unknown: flags.unknown, budgetExceeded: r.usedUsd > r.budgetUsd,
  };
}

export function workList(c: TabsContext, q: { sessionId?: string; limit?: number; before?: { closedAt: string; requestId: string } | null } = {}): WorkList {
  const { ledger } = c;
  const now = nowOf(c);
  const sessionId = q.sessionId ?? '';
  const limit = Math.min(50, Math.max(1, Math.floor(q.limit ?? 12)));
  const openIds = ledger.db.prepare(`SELECT id FROM requests WHERE status != 'closed' AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(new Date(now.getTime() - OPEN_MAX_AGE_MS).toISOString(), MAX_OPEN) as Row[];
  const open = openIds.map(x => ledger.getRequest(s(x.id))).filter((r): r is RequestRow => !!r).map(r => openRow(ledger, r, sessionId, now));

  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.before) { where.push('(closed_at < ? OR (closed_at = ? AND request_id < ?))'); params.push(q.before.closedAt, q.before.closedAt, q.before.requestId); }
  const page = ledger.db.prepare(`SELECT request_id, session_id, created_at, closed_at, kind, level, final_level, outcome, changed_files, lines_added, lines_removed,
      duration_ms, active_ms, total_usd, record, acceptance FROM request_records${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY closed_at DESC, request_id DESC LIMIT ?`).all(...params, limit + 1) as Row[];
  const shown = page.slice(0, limit);
  const rows = shown.map((r): WorkRow => {
    const rec = parse<RecordBlob>(r.record, {});
    const id = s(r.request_id);
    const f = rec.costs ?? {};
    const subs = ledger.listSubtasks(id);
    const files = mergedFiles(subs);
    const changes = ledger.listStepChanges({ requestId: id });
    return {
      requestId: id, state: 'closed', mine: s(r.session_id) === sessionId, createdAt: s(r.created_at), closedAt: s(r.closed_at),
      kind: sn(r.kind), level: s(r.level) as Level, finalLevel: s(r.final_level) as Level, outcome: sn(r.outcome),
      passed: recordVerifyOk(rec) && r.acceptance !== 'not_accepted', acceptance: sn(r.acceptance),
      subtasks: (rec.subtasks ?? []).length, verifyFailures: rec.verifyFailures ?? 0,
      stepUps: changes.length ? upsOf(changes) : (rec.slots ?? []).reduce((a, x) => a + (x.ups ?? 0), 0),
      changedFiles: nn(r.changed_files), linesAdded: nn(r.lines_added), linesRemoved: nn(r.lines_removed),
      files: topFiles(rec.files?.length ? rec.files : files, 3),
      durationMs: nn(r.duration_ms), activeMs: nn(r.active_ms),
      totalUsd: num(r.total_usd), estimated: !!f.estimated, unknown: !!f.unknown, budgetExceeded: !!f.budgetExceeded,
    };
  });
  const last = shown[shown.length - 1];
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const today = { done: 0, failed: 0, usd: 0 };
  for (const r of ledger.db.prepare('SELECT total_usd, record, acceptance FROM request_records WHERE closed_at >= ?').all(midnight) as Row[]) {
    if (recordVerifyOk(parse<RecordBlob>(r.record, {})) && r.acceptance !== 'not_accepted') today.done++; else today.failed++;
    today.usd += num(r.total_usd);
  }
  today.usd = round6(today.usd);
  return { open, rows, nextCursor: page.length > limit && last ? cursorOf(s(last.closed_at), s(last.request_id)) : null, today };
}

// ------------------------------------------------------------------ Work: one request

export interface StepChange {
  at: string; requestId: string; subtaskId: string | null; role: Role; slot: number; from: LadderId; to: LadderId;
  direction: 'up' | 'down'; reason: StepChangeRow['reason']; detail: string | null;
}
const stepChange = (x: StepChangeRow): StepChange => ({
  at: x.at, requestId: x.requestId, subtaskId: x.subtaskId, role: x.role, slot: x.slot, from: x.from, to: x.to,
  direction: x.reason === 'easy' ? 'down' : 'up', reason: x.reason, detail: x.detail,
});

export interface WorkSubtask {
  id: string; role: Role; slot: number; attempts: number;
  step: LadderId; model: string; effort: string; estimated: boolean;
  /** Decision 230: the subtask's own difficulty and where it came from (tag/request/floor). */
  difficulty?: Difficulty; difficultySource?: DifficultySource;
  ranModel: string | null;
  status: string; verdict: string | null;
  stepChanges: StepChange[];
  scope: string[]; unscoped: boolean;
  files: { list: SubtaskFile[]; total: number; truncated: boolean; approximate: boolean } | null;
  checks: Array<{ kind: string; attempt: number; result: 'ok' | 'failed' | 'skipped'; testsPassed?: number; testsFailed?: number; durationMs?: number }>;
  repro: { required: boolean; state: string; reason?: string; files?: string[] } | null;
  review: { verdict: 'accept' | 'reject'; by: 'lead' | 'reviewer' | 'tester'; bySubtaskId?: string; margin?: 'easy' | 'normal' } | null;
  time: { startedAt: string | null; stoppedAt: string | null; runMs: number | null; verifyMs: number | null };
  cost: { usd: number | null; state: 'actual' | 'estimate' | 'unknown' | 'none'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
export interface WorkDetail {
  requestId: string; state: WorkRow['state']; createdAt: string; closedAt: string | null;
  kind: string | null; taskType: string | null;
  level: { judged: Level; source: string; rule: string | null; confidence: number | null; final: Level; changes: Array<{ from: Level; to: Level; why: 'manual' | 'forced' | 'replanned' }> };
  /** Decision 230: the request's difficulty, its source ('router' = the rule floor raised it), and whether the lead reported one. */
  difficulty: { value: Difficulty; source: DifficultySource; reported: boolean } | null;
  /** Decision 231: whether the router can check this request's result here (probing | checkable | unchecked | no-tests); null until stamped. */
  checkability: Checkability | null;
  plan: { preset: string; leadDirect: boolean; leadModel: string | null; leadClass: string | null; budgetUsd: number; holdout: string | null };
  outcome: string | null; passed: boolean | null; acceptance: string | null;
  subtasks: WorkSubtask[];
  changes: { changedFiles: number; linesAdded: number; linesRemoved: number; newFiles: number; deletedFiles: number; approximate: boolean } | null;
  files: SubtaskFile[];
  tests: { passed: number; failed: number } | null;
  stepChanges: StepChange[];
  time: { durationMs: number | null; activeMs: number | null; awaitingMs: number; phases: Array<{ phase: 'lead' | 'workers' | 'verify' | 'awaiting_user'; ms: number }> };
  timeline: Array<{ kind: 'plan' | 'worker' | 'verify' | 'awaiting_user'; role: Role | null; subtaskId: string | null; startedAt: string; endedAt: string | null; ok: boolean | null }>;
  cost: { totalUsd: number; leadUsd: number | null; workerUsd: number; budgetUsd: number; estimated: boolean; unknown: boolean; budgetExceeded: boolean; basis: 'proxy' | 'transcript' };
  /** Whether a prompt is kept for the request (recordPrompts). Its text is never in a panel answer; `data export` has it. */
  hasPrompt: boolean;
}

/** Signals that are not a verify check of the subtask's work. */
const NOT_A_CHECK = new Set(['review', 'error_repeat', 'max_turns', 'tool_error', 'repro']);

/** The length of the union of time spans, in milliseconds. */
function unionMs(spans: Array<[number, number]>): number {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a).sort((x, y) => x[0] - y[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of sorted) {
    if (a > end) { total += b - a; end = b; }
    else if (b > end) { total += b - end; end = b; }
  }
  return total;
}

export function workDetail(c: TabsContext, requestId: string): WorkDetail | null {
  const { ledger } = c;
  const r = ledger.getRequest(requestId);
  const recRow = ledger.db.prepare('SELECT record, acceptance, prompt, closed_at FROM request_records WHERE request_id = ?').get(requestId) as Row | undefined;
  if (!r) return null;   // a record whose request rows were purged has nothing more than the list shows
  const rec = recRow ? parse<RecordBlob>(recRow.record, {}) : undefined;
  const now = nowOf(c).toISOString();
  const closed = r.status === 'closed';
  const end = r.closedAt ?? now;
  const subs = ledger.listSubtasks(requestId);
  const agents = ledger.listAgents(requestId);
  const signals = ledger.listSignals(requestId);
  const costs = ledger.listCosts(requestId);
  const proxy = ledger.hasProxyCosts(requestId);
  const counts = (src: unknown) => (proxy ? src === 'proxy' : src === 'transcript' || src === 'estimate');
  const steps = ledger.listStepChanges({ requestId }).map(stepChange);
  const extras = ledger.requestExtras(requestId);
  const j = judged(r);

  const subtasks = subs.map((x): WorkSubtask => {
    const mine = agents.filter(a => a.subtaskId === x.id).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const sig = signals.filter(g => g.subtaskId === x.id);
    const cost = costs.filter(k => k.subtask_id === x.id && counts(k.source));
    const planned = ladderStep(x.step);
    const first = mine[0], last = mine[mine.length - 1];
    const runs = mine.map(a => ms(a.startedAt, a.stoppedAt ?? (closed ? null : now))).filter((v): v is number => v !== null);
    const priced = cost.filter(k => k.usd !== null && k.usd !== undefined);
    const state: WorkSubtask['cost']['state'] = !cost.length ? 'none' : priced.length < cost.length ? 'unknown' : cost.some(k => k.source === 'estimate') ? 'estimate' : 'actual';
    const reproFiles = Object.keys(x.repro?.files ?? {});
    return {
      id: x.id, role: x.role, slot: x.slot, attempts: x.attempts, step: x.step, model: planned.alias, effort: planned.effort, estimated: planned.estimated === true,
      ...(x.difficulty ? { difficulty: x.difficulty } : {}), ...(x.difficultySource ? { difficultySource: x.difficultySource } : {}),
      ranModel: [...mine].reverse().find(a => a.resolvedModel)?.resolvedModel ?? null,
      status: x.status, verdict: x.verdict,
      stepChanges: steps.filter(k => k.subtaskId === x.id),
      scope: x.writeScope, unscoped: x.unscoped,
      files: x.changes ? { list: x.changes.files, total: x.changes.total, truncated: x.changes.truncated, approximate: x.changes.approximate } : null,
      // one entry per attempt and kind of check (checks.ts): two commands of a kind are one check
      checks: checksByKind(sig.filter(g => !NOT_A_CHECK.has(g.kind))),
      repro: x.repro ? {
        required: x.repro.required, state: x.repro.state ?? (x.repro.required ? 'pending' : 'off'),
        ...(x.repro.reason ? { reason: x.repro.reason } : {}), ...(reproFiles.length ? { files: reproFiles } : {}),
      } : null,
      review: x.review ? {
        verdict: x.review.verdict, by: x.review.by, ...(x.review.bySubtaskId ? { bySubtaskId: x.review.bySubtaskId } : {}), ...(x.review.margin ? { margin: x.review.margin } : {}),
      } : null,
      time: {
        startedAt: first?.startedAt ?? null, stoppedAt: last?.stoppedAt ?? null,
        runMs: runs.length ? runs.reduce((a, b) => a + b, 0) : null,
        verifyMs: sig.some(g => g.durationMs !== undefined) ? sig.reduce((a, g) => a + (g.durationMs ?? 0), 0) : null,
      },
      cost: {
        usd: state === 'none' ? null : round6(priced.reduce((a, k) => a + num(k.usd), 0)), state,
        inputTokens: cost.reduce((a, k) => a + num(k.input_tokens), 0), outputTokens: cost.reduce((a, k) => a + num(k.output_tokens), 0),
        cacheReadTokens: cost.reduce((a, k) => a + num(k.cache_read_tokens), 0), cacheWriteTokens: cost.reduce((a, k) => a + num(k.cache_write_tokens), 0),
      },
    };
  });

  // the timeline: planning until the first worker, each worker's run, each verify, and a wait for the user that is still on
  const timeline: WorkDetail['timeline'] = [];
  const firstStart = agents.map(a => a.startedAt).sort()[0];
  timeline.push({ kind: 'plan', role: null, subtaskId: null, startedAt: r.createdAt, endedAt: firstStart ?? (closed ? end : null), ok: null });
  const lastAgentOf = new Map<string, string>();
  for (const a of agents) if (a.subtaskId) { const cur = lastAgentOf.get(a.subtaskId); if (!cur || a.startedAt >= (agents.find(z => z.agentId === cur)?.startedAt ?? '')) lastAgentOf.set(a.subtaskId, a.agentId); }
  for (const a of [...agents].sort((x, y) => x.startedAt.localeCompare(y.startedAt))) {
    const sub = a.subtaskId ? subs.find(x => x.id === a.subtaskId) : undefined;
    const isLast = !!a.subtaskId && lastAgentOf.get(a.subtaskId) === a.agentId;
    timeline.push({
      kind: 'worker', role: (a.role ?? sub?.role ?? null) as Role | null, subtaskId: a.subtaskId, startedAt: a.startedAt, endedAt: a.stoppedAt ?? (closed ? end : null),
      ok: isLast && sub ? (sub.status === 'passed' ? true : sub.status === 'failed' || sub.status === 'hitl' ? false : null) : null,
    });
  }
  const verifyRuns = new Map<string, { subtaskId: string | null; agentId: string | null; end: string; ms: number; ok: boolean }>();
  for (const g of signals) {
    if (g.durationMs === undefined) continue;
    const key = `${g.subtaskId}|${g.agentId}|${g.attempt}`;
    const v = verifyRuns.get(key) ?? { subtaskId: g.subtaskId, agentId: g.agentId, end: g.createdAt, ms: 0, ok: true };
    v.ms += g.durationMs; v.ok = v.ok && g.ok; if (g.createdAt > v.end) v.end = g.createdAt;
    verifyRuns.set(key, v);
  }
  for (const v of verifyRuns.values()) {
    timeline.push({
      kind: 'verify', role: (subs.find(x => x.id === v.subtaskId)?.role ?? null) as Role | null, subtaskId: v.subtaskId,
      startedAt: new Date(Date.parse(v.end) - v.ms).toISOString(), endedAt: v.end, ok: v.ok,
    });
  }
  if (extras.awaitingSince) timeline.push({ kind: 'awaiting_user', role: null, subtaskId: null, startedAt: extras.awaitingSince, endedAt: null, ok: null });
  timeline.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  // the phases: they add up to the request's duration
  const durationMs = ms(r.createdAt, end) ?? 0;
  const awaitingMs = Math.min(durationMs, extras.awaitingMs + (extras.awaitingSince ? ms(extras.awaitingSince, end) ?? 0 : 0));
  const verifyMs = Math.min(durationMs - awaitingMs, [...verifyRuns.values()].reduce((a, v) => a + v.ms, 0));
  // a verify that ran while its worker was still counted as running (a blocked stop) is verify time, not worker time
  const insideMs = [...verifyRuns.values()].filter(v => { const a = agents.find(z => z.agentId === v.agentId); return !!a && (!a.stoppedAt || v.end <= a.stoppedAt); }).reduce((a, v) => a + v.ms, 0);
  const spanMs = unionMs(agents.map(a => [Date.parse(a.startedAt), Date.parse(a.stoppedAt ?? end)]));
  const workersMs = Math.max(0, Math.min(durationMs - awaitingMs - verifyMs, spanMs - insideMs));
  const leadMs = Math.max(0, durationMs - awaitingMs - verifyMs - workersMs);

  const files = mergedFiles(subs);
  const lastTests = subtasks.flatMap(x => { const top = x.checks.reduce((m, k) => Math.max(m, k.attempt), 0); return x.checks.filter(k => k.attempt === top && k.kind === 'test'); });
  const flags = ledger.costFlags(requestId);
  const levelChanges: WorkDetail['level']['changes'] = [];
  const judgedLevel = r.forcedFrom ?? j.level;
  if (r.forcedFrom && r.forcedFrom !== r.level) levelChanges.push({ from: r.forcedFrom, to: r.level, why: 'forced' });
  else if (r.replannedFrom && r.replannedFrom.level !== r.level) levelChanges.push({ from: r.replannedFrom.level, to: r.level, why: 'replanned' });
  else if (judgedLevel !== r.level) levelChanges.push({ from: judgedLevel, to: r.level, why: [r.triage, r.overriddenTriage].some(t => t?.source === 'manual') ? 'manual' : 'replanned' });
  const ch = rec?.changes ?? null;

  return {
    requestId, state: closed ? 'closed' : r.status === 'awaiting_user' ? 'awaiting_user' : 'open', createdAt: r.createdAt, closedAt: r.closedAt,
    kind: j.kind ?? null, taskType: j.taskType ?? null,
    level: { judged: judgedLevel, source: r.forcedFrom ? 'forced' : String(j.source), rule: j.rule ?? null, confidence: typeof j.confidence === 'number' ? j.confidence : null, final: r.level, changes: levelChanges },
    difficulty: r.triage.difficulty ? { value: r.triage.difficulty, source: r.triage.difficultySource ?? 'default', reported: r.triage.difficultyReported === true } : null,
    checkability: r.checkability,
    plan: { preset: r.preset, leadDirect: r.team.leadDirect === true, leadModel: r.leadModel, leadClass: r.leadClass, budgetUsd: r.budgetUsd, holdout: r.holdout },
    outcome: r.outcome ?? rec?.outcome ?? null,
    passed: closed && rec ? recordVerifyOk(rec) && recRow?.acceptance !== 'not_accepted' : null,
    acceptance: sn(recRow?.acceptance),
    subtasks,
    changes: ch ? { changedFiles: ch.changedFiles, linesAdded: ch.linesAdded, linesRemoved: ch.linesRemoved, newFiles: ch.newFiles, deletedFiles: ch.deletedFiles, approximate: ch.approximate } : null,
    files: (rec?.files?.length && !files.length ? rec.files : files).slice(0, 200),
    tests: lastTests.length ? { passed: lastTests.reduce((a, k) => a + (k.testsPassed ?? 0), 0), failed: lastTests.reduce((a, k) => a + (k.testsFailed ?? 0), 0) } : null,
    stepChanges: steps,
    time: {
      durationMs: closed ? durationMs : ms(r.createdAt, now), activeMs: closed ? Math.max(0, durationMs - awaitingMs) : null, awaitingMs,
      phases: [{ phase: 'lead', ms: leadMs }, { phase: 'workers', ms: workersMs }, { phase: 'verify', ms: verifyMs }, { phase: 'awaiting_user', ms: awaitingMs }],
    },
    timeline,
    cost: {
      totalUsd: round6(r.usedUsd + r.leadCostUsd), leadUsd: closed && rec?.costs ? rec.costs.leadUsd ?? null : null, workerUsd: round6(r.usedUsd), budgetUsd: r.budgetUsd,
      estimated: flags.estimated, unknown: flags.unknown, budgetExceeded: r.usedUsd > r.budgetUsd, basis: proxy ? 'proxy' : 'transcript',
    },
    hasPrompt: typeof (recRow?.prompt ?? extras.prompt) === 'string' && String(recRow?.prompt ?? extras.prompt).length > 0,
  };
}

// ------------------------------------------------------------------ Savings

export const LEAD_PRICED_ASSUMPTIONS: readonly string[] = [
  'An estimate, not a measurement: what the workers\' tokens would have cost at the lead model\'s list price.',
  'It assumes the lead would have used the same tokens as the workers did. A lead doing the work itself reads and writes differently, so the real number could be higher or lower.',
  'Standard list prices are used for both sides (no long-prompt or fast-mode rates); cache reads and writes are priced at the lead model\'s cache rates.',
  'The lead\'s own cost is taken as the same in both cases: the cost of briefing workers and reading their results is not taken out.',
];

export interface Savings {
  period: Period; since: string; until: string;
  measured: {
    cost: {
      label: 'billed' | 'api-equivalent' | 'mixed';
      totalUsd: number; leadUsd: number; workerUsd: number;
      requests: number; passed: number; costPerPassedUsd: number | null;
      bySource: { proxy: number; transcript: number };
      flags: { estimated: number; unknown: number; budgetExceeded: number };
    };
    limits: SessionLimits | null;
  };
  estimated: {
    leadPriced: {
      workerUsd: number; atLeadPriceUsd: number; differenceUsd: number; requests: number;
      leftOut: { noLeadModel: number; noPrice: number; noTokens: number };
      assumptions: string[];
    };
    holdout: Array<{
      leadClass: string; level: Level;
      team: { n: number; accepted: number; costPerAcceptedUsd: number | null };
      direct: { n: number; accepted: number; costPerAcceptedUsd: number | null };
      need: { team: number; direct: number };
      enough: boolean;
      differencePct: number | null;
    }>;
    holdoutRate: number; holdoutMode: 'on' | 'observe' | 'off';
  };
  series: {
    unit: 'hour' | 'day'; utcOffsetMinutes: number;
    points: Array<{ start: string; requests: number; passed: number; totalUsd: number; leadUsd: number; workerUsd: number; leadPricedDifferenceUsd: number | null }>;
  };
}

/** A model id as the price table knows it: the id itself, or the entry it starts with (a dated or bracketed variant). */
function pricedModel(id: string | null | undefined): string | null {
  if (!id) return null;
  if (PRICING_PER_MTOK[id]) return id;
  const base = id.replace(/\[.*$/, '');
  return Object.keys(PRICING_PER_MTOK).find(k => base === k || base.startsWith(`${k}-`)) ?? null;
}

/** Tokens at a model's standard list price (no long-prompt tier, no fast mode; cache writes at the 5-minute rate). */
export function listPriceUsd(modelId: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  const p = PRICING_PER_MTOK[modelId]!;
  return (t.input * p.input + t.cacheWrite * CACHE_MULTIPLIER.write5m * p.input + t.cacheRead * (p.cacheRead ?? CACHE_MULTIPLIER.read) * p.input + t.output * p.output) / 1e6;
}

/** What the workers of one request cost, and the same tokens at the lead's list price; why not, when it cannot be said. */
function leadPricedOf(ledger: Ledger, requestId: string, leadModel: string | null | undefined): { workerUsd: number; atLeadPriceUsd: number } | 'noLeadModel' | 'noPrice' | 'noTokens' | 'none' {
  const proxy = ledger.hasProxyCosts(requestId);
  const rows = (ledger.listCosts(requestId)).filter(k => k.subtask_id !== null && k.subtask_id !== undefined && (proxy ? k.source === 'proxy' : k.source === 'transcript' || k.source === 'estimate'));
  if (!rows.length) return 'none';   // nothing was delegated, or nothing was recorded for it
  if (!leadModel) return 'noLeadModel';
  const lead = pricedModel(leadModel);
  if (!lead) return 'noPrice';
  let workerUsd = 0, atLead = 0, tokens = 0;
  for (const k of rows) {
    const t = { input: num(k.input_tokens), output: num(k.output_tokens), cacheRead: num(k.cache_read_tokens), cacheWrite: num(k.cache_write_tokens) };
    // a worker whose usage is not known, or whose model has no price: the two sides would not cover the same work
    if (k.usd === null || k.usd === undefined) return t.input + t.output + t.cacheRead + t.cacheWrite > 0 ? 'noPrice' : 'noTokens';
    tokens += t.input + t.output + t.cacheRead + t.cacheWrite;
    const own = pricedModel(sn(k.model_id));
    // the workers' side at standard list prices too, so the difference is between two prices and not two price rules
    workerUsd += own ? listPriceUsd(own, t) : num(k.usd);
    atLead += listPriceUsd(lead, t);
  }
  if (!tokens) return 'noTokens';
  return { workerUsd, atLeadPriceUsd: atLead };
}

export function savings(c: TabsContext, period: Period): Savings {
  const { ledger } = c;
  const now = nowOf(c);
  const since = new Date(now.getTime() - PERIOD_MS[period]);
  const rows = ledger.db.prepare('SELECT request_id, closed_at, total_usd, lead_usd, subtask_usd, record, acceptance FROM request_records WHERE closed_at >= ? AND closed_at <= ? ORDER BY closed_at')
    .all(since.toISOString(), now.toISOString()) as Row[];

  const unit: 'hour' | 'day' = period === '24h' ? 'hour' : 'day';
  const startOf = (d: Date): Date => (unit === 'hour' ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()) : new Date(d.getFullYear(), d.getMonth(), d.getDate()));
  const next = (d: Date): Date => (unit === 'hour' ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1) : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
  type Point = Savings['series']['points'][number];
  const points = new Map<number, Point>();
  for (let d = startOf(since); d.getTime() <= now.getTime(); d = next(d)) {
    points.set(d.getTime(), { start: d.toISOString(), requests: 0, passed: 0, totalUsd: 0, leadUsd: 0, workerUsd: 0, leadPricedDifferenceUsd: null });
  }

  const cost = { totalUsd: 0, leadUsd: 0, workerUsd: 0, requests: 0, passed: 0, bySource: { proxy: 0, transcript: 0 }, flags: { estimated: 0, unknown: 0, budgetExceeded: 0 } };
  const lp = { workerUsd: 0, atLeadPriceUsd: 0, requests: 0, leftOut: { noLeadModel: 0, noPrice: 0, noTokens: 0 } };
  for (const r of rows) {
    const rec = parse<RecordBlob>(r.record, {});
    const ok = recordVerifyOk(rec) && r.acceptance !== 'not_accepted';
    const f = rec.costs ?? {};
    cost.requests++; if (ok) cost.passed++;
    cost.totalUsd += num(r.total_usd); cost.leadUsd += num(r.lead_usd); cost.workerUsd += num(r.subtask_usd);
    if (f.source === 'proxy') cost.bySource.proxy++; else cost.bySource.transcript++;
    if (f.estimated) cost.flags.estimated++;
    if (f.unknown) cost.flags.unknown++;
    if (f.budgetExceeded) cost.flags.budgetExceeded++;
    const p = points.get(startOf(new Date(s(r.closed_at))).getTime());
    if (p) { p.requests++; if (ok) p.passed++; p.totalUsd += num(r.total_usd); p.leadUsd += num(r.lead_usd); p.workerUsd += num(r.subtask_usd); }
    const e = leadPricedOf(ledger, s(r.request_id), rec.plan?.leadModel);
    if (e === 'none') continue;
    if (typeof e === 'string') { lp.leftOut[e]++; continue; }
    lp.requests++; lp.workerUsd += e.workerUsd; lp.atLeadPriceUsd += e.atLeadPriceUsd;
    if (p) p.leadPricedDifferenceUsd = (p.leadPricedDifferenceUsd ?? 0) + (e.atLeadPriceUsd - e.workerUsd);
  }

  const routing = routingView(ledger, c.config, now.toISOString());
  const holdout: Savings['estimated']['holdout'] = [];
  for (const cl of routing.classes) {
    for (const l of cl.levels) {
      if (!l.delegatedByConfig || (!l.delegated.n && !l.direct.n)) continue;
      const [haveT, needT] = l.decision.need.delegated, [haveD, needD] = l.decision.need.direct;
      const enough = haveT >= needT && haveD >= needD && l.delegated.costPerAcceptedUsd !== null && l.direct.costPerAcceptedUsd !== null && l.direct.costPerAcceptedUsd > 0;
      holdout.push({
        leadClass: cl.leadClass, level: l.level,
        team: { n: l.delegated.n, accepted: l.delegated.accepted, costPerAcceptedUsd: l.delegated.costPerAcceptedUsd },
        direct: { n: l.direct.n, accepted: l.direct.accepted, costPerAcceptedUsd: l.direct.costPerAcceptedUsd },
        need: { team: needT, direct: needD }, enough,
        differencePct: enough ? Math.round((l.delegated.costPerAcceptedUsd! / l.direct.costPerAcceptedUsd! - 1) * 1000) / 10 : null,
      });
    }
  }

  const { proxy, transcript } = cost.bySource;
  return {
    period, since: since.toISOString(), until: now.toISOString(),
    measured: {
      cost: {
        label: proxy && !transcript ? 'billed' : proxy ? 'mixed' : 'api-equivalent',
        totalUsd: round6(cost.totalUsd), leadUsd: round6(cost.leadUsd), workerUsd: round6(cost.workerUsd),
        requests: cost.requests, passed: cost.passed, costPerPassedUsd: cost.passed ? round6(cost.totalUsd / cost.passed) : null,
        bySource: cost.bySource, flags: cost.flags,
      },
      limits: latestLimits(ledger.db),
    },
    estimated: {
      leadPriced: {
        workerUsd: round6(lp.workerUsd), atLeadPriceUsd: round6(lp.atLeadPriceUsd), differenceUsd: round6(lp.atLeadPriceUsd - lp.workerUsd), requests: lp.requests,
        leftOut: lp.leftOut, assumptions: [...LEAD_PRICED_ASSUMPTIONS],
      },
      holdout, holdoutRate: routingHoldoutRate(c.config), holdoutMode: routingMode(c.config),
    },
    series: {
      unit, utcOffsetMinutes: -now.getTimezoneOffset(),
      points: [...points.values()].map(p => ({
        ...p, totalUsd: round6(p.totalUsd), leadUsd: round6(p.leadUsd), workerUsd: round6(p.workerUsd),
        leadPricedDifferenceUsd: p.leadPricedDifferenceUsd === null ? null : round6(p.leadPricedDifferenceUsd),
      })),
    },
  };
}

// ------------------------------------------------------------------ Team

export type Source = 'default' | 'profile' | 'own' | 'project';

export interface TeamLayers {
  profile: Profile;
  /** The presets as each layer leaves them: the defaults, the profile, the user's teams.yaml, the project's. */
  defaults: Record<Level, TeamPreset>; profiled: Record<Level, TeamPreset>; own: Record<Level, TeamPreset>; project: Record<Level, TeamPreset>;
  problems: Array<{ path: string; message: string }>;
}

/** The team presets layer by layer, so a value's source can be named. An invalid file is skipped and reported. */
export function teamLayers(homeRoot: string | undefined, profile: Profile, cwd: string | undefined): TeamLayers {
  const problems: TeamLayers['problems'] = [];
  const defaults = structuredClone(DEFAULT_PRESETS);
  const profiled = profilePresets(profile);
  const load = (file: string, base: Record<Level, TeamPreset>, name: string): Record<Level, TeamPreset> => {
    if (!fs.existsSync(file)) return base;
    try { return loadPresets(file, base); }
    catch (e) { problems.push({ path: name, message: `ignored: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200)}` }); return base; }
  };
  const own = homeRoot ? load(path.join(homeRoot, TEAMS_FILE), profiled, TEAMS_FILE) : profiled;
  const root = cwd ? workTreeRoot(cwd) : undefined;
  const project = root ? load(path.join(root, PROJECT_TEAMS_FILE), own, PROJECT_TEAMS_FILE) : own;
  return { profile, defaults, profiled, own, project, problems };
}

/** Where a value comes from: the topmost layer that changed it. */
export function sourceOf<T>(pick: (p: Record<Level, TeamPreset>) => T, l: TeamLayers): Source {
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(pick(l.project), pick(l.own))) return 'project';
  if (!same(pick(l.own), pick(l.profiled))) return 'own';
  if (!same(pick(l.profiled), pick(l.defaults))) return 'profile';
  return 'default';
}

export const TEAM_LEVELS: readonly Level[] = ['L1', 'L2', 'L3'];
export const ROLES: readonly Role[] = ['architect', 'ui-designer', 'coder', 'reviewer', 'tester'];

export interface TeamView {
  period: Period; since: string; until: string;
  profile: { value: Profile; source: 'default' | 'own' };
  leadClass: string | null;
  delegateFrom: { value: Level; source: Source } | null;
  roles: Array<{
    role: Role;
    // decision 225: one entry per level x difficulty, each with the start cell that difficulty gives.
    levels: Array<{ level: Level; difficulty: Difficulty; count: number; step: LadderId; model: string; effort: string; estimated: boolean; source: Source }>;
    stats: { subtasks: number; passed: number; failed: number; passRate: number | null; avgCostUsd: number | null; avgRunMs: number | null; stepUps: number; stepDowns: number };
  }>;
  stepChanges: StepChange[];
  triage: TriageReport;
  routing: RoutingView;
}

/** The lead class of a session, from the model its status line or hooks last reported. */
export function sessionLeadClass(ledger: Ledger, sessionId: string | undefined): LeadModelClass | null {
  if (!sessionId) return null;
  try {
    const r = ledger.db.prepare('SELECT lead_model FROM sessions WHERE session_id = ?').get(sessionId) as Row | undefined;
    return r?.lead_model ? leadModelClass(String(r.lead_model)) : null;
  } catch { return null; }
}

/** Where delegation starts for a lead class, and where that comes from. `own` is the file's own delegateFrom. */
export function delegateFromOf(profile: Profile, own: Partial<Record<LeadModelClass, Level>> | undefined, leadClass: LeadModelClass): { value: Level; source: Source } {
  const mine = own?.[leadClass];
  if (mine) return { value: mine, source: 'own' };
  const p = PROFILE_LAYERS[profile].delegateFrom?.[leadClass];
  return p && p !== DEFAULT_DELEGATE_FROM[leadClass] ? { value: p, source: 'profile' } : { value: profileDelegateFrom(profile)[leadClass], source: 'default' };
}

/** What the user wrote in config.json (not what the profile gives). */
function ownConfig(file: string | undefined): { profile?: unknown; delegateFrom?: Partial<Record<LeadModelClass, Level>> } {
  if (!file) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const from = j.delegateFrom;
    return { ...(j.profile !== undefined ? { profile: j.profile } : {}), ...(from && typeof from === 'object' && !Array.isArray(from) ? { delegateFrom: from as Partial<Record<LeadModelClass, Level>> } : {}) };
  } catch { return {}; }
}

export function teamView(c: TabsContext, q: { period: Period; sessionId?: string }): TeamView {
  const { ledger } = c;
  const own = ownConfig(c.configFile);
  const now = nowOf(c);
  const since = new Date(now.getTime() - PERIOD_MS[q.period]).toISOString();
  const profile = profileOf(c.config);
  const layers = teamLayers(c.homeRoot, profile, q.sessionId ? c.sessionCwd?.(q.sessionId) : undefined);
  const leadClass = sessionLeadClass(ledger, q.sessionId);

  const stats = new Map<string, { subtasks: number; passed: number; failed: number; usd: number; priced: number; runMs: number; ran: number; ups: number; downs: number }>();
  const stat = (role: string) => { let v = stats.get(role); if (!v) { v = { subtasks: 0, passed: 0, failed: 0, usd: 0, priced: 0, runMs: 0, ran: 0, ups: 0, downs: 0 }; stats.set(role, v); } return v; };
  const subs = ledger.db.prepare(`SELECT s.request_id, s.id, s.role, s.status, s.verdict FROM subtasks s JOIN request_records rr ON rr.request_id = s.request_id WHERE rr.closed_at >= ?`).all(since) as Row[];
  const proxyOf = new Map<string, boolean>();
  for (const x of subs) {
    const v = stat(s(x.role));
    v.subtasks++;
    if (x.status === 'passed') v.passed++;
    else if (x.status === 'failed' || (x.status === 'hitl' && (x.verdict === 'miss' || x.verdict === 'rejected'))) v.failed++;
    const rid = s(x.request_id);
    if (!proxyOf.has(rid)) proxyOf.set(rid, ledger.hasProxyCosts(rid));
    const k = ledger.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS n, COALESCE(SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END), 0) AS unknown FROM costs
      WHERE request_id = ? AND subtask_id = ? AND ${proxyOf.get(rid) ? "source = 'proxy'" : "source IN ('transcript', 'estimate')"}`).get(rid, s(x.id)) as Row;
    if (num(k.n) > 0 && num(k.unknown) === 0) { v.usd += num(k.usd); v.priced++; }
    const t = ledger.db.prepare('SELECT started_at, stopped_at FROM agents WHERE request_id = ? AND subtask_id = ?').all(rid, s(x.id)) as Row[];
    const run = t.map(a => ms(sn(a.started_at), sn(a.stopped_at))).filter((m): m is number => m !== null);
    if (run.length) { v.runMs += run.reduce((a, b) => a + b, 0); v.ran++; }
  }
  const changes = ledger.listStepChanges({ since, limit: 1000 });
  for (const x of changes) { if (x.reason === 'easy') stat(x.role).downs++; else stat(x.role).ups++; }

  return {
    period: q.period, since, until: now.toISOString(),
    profile: { value: profile, source: own.profile !== undefined ? 'own' : 'default' },
    leadClass,
    delegateFrom: leadClass ? delegateFromOf(profile, own.delegateFrom, leadClass) : null,
    roles: ROLES.map(role => {
      const v = stats.get(role);
      const judgedN = (v?.passed ?? 0) + (v?.failed ?? 0);
      return {
        role,
        levels: TEAM_LEVELS.flatMap(level => {
          const m = layers.project[level].roles.find(x => x.role === role);
          if (!m || m.count <= 0) return [];
          const source = sourceOf(p => p[level].roles.find(x => x.role === role) ?? null, layers);
          // decisions 225, 226: the start cell depends on difficulty, the profile notch and any user override; show all three difficulties.
          return DIFFICULTIES.map(difficulty => {
            const cell = memberStartCell(role, m.start, m.startSet, difficulty, profile, c.config?.fableOptIn === true);
            const st = ladderStep(cell);
            return { level, difficulty, count: m.count, step: cell, model: st.alias, effort: st.effort, estimated: st.estimated === true, source };
          });
        }),
        stats: {
          subtasks: v?.subtasks ?? 0, passed: v?.passed ?? 0, failed: v?.failed ?? 0, passRate: judgedN ? Math.round(((v?.passed ?? 0) / judgedN) * 1000) / 1000 : null,
          avgCostUsd: v?.priced ? round6(v.usd / v.priced) : null, avgRunMs: v?.ran ? Math.round(v.runMs / v.ran) : null, stepUps: v?.ups ?? 0, stepDowns: v?.downs ?? 0,
        },
      };
    }),
    stepChanges: changes.slice(0, 20).map(stepChange),
    triage: metricsTriageReport(ledger, { since }),
    routing: routingView(ledger, c.config, now.toISOString()),
  };
}
