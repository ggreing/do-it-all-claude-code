// The daemon's HTTP server: the rate limits route (spec 3.8), the metrics routes (decision 132, sealed since the
// browser dashboard was removed, decision 183) and what /dashboard answers now. Every route refuses any Origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import { TOKEN, call, callAs, postHook, request, rmrf, rows, startTestDaemon, tmpDir, type TestDaemon } from './helpers.ts';

const LIMITS = {
  five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
  seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
};

async function withDaemon(fn: (d: TestDaemon) => Promise<void>): Promise<void> {
  const d = await startTestDaemon({ now: () => new Date('2026-11-12T12:00:00.000Z') });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
const json = (token: string | null, body: unknown, extra: Record<string, string> = {}) => ({
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
});

test('the hook API still refuses any Origin, the daemon\'s own included', () => withDaemon(async d => {
  const hook = { session_id: 's', cwd: d.home, transcript_path: path.join(d.home, 's.jsonl'), hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  assert.equal((await postHook(d.port, hook)).status, 200);
  for (const origin of [`http://127.0.0.1:${d.port}`, `http://localhost:${d.port}`, 'https://evil.example', 'null']) {
    for (const p of ['/router/v1/hooks/claude-code', '/router/v1/limits', '/router/v1/usage', '/router/v1/tools/call']) {
      const r = await request(d.port, { path: p, ...json(TOKEN, hook, { origin }) });
      assert.equal(r.status, 403, `${p} with Origin ${origin}`);
    }
    assert.equal((await request(d.port, { path: '/router/v1/status', headers: { authorization: `Bearer ${TOKEN}`, origin } })).status, 403);
  }
  assert.equal(rows(d, "SELECT COUNT(*) AS c FROM events WHERE type = 'prompt_submit'")[0]!.c, 1, 'no refused hook was recorded');
}));

test('spec 3.8: POST /router/v1/limits stores a session\'s latest rate limits (token required; junk is not stored)', () => withDaemon(async d => {
  const post = (token: string | null, body: unknown) => callAs(d.port, token, { method: 'POST', path: '/router/v1/limits', body: JSON.stringify(body) });
  assert.equal((await post(null, { sessionId: 's1', rateLimits: LIMITS })).status, 401);
  assert.equal((await post('wrong', { sessionId: 's1', rateLimits: LIMITS })).status, 401);
  assert.equal((await post(TOKEN, { rateLimits: LIMITS })).status, 400);
  assert.equal((await post(TOKEN, { sessionId: 'has space', rateLimits: LIMITS })).status, 400);
  assert.deepEqual((await post(TOKEN, { sessionId: 's1', rateLimits: { five_hour: { resets_at: 1 } } })).body, { stored: false, model: false });
  assert.deepEqual((await post(TOKEN, { sessionId: 's1', rateLimits: LIMITS, at: '1999-01-01T00:00:00.000Z' })).body, { stored: true, model: false });
  assert.deepEqual(rows(d, 'SELECT session_id, five_hour_pct, seven_day_pct, spend_pct, updated_at FROM session_limits'),
    [{ session_id: 's1', five_hour_pct: 23.5, seven_day_pct: 41.2, spend_pct: null, updated_at: '2026-11-12T12:00:00.000Z' }]);   // the daemon's clock
  assert.equal((await call(d.port, { path: '/router/v1/limits' })).status, 405);
}));

test('decision 183: the metrics are routes of the API, reached by a sealed call only', () => withDaemon(async d => {
  await call(d.port, { method: 'POST', path: '/router/v1/limits', body: JSON.stringify({ sessionId: 's1', rateLimits: LIMITS }) });
  for (const p of ['summary', 'requests?limit=5', 'triage-report']) {
    const route = `/router/v1/metrics/${p}`;
    assert.equal((await request(d.port, { path: route })).status, 401, `${p}: no credential`);
    assert.equal((await request(d.port, { path: route, headers: { authorization: `Bearer ${TOKEN}` } })).status, 401, `${p}: the token as a header (decision 164)`);
    assert.equal((await request(d.port, { path: route, headers: { origin: `http://127.0.0.1:${d.port}` } })).status, 403, `${p}: a browser page`);
    assert.equal((await call(d.port, { path: route })).status, 200, p);
  }
  const summary = (await call(d.port, { path: '/router/v1/metrics/summary' })).body as { limits: { fiveHour: { usedPercentage: number } } };
  assert.equal(summary.limits.fiveHour.usedPercentage, 23.5);
  assert.ok(Array.isArray(((await call(d.port, { path: '/router/v1/metrics/requests' })).body as { rows: unknown[] }).rows));
  assert.equal((await call(d.port, { path: '/router/v1/metrics/requests/nope' })).status, 404);
  assert.equal((await call(d.port, { path: '/router/v1/metrics/requests?limit=abc' })).status, 400);
  assert.equal((await call(d.port, { path: '/router/v1/metrics/summary?since=yesterday' })).status, 400);
  assert.equal((await call(d.port, { path: '/router/v1/metrics/now' })).status, 404, 'the dashboard\'s live view is not a route any more');
  assert.equal((await call(d.port, { method: 'POST', path: '/router/v1/metrics/summary', body: '{}' })).status, 405);
}));

test('decision 186: /dashboard answers 410 with one line that names /office, whoever asks', () => withDaemon(async d => {
  const gone = 'The browser dashboard was removed in 0.5.0. Use /office inside Claude Code.\n';
  for (const p of ['/dashboard', '/dashboard/', '/dashboard/metrics/summary', '/dashboard/settings', '/dashboard/assets/index.js']) {
    const r = await request(d.port, { path: p });
    assert.deepEqual([r.status, r.text], [410, gone], p);
    assert.match(String(r.headers['content-type']), /^text\/plain/);
  }
  // the page's old login: no session is made
  const auth = await request(d.port, { path: '/dashboard/auth', ...json(null, { code: 'x' }, { origin: `http://127.0.0.1:${d.port}`, 'sec-fetch-site': 'same-origin' }) });
  assert.equal(auth.status, 410);
  assert.equal(auth.headers['set-cookie'], undefined);
  // the code route an older CLI calls, sealed: the same line, no code
  const old = await call(d.port, { method: 'POST', path: '/dashboard/register-code' });
  assert.deepEqual([old.status, old.text], [410, gone]);
  // other paths are as before
  assert.equal((await request(d.port, { path: '/dashboards' })).status, 404);
}));

test('ledger v11: a v10 ledger gains session_limits', () => {
  const dir = tmpDir('ar-v10-');
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('DROP TABLE session_limits; PRAGMA user_version = 10;');
    l.close();
    const again = new Ledger(file);
    assert.equal(Number((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
    assert.ok(again.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'session_limits'").get());
    again.close();
  } finally { rmrf(dir); }
});

test('decision 138: POST /router/v1/routing/reset clears the released levels (token required, no body)', async () => {
  const d = await startTestDaemon({ config: { autoRelease: 'on' } });
  try {
    const reset = (o: { token?: string | null; method?: string } = {}) => callAs(d.port, o.token === undefined ? TOKEN : o.token, { method: o.method ?? 'POST', path: '/router/v1/routing/reset' });
    const released = () => d.router.routing().classes.flatMap(c => c.levels.filter(l => l.released).map(l => `${c.leadClass}:${l.level}`));
    d.ledger.setRelease('opus', { autoDelegateFrom: 'L2' }, '2026-11-12T12:00:00.000Z');
    assert.deepEqual(released(), ['opus:L1']);
    assert.equal((await reset({ token: null })).status, 401);
    assert.equal((await reset({ method: 'GET' })).status, 405);
    assert.equal((await reset({ token: TOKEN, method: 'POST' })).status, 200);
    assert.deepEqual(released(), []);
    assert.deepEqual((await reset()).body, { cleared: 0 });
  } finally { await d.close(); rmrf(d.home); }
});
