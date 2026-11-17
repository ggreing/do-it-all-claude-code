// The metrics reads as routes of the daemon's API (decision 183 removed the browser dashboard that served them):
// the same parameters and the same answers as the functions of metrics.ts give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import { latestLimits } from '../src/limits.ts';
import { metricsRequestDetail, metricsRequests, metricsSummary, metricsTriageReport } from '../src/metrics.ts';
import { DASHBOARD_GONE, METRICS_PREFIX, isDashboardPath, isMetricsRoute, metricsRoute } from '../src/metrics-routes.ts';

function seed(l: Ledger, id: string, closedAt: string, prompt: string | null = null): void {
  const record = {
    version: 1,
    triage: { kind: 'team', level: 'L2', confidence: 0.7, source: 'rule', rule: 'r.files', rationale: 'ok' },
    plan: { level: 'L2', preset: 'L2', leadDirect: false, replannedFrom: null, manualLevel: null, leadClass: 'opus', forcedFrom: null, holdout: null },
    outcome: 'delegated',
    subtasks: [{ id: 'S0', role: 'coder', slot: 0, step: 's1', upCount: 0, status: 'passed', verdict: 'meet', attempts: 1, costUsd: 0 }],
    verifyFailures: 0,
    costs: { subtaskUsd: 0.2, leadUsd: 0.1, totalUsd: 0.3, estimated: false, unknown: false, budgetExceeded: false },
  };
  l.upsertRecord({
    requestId: id, sessionId: 'sess', createdAt: closedAt, closedAt, kind: 'team', level: 'L2', finalLevel: 'L2', outcome: 'delegated',
    changedFiles: 1, linesAdded: 1, linesRemoved: 0, durationMs: 1000, activeMs: 900, subtaskUsd: 0.2, leadUsd: 0.1, totalUsd: 0.3, record, prompt,
  });
}
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 10, 0, 0)).toISOString();
/** As it goes over the wire: JSON, so a key without a value is not there. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const get = (l: Ledger, pathAndQuery: string, o: Parameters<typeof metricsRoute>[3] = {}) =>
  wire(metricsRoute(l, 'GET', new URL(`${METRICS_PREFIX}/${pathAndQuery}`, 'http://127.0.0.1'), o));

function withLedger(fn: (l: Ledger) => void): void {
  const l = new Ledger(':memory:');
  try {
    seed(l, 'r1', day(10), 'fix sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 please');
    seed(l, 'r2', day(11));
    seed(l, 'r3', day(12));
    fn(l);
  } finally { l.close(); }
}

test('each route answers what its metrics function gives', () => withLedger(l => {
  assert.deepEqual(get(l, 'summary'), wire({ status: 200, body: { ...metricsSummary(l, {}), limits: latestLimits(l.db) } }));
  const w = { since: day(11), until: day(12) };
  assert.deepEqual(get(l, `summary?since=${encodeURIComponent(w.since)}&until=${encodeURIComponent(w.until)}`).body, wire({ ...metricsSummary(l, w), limits: latestLimits(l.db) }));
  assert.deepEqual(get(l, 'requests?limit=2').body, wire(metricsRequests(l, { limit: 2, before: null, level: undefined, outcome: undefined })));
  assert.deepEqual(get(l, 'triage-report').body, wire(metricsTriageReport(l, {})));
  assert.deepEqual(get(l, 'requests/r2').body, wire(metricsRequestDetail(l, 'r2', { includePrompt: false, secrets: [] })));
}));

test('requests: the cursor of one page gives the next, and a level filter applies', () => withLedger(l => {
  const first = get(l, 'requests?limit=2').body as { rows: Array<{ requestId: string }>; nextCursor: { closedAt: string; requestId: string } | null };
  assert.deepEqual(first.rows.map(r => r.requestId), ['r3', 'r2']);
  assert.ok(first.nextCursor);
  const next = get(l, `requests?limit=2&before=${encodeURIComponent(`${first.nextCursor.closedAt},${first.nextCursor.requestId}`)}`).body as { rows: Array<{ requestId: string }> };
  assert.deepEqual(next.rows.map(r => r.requestId), ['r1']);
  assert.deepEqual((get(l, 'requests?level=L3').body as { rows: unknown[] }).rows, []);
}));

test('a request\'s prompt comes back only while recordPrompts is on, with secrets masked', () => withLedger(l => {
  const off = JSON.stringify(get(l, 'requests/r1').body);
  assert.doesNotMatch(off, /please/);
  const on = JSON.stringify(get(l, 'requests/r1', { recordPrompts: true, secrets: [] }).body);
  assert.match(on, /please/);
  assert.doesNotMatch(on, /abcdefghijklmnopqrstuvwxyz0123456789/);
}));

test('bad input is a 400, an unknown request or path a 404, another method a 405', () => withLedger(l => {
  assert.deepEqual(get(l, 'requests?limit=abc'), { status: 400, body: { error: 'limit must be a number' } });
  assert.deepEqual(get(l, 'summary?since=yesterday'), { status: 400, body: { error: 'since is not a date' } });
  assert.deepEqual(get(l, 'requests?until=12%2F40%2Fx'), { status: 400, body: { error: 'until is not a date' } });
  assert.equal(get(l, 'summary?since=2026-11-11').status, 200);
  assert.equal(get(l, 'requests/%E0%A4%A').status, 400);
  assert.deepEqual(get(l, 'requests/nope'), { status: 404, body: { error: 'no such request' } });
  assert.equal(get(l, 'now').status, 404);                       // the dashboard's live view; the office has its own route
  assert.equal(get(l, 'nothing').status, 404);
  assert.equal(metricsRoute(l, 'POST', new URL(`${METRICS_PREFIX}/summary`, 'http://127.0.0.1')).status, 405);
}));

test('which paths are metrics routes and which the removed dashboard\'s', () => {
  assert.equal(isMetricsRoute('/router/v1/metrics/summary'), true);
  assert.equal(isMetricsRoute('/router/v1/metrics'), false);
  assert.equal(isMetricsRoute('/router/v1/metricsx/summary'), false);
  for (const p of ['/dashboard', '/dashboard/', '/dashboard/metrics/summary', '/dashboard/register-code']) assert.equal(isDashboardPath(p), true, p);
  for (const p of ['/dashboards', '/router/v1/dashboard', '/']) assert.equal(isDashboardPath(p), false, p);
  assert.match(DASHBOARD_GONE, /\/office inside Claude Code/);
});
