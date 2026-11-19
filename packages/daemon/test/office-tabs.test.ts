// Decisions 193, 194: the routes behind the team office's Work, Savings, Team and Settings tabs, and the profile.
// A real test daemon on a temporary router home (never the user's own); every call is sealed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PRESETS, PROFILE_LAYERS, applyTeamPaths, profilePresets, readAudit, withProfile } from '@do-it-all-claude-code/core';
import { readConfig } from '../src/config.ts';
import { Ledger } from '../src/ledger.ts';
import { listPriceUsd } from '../src/tabs.ts';
import { call, makeRepo, postHook, request, rmrf, rows, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
const stop = (msg = 'Done.'): HookInput => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: msg });
const get = async (d: TestDaemon, p: string) => { const r = await call(d.port, { path: p }); return { status: r.status, body: r.body as any }; };
const post = async (d: TestDaemon, p: string, body: unknown) => { const r = await call(d.port, { method: 'POST', path: p, body: JSON.stringify(body) }); return { status: r.status, body: r.body as any }; };

/**
 * A daemon with one L2 request in a repository: coder A adds src/b.ts and edits src/a.ts and passes; coder B misses
 * (its verify fails twice), which raises its slot. `open` leaves the request running; otherwise it is closed.
 */
async function withWork(fn: (d: TestDaemon, sid: string, repo: string) => Promise<void>, o: { open?: boolean; config?: Record<string, unknown> } = {}): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'one\ntwo\n', 'README.md': 'x\n' });
  let pass = '', fail = '';
  let failing = false;
  let t = Date.parse('2026-11-17T09:00:00.000Z');
  const d = await startTestDaemon({
    now: () => new Date(t), ...(o.config ? { config: o.config } : {}),
    verify: { resolveCommands: async () => [{ kind: 'test' as const, command: `node "${failing ? fail : pass}"` }] },
  });
  pass = path.join(d.home, 'pass.cjs').split(path.sep).join('/');
  fail = path.join(d.home, 'fail.cjs').split(path.sep).join('/');
  fs.writeFileSync(pass, "console.log('\\u2139 pass 3'); console.log('\\u2139 fail 0');\n");
  fs.writeFileSync(fail, "console.log('\\u2139 pass 1'); console.log('\\u2139 fail 2'); process.exit(1);\n");
  const sid = 'tabs-1';
  const hook = async (h: HookInput) => {
    t += 1000;
    const r = await postHook(d.port, { session_id: sid, cwd: repo, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
  };
  const agent = (id: string, sub: string, scope: string) => ({
    dispatch: { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_${id}`,
      tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${sub}] work\n[scope: ${scope}]`, model: 'sonnet', effort: 'medium' } },
    start: { hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' },
    stop: (active = false) => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: active }),
  });
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await d.router.drain();
    const a = agent('ag-a', 'A', 'src/**');
    await hook(a.dispatch); await hook(a.start);
    write(repo, 'src/b.ts', 'b1\nb2\nb3\n');           // new: 3 lines
    write(repo, 'src/a.ts', 'one\nTWO\nthree\n');      // 2 added, 1 removed
    await hook(a.stop());
    const b = agent('ag-b', 'B', 'docs/**');
    await hook(b.dispatch); await hook(b.start);
    write(repo, 'docs/n.md', 'n\n');
    failing = true;
    await hook(b.stop());                               // the first failure: one fix round
    await hook(b.stop(true));                           // the second: a miss, the slot is raised
    failing = false;
    if (!o.open) {
      await hook(stop());                               // blocked once: the failed coder can be tried again (decision 175)
      await hook({ ...stop(), stop_hook_active: true });
      await d.router.drain();
    }
    await fn(d, sid, repo);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

// ------------------------------------------------------------------ the ledger

test('a v17 ledger gains the subtask changes column, the step changes table (decision 193), and the per-subtask difficulty columns (decision 230)', () => {
  const dir = tmpDir('ar-v19-');
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('ALTER TABLE subtasks DROP COLUMN changes; ALTER TABLE subtasks DROP COLUMN difficulty; ALTER TABLE subtasks DROP COLUMN difficulty_source; DROP TABLE step_changes; PRAGMA user_version = 17;');
    l.close();
    const again = new Ledger(file);
    const subCols = (again.db.prepare('PRAGMA table_info(subtasks)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(['changes', 'difficulty', 'difficulty_source'].every(c => subCols.includes(c)), subCols.join(','));
    again.addStepChange({ requestId: 'r', subtaskId: 'A', role: 'coder', slot: 0, from: 's1', to: 's2', reason: 'miss', detail: null, at: '2026-11-17T00:00:00.000Z' });
    assert.deepEqual(again.listStepChanges({ requestId: 'r' }).map(x => [x.from, x.to, x.reason]), [['s1', 's2', 'miss']]);
    assert.equal((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 19);
    again.close();
  } finally { rmrf(dir); }
});

// ------------------------------------------------------------------ Work

test('decision 193: a running request is on top of the Work list, with its files and step-ups so far', () => withWork(async (d, sid) => {
  const r = await get(d, `/router/v1/metrics/work?session_id=${sid}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 0);
  const [row] = r.body.open;
  assert.deepEqual([row.state, row.mine, row.finalLevel, row.passed, row.subtasks, row.stepUps], ['open', true, 'L2', null, 2, 1]);
  assert.deepEqual(row.files.map((f: any) => [f.path, f.added, f.removed]), [['src/a.ts', 2, 1], ['src/b.ts', 3, 0], ['docs/n.md', 1, 0]]);
  assert.equal((await get(d, '/router/v1/metrics/work?session_id=other')).body.open[0].mine, false);
}, { open: true }));

test('decision 193: a closed request moves to the rows; the cursor pages; today counts it', () => withWork(async (d, sid) => {
  const r = await get(d, `/router/v1/metrics/work?session_id=${sid}&limit=1`);
  assert.deepEqual([r.body.open.length, r.body.rows.length, r.body.nextCursor], [0, 1, null]);
  const [row] = r.body.rows;
  assert.deepEqual([row.state, row.passed, row.subtasks, row.stepUps, row.verifyFailures], ['closed', false, 2, 1, 2]);
  assert.deepEqual(r.body.today, { done: 0, failed: 1, usd: 0 });
  assert.equal((await get(d, '/router/v1/metrics/work?before=nonsense')).status, 400);
  assert.equal((await get(d, '/router/v1/metrics/work?limit=abc')).status, 400);
}));

test('decision 193: one request in detail: the plan, each subtask\'s files, checks, step changes, times and cost; no prompt', () => withWork(async (d, sid) => {
  const id = String(rows(d, 'SELECT id FROM requests WHERE session_id = ?', sid)[0]!.id);
  const r = await get(d, `/router/v1/metrics/work/${id}`);
  assert.equal(r.status, 200);
  const v = r.body;
  assert.deepEqual([v.state, v.level.final, v.plan.leadDirect, v.passed], ['closed', 'L2', false, false]);
  const [a, b] = v.subtasks;
  // coder A: what it changed, against its start commit
  assert.deepEqual([a.id, a.role, a.step, a.model, a.effort, a.status], ['A', 'coder', 's3', 'sonnet', 'medium', 'passed']);
  assert.deepEqual(a.files, { list: [
    { path: 'src/a.ts', added: 2, removed: 1, state: 'changed' },
    { path: 'src/b.ts', added: 3, removed: 0, state: 'new' },
  ], total: 2, truncated: false, approximate: false });
  assert.deepEqual(a.scope, ['src/**']);
  assert.deepEqual(a.checks.map((k: any) => [k.kind, k.attempt, k.result, k.testsPassed, k.testsFailed]), [['test', 1, 'ok', 3, 0], ['scope', 1, 'ok', undefined, undefined]]);
  assert.equal(typeof a.checks[0].durationMs, 'number');
  // coder B: two failed stops, then its slot went one step up
  assert.deepEqual([b.id, b.status, b.verdict], ['B', 'failed', 'miss']);
  assert.deepEqual(b.checks.filter((k: any) => k.kind === 'test').map((k: any) => [k.attempt, k.result, k.testsFailed]), [[1, 'failed', 2], [2, 'failed', 2]]);
  assert.deepEqual(b.stepChanges.map((k: any) => [k.subtaskId, k.from, k.to, k.direction, k.reason]), [['B', 's3', 's4', 'up', 'miss']]);
  assert.deepEqual(v.stepChanges, b.stepChanges);
  assert.deepEqual(a.stepChanges, [], 'the raise is listed with the subtask that missed');
  // the request as a whole
  assert.deepEqual(v.files.map((f: any) => f.path).sort(), ['docs/n.md', 'src/a.ts', 'src/b.ts']);
  assert.deepEqual(v.tests, { passed: 4, failed: 2 });
  assert.equal(v.time.phases.reduce((n: number, p: any) => n + p.ms, 0), v.time.durationMs, 'the phases add up to the duration');
  assert.deepEqual(v.time.phases.map((p: any) => p.phase), ['lead', 'workers', 'verify', 'awaiting_user']);
  assert.deepEqual(v.timeline.map((k: any) => k.kind).filter((k: string) => k !== 'verify'), ['plan', 'worker', 'worker']);
  assert.equal(v.timeline.filter((k: any) => k.kind === 'verify').length, 3);
  assert.equal(v.cost.budgetUsd, DEFAULT_PRESETS.L2.budgetUsd);
  // never in a panel answer
  assert.equal('prompt' in v, false);
  assert.equal(v.hasPrompt, false);
  assert.doesNotMatch(JSON.stringify(v), /Refactor the validation|pass\.cjs|fail\.cjs/);
  assert.equal((await get(d, '/router/v1/metrics/work/nope')).status, 404);
  assert.equal((await request(d.port, { path: `/router/v1/metrics/work/${id}` })).status, 401, 'sealed only');
}));

test('decision 193: with recordPrompts on the detail says a prompt is kept, and still does not carry it', () => withWork(async (d, sid) => {
  const id = String(rows(d, 'SELECT id FROM requests WHERE session_id = ?', sid)[0]!.id);
  const v = (await get(d, `/router/v1/metrics/work/${id}`)).body;
  assert.equal(v.hasPrompt, true);
  assert.doesNotMatch(JSON.stringify(v), /Refactor the validation/);
}, { config: { recordPrompts: true } }));

test('decision 193: a request the lead handled itself lists its changed files from the record', async () => {
  const repo = makeRepo({ 'README.md': 'a typo\n', 'src/a.ts': 'one\n' });
  const d = await startTestDaemon();
  const hook = async (h: HookInput) => assert.equal((await postHook(d.port, { session_id: 'direct', cwd: repo, transcript_path: path.join(d.home, 'direct.jsonl'), ...h })).status, 200);
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the typo in README.md' });
    await d.router.drain();
    write(repo, 'README.md', 'the typo\nand a line\n');
    await hook(stop());
    await d.router.drain();
    const [row] = (await get(d, '/router/v1/metrics/work')).body.rows;
    assert.deepEqual([row.outcome, row.subtasks, row.changedFiles, row.passed], ['direct', 0, 1, true]);
    assert.deepEqual(row.files, [{ path: 'README.md', added: 2, removed: 1 }]);
    const v = (await get(d, `/router/v1/metrics/work/${row.requestId}`)).body;
    assert.deepEqual(v.files, [{ path: 'README.md', added: 2, removed: 1, state: 'changed' }]);
    assert.deepEqual([v.subtasks.length, v.plan.leadDirect, v.timeline.map((k: any) => k.kind)], [0, true, ['plan']]);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});

// ------------------------------------------------------------------ Savings

test('decision 193: Savings keeps what was measured apart from the two estimates', () => withWork(async (d, sid) => {
  const id = String(rows(d, 'SELECT id FROM requests WHERE session_id = ?', sid)[0]!.id);
  // the workers' tokens, as a transcript would have given them, and the lead's model
  const at = '2026-11-17T09:00:05.000Z';
  const before = (await get(d, '/router/v1/metrics/savings?period=24h')).body.estimated.leadPriced;
  assert.deepEqual([before.requests, before.leftOut], [0, { noLeadModel: 1, noPrice: 0, noTokens: 0 }], 'delegated, but the model of the lead was never seen');
  d.ledger!.db.prepare('DELETE FROM costs WHERE request_id = ?').run(id);
  d.ledger!.db.prepare(`INSERT INTO costs (request_id, subtask_id, agent_id, source, model_id, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, usd, created_at)
    VALUES (?, 'A', 'ag-a', 'transcript', 'claude-haiku-5-5', 100000, 20000, 0, 400000, 0.024, ?)`).run(id, at);
  d.ledger!.db.prepare(`UPDATE request_records SET record = json_set(record, '$.plan.leadModel', 'claude-sonnet-5-5'), subtask_usd = 0.024, total_usd = 0.124, lead_usd = 0.1 WHERE request_id = ?`).run(id);
  const r = await get(d, '/router/v1/metrics/savings?period=24h');
  assert.equal(r.status, 200);
  const v = r.body;
  assert.deepEqual([v.measured.cost.label, v.measured.cost.requests, v.measured.cost.passed, v.measured.cost.totalUsd, v.measured.cost.costPerPassedUsd], ['api-equivalent', 1, 0, 0.124, null]);
  assert.deepEqual(v.measured.cost.bySource, { proxy: 0, transcript: 1 });
  assert.equal(v.measured.limits, null);
  const t = { input: 100000, output: 20000, cacheRead: 400000, cacheWrite: 0 };
  const lp = v.estimated.leadPriced;
  assert.equal(lp.requests, 1);
  assert.equal(lp.workerUsd, Math.round(listPriceUsd('claude-haiku-5-5', t) * 1e6) / 1e6);
  assert.equal(lp.atLeadPriceUsd, Math.round(listPriceUsd('claude-sonnet-5-5', t) * 1e6) / 1e6);
  assert.equal(lp.differenceUsd, Math.round((lp.atLeadPriceUsd - lp.workerUsd) * 1e6) / 1e6);
  assert.ok(lp.differenceUsd > 0);
  assert.equal(lp.assumptions.length, 4);
  assert.match(lp.assumptions[0], /estimate, not a measurement/);
  assert.deepEqual(v.estimated.holdout, [], 'no holdout request yet: nothing to compare');
  assert.equal(v.series.unit, 'hour');
  const hit = v.series.points.filter((p: any) => p.requests > 0);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].leadPricedDifferenceUsd, lp.differenceUsd);
  assert.ok(v.series.points.length >= 24);
  // a lead model nobody knows the price of: the request is left out and counted
  d.ledger!.db.prepare(`UPDATE request_records SET record = json_set(record, '$.plan.leadModel', 'some-future-model') WHERE request_id = ?`).run(id);
  const again = (await get(d, '/router/v1/metrics/savings?period=7d')).body;
  assert.deepEqual([again.estimated.leadPriced.requests, again.estimated.leadPriced.leftOut.noPrice, again.series.unit], [0, 1, 'day']);
  assert.equal((await get(d, '/router/v1/metrics/savings?period=1y')).status, 400);
}));

// ------------------------------------------------------------------ Team

test('decision 193: Team gives each role its steps per level with their source, its results and the step changes', () => withWork(async (d, sid) => {
  const v = (await get(d, `/router/v1/metrics/team?period=7d&session_id=${sid}`)).body;
  assert.deepEqual(v.profile, { value: 'balanced', source: 'default' });
  const coder = v.roles.find((r: any) => r.role === 'coder');
  // decision 226: one entry per level x difficulty; the coder's cell comes from the difficulty table (same at every level)
  assert.deepEqual(coder.levels, [
    { level: 'L1', difficulty: 'routine', count: 1, step: 's1', model: 'haiku', effort: 'low', estimated: false, source: 'default' },
    { level: 'L1', difficulty: 'moderate', count: 1, step: 's3', model: 'sonnet', effort: 'medium', estimated: false, source: 'default' },
    { level: 'L1', difficulty: 'hard', count: 1, step: 's5', model: 'opus', effort: 'high', estimated: false, source: 'default' },
    { level: 'L2', difficulty: 'routine', count: 2, step: 's1', model: 'haiku', effort: 'low', estimated: false, source: 'default' },
    { level: 'L2', difficulty: 'moderate', count: 2, step: 's3', model: 'sonnet', effort: 'medium', estimated: false, source: 'default' },
    { level: 'L2', difficulty: 'hard', count: 2, step: 's5', model: 'opus', effort: 'high', estimated: false, source: 'default' },
    { level: 'L3', difficulty: 'routine', count: 2, step: 's1', model: 'haiku', effort: 'low', estimated: false, source: 'default' },
    { level: 'L3', difficulty: 'moderate', count: 2, step: 's3', model: 'sonnet', effort: 'medium', estimated: false, source: 'default' },
    { level: 'L3', difficulty: 'hard', count: 2, step: 's5', model: 'opus', effort: 'high', estimated: false, source: 'default' },
  ]);
  assert.deepEqual([coder.stats.subtasks, coder.stats.passed, coder.stats.failed, coder.stats.passRate, coder.stats.stepUps, coder.stats.stepDowns], [2, 1, 1, 0.5, 1, 0]);
  assert.equal(typeof coder.stats.avgRunMs, 'number');
  assert.deepEqual(v.stepChanges.map((k: any) => [k.role, k.from, k.to, k.reason]), [['coder', 's3', 's4', 'miss']]);
  assert.equal(v.triage.overall.total, 1);
  assert.equal(Array.isArray(v.routing.classes), true);
}));

// ------------------------------------------------------------------ the profile

test('decision 194: balanced is the defaults; save and quality move teams, budgets, the start of delegation and step-down', () => {
  assert.deepEqual(profilePresets('balanced'), DEFAULT_PRESETS);
  const save = profilePresets('save'), quality = profilePresets('quality');
  assert.deepEqual(save.L2.roles.map(r => `${r.role}x${r.count}@${r.start}`), ['coderx2@s1', 'testerx1@s1']);
  assert.deepEqual([save.L0.budgetUsd, save.L1.budgetUsd, save.L2.budgetUsd, save.L3.budgetUsd], [0.3, 1.2, 3, 9]);
  assert.deepEqual(quality.L2.roles.map(r => `${r.role}x${r.count}@${r.start}`), ['architectx1@s4', 'coderx2@s2', 'reviewerx1@s4', 'testerx1@s2']);
  assert.deepEqual([quality.L1.budgetUsd, quality.L2.budgetUsd, quality.L3.budgetUsd], [3, 7.5, 22.5]);
  assert.deepEqual(withProfile({ profile: 'quality' }), { profile: 'quality', delegateFrom: { opus: 'L2', sonnet: 'L2', haiku: 'L2', other: 'L2' }, stepDown: 'off' });
  // the user's own value stays
  assert.deepEqual(withProfile({ profile: 'quality', stepDown: 'on' as const, delegateFrom: { sonnet: 'L1' as const } }),
    { profile: 'quality', stepDown: 'on', delegateFrom: { opus: 'L2', sonnet: 'L1', haiku: 'L2', other: 'L2' } });
  assert.deepEqual(withProfile({}), {});
  assert.equal(PROFILE_LAYERS.balanced.budgetFactor, 1);
});

test('decision 194: the daemon runs on the profile: a quality profile keeps L1 with a Sonnet lead, and a request gets the profile\'s budget', async () => {
  const dir = tmpDir('ar-prof-');
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemonPort: 0, profile: 'quality' }));
    const cfg = readConfig(path.join(dir, 'config.json'));
    assert.deepEqual([cfg.profile, cfg.stepDown, cfg.delegateFrom?.sonnet], ['quality', 'off', 'L2']);
    const warnings: string[] = [];
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ daemonPort: 0, profile: 'fast' }));
    assert.equal(readConfig(path.join(dir, 'config.json'), warnings).profile, undefined);
    assert.match(warnings.join('\n'), /config\.profile ignored/);
  } finally { rmrf(dir); }
  const repo = makeRepo();
  const d = await startTestDaemon({ config: { profile: 'save' } });
  try {
    const r = await postHook(d.port, { session_id: 'p1', cwd: repo, transcript_path: path.join(d.home, 'p1.jsonl'), hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    assert.equal(r.status, 200);
    const [req] = rows(d, 'SELECT level, budget_usd, team FROM requests');
    assert.deepEqual([req!.level, req!.budget_usd], ['L2', 3]);
    assert.deepEqual((JSON.parse(String(req!.team)) as { roles: Array<{ role: string }> }).roles.map(x => x.role), ['coder', 'tester']);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});

test('decision 194: team changes by path land in teams.yaml; a value back at the profile\'s leaves the file', () => {
  const base = profilePresets('balanced');
  const one = applyTeamPaths('', base, { 'team.L2.coder.start': 's2' });
  assert.match(one, /L2:\n\s+roles:/);
  assert.match(one, /role: coder\n\s+count: 2\n\s+start: s2/);
  assert.equal(applyTeamPaths(one, base, { 'team.L2.coder.start': null }), '', 'back to the base: nothing of its own is left');
  assert.equal(applyTeamPaths(one, base, { 'team.L2.coder.start': 's1' }), '');
  // a role the level does not have is added; a count of 0 takes one out
  const two = applyTeamPaths('L1:\n  budget_usd: 3\n', base, { 'team.L1.reviewer.count': 1, 'team.L3.ui-designer.count': 0 });
  assert.match(two, /budget_usd: 3/);
  assert.match(two, /role: reviewer\n\s+count: 1\n\s+start: s1/);
  assert.match(two, /role: ui-designer\n\s+count: 0/);
  const errors = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { errors: Array<{ path: string }> }).errors.map(x => x.path); } return []; };
  assert.deepEqual(errors(() => applyTeamPaths('', base, { 'team.L0.coder.count': 2, 'team.L2.boss.count': 1, 'team.L2.coder.start': 's9', 'team.L2.coder.count': 9, 'team.L2': 1 })),
    ['team.L0.coder.count', 'team.L2.boss.count', 'team.L2.coder.start', 'team.L2.coder.count', 'team.L2']);
  assert.deepEqual(errors(() => applyTeamPaths('', base, { 'team.L1.coder.count': 0 })), ['team.L1'], 'a team needs a member');
});

// ------------------------------------------------------------------ Settings

test('decision 194: the Settings view: each item with its value and source, drawable with buttons', () => withWork(async (d, sid) => {
  assert.equal((await request(d.port, { path: '/router/v1/office/settings' })).status, 401, 'sealed only');
  const v = (await get(d, `/router/v1/office/settings?session_id=${sid}`)).body;
  assert.deepEqual([v.profile.value, v.profile.source, v.profile.options.map((o: any) => o.id)], ['save', 'own', ['save', 'balanced', 'quality']]);
  assert.deepEqual(v.profile.options.map((o: any) => o.measured === null), [true, false, true], 'only balanced rests on a measurement');
  const item = (p: string) => v.items.find((i: any) => i.path === p);
  assert.deepEqual([item('profile').value, item('profile').source, item('profile').group], ['save', 'own', 'profile']);
  // a budget the profile gives, with how; one the user set
  assert.deepEqual([item('budgetsUsd.L2').value, item('budgetsUsd.L2').source, item('budgetsUsd.L2').sourceNote, item('budgetsUsd.L2').default], [3, 'profile', 'profile x 0.6', 5]);
  assert.deepEqual([item('budgetsUsd.L3').value, item('budgetsUsd.L3').source, item('budgetsUsd.L3').profileValue], [12, 'own', 9]);
  // the profile's team: no reviewer at L2
  assert.deepEqual([item('team.L2.reviewer.count').value, item('team.L2.reviewer.count').source, item('team.L2.reviewer.count').default], [0, 'profile', 1]);
  assert.equal(item('team.L2.reviewer.start'), undefined, 'a role that is not in the team has no start step to pick');
  assert.deepEqual([item('team.L3.coder.start').value, item('team.L3.coder.start').source, item('team.L3.coder.start').optionLabels.s3], ['s3', 'profile', 'sonnet medium']);
  assert.deepEqual([item('reproduceFirst').value, item('reproduceFirst').source, item('reproduceFirst').options], ['off', 'default', ['on', 'observe', 'off']]);
  assert.deepEqual([item('autoStart').value, item('officeAutoOpen').value, item('holdoutRate').group], ['on', 'on', 'advanced']);
  for (const i of v.items) {
    assert.ok(i.type === 'boolean' || i.options || i.choices || (typeof i.min === 'number' && typeof i.max === 'number'), `${i.path} can be drawn with buttons`);
  }
  assert.deepEqual(v.team.find((t: any) => t.level === 'L2').roles.map((r: any) => r.role), ['coder', 'tester']);
  assert.ok(v.text.some((t: any) => t.key === 'verify') && v.text.some((t: any) => t.key === 'teams.yaml' && t.command === 'do-it-all-claude-code preset edit'));
  assert.ok(v.managed.some((m: any) => m.key === 'daemonPort'));
  assert.doesNotMatch(JSON.stringify(v), new RegExp(d.home.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'no machine path');
}, { config: { profile: 'save', budgetsUsd: { L3: 12 } } }));

test('decision 194: the Settings write: checked as the CLI\'s is, in the same history as source "office", with a revision', () => withWork(async (d) => {
  const view = (await get(d, '/router/v1/office/settings')).body;
  // config keys and team paths in one call
  const ok = await post(d, '/router/v1/office/settings', { revision: view.revision, set: { profile: 'quality', reproduceFirst: 'observe', 'budgetsUsd.L1': 4, 'team.L2.coder.start': 's3' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.changed.sort(), ['budgetsUsd.L1', 'profile', 'reproduceFirst', 'team.L2.coder.start']);
  assert.notDeepEqual(ok.body.revision, view.revision);
  const cfg = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  assert.deepEqual([cfg.profile, cfg.reproduceFirst, cfg.budgetsUsd.L1], ['quality', 'observe', 4]);
  assert.match(fs.readFileSync(path.join(d.home, 'teams.yaml'), 'utf8'), /role: coder\n\s+count: 2\n\s+start: s3/);
  assert.deepEqual([d.router.config.profile, d.router.config.stepDown, d.router.config.reproduceFirst], ['quality', 'off', 'observe'], 'the router runs on it at once');
  const log = readAudit(d.home);
  assert.deepEqual(log.map(e => [e.source, e.kind]).sort(), [['office', 'config'], ['office', 'presets']]);
  const now = (await get(d, '/router/v1/office/settings')).body;
  const item = (p: string) => now.items.find((i: any) => i.path === p);
  assert.deepEqual([item('team.L2.coder.start').value, item('team.L2.coder.start').source, item('team.L2.coder.start').profileValue], ['s3', 'own', 's2']);
  assert.deepEqual([item('stepDown').value, item('stepDown').source], ['off', 'profile']);
  // a stale revision: nothing is written
  const stale = await post(d, '/router/v1/office/settings', { revision: view.revision, set: { reproduceFirst: 'on' } });
  assert.deepEqual([stale.status, stale.body.errors[0].path], [409, 'revision']);
  // every problem at once, from both parts, and nothing written
  const bad = await post(d, '/router/v1/office/settings', { revision: now.revision, set: { profile: 'fast', daemonPort: 1, 'team.L2.coder.start': 's9', updateCheck: 'on' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.errors.map((e: any) => e.path).sort(), ['daemonPort', 'profile', 'team.L2.coder.start']);
  assert.match(bad.body.errors.find((e: any) => e.path === 'daemonPort').message, /set by init/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8')).updateCheck, undefined);
  // null takes an own value away
  const back = await post(d, '/router/v1/office/settings', { set: { 'team.L2.coder.start': null, 'budgetsUsd.L1': null } });
  assert.equal(back.status, 200);
  assert.equal(fs.existsSync(path.join(d.home, 'teams.yaml')), false, 'nothing of its own is left in teams.yaml');
  assert.equal((await post(d, '/router/v1/office/settings', { set: {} })).status, 400);
}));
