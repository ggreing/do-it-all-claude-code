// Decision 221: a session of several requests (scripts/measure-session.ts). The scenario's own check, the figures
// read from a step's stream, the grading of a step in a copy, and a whole session with a fake claude
// (bench/test/kpi-fake-claude.mjs) that copies a step's oracle where a real session would edit. Nothing here
// starts the real Claude Code or touches the network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamLine } from '../src/kpi/phases.ts';
import { claudeArgs } from '../src/kpi/run-args.ts';
import { freePort, noPluginCalls, safeEnv } from './kpi-safe-env.ts';
import { gradeStep, leadContext, loadScenario, sessionCost, sessionIdSeen, snapshot, snapshotDiff, stepCost, stepStatus } from '../src/kpi/session.ts';

const BENCH = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(BENCH, '..');
let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sess-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const L = (m: Record<string, unknown>): StreamLine => ({ t: 0, m });
const usage = (input: number, read: number, write: number, output = 1) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output });
const said = (id: string, model: string, u: ReturnType<typeof usage>, parent: string | null = null) => L({ type: 'assistant', parent_tool_use_id: parent, message: { id, model, usage: u, content: [] } });

test('the scenario: six steps on one fixture, and its oracles and hidden tests hold together', () => {
  const s = loadScenario('taskboard-01')!;
  assert.deepEqual(s.steps.map(x => [x.id, x.kind, x.level]), [['01', 'feature', 'L1'], ['02', 'fix', 'L1'], ['03', 'feature', 'L2'], ['04', 'extension', 'L1'], ['05', 'extension', 'L2'], ['06', 'refactor', 'L2']]);
  assert.equal(loadScenario('no-such-scenario'), null);
  assert.equal(loadScenario('../custom'), null);
  // each oracle passes the tests of its step and of every step before it; the state before a step fails that step's tests
  const r = spawnSync(process.execPath, [path.join(BENCH, 'tasks', 'sessions', '_validate.mjs')], { encoding: 'utf8', timeout: 280_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /step 06 L2 refactor +after: pass \d+ fail 0 +before: own pass \d+, hidden fail [1-9]/);
});

test('the lead\'s context and a step\'s cost, from the step\'s stream', () => {
  const lines = [
    L({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    // one message, printed once per content block with the same id and usage
    said('m1', 'claude-sonnet-5-5', usage(2, 10_000, 5_000)), said('m1', 'claude-sonnet-5-5', usage(2, 10_000, 5_000)),
    said('w1', 'claude-haiku-5-5', usage(4, 6_000, 2_000), 'toolu_agent'),
    said('m2', 'claude-sonnet-5-5', usage(2, 15_000, 1_000)),
    L({ type: 'system', subtype: 'compact_boundary' }),
    said('m3', 'claude-sonnet-5-5', usage(2, 4_000, 3_000)),
    said('s', '<synthetic>', usage(0, 0, 0)),
  ];
  assert.deepEqual(leadContext(lines), { calls: 3, firstTokens: 15_002, lastTokens: 7_002, maxTokens: 16_002, firstCacheReadTokens: 10_000,
    cacheReadTokens: 29_000, cacheWriteTokens: 9_000, inputTokens: 6, compactions: 1 });
  assert.equal(sessionIdSeen(lines), 'sess-1');
  assert.deepEqual(leadContext([]), { calls: 0, firstTokens: null, lastTokens: null, maxTokens: null, firstCacheReadTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, compactions: 0 });
  // the stream's input side at list price (Sonnet: $2/M in, cache write 1.25x, cache read 0.05x; Haiku: $0.10/M, read 0.1x); output is not in it
  const c = stepCost(lines, { total_cost_usd: 0.5, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.4 }, 'claude-haiku-5-5': { costUSD: 0.1 } } });
  const sonnet = (6 * 2 + 9_000 * 1.25 * 2 + 29_000 * 0.05 * 2) / 1e6;
  const haiku = (4 * 0.1 + 2_000 * 1.25 * 0.1 + 6_000 * 0.1 * 0.1) / 1e6;
  assert.deepEqual([c.costUsd, c.usageCostUsd, c.unpricedMessages], [0.5, 0.5, 0]);
  assert.ok(Math.abs(c.streamInputLeadUsd - sonnet) < 2e-6 && Math.abs(c.streamInputWorkersUsd - haiku) < 2e-6, JSON.stringify(c));
  assert.ok(Math.abs(c.streamInputUsd - (sonnet + haiku)) < 3e-6);
  // a model without a price is counted, not guessed; no result line, no totals
  const odd = stepCost([said('x', 'some-other-model', usage(1, 1, 1))], null);
  assert.deepEqual([odd.costUsd, odd.usageCostUsd, odd.streamInputUsd, odd.unpricedMessages], [0, null, 0, 1]);
});

test('whether step totals are each process\'s own: a total below the one before settles it', () => {
  assert.deepEqual(sessionCost([0.2, 0.05, 0.3]), { reading: 'per-step', sumUsd: 0.55, lastUsd: 0.3 });
  assert.deepEqual(sessionCost([0.2, 0.25, 0.6]), { reading: 'undecided', sumUsd: 1.05, lastUsd: 0.6 });
  assert.deepEqual(sessionCost([0.2]), { reading: 'per-step', sumUsd: 0.2, lastUsd: 0.2 });
  assert.deepEqual([0, 1, 2, 3].map(i => stepStatus([true, false, false, true], i)), ['pass', 'failed', 'failed_after_failure', 'pass']);
});

test('a session step\'s command line: the first step names the session, the later ones resume it', () => {
  const base = { lead: 'sonnet', effort: 'high', capUsd: 2, settings: '{}', agentTool: true, strictMcp: true };
  const first = claudeArgs({ ...base, session: { id: 'abc', resume: false } });
  const later = claudeArgs({ ...base, session: { id: 'abc', resume: true } });
  assert.deepEqual([first.slice(-2), later.slice(-2)], [['--session-id', 'abc'], ['--resume', 'abc']]);
  assert.ok(!first.includes('--resume') && !later.includes('--session-id'));
  // a single-request run has neither, and is otherwise the same command line
  assert.deepEqual(claudeArgs(base), first.slice(0, -2));
});

test('a step is graded in a copy: its own tests, the earlier steps\' tests, and what changed', async () => {
  const s = loadScenario('taskboard-01')!;
  const fixture = path.join(BENCH, 'fixtures', 'taskboard');
  const oracle = (id: string) => path.join(s.dir, 'steps', id, 'oracle');
  // a working tree after step 02, with harness and git folders the copy must leave out
  const repo = path.join(tmp, 'repo');
  fs.cpSync(fixture, repo, { recursive: true });
  fs.cpSync(oracle('02'), repo, { recursive: true, force: true });
  for (const d of ['.git', '.claude', '.bench-hidden']) { fs.mkdirSync(path.join(repo, d)); fs.writeFileSync(path.join(repo, d, 'x'), 'x'); }
  const snap2 = path.join(tmp, 'grade', 'step-02');
  snapshot(repo, snap2);
  assert.deepEqual(['.git', '.claude', '.bench-hidden'].map(d => fs.existsSync(path.join(snap2, d))), [false, false, false]);
  const ok = await gradeStep(s, 1, snap2);
  assert.deepEqual([ok.pass, ok.own.ok, ok.regressions, ok.fixtureFail], [true, true, [], false]);
  assert.ok(!fs.existsSync(path.join(repo, '.bench-hidden', 'due-dates.test.ts')), 'the session\'s repository gets no hidden test');
  // the same state graded as step 03: that step was not done, the earlier ones still hold
  const notDone = await gradeStep(s, 2, snap2);
  assert.deepEqual([notDone.pass, notDone.own.ok, notDone.regressions], [false, false, []]);
  assert.match(notDone.detail, /own pass=\d+ fail=[1-9]/);
  // step 02 undone (the fixture's transitions bug is back) while step 03 is in place: a regression in 02
  const snap3 = path.join(tmp, 'grade', 'step-03');
  fs.cpSync(fixture, snap3, { recursive: true });
  fs.cpSync(oracle('03'), snap3, { recursive: true, force: true });
  const service = path.join(snap3, 'src', 'service', 'taskService.ts');
  const text = fs.readFileSync(service, 'utf8');
  assert.ok(text.includes('canTransition(task.status, status)'));
  fs.writeFileSync(service, text.replace('canTransition(task.status, status)', 'canTransition(status, task.status)'));
  const regressed = await gradeStep(s, 2, snap3);
  assert.equal(regressed.pass, false);
  assert.ok(regressed.regressions.includes('02'), regressed.detail);
  // what a step changed, between two copies
  const before = path.join(tmp, 'grade', 'step-00');
  snapshot(fixture, before);
  const diff = await snapshotDiff(before, snap2);
  assert.equal(diff.changedFiles, 3);
  assert.ok(diff.linesAdded > 20 && diff.linesRemoved > 0, JSON.stringify(diff));
});

/** The fake's lines for one step: an init line in the session it was given, one lead call, a result. */
const call = (copy: string | undefined, costUsd: number, contextTokens: number) => [
  { line: { type: 'system', subtype: 'init', session_id: '{{session}}', mcp_servers: [], tools: ['Read', 'Edit'] } },
  { ...(copy ? { copy } : {}), line: { type: 'assistant', parent_tool_use_id: null, message: { id: `m-${contextTokens}`, model: 'claude-sonnet-5-5', usage: usage(2, contextTokens, 500), content: [] } } },
  { line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: costUsd, num_turns: 3, session_id: '{{session}}', modelUsage: { 'claude-sonnet-5-5': { costUSD: costUsd } } } },
];

function fakeClaude(name: string, calls: unknown): { fake: string; callsFile: string } {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  const fake = path.join(dir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ calls }));
  return { fake, callsFile: path.join(dir, 'calls.jsonl') };
}
const script = path.join(ROOT, 'scripts', 'measure-session.ts');
const readJsonl = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>) : []);   // eslint-disable-line @typescript-eslint/no-explicit-any

test('measure-session with a fake claude: six steps in one session, graded step by step, a failure and what follows it kept apart', () => {
  const s = loadScenario('taskboard-01')!;
  const oracle = (id: string) => path.join(s.dir, 'steps', id, 'oracle');
  // steps 03 and 04 change nothing (03 fails first, 04 fails after it); step 05's edits bring the session back
  const { fake, callsFile } = fakeClaude('fake', [call(oracle('01'), 0.2, 12_000), call(oracle('02'), 0.05, 20_000), call(undefined, 0.3, 26_000),
    call(undefined, 0.1, 31_000), call(oracle('05'), 0.4, 40_000), call(oracle('06'), 0.25, 47_000)]);
  const out = path.join(tmp, 'out');
  const work = path.join(tmp, 'work');
  const r = spawnSync(process.execPath, [script, '--api-key-helper', 'not-a-real-helper', '--arrangements', 'direct', '--reps', '1', '--lead', 'sonnet', '--out', out, '--work', work],
    { encoding: 'utf8', timeout: 280_000, env: safeEnv(tmp, 'direct', { BENCH_CLAUDE_BIN: fake }).env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // one process per step, in one session: the first names the id, the others resume it; each gets its step's prompt
  const calls = readJsonl(callsFile) as Array<{ args: string[]; cwd: string; anthropicModel: string | null; prompt: string }>;
  assert.equal(calls.length, 6);
  const id = calls[0]!.args[calls[0]!.args.indexOf('--session-id') + 1]!;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  for (const c of calls.slice(1)) assert.deepEqual([c.args.includes('--session-id'), c.args[c.args.indexOf('--resume') + 1]], [false, id]);
  assert.deepEqual(calls.map(c => c.prompt.slice(0, 12)), s.steps.map(x => x.prompt.slice(0, 12)));
  assert.deepEqual([...new Set(calls.map(c => c.cwd))].length, 1, 'every step runs in the same repository');
  assert.deepEqual([...new Set(calls.map(c => c.anthropicModel))], ['sonnet']);
  for (const c of calls) { assert.ok(c.args.includes('--strict-mcp-config') && !c.args.includes('--plugin-dir')); assert.ok(c.args.includes('Bash(wc *)')); }
  // the record: one per session, a step each
  const [rec] = readJsonl(path.join(out, 'sessions.jsonl'));
  assert.deepEqual([rec!.scenario, rec!.arrangement, rec!.rep, rec!.sessionId, rec!.agentTool, rec!.steps.length], ['taskboard-01', 'direct', 1, id, true, 6]);
  const steps = rec!.steps as Array<Record<string, any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(steps.map(x => x.status), ['pass', 'pass', 'failed', 'failed_after_failure', 'pass', 'pass']);
  assert.deepEqual(steps.map(x => x.ownPassed), [true, true, false, false, true, true]);
  // step 04 has nothing of its own, and step 03's tests still fail under it: both are on record
  assert.deepEqual([steps[3]!.regressions, steps[2]!.regressions, steps[4]!.regressions], [['03'], [], []]);
  assert.deepEqual(steps.map(x => x.resumed), [false, true, true, true, true, true]);
  assert.deepEqual(steps.map(x => x.costUsd), [0.2, 0.05, 0.3, 0.1, 0.4, 0.25]);
  assert.deepEqual(steps.map(x => x.context.lastTokens), [12_502, 20_502, 26_502, 31_502, 40_502, 47_502]);
  assert.deepEqual(steps.map(x => x.changedFiles > 0), [true, true, false, false, true, true]);
  assert.ok(steps.every(x => x.streamInputUsd > 0 && x.usageCostUsd === x.costUsd && x.leadTurns === 3 && x.phases));
  assert.deepEqual(rec!.totals, {
    costUsd: 1.3, costReading: 'per-step', sumOfStepTotalsUsd: 1.3, lastStepTotalUsd: 0.25, streamInputUsd: rec!.totals.streamInputUsd, wallSeconds: rec!.totals.wallSeconds,
    stepsPassed: 4, steps: 6, firstFailedStep: '03', failedAfterFailure: ['04'], finalAllPass: true,
    leadContextFirstStep: 12_502, leadContextLastStep: 47_502, leadContextMax: 47_502, leadCacheReadTokens: 176_000, compactions: 0,
  });
  assert.match(r.stdout, /4\/6 steps pass \(first failure: step 03\), final state passes/);
  // the session's repository holds no hidden test and no commit of the harness; the graded copies are beside it
  const repo = calls[0]!.cwd;
  assert.ok(!fs.existsSync(path.join(repo, '.bench-hidden')));
  assert.equal(spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
  assert.ok(fs.existsSync(path.join(path.dirname(repo), 'grade', 'step-06', '.bench-hidden', 'task-queries.test.ts')));
  // the ledger has every step's cost; a second run finds the session done
  assert.equal(readJsonl(path.join(out, 'ledger.jsonl')).length, 6);
  assert.equal(fs.readdirSync(path.join(out, 'streams')).length, 6);
  const again = spawnSync(process.execPath, [script, '--only-plan', '--arrangements', 'direct', '--reps', '2', '--out', out, '--work', work], { encoding: 'utf8', timeout: 60_000 });
  assert.match(again.stdout, /session direct rep 1 .*\(done\)/);
  assert.doesNotMatch(again.stdout, /session direct rep 2 .*\(done\)/);
});

test('measure-session router session: the plugin and its MCP server on every step, one daemon for the session, the profile on record', () => {
  const s = loadScenario('taskboard-01')!;
  const router = { mcp_servers: [{ name: 'plugin:do-it-all-claude-code:router', status: 'connected' }], tools: ['Read', 'mcp__plugin_do-it-all-claude-code_router__router_report_triage'] };
  const calls = s.steps.map((x, i) => call(path.join(s.dir, 'steps', x.id, 'oracle'), 0.1 + (i % 2) * 0.1, 10_000 + i * 2_000)
    .map((l, n) => (n === 0 ? { line: { ...l.line, ...router } } : l)));
  const { fake, callsFile } = fakeClaude('fake-auto', calls);
  const out = path.join(tmp, 'out-auto');
  const safe = safeEnv(tmp, 'auto', { BENCH_CLAUDE_BIN: fake });
  const port = freePort();   // a port of this test's own: other test files start daemons at the same time
  const r = spawnSync(process.execPath, [script, '--api-key-helper', 'not-a-real-helper', '--arrangements', 'auto', '--reps', '1', '--profile', 'save', '--daemon-port', String(port), '--out', out, '--work', path.join(tmp, 'work-auto')],
    { encoding: 'utf8', timeout: 280_000, env: safe.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The user's Claude Code is never touched: init registers no plugin, and the router's CLI runs with a config
  // folder of this session's workspace.
  assert.equal(noPluginCalls(safe.calls()), undefined);
  assert.ok(safe.calls().length > 0, 'the recording claude on the PATH was reached (init asks for the version)');
  for (const c of safe.calls()) assert.equal(path.normalize(c.configDir), path.join(tmp, 'work-auto', 'taskboard-01-auto-r1', 'claude-init'), `claude ${c.args}`);
  assert.match(r.stdout, /router MCP server: \d+ tools, the daemon answered/);
  assert.equal(r.stdout.match(/router MCP server: /g)!.length, 1, 'the daemon is started once for the session');
  const made = readJsonl(callsFile) as Array<{ args: string[] }>;
  assert.equal(made.length, 6);
  for (const c of made) assert.ok(c.args.includes('--plugin-dir') && !c.args.includes('--strict-mcp-config') && c.args.includes('Read,Edit,Write,Glob,Grep,Bash,Agent'));
  const [rec] = readJsonl(path.join(out, 'sessions.jsonl'));
  assert.deepEqual([rec!.arrangement, rec!.routerMcp, rec!.profile, rec!.agentTool, rec!.mcp.routerTools], ['auto', true, 'save', undefined, 1]);
  assert.deepEqual([rec!.totals.stepsPassed, rec!.totals.firstFailedStep, rec!.totals.finalAllPass, rec!.totals.costReading], [6, null, true, 'per-step']);
  // the fake runs no hook, so the daemon saw no request: the step says so instead of leaving the field out
  assert.deepEqual(rec!.steps[0].router, { requests: [], costLeadUsd: 0, costWorkersUsd: 0 });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'work-auto', 'taskboard-01-auto-r1', 'router-home', 'config.json'), 'utf8')) as { profile?: string; holdoutRate?: number; daemonPort?: number };
  assert.deepEqual([cfg.profile, cfg.holdoutRate, cfg.daemonPort], ['save', 0, port]);
});

test('measure-session: a step that ran in another session stops the measurement and leaves no record; the plan and its options', () => {
  const wrong = [
    { line: { type: 'system', subtype: 'init', session_id: 'some-other-session', mcp_servers: [], tools: [] } },
    { line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, num_turns: 1 } },
  ];
  const { fake } = fakeClaude('fake-wrong', [wrong]);
  const out = path.join(tmp, 'out-wrong');
  const r = spawnSync(process.execPath, [script, '--api-key-helper', 'not-a-real-helper', '--arrangements', 'direct', '--reps', '1', '--out', out, '--work', path.join(tmp, 'work-wrong')],
    { encoding: 'utf8', timeout: 120_000, env: safeEnv(tmp, 'wrong', { BENCH_CLAUDE_BIN: fake }).env });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /stopped after taskboard-01\|direct\|1\|01 \(\$0\.020 spent on it\): the step ran in session some-other-session, not in [0-9a-f-]+: it did not start the session/);
  assert.deepEqual(readJsonl(path.join(out, 'sessions.jsonl')), []);
  assert.equal(readJsonl(path.join(out, 'ledger.jsonl')).length, 1);

  const plan = (...extra: string[]) => spawnSync(process.execPath, [script, '--only-plan', '--out', path.join(tmp, 'out-plan'), '--work', path.join(tmp, 'work-plan'), ...extra], { encoding: 'utf8', timeout: 60_000 });
  const dflt = plan();
  assert.equal(dflt.status, 0, dflt.stdout + dflt.stderr);
  assert.match(dflt.stdout, /plan: scenario taskboard-01 \(6 steps in one session\), 6 sessions, lead sonnet\/high/);
  assert.match(dflt.stdout, /router sessions with the router's MCP server, profile balanced \(the router's default\)/);
  assert.match(dflt.stdout, /direct sessions with the Agent tool/);
  assert.match(dflt.stdout, /every step may also use Bash\(echo \*\), Bash\(pwd\), Bash\(wc \*\) without a prompt \(decision 222\)/);
  assert.match(dflt.stdout, /step 03 L2 feature +cap \$5/);
  assert.match(dflt.stdout, /session auto +rep 3 +caps add up to \$21/);
  assert.match(plan('--reps', '1', '--arrangements', 'auto', '--profile', 'quality', '--lead', 'claude-opus-5-5').stdout, /1 sessions, lead claude-opus-5-5\/high[\s\S]*profile quality$/m);
  for (const bad of [['--reps', '0'], ['--reps', 'many'], ['--scenario', 'nope'], ['--arrangements', 'team-L2'], ['--profile', 'fast'], ['--daemon-port', '80'], ['--daemon-port', 'free']]) assert.equal(plan(...bad).status, 2, bad.join(' '));
});
