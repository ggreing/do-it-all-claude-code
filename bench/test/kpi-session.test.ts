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
import { recompute } from '../src/kpi/session-recompute.ts';
import { gradeStep, leadContext, leadTurns, loadScenario, reported, sessionCost, sessionIdSeen, snapshot, snapshotDiff, stepCost, stepStatus, streamFileOf, type Reported } from '../src/kpi/session.ts';

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
  const c = stepCost(lines, reported(lines, { total_cost_usd: 0.5, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.4 }, 'claude-haiku-5-5': { costUSD: 0.1 } } }));
  const sonnet = (6 * 2 + 9_000 * 1.25 * 2 + 29_000 * 0.05 * 2) / 1e6;
  const haiku = (4 * 0.1 + 2_000 * 1.25 * 0.1 + 6_000 * 0.1 * 0.1) / 1e6;
  assert.deepEqual([c.costUsd, c.costBasis, c.reportedTotalUsd, c.usageCostUsd, c.sinceLastResultUsd, c.unpricedMessages], [0.5, 'first', 0.5, 0.5, null, 0]);
  assert.ok(Math.abs(c.streamInputLeadUsd - sonnet) < 2e-6 && Math.abs(c.streamInputWorkersUsd - haiku) < 2e-6, JSON.stringify(c));
  assert.ok(Math.abs(c.streamInputUsd - (sonnet + haiku)) < 3e-6);
  // a model without a price is counted, not guessed; no result line, no cost known
  const lone = [said('x', 'some-other-model', usage(1, 1, 1))];
  const odd = stepCost(lone, reported(lone, null));
  assert.deepEqual([odd.costUsd, odd.costBasis, odd.usage, odd.usageCostUsd, odd.streamInputUsd, odd.unpricedMessages], [0, 'none', null, null, 0, 1]);
});

/** A result line as a resumed process writes it: the session's running total and per-model usage, and what the process counted itself. */
const tokens = (input: number, output: number, read: number, write: number, costUSD: number) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD });
const resultLine = (totalUsd: number, modelUsage: Record<string, unknown> | undefined, since?: Record<string, unknown>, turns = 1) =>
  L({ type: 'result', subtype: 'success', total_cost_usd: totalUsd, num_turns: turns, ...(modelUsage ? { modelUsage } : {}), ...(since ? { model_usage_since_last_result: since } : {}) });

/** The steps' costs for the totals their processes reported one after the other, as the measurement keeps them. */
function chain(steps: Array<{ lines: StreamLine[] }>): ReturnType<typeof stepCost>[] {
  let before: Reported | null = null;
  return steps.map(({ lines }) => {
    const now = reported(lines, [...lines].reverse().find(l => l.m.type === 'result')?.m ?? null);
    const cost = stepCost(lines, now, before);
    if (cost.costBasis !== 'none') before = now;
    return cost;
  });
}

test('a resumed step reports the session\'s running total: its cost is the difference from the step before, and the session cost the last total', () => {
  // totals 0.1, 0.25, 0.3 over three steps: the steps cost 0.1, 0.15 and 0.05, and the budget is charged 0.3
  const three = chain([0.1, 0.25, 0.3].map(t => ({ lines: [resultLine(t, undefined)] })));
  assert.deepEqual(three.map(c => [c.costUsd, c.costBasis, c.reportedTotalUsd]), [[0.1, 'first', 0.1], [0.15, 'difference', 0.25], [0.05, 'difference', 0.3]]);
  const session = sessionCost(three);
  assert.deepEqual([session.costUsd, session.costReading, session.lastReportedTotalUsd, session.sinceLastResultUsd], [0.3, 'running-total', 0.3, null]);
  assert.equal(Math.round(three.reduce((a, c) => a + c.costUsd, 0) * 1e6) / 1e6, 0.3, 'what the ledger adds up to');

  // the per-model tokens are differences too; a model with nothing in the step is left out. A process that was
  // woken by its background workers writes several result lines: its own count is their sum, its turns likewise
  const s = 'claude-sonnet-5-5', h = 'claude-haiku-5-5';
  const one = [resultLine(0.11, { [s]: tokens(18, 2_900, 151_000, 24_000, 0.1), [h]: tokens(24, 8_700, 215_000, 27_000, 0.01) }, { [s]: tokens(18, 2_900, 151_000, 24_000, 0.1), [h]: tokens(24, 8_700, 215_000, 27_000, 0.01) }, 9),
    resultLine(0.11, { [s]: tokens(18, 2_900, 151_000, 24_000, 0.1), [h]: tokens(24, 8_700, 215_000, 27_000, 0.01) }, {}, 3)];
  const two = [resultLine(0.2, { [s]: tokens(38, 6_800, 447_000, 34_000, 0.19), [h]: tokens(24, 8_700, 215_000, 27_000, 0.01) }, { [s]: tokens(20, 3_900, 296_000, 10_000, 0.09) }, 13)];
  const [first, second] = chain([{ lines: one }, { lines: two }]);
  assert.deepEqual([first!.costUsd, first!.costBasis, first!.sinceLastResultUsd, first!.usageCostUsd, Object.keys(first!.usage!)], [0.11, 'first', 0.11, 0.11, [s, h]]);
  assert.deepEqual([second!.costUsd, second!.costBasis, second!.reportedTotalUsd, second!.sinceLastResultUsd, second!.usageCostUsd], [0.09, 'difference', 0.2, 0.09, 0.09]);
  assert.deepEqual(second!.usage, { [s]: { inputTokens: 20, outputTokens: 3_900, thinkingTokens: 0, cacheReadInputTokens: 296_000, cacheCreationInputTokens: 10_000, costUsd: 0.09 } });
  assert.deepEqual([leadTurns(one), leadTurns(two), leadTurns([])], [12, 13, null]);
  const both = sessionCost([first!, second!]);
  assert.deepEqual([both.costUsd, both.sinceLastResultUsd, both.usage[s]!.cacheReadInputTokens, both.usage[h]!.outputTokens, both.usage[s]!.costUsd], [0.2, 0.2, 447_000, 8_700, 0.19]);
});

test('a total that did not go on from the step before is the step\'s own; a step without a total costs nothing known', () => {
  // a total below the one before cannot be a running total
  const drop = chain([0.2, 0.05, 0.3].map(t => ({ lines: [resultLine(t, undefined)] })));
  assert.deepEqual(drop.map(c => [c.costUsd, c.costBasis]), [[0.2, 'first'], [0.05, 'own-total'], [0.25, 'difference']]);
  assert.deepEqual([sessionCost(drop).costUsd, sessionCost(drop).costReading, sessionCost(drop).lastReportedTotalUsd], [0.5, 'mixed', 0.3]);
  // a higher total whose process counted all of it itself started at zero: the process's own count says so
  const m = 'claude-sonnet-5-5';
  const restarted = chain([{ lines: [resultLine(0.2, undefined, { [m]: tokens(1, 1, 1, 1, 0.2) })] }, { lines: [resultLine(0.3, { [m]: tokens(5, 5, 5, 5, 0.3) }, { [m]: tokens(5, 5, 5, 5, 0.3) })] }]);
  assert.deepEqual(restarted.map(c => [c.costUsd, c.costBasis]), [[0.2, 'first'], [0.3, 'own-total']]);
  assert.equal(restarted[1]!.usage![m]!.inputTokens, 5);
  // a step whose process wrote no result (killed), then one with a zeroed total: neither moves the total the next difference is taken from
  const gap = chain([{ lines: [resultLine(0.2, undefined)] }, { lines: [] }, { lines: [resultLine(0, undefined)] }, { lines: [resultLine(0.45, undefined)] }]);
  assert.deepEqual(gap.map(c => [c.costUsd, c.costBasis]), [[0.2, 'first'], [0, 'none'], [0, 'none'], [0.25, 'difference']]);
  assert.deepEqual([sessionCost(gap).costUsd, sessionCost(gap).costReading], [0.45, 'running-total']);
  assert.deepEqual([0, 1, 2, 3].map(i => stepStatus([true, false, false, true], i)), ['pass', 'failed', 'failed_after_failure', 'pass']);
});

test('recompute: an output folder that counted each step\'s reported total gets the steps\' own costs, once', () => {
  const out = path.join(tmp, 'old-out');
  fs.mkdirSync(path.join(out, 'streams'), { recursive: true });
  const m = 'claude-sonnet-5-5';
  // the auto session as it was recorded: three steps whose costUsd is the running total; step 02's stream is gone
  const totals = [0.1, 0.25, 0.3];
  const old = (id: string, i: number) => ({ id, passed: true, costUsd: totals[i], usageCostUsd: totals[i], streamInputUsd: 0.01, streamInputLeadUsd: 0.01, streamInputWorkersUsd: 0, unpricedMessages: 0, leadTurns: 2 });
  const rec = { scenario: 'taskboard-01', arrangement: 'auto', rep: 1, steps: ['01', '02', '03'].map(old),
    totals: { costUsd: null, costReading: 'undecided', sumOfStepTotalsUsd: 0.65, lastStepTotalUsd: 0.3, streamInputUsd: 0.03, wallSeconds: 60, stepsPassed: 3 } };
  fs.writeFileSync(path.join(out, 'sessions.jsonl'), JSON.stringify(rec) + '\n');
  const stream = (id: string, lines: StreamLine[]) => fs.writeFileSync(streamFileOf(out, `taskboard-01|auto|1|${id}`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  stream('01', [said('a', m, usage(2, 1_000, 500)), resultLine(0.1, { [m]: tokens(2, 100, 1_000, 500, 0.1) }, { [m]: tokens(2, 100, 1_000, 500, 0.1) }, 4)]);
  stream('03', [said('c', m, usage(2, 3_000, 500)), resultLine(0.3, { [m]: tokens(8, 400, 6_000, 1_500, 0.3) }, { [m]: tokens(2, 100, 3_000, 500, 0.05) }, 3)]);
  // the ledger: that session, then a direct session stopped after two steps and started again (its step ids start over)
  const entry = (key: string, costUsd: number) => JSON.stringify({ key, costUsd, at: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(out, 'ledger.jsonl'), [...totals.map((t, i) => entry(`taskboard-01|auto|1|0${i + 1}`, t)),
    entry('taskboard-01|direct|1|01', 0.2), entry('taskboard-01|direct|1|02', 0.3), entry('taskboard-01|direct|1|01', 0.25), entry('taskboard-01|direct|1|02', 0.4)].join('\n') + '\n');

  const r = recompute(out);
  assert.deepEqual([r.sessions, r.sessionsLeft, r.ledgerEntries, r.ledgerBeforeUsd, r.ledgerAfterUsd], [1, 0, 7, 1.8, 1]);
  assert.match(r.notes.join('\n'), /taskboard-01\|auto\|1\|02: no kept stream/);
  const readBack = (f: string) => fs.readFileSync(path.join(out, f), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, any>);   // eslint-disable-line @typescript-eslint/no-explicit-any
  const [now] = readBack('sessions.jsonl');
  assert.deepEqual(now!.steps.map((s: Record<string, unknown>) => [s.id, s.costUsd, s.costBasis, s.reportedTotalUsd]), [['01', 0.1, 'first', 0.1], ['02', 0.15, 'difference', 0.25], ['03', 0.05, 'difference', 0.3]]);
  // from a stream: the per-model figures, the process's own count and the turns; without one: what was on record stays
  assert.deepEqual([now!.steps[0].usage[m].cacheReadInputTokens, now!.steps[0].sinceLastResultUsd, now!.steps[0].leadTurns, now!.steps[0].passed], [1_000, 0.1, 4, true]);
  assert.deepEqual([now!.steps[1].usage, now!.steps[1].usageCostUsd, now!.steps[1].sinceLastResultUsd, now!.steps[1].streamInputUsd, now!.steps[1].leadTurns], [null, null, null, 0.01, 2]);
  // step 03's difference is taken from step 02's recorded total; without step 02's per-model usage its own cannot be told apart
  assert.deepEqual([now!.steps[2].usage, now!.steps[2].sinceLastResultUsd, now!.steps[2].leadTurns], [null, 0.05, 3]);
  assert.deepEqual([now!.costRecomputed, now!.totals.costUsd, now!.totals.costReading, now!.totals.lastReportedTotalUsd, now!.totals.wallSeconds, now!.totals.stepsPassed, 'sumOfStepTotalsUsd' in now!.totals],
    [true, 0.3, 'running-total', 0.3, 60, 3, false]);
  assert.deepEqual(readBack('ledger.jsonl').map(e => [e.key.slice(13), e.costUsd, e.costBasis, e.reportedTotalUsd]), [
    ['auto|1|01', 0.1, 'first', 0.1], ['auto|1|02', 0.15, 'difference', 0.25], ['auto|1|03', 0.05, 'difference', 0.3],
    ['direct|1|01', 0.2, 'first', 0.2], ['direct|1|02', 0.1, 'difference', 0.3], ['direct|1|01', 0.25, 'first', 0.25], ['direct|1|02', 0.15, 'difference', 0.4]]);
  // the files as they were are kept, and a second pass finds nothing left to do
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'sessions.jsonl.before-recompute'), 'utf8')), rec);
  assert.equal(fs.readFileSync(path.join(out, 'ledger.jsonl.before-recompute'), 'utf8').split('\n').filter(Boolean).length, 7);
  const after = fs.readFileSync(path.join(out, 'sessions.jsonl'), 'utf8') + fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8');
  const again = recompute(out);
  assert.deepEqual([again.sessions, again.sessionsLeft, again.ledgerEntries, again.ledgerAfterUsd], [0, 1, 0, 1]);
  assert.equal(fs.readFileSync(path.join(out, 'sessions.jsonl'), 'utf8') + fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8'), after);
  // the script's option does the same and runs nothing; it needs a folder with such files
  const cli = spawnSync(process.execPath, [script, '--recompute', '--out', out], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /recomputed 0 session record\(s\) \(1 already had step costs\) and 0 ledger entries .*the ledger adds up to \$1\.000, before \$1\.000/);
  assert.equal(spawnSync(process.execPath, [script, '--recompute', '--out', path.join(tmp, 'nothing-here')], { encoding: 'utf8', timeout: 60_000 }).status, 2);
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

/**
 * The fake's lines for one step: an init line in the session it was given, one lead call, a result. `totalUsd` is
 * what a resumed process reports: the session's running total, in total_cost_usd and in modelUsage (whose
 * cache-read count runs on the same way).
 */
const call = (copy: string | undefined, totalUsd: number, contextTokens: number, readSoFar = contextTokens) => [
  { line: { type: 'system', subtype: 'init', session_id: '{{session}}', mcp_servers: [], tools: ['Read', 'Edit'] } },
  { ...(copy ? { copy } : {}), line: { type: 'assistant', parent_tool_use_id: null, message: { id: `m-${contextTokens}`, model: 'claude-sonnet-5-5', usage: usage(2, contextTokens, 500), content: [] } } },
  { line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: totalUsd, num_turns: 3, session_id: '{{session}}', modelUsage: { 'claude-sonnet-5-5': { cacheReadInputTokens: readSoFar, costUSD: totalUsd } } } },
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
  // Each process reports the session's running total: 0.2, 0.25, 0.55, 0.65, 1.05, 1.3 for steps that cost 0.2,
  // 0.05, 0.3, 0.1, 0.4 and 0.25 (and the cache reads so far, likewise).
  const { fake, callsFile } = fakeClaude('fake', [call(oracle('01'), 0.2, 12_000, 12_000), call(oracle('02'), 0.25, 20_000, 32_000), call(undefined, 0.55, 26_000, 58_000),
    call(undefined, 0.65, 31_000, 89_000), call(oracle('05'), 1.05, 40_000, 129_000), call(oracle('06'), 1.3, 47_000, 176_000)]);
  const out = path.join(tmp, 'out');
  const work = path.join(tmp, 'work');
  // The output folder of an earlier measurement: its router session is on record, and $0.3 is in its ledger.
  // Only the direct sessions are asked for; they are added to it.
  fs.mkdirSync(out);
  const earlier = { scenario: 'taskboard-01', arrangement: 'auto', rep: 1, steps: [{ id: '01', costUsd: 0.3, costBasis: 'first', reportedTotalUsd: 0.3 }], totals: { costUsd: 0.3 } };
  fs.writeFileSync(path.join(out, 'sessions.jsonl'), JSON.stringify(earlier) + '\n');
  fs.writeFileSync(path.join(out, 'ledger.jsonl'), JSON.stringify({ key: 'taskboard-01|auto|1|01', costUsd: 0.3, costBasis: 'first', reportedTotalUsd: 0.3 }) + '\n');
  // Budget $1.9 with caps of a tenth ($0.2 for an L1 step, $0.5 for L2): the steps' own costs fit ($0.3 + $1.3).
  // The reported totals added up ($4.0) would have stopped the session before its fifth step.
  const r = spawnSync(process.execPath, [script, '--api-key-helper', 'not-a-real-helper', '--arrangements', 'direct', '--reps', '1', '--lead', 'sonnet', '--budget', '1.9', '--cap-scale', '0.1', '--out', out, '--work', work],
    { encoding: 'utf8', timeout: 280_000, env: safeEnv(tmp, 'direct', { BENCH_CLAUDE_BIN: fake }).env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /plan: .* 1 sessions, .*budget \$1\.9 \(spent so far \$0\.30\)/);
  assert.match(r.stdout, /done\. spent \$1\.60 of \$1\.9\./);
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
  const [kept, rec] = readJsonl(path.join(out, 'sessions.jsonl'));
  assert.deepEqual(kept, earlier, 'the earlier session\'s record is left as it was');
  assert.deepEqual([rec!.scenario, rec!.arrangement, rec!.rep, rec!.sessionId, rec!.agentTool, rec!.steps.length], ['taskboard-01', 'direct', 1, id, true, 6]);
  const steps = rec!.steps as Array<Record<string, any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(steps.map(x => x.status), ['pass', 'pass', 'failed', 'failed_after_failure', 'pass', 'pass']);
  assert.deepEqual(steps.map(x => x.ownPassed), [true, true, false, false, true, true]);
  // step 04 has nothing of its own, and step 03's tests still fail under it: both are on record
  assert.deepEqual([steps[3]!.regressions, steps[2]!.regressions, steps[4]!.regressions], [['03'], [], []]);
  assert.deepEqual(steps.map(x => x.resumed), [false, true, true, true, true, true]);
  // a step's cost and tokens are its own: the difference from the running total of the step before
  assert.deepEqual(steps.map(x => x.costUsd), [0.2, 0.05, 0.3, 0.1, 0.4, 0.25]);
  assert.deepEqual(steps.map(x => x.costBasis), ['first', 'difference', 'difference', 'difference', 'difference', 'difference']);
  assert.deepEqual(steps.map(x => x.reportedTotalUsd), [0.2, 0.25, 0.55, 0.65, 1.05, 1.3]);
  assert.deepEqual(steps.map(x => x.usage['claude-sonnet-5-5'].cacheReadInputTokens), [12_000, 20_000, 26_000, 31_000, 40_000, 47_000]);
  assert.deepEqual(steps.map(x => x.context.lastTokens), [12_502, 20_502, 26_502, 31_502, 40_502, 47_502]);
  assert.deepEqual(steps.map(x => x.changedFiles > 0), [true, true, false, false, true, true]);
  assert.ok(steps.every(x => x.streamInputUsd > 0 && x.usageCostUsd === x.costUsd && x.sinceLastResultUsd === null && x.leadTurns === 3 && x.phases));
  assert.deepEqual(rec!.totals, {
    costUsd: 1.3, costReading: 'running-total', lastReportedTotalUsd: 1.3, sinceLastResultUsd: null,
    usage: { 'claude-sonnet-5-5': { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadInputTokens: 176_000, cacheCreationInputTokens: 0, costUsd: 1.3 } },
    streamInputUsd: rec!.totals.streamInputUsd, wallSeconds: rec!.totals.wallSeconds,
    stepsPassed: 4, steps: 6, firstFailedStep: '03', failedAfterFailure: ['04'], finalAllPass: true,
    leadContextFirstStep: 12_502, leadContextLastStep: 47_502, leadContextMax: 47_502, leadCacheReadTokens: 176_000, compactions: 0,
  });
  assert.match(r.stdout, /4\/6 steps pass \(first failure: step 03\), final state passes/);
  assert.match(r.stdout, /-> PASS .* \$0\.050 \(of the session's \$0\.250 so far; stream input/);
  assert.match(r.stdout, /cost: \$1\.300$/m);
  // the session's repository holds no hidden test and no commit of the harness; the graded copies are beside it
  const repo = calls[0]!.cwd;
  assert.ok(!fs.existsSync(path.join(repo, '.bench-hidden')));
  assert.equal(spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').length, 1);
  assert.ok(fs.existsSync(path.join(path.dirname(repo), 'grade', 'step-06', '.bench-hidden', 'task-queries.test.ts')));
  // the ledger has every step's own cost after the earlier session's entry; a second run finds both sessions done
  const ledger = readJsonl(path.join(out, 'ledger.jsonl'));
  assert.deepEqual(ledger.slice(1).map(e => [e.key, e.costUsd, e.costBasis, e.reportedTotalUsd, e.sessionId]), steps.map(x => [`taskboard-01|direct|1|${x.id}`, x.costUsd, x.costBasis, x.reportedTotalUsd, id]));
  assert.equal(Math.round(ledger.reduce((a, e) => a + e.costUsd, 0) * 1e6) / 1e6, 1.6);
  assert.equal(fs.readdirSync(path.join(out, 'streams')).length, 6);
  const again = spawnSync(process.execPath, [script, '--only-plan', '--arrangements', 'auto,direct', '--reps', '2', '--out', out, '--work', work], { encoding: 'utf8', timeout: 60_000 });
  assert.match(again.stdout, /session auto +rep 1 .*\(done\)/);
  assert.match(again.stdout, /session direct rep 1 .*\(done\)/);
  assert.doesNotMatch(again.stdout, /session direct rep 2 .*\(done\)/);
});

test('measure-session router session: the plugin and its MCP server on every step, one daemon for the session, the profile on record', () => {
  const s = loadScenario('taskboard-01')!;
  const router = { mcp_servers: [{ name: 'plugin:do-it-all-claude-code:router', status: 'connected' }], tools: ['Read', 'mcp__plugin_do-it-all-claude-code_router__router_report_triage'] };
  const calls = s.steps.map((x, i) => call(path.join(s.dir, 'steps', x.id, 'oracle'), 0.1 * (i + 1), 10_000 + i * 2_000)
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
  assert.deepEqual([rec!.totals.stepsPassed, rec!.totals.firstFailedStep, rec!.totals.finalAllPass, rec!.totals.costReading, rec!.totals.costUsd], [6, null, true, 'running-total', 0.6]);
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
