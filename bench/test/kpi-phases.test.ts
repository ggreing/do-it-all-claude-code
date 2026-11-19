// Decision 174: the phase timings of a KPI run, from a stream stamped on arrival and the daemon ledger. A synthetic
// stream for the analysis; a fake claude (bench/test/kpi-fake-claude.mjs) for the capture and a smoke run of
// scripts/measure107.ts. Nothing here starts the real Claude Code or touches the network.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysePhases, phaseReport, type LedgerTiming, type StreamLine } from '../src/kpi/phases.ts';
import { killedWorkers, runCaptured, stderrTail, TIMING_FLAGS } from '../src/kpi/capture.ts';
import { RUN_ENV } from '../src/kpi/run-args.ts';
import { ROUTER_TOOL_PREFIX, mcpSeen } from '../src/kpi/router-mcp.ts';
import { projectFolderName, projectFolderOf, subscriptionRunEnv, transcriptUnread, transcriptsLine } from '../src/kpi/subscription.ts';
import { freePort, noPluginCalls, safeEnv, type SafeEnv } from './kpi-safe-env.ts';

const BENCH = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(BENCH, '..');
let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-kpi-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// a string shaped like a key (no real one), for what must not reach a file
const KEY_LIKE = 'sk-ant-api03-abcdefghijklmnop';
const L = (t: number, m: Record<string, unknown>): StreamLine => ({ t, m });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const lead = (t: number, ...content: unknown[]) => L(t, { type: 'assistant', parent_tool_use_id: null, message: { content } });
const worker = (t: number, parent: string, ...content: unknown[]) => L(t, { type: 'assistant', parent_tool_use_id: parent, message: { content } });
const done = (t: number, id: string, parent: string | null = null, extra?: unknown) => L(t, { type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, ...(extra ? { tool_use_result: extra } : {}) });
const hook = (t0: number, t1: number, id: string, event: string): StreamLine[] => [
  L(t0, { type: 'system', subtype: 'hook_started', hook_id: id, hook_name: `${event}:relay`, hook_event: event }),
  L(t1, { type: 'system', subtype: 'hook_response', hook_id: id, hook_name: `${event}:relay`, hook_event: event, outcome: 'success' }),
];

/** A router-on run: triage, a read, a coder (foreground), its retry, a background tester, the lead's merge and test run. */
function delegationStream(): StreamLine[] {
  return [
    L(1200, { type: 'system', subtype: 'init', apiKeySource: 'none' }),
    ...hook(1300, 1800, 'h1', 'UserPromptSubmit'),
    lead(2000, tool('r1', 'Read', { file_path: 'src/a.ts' })), done(2100, 'r1'),
    lead(5000, tool('ag1', 'Agent', { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] change a\n[scope: src/**]' })),
    ...hook(5000, 5600, 'h2', 'PreToolUse'),
    worker(6500, 'ag1', { type: 'text', text: 'on it' }),
    worker(7000, 'ag1', tool('w1', 'Read', { file_path: 'src/a.ts' })), done(7100, 'w1', 'ag1'),
    worker(9000, 'ag1', tool('w2', 'Edit', { file_path: 'src/a.ts' })), done(9200, 'w2', 'ag1'),
    ...hook(9000, 9300, 'h3', 'PreToolUse'),
    worker(12000, 'ag1', tool('w3', 'Bash', { command: 'npm test' })), done(14000, 'w3', 'ag1'),
    ...hook(14500, 18500, 'h4', 'SubagentStop'),
    done(20000, 'ag1', null, { status: 'completed', agentId: 'agent-1', totalDurationMs: 14800 }),
    // the same subtask again (after a step up)
    lead(21000, tool('ag2', 'Agent', { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] again' })),
    worker(23000, 'ag2', tool('w4', 'Edit', { file_path: 'src/a.ts' })), done(23500, 'ag2-x', 'ag2'),
    done(30000, 'ag2', null, { status: 'completed', agentId: 'agent-2' }),
    // a background tester, overlapping nothing else
    lead(30500, tool('ag3', 'Agent', { subagent_type: 'do-it-all-claude-code:tester', prompt: '[subtask:T] test', run_in_background: true })),
    L(30600, { type: 'system', subtype: 'task_started', task_id: 'task-3', tool_use_id: 'ag3', task_type: 'local_agent' }),
    done(30700, 'ag3', null, { status: 'async_launched', isAsync: true, agentId: 'agent-3' }),
    worker(32000, 'ag3', tool('w5', 'Read', { file_path: 'src/b.ts' })), done(32100, 'w5', 'ag3'),
    L(40000, { type: 'system', subtype: 'task_notification', task_id: 'task-3', status: 'completed' }),
    // the lead merges a worktree and runs the tests again, then answers
    lead(41000, tool('b1', 'Bash', { command: 'git merge router/A' })), done(42000, 'b1'),
    lead(43000, tool('b2', 'Bash', { command: 'npm test' })), done(46000, 'b2'),
    L(48000, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 4 }),
  ];
}

const ledger = (): LedgerTiming => ({
  startedAt: '2026-11-16T05:00:00.000Z',
  events: [{ type: 'PreToolUse', toolName: 'Agent', agentId: null, at: '2026-11-16T05:00:05.000Z' }, { type: 'SubagentStop', toolName: null, agentId: 'agent-1', at: '2026-11-16T05:00:14.500Z' }],
  signals: [
    { agentId: 'agent-1', subtaskId: 'A', kind: 'test', durationMs: 3000, attempt: 1, at: '' },
    { agentId: 'agent-1', subtaskId: 'A', kind: 'typecheck', durationMs: 1000, attempt: 1, at: '' },
    { agentId: 'agent-2', subtaskId: 'A', kind: 'test', durationMs: 2500, attempt: 2, at: '' },
    { agentId: 'agent-1', subtaskId: 'A', kind: 'scope', durationMs: null, attempt: 1, at: '' },
  ],
  agents: [{ agentId: 'agent-1', role: 'coder', subtaskId: 'A', startedAt: '', stoppedAt: '', worktreePath: '/w/A' }],
  subtasks: [{ id: 'A', attempts: 2, upCount: 1 }, { id: 'T', attempts: 1, upCount: 0 }],
});

test('phases: startup, the lead before the first worker, each worker\'s start delay and work, verify, hooks, merges, retries, the wrap-up', () => {
  const p = analysePhases(delegationStream(), 49_000, ledger());
  assert.deepEqual([p.wallSeconds, p.startupSeconds, p.leadBeforeFirstWorkerSeconds, p.delegationSeconds, p.leadFinishSeconds, p.exitSeconds], [49, 1.2, 3.8, 35, 8, 1]);
  assert.deepEqual([p.workersActiveSeconds, p.leadBetweenWorkersSeconds], [33.5, 1.5], 'workers 5-20, 21-30, 30.5-40; the lead alone 20-21 and 30-30.5');
  const [a, b, c] = p.workers;
  assert.deepEqual([a!.subtask, a!.retry, a!.background, a!.startDelaySeconds, a!.workSeconds, a!.totalSeconds, a!.agentTotalSeconds, a!.toolCalls, a!.rereads, a!.verifySeconds],
    ['A', false, false, 2, 13, 15, 14.8, 3, 1, 4]);
  assert.deepEqual([b!.retry, b!.totalSeconds, b!.verifySeconds], [true, 9, 2.5]);
  assert.deepEqual([c!.background, c!.endedAt, c!.startDelaySeconds, c!.rereads], [true, 40, 1.5, 0], 'a background worker ends at its task notification');
  assert.deepEqual(p.verify, { source: 'daemon', totalSeconds: 6.5, byKind: { test: { count: 2, seconds: 5.5 }, typecheck: { count: 1, seconds: 1 } } });
  assert.deepEqual([p.hooks.source, p.hooks.count, p.hooks.totalSeconds, p.hooks.byEvent.PreToolUse, p.hooks.byEvent.SubagentStop!.seconds, p.hooks.daemonEvents], ['stream', 4, 5.4, { count: 2, seconds: 0.9 }, 4, 2]);
  assert.deepEqual(p.worktrees, { count: 1, mergeSeconds: 1, mergeCalls: 1 });
  assert.deepEqual(p.retries, { workers: 1, seconds: 9, stepUps: 1, attempts: 3 });
  assert.deepEqual([p.leadRanTestsAtEnd, p.leadTestSecondsAtEnd], [true, 3]);
  assert.ok(p.notMeasured.some(n => /worktree creation: not timed on its own/.test(n)));
});

test('phases of a router-off run, and of a stream without hook events or worker messages, say what was not measured', () => {
  const p = analysePhases([L(900, { type: 'system', subtype: 'init' }), lead(3000, tool('r', 'Read', { file_path: 'x' })), done(3100, 'r'), L(9000, { type: 'result' })], 9500, null);
  assert.deepEqual([p.startupSeconds, p.workers.length, p.leadBeforeFirstWorkerSeconds, p.leadFinishSeconds, p.hooks.source, p.verify.source], [0.9, 0, null, null, 'none', 'none']);
  assert.ok(p.notMeasured.some(n => /--include-hook-events/.test(n)) && p.notMeasured.some(n => /no Agent call/.test(n)) && p.notMeasured.some(n => /no daemon ledger/.test(n)));
  const q = analysePhases([L(500, { type: 'system', subtype: 'init' }), lead(1000, tool('ag', 'Agent', { prompt: 'x' })), done(5000, 'ag'), L(6000, { type: 'result' })], 6000, null);
  assert.ok(q.notMeasured.some(n => /--forward-subagent-text/.test(n)));
});

test('the report: per task, per level, and each overhead\'s share of the time delegation added', () => {
  const p = analysePhases(delegationStream(), 49_000, ledger());
  const md = phaseReport([{ taskId: 'c-l1-01', level: 'L1', arrangement: 'auto', wallSeconds: 49, phases: p }], [{ taskId: 'c-l1-01', level: 'L1', arrangement: 'direct', wallSeconds: 29 }]);
  assert.match(md, /\| c-l1-01 \| L1 \| 49\.0 \| 1\.2 \| 3\.8 \| 33\.5 \| 1\.5 \| 8\.0 \| 3 \| 5\.5 \| 5 \| 1 \| 6\.5 \| 5\.4 \(4\) \| 1\.0 \| 9\.0 \| yes \(3\.0\) \|/);
  assert.match(md, /## Totals per level[\s\S]*\| all \| 1 \| 49\.0 \|/);
  assert.match(md, /\| L1 \| 1 \| 29\.0 \| 49\.0 \| 20\.0 \| 3\.8 \(19%\) \| 5\.5 \(28%\) \| 1\.5 \(8%\) \| 6\.5 \(33%\) \| 5\.4 \(27%\) \| 1\.0 \(5%\) \| 8\.0 \(40%\) \| 9\.0 \(45%\) \|/);
  assert.match(md, /## Not measured[\s\S]*worktree creation/);
});

test('the capture stamps each line as it arrives, keeps the result, and writes the stream redacted', async () => {
  const fakeDir = path.join(tmp, 'fake');
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify([
    { line: { type: 'system', subtype: 'init' } },
    { pauseMs: 300, line: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `key ${KEY_LIKE}` }] } } },
    { pauseMs: 300, line: { type: 'result', subtype: 'success', total_cost_usd: 0.02, num_turns: 1 } },
  ]));
  const streamFile = path.join(tmp, 'out', 'stream.jsonl');
  const c = await runCaptured(process.execPath, [fake], { cwd: tmp, env: { ...process.env } as Record<string, string>, input: 'go', timeoutSec: 30, streamFile });
  assert.equal(c.lines.length, 3);
  assert.ok(c.lines[1]!.t - c.lines[0]!.t >= 200 && c.lines[2]!.t - c.lines[1]!.t >= 200, JSON.stringify(c.lines.map(l => l.t)));
  assert.deepEqual([c.result?.total_cost_usd, c.code], [0.02, 0]);
  const saved = fs.readFileSync(streamFile, 'utf8');
  assert.equal(saved.trim().split('\n').length, 3);
  assert.ok(!saved.includes('abcdefghijklmnop'), 'the stream on disk is redacted');
});

// A worker cut off by Claude Code, as its stream shows it (2.1.327): the agent's task goes to "killed"; the shell
// command it was running is a task of its own and no worker. Claude Code says on stderr that it stopped them.
const killedSteps = [
  { line: { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_a1', description: 'Fix the case', subagent_type: 'do-it-all-claude-code:coder', is_backgrounded: true, task_type: 'local_agent' } },
  { line: { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_b1', description: 'npm test', owned_by_subagent: true, parent_task_id: 'a1', task_type: 'local_bash' } },
  { line: { type: 'system', subtype: 'task_started', task_id: 'a2', tool_use_id: 'toolu_a2', description: 'Review it', subagent_type: 'do-it-all-claude-code:reviewer', task_type: 'local_agent' } },
  { line: { type: 'system', subtype: 'task_updated', task_id: 'a2', patch: { status: 'completed' } } },
  { pauseMs: 50, stderr: `Background tasks still running 10m after the last turn (1 agent); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\nlog in ${path.join(os.homedir(), 'logs', 'x.log')}, key ${KEY_LIKE}\n`,
    line: { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } } },
  { line: { type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'killed' } } },
  { line: { type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'killed' } } },
];

test('the workers Claude Code stopped, from a run\'s stream; the end of its stderr for the record', () => {
  const lines = killedSteps.map((s, i) => L(1000 + i * 250, s.line));
  assert.deepEqual(killedWorkers(lines), [{ taskId: 'a1', agent: 'do-it-all-claude-code:coder', description: 'Fix the case', atSeconds: 2 }]);
  assert.deepEqual(killedWorkers(lines.slice(1, 4)), [], 'nothing was killed');
  // a killed task whose start is not in the stream is kept (it may be a worker); a shell command's is not
  assert.deepEqual(killedWorkers([L(500, { type: 'system', subtype: 'task_updated', task_id: 'zz', patch: { status: 'killed' } })]), [{ taskId: 'zz', agent: null, description: null, atSeconds: 0.5 }]);
  assert.deepEqual(killedWorkers([lines[1]!, lines[5]!]), []);
  assert.equal(stderrTail(''), undefined);
  assert.equal(stderrTail('  \n'), undefined);
  assert.equal(stderrTail('x'.repeat(700) + 'end', 10), 'xxxxxxxend');
  assert.equal(stderrTail('at C:\\Users\\someone\\.cfg\\a.log and C:/Users/someone/b.log', 600, 'C:\\Users\\someone'), 'at ~\\.cfg\\a.log and ~/b.log');
  assert.ok(!String(stderrTail(`token ${KEY_LIKE}`)).includes('abcdefghijklmnop'));
  assert.deepEqual(RUN_ENV, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' });
});

test('measure107 smoke run with a fake claude: the timing flags are passed, the stream is kept, the record has phases', () => {
  const fakeDir = path.join(tmp, 'fake');
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify([
    { line: { type: 'system', subtype: 'init' } },
    { pauseMs: 200, line: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'src/case.ts' } }] } } },
    // a worker and a shell command of its own, both still running when Claude Code ends the session and says so on stderr
    ...killedSteps,
    { pauseMs: 100, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 2, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
  ]));
  const out = path.join(tmp, 'out');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--api-key-helper', 'not-a-real-helper', '--arrangements', 'direct', '--tasks', 'c-l1-01', '--lead', 'sonnet', '--out', out, '--work', path.join(tmp, 'work')], {
    encoding: 'utf8', timeout: 240_000, env: safeEnv(tmp, 'direct', { BENCH_CLAUDE_BIN: fake }).env,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const call = JSON.parse(fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').trim().split('\n')[0]!) as { args: string[]; anthropicModel: string | null; bgWaitCeiling: string | null };
  for (const f of TIMING_FLAGS) assert.ok(call.args.includes(f), f);
  // print mode's ceiling on waiting for background tasks is off: the task's timeout and the cost cap end a run
  assert.equal(call.bgWaitCeiling, '0');
  // the worker Claude Code stopped is on the record (its shell command is not a worker), and so is the end of
  // stderr, without the key and the home folder that were in it
  const marked = JSON.parse(fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim()) as { killedWorkers: Array<Record<string, unknown>>; stderrTail?: string };
  assert.deepEqual(marked.killedWorkers.map(k => [k.taskId, k.agent, k.description, typeof k.atSeconds]), [['a1', 'do-it-all-claude-code:coder', 'Fix the case', 'number']]);
  assert.match(String(marked.stderrTail), /^Background tasks still running 10m after the last turn \(1 agent\); stopping them\.[\s\S]*\nlog in ~[\\/]logs[\\/]x\.log, key sk-ant-…\[REDACTED\]$/);
  assert.match(r.stdout, /1 worker\(s\) stopped by Claude Code before finishing \(do-it-all-claude-code:coder at \d+(\.\d)?s\): the change may be incomplete/);
  // decision 218: the lead's model is also in the run's environment (the router's hooks read it there), same value as --model
  assert.deepEqual([call.args[call.args.indexOf('--model') + 1], call.anthropicModel], ['sonnet', 'sonnet']);
  assert.ok(!call.args.includes('json') || call.args[call.args.indexOf('--output-format') + 1] === 'stream-json');
  // decision 213: router off has the Agent tool, as a user's session has, and no plugin; the record says so
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash,Agent');
  assert.ok(!call.args.includes('--plugin-dir'));
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1] ?? '', /wait until every subagent you started has finished/);
  assert.match(r.stdout, /direct runs with the Agent tool/);
  // decision 222: echo, pwd and wc are allowed without a prompt, in every arrangement; the plan and the record say so
  const allowed = call.args.slice(call.args.indexOf('--allowedTools') + 1, call.args.indexOf('--append-system-prompt'));
  for (const t of ['Agent', 'Bash(git diff*)', 'Bash(echo *)', 'Bash(pwd)', 'Bash(wc *)']) assert.ok(allowed.includes(t), t);
  assert.match(r.stdout, /every run may also use Bash\(echo \*\), Bash\(pwd\), Bash\(wc \*\) without a prompt \(decision 222/);
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim()) as { costUsd: number; leadCalls: number; agentTool: boolean; allowedSince222: boolean; phases: { startupSeconds: number; leadToolCalls: number; notMeasured: string[] } };
  assert.deepEqual([rec.agentTool, rec.allowedSince222], [true, true]);
  // the grade is a real one (the test's environment does not make `node --test` a nested run that runs nothing):
  // the fake session changed no file, so the task's hidden tests fail and the fixture's own tests pass
  const graded = rec as unknown as { passed: boolean; grade: string };
  assert.equal(graded.passed, false, graded.grade);
  assert.match(graded.grade, /^tests pass=[1-9]\d* fail=[1-9]\d*$/);
  assert.deepEqual([rec.costUsd, rec.leadCalls, rec.phases.leadToolCalls], [0.01, 2, 1]);
  assert.ok(rec.phases.startupSeconds >= 0 && rec.phases.notMeasured.some(n => /no daemon ledger/.test(n)));
  assert.ok(fs.existsSync(path.join(out, 'streams', 'c-l1-01_direct.jsonl')));
  assert.match(r.stdout, /phases: startup /);
  const rep = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kpi-phases.ts'), '--runs', path.join(out, 'runs.jsonl')], { encoding: 'utf8' });
  assert.equal(rep.status, 0, rep.stderr);
  // the arrangement of the measurements before decision 213 stays reachable (the plan only: no run)
  const old = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--only-plan', '--direct-no-agent-tool', '--arrangements', 'direct', '--tasks', 'c-l1-01', '--out', path.join(tmp, 'out-old'), '--work', path.join(tmp, 'work')], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.match(old.stdout, /direct runs without the Agent tool/);
  // --profile is the router's: a direct-only plan does not mention it, and a value that is no profile is refused
  assert.doesNotMatch(old.stdout, /profile/);
  const plan = (...extra: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--only-plan', '--tasks', 'c-l1-01', '--out', path.join(tmp, 'out-plan'), '--work', path.join(tmp, 'work'), ...extra], { encoding: 'utf8', timeout: 60_000 });
  assert.match(plan('--arrangements', 'direct,auto', '--profile', 'save').stdout, /router runs with the router's MCP server, profile save$/m);
  for (const bad of [['--profile', 'fast'], ['--profile']]) {
    const r2 = plan('--arrangements', 'auto', ...bad);
    assert.equal(r2.status, 2, r2.stdout + r2.stderr);
    assert.match(r2.stderr, /--profile (must be one of|needs a value:) save, balanced, quality/);
  }
});

// ---- decision 213: the router's MCP server in a router run

const ROUTER_SERVER = { name: 'plugin:do-it-all-claude-code:router', status: 'connected' };
const initLine = (servers: unknown[], tools: string[] = []): StreamLine => L(0, { type: 'system', subtype: 'init', mcp_servers: servers, tools: ['Read', 'Edit', ...tools] });

test('what a session loaded as MCP servers, against what the run asked for', () => {
  const triage = `${ROUTER_TOOL_PREFIX}router_report_triage`;
  // a router run with the server: the router's server, its tools listed, nothing else
  assert.deepEqual(mcpSeen([initLine([ROUTER_SERVER], [triage, `${ROUTER_TOOL_PREFIX}router_get_plan`])], true),
    { seen: true, servers: [ROUTER_SERVER], routerTools: 2 });
  // still connecting when the session starts: not judged
  assert.equal(mcpSeen([initLine([{ ...ROUTER_SERVER, status: 'pending' }])], true).problem, undefined);
  // not the arrangement asked for
  assert.match(mcpSeen([initLine([])], true).problem ?? '', /the router's MCP server is not in the session \(mcp_servers: none\)/);
  assert.match(mcpSeen([initLine([{ ...ROUTER_SERVER, status: 'failed' }])], true).problem ?? '', /did not connect/);
  assert.match(mcpSeen([initLine([ROUTER_SERVER])], true).problem ?? '', /connected but its tools are not in the session's tool list/);
  assert.match(mcpSeen([initLine([ROUTER_SERVER, { name: 'github', status: 'connected' }], [triage])], true).problem ?? '', /other MCP servers are in the session: github/);
  // a run that asked for no server (router off, or --no-router-mcp): none may be there
  assert.deepEqual(mcpSeen([initLine([])], false), { seen: true, servers: [], routerTools: 0 });
  assert.match(mcpSeen([initLine([ROUTER_SERVER], [triage])], false).problem ?? '', /in a run that asked for none/);
  assert.match(mcpSeen([initLine([{ name: 'github', status: 'connected' }])], false).problem ?? '', /other MCP servers are in the session: github/);
  // no init line (claude did not start): nothing can be said, so nothing is claimed
  assert.deepEqual(mcpSeen([], true), { seen: false, servers: [], routerTools: 0 });
});

/** A measure107 run of one router arrangement with the fake claude, whose session starts with `init`. */
function routerRun(name: string, init: Record<string, unknown>, extra: string[] = []): { r: ReturnType<typeof spawnSync>; args: string[]; out: string; anthropicModel: string | null; work: string; claudeOnPath: ReturnType<SafeEnv['calls']> } {
  const fakeDir = path.join(tmp, `fake-${name}`);
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify([
    { line: { type: 'system', subtype: 'init', ...init } },
    // a router run writes a result line per turn of the lead: its first turn, then one when its background workers are done
    { pauseMs: 50, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 4, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
    { pauseMs: 20, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 3, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
  ]));
  const out = path.join(tmp, `out-${name}`);
  const safe = safeEnv(tmp, name, { BENCH_CLAUDE_BIN: fake });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--api-key-helper', 'not-a-real-helper', '--arrangements', 'auto', '--tasks', 'c-l1-01', '--lead', 'sonnet',
    '--out', out, '--work', path.join(tmp, `work-${name}`), '--daemon-port', String(freePort()), ...extra], { encoding: 'utf8', timeout: 240_000, env: safe.env });
  const calls = path.join(fakeDir, 'calls.jsonl');
  const first = fs.existsSync(calls) ? JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n')[0]!) as { args: string[]; anthropicModel: string | null } : undefined;
  return { r, args: first?.args ?? [], out, anthropicModel: first?.anthropicModel ?? null, work: path.join(tmp, `work-${name}`), claudeOnPath: safe.calls() };
}
const records = (out: string) => (fs.existsSync(path.join(out, 'runs.jsonl')) ? fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>) : []);

test('measure107 router run: the plugin\'s MCP server is loaded as in a session, checked before and after the run, and recorded', () => {
  const tools = ['router_get_plan', 'router_report_triage'].map(t => `${ROUTER_TOOL_PREFIX}${t}`);
  const { r, args, out, anthropicModel, work, claudeOnPath } = routerRun('mcp', { mcp_servers: [ROUTER_SERVER], tools });
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
  // The user's Claude Code is never touched: the router's init registers no plugin (no `claude plugin ...` call),
  // and whatever the router's CLI asks the claude on the PATH, it asks with a config folder of this run.
  assert.equal(noPluginCalls(claudeOnPath), undefined);
  assert.ok(claudeOnPath.length > 0, 'the recording claude on the PATH was reached (init asks for the version)');
  for (const c of claudeOnPath) assert.equal(path.normalize(c.configDir), path.join(work, 'c-l1-01-auto', 'claude-init'), `claude ${c.args}`);
  assert.ok(!fs.existsSync(path.join(work, 'c-l1-01-auto', 'router-home', 'plugin', '.claude-plugin', 'marketplace.json')), 'no local marketplace is written for a run');
  // decision 218: the router's hooks learn the lead's model from the run's environment
  assert.equal(anthropicModel, 'sonnet');
  // no --profile: the router's default, and the plan and the record say which
  assert.match(String(r.stdout), /router runs with the router's MCP server, profile balanced \(the router's default\)/);
  assert.equal(records(out)[0]!.profile, 'balanced');
  // no --strict-mcp-config: the plugin's own declaration is what loads the server; the plugin is there
  assert.ok(!args.includes('--strict-mcp-config') && !args.includes('--mcp-config'), args.join(' '));
  assert.equal(args[args.indexOf('--plugin-dir') + 1], path.join(ROOT, 'plugin'));
  assert.match(String(r.stdout), /router runs with the router's MCP server/);
  // before the run, with no model call: the server starts, lists its tools and reaches this run's daemon
  assert.match(String(r.stdout), /router MCP server: 6 tools, the daemon answered/);
  const [rec] = records(out);
  assert.deepEqual([rec!.routerMcp, rec!.mcp], [true, { seen: true, servers: ['plugin:do-it-all-claude-code:router (connected)'], routerTools: 2 }]);
  assert.equal(rec!.agentTool, undefined);
  // the lead's round trips are added over the run's result lines (4 and 3); the cost is the last line's total, once
  assert.deepEqual([rec!.leadCalls, rec!.costUsd], [7, 0.01]);
});

test('measure107 router run: --no-router-mcp is the earlier arrangement; a session with the wrong servers stops the measurement and leaves no record', () => {
  const old = routerRun('strict', { mcp_servers: [] }, ['--no-router-mcp', '--profile', 'quality']);
  assert.equal(old.r.status, 0, String(old.r.stdout) + String(old.r.stderr));
  assert.ok(old.args.includes('--strict-mcp-config'));
  assert.match(String(old.r.stdout), /router runs without the router's MCP server, profile quality$/m);
  // --profile: the run's router config has it, and the record says so
  const cfg = JSON.parse(fs.readFileSync(path.join(old.work, 'c-l1-01-auto', 'router-home', 'config.json'), 'utf8')) as { profile?: string; holdoutRate?: number };
  assert.deepEqual([cfg.profile, cfg.holdoutRate, records(old.out)[0]!.profile], ['quality', 0, 'quality']);
  assert.doesNotMatch(String(old.r.stdout), /router MCP server: /);
  assert.deepEqual([records(old.out)[0]!.routerMcp, records(old.out)[0]!.mcp.servers], [false, []]);

  // asked for the server, the session does not have it: exit 3, the cost is in the ledger, no record (it is run again)
  const missing = routerRun('missing', { mcp_servers: [] });
  assert.equal(missing.r.status, 3, String(missing.r.stdout) + String(missing.r.stderr));
  assert.match(String(missing.r.stderr), /stopped after c-l1-01\|auto \(\$0\.010 spent on it\): the router's MCP server is not in the session/);
  assert.deepEqual(records(missing.out), []);
  // neither run registered a plugin in Claude Code
  assert.deepEqual([noPluginCalls(old.claudeOnPath), noPluginCalls(missing.claudeOnPath)], [undefined, undefined]);
  assert.match(fs.readFileSync(path.join(missing.out, 'ledger.jsonl'), 'utf8'), /"costUsd":0\.01/);
});

// ---- the measurement scripts and the user's Claude Code settings
//
// `init --yes` installs the generated plugin: `claude plugin marketplace add <router home>/plugin --scope user`.
// From a measurement script, whose router home is a temporary folder, that wrote the user's own settings. The
// scripts now pass --no-plugin and give the CLI a config folder of the run; this pins both, and shows that the
// recording `claude` of these tests does see the call when it is made.

test('the router\'s init with --no-plugin asks Claude Code for nothing but its version; without the flag it registers a marketplace', () => {
  const cli = path.join(ROOT, 'packages', 'cli', 'src', 'index.ts');
  const init = (name: string, ...extra: string[]) => {
    const safe = safeEnv(tmp, name, { DO_IT_ALL_CLAUDE_CODE_HOME: path.join(tmp, `home-${name}`) });
    delete safe.env.AGENTIC_ROUTER_HOME;   // the previous release's home would be moved into the temp one
    const r = spawnSync(process.execPath, [cli, 'init', '--yes', ...extra, '--claude-settings', path.join(tmp, `cs-${name}.json`), '--project', path.join(tmp, `project-${name}`)],
      { encoding: 'utf8', timeout: 120_000, env: safe.env, cwd: tmp });
    return { r, calls: safe.calls(), configDir: String(safe.env.CLAUDE_CONFIG_DIR), home: path.join(tmp, `home-${name}`) };
  };
  const quiet = init('quiet', '--no-plugin');
  assert.equal(quiet.r.status, 0, quiet.r.stdout + quiet.r.stderr);
  assert.equal(noPluginCalls(quiet.calls), undefined);
  assert.deepEqual([...new Set(quiet.calls.map(c => c.args))], ['--version']);
  assert.match(quiet.r.stdout, /Plugin not installed in Claude Code \(--no-plugin\)\. Load it with: claude --plugin-dir /);
  assert.ok(fs.existsSync(path.join(quiet.home, 'plugin', 'hooks', 'hooks.json')), 'the plugin is still generated in the router home');
  assert.ok(!fs.existsSync(path.join(quiet.home, 'plugin', '.claude-plugin', 'marketplace.json')), 'no local marketplace manifest');
  // the control: the same call without the flag does go to `claude plugin ...`, here caught by the recording
  // claude and pointed at this test's own config folder
  const loud = init('loud');
  assert.equal(loud.r.status, 0, loud.r.stdout + loud.r.stderr);
  assert.match(noPluginCalls(loud.calls) ?? '', /^claude plugin marketplace add .*--scope user/);
  for (const c of loud.calls) assert.equal(path.normalize(c.configDir), path.normalize(loud.configDir));
});

test('the measurement and end-to-end scripts never run the router\'s init without --no-plugin and a config folder of their own', () => {
  for (const file of ['scripts/measure107.ts', 'scripts/measure-session.ts', 'scripts/e2e.ts', 'scripts/guard-e2e/run.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const inits = text.split('\n').filter(l => /cli\((?:home, )?'init'/.test(l));
    assert.ok(inits.length > 0, `${file}: an init call`);
    for (const l of inits) assert.match(l, /'init', '--yes', '--no-plugin'/, `${file}: ${l.trim()}`);
    assert.ok(/CLAUDE_CONFIG_DIR: path\.join\(.*'claude-init'\)/.test(text), `${file}: the CLI's own CLAUDE_CONFIG_DIR`);
  }
});

// ---- decision 226: a measurement on the subscription login instead of an API key

const usageSteps = (weekly: number, init: Record<string, unknown> = {}) => [
  { line: { type: 'system', subtype: 'init', apiKeySource: 'none', claude_code_version: '2.1.326', plugins: [], mcp_servers: [], ...init } },
  { line: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'usage' }] },
    usage_report: { rate_limits: { limits: [{ kind: 'weekly_all', group: 'weekly', percent: weekly, resets_at: '2026-11-22T00:00:00Z', severity: 'normal', is_active: false }], extra_usage: { is_enabled: false } } } } },
  { line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, num_turns: 1, modelUsage: {} } },
];
const runSteps = (init: Record<string, unknown> = {}, limit: Record<string, unknown> = { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.1 }) => [
  { line: { type: 'system', subtype: 'init', apiKeySource: 'none', claude_code_version: '2.1.326', plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }], mcp_servers: [], ...init } },
  { pauseMs: 30, line: { type: 'rate_limit_event', rate_limit_info: limit } },
  { pauseMs: 30, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 2, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
];
interface FakeCall { args: string[]; cwd: string; usage: boolean; env: string[]; configDir: string | null; anthropicModel: string | null; bgWaitCeiling: string | null }

/** A measure107 run on the subscription login with the fake claude; the parent's environment holds credential variables. */
function subRun(name: string, scenario: { calls: unknown[][]; usage?: unknown[][] }, extra: string[] = [], arrangement = 'direct') {
  const fakeDir = path.join(tmp, `fake-${name}`);
  fs.mkdirSync(fakeDir, { recursive: true });
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify(scenario));
  const out = path.join(tmp, `out-${name}`), work = path.join(tmp, `work-${name}`);
  const safe = safeEnv(tmp, name, { BENCH_CLAUDE_BIN: fake, ANTHROPIC_API_KEY: 'not-a-real-key', ANTHROPIC_AUTH_TOKEN: 'not-a-real-token', CLAUDE_CODE_OAUTH_TOKEN: 'not-a-real-token', CLAUDE_CODE_USE_BEDROCK: '1' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--subscription', '--arrangements', arrangement, '--tasks', 'c-l1-01', '--lead', 'sonnet', '--out', out, '--work', work,
    ...(arrangement === 'direct' ? [] : ['--daemon-port', String(freePort())]), ...extra], { encoding: 'utf8', timeout: 240_000, env: safe.env });
  const file = path.join(fakeDir, 'calls.jsonl');
  const calls = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as FakeCall) : [];
  const ledger = fs.existsSync(path.join(out, 'ledger.jsonl')) ? fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>) : [];
  return { r, out, work, calls, runs: calls.filter(c => !c.usage), readings: calls.filter(c => c.usage), ledger, userConfigDir: String(safe.env.CLAUDE_CONFIG_DIR), text: String(r.stdout) + String(r.stderr) };
}

test('measure107 --subscription: the run gets no key, no credential variable and no config folder of the run; it is recorded as a subscription run', () => {
  const s = subRun('sub', { calls: [runSteps()], usage: [usageSteps(10), usageSteps(12)] });
  assert.equal(s.r.status, 0, s.text);
  assert.deepEqual(s.calls.map(c => c.usage), [true, false, true], 'a reading before the run and one after it');
  const run = s.runs[0]!;
  // no key helper in --settings: the credential deny rules only
  const settings = JSON.parse(run.args[run.args.indexOf('--settings') + 1]!) as { apiKeyHelper?: string; permissions: { deny: string[] }; autoMemoryEnabled?: boolean };
  assert.deepEqual([settings.apiKeyHelper, settings.autoMemoryEnabled, settings.permissions.deny.includes('Read(~/.claude/**)')], [undefined, false, true]);
  // nothing that names a credential or another provider reaches the run, in the run or in a reading
  for (const c of s.calls) for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'BENCH_CLAUDE_BIN']) assert.ok(!c.env.includes(k), `${k} reached ${c.usage ? 'a reading' : 'the run'}`);
  for (const k of ['CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'DISABLE_AUTOUPDATER', 'ANTHROPIC_MODEL']) assert.ok(run.env.includes(k), k);
  // no ceiling on print mode's wait for background tasks in the run; a reading starts none, and gets no such variable
  assert.deepEqual([run.bgWaitCeiling, s.readings[0]!.bgWaitCeiling], ['0', null]);
  assert.deepEqual([records(s.out)[0]!.killedWorkers, records(s.out)[0]!.stderrTail], [[], undefined]);
  // a direct run and a reading write nothing of the session to disk: the switch that turns persistence off is on in both
  for (const c of s.calls) assert.ok(c.env.includes('CLAUDE_CODE_SKIP_PROMPT_HISTORY'), c.usage ? 'a reading' : 'the run');
  // the config folder is the caller's own (here the test's), never a folder of the run: Claude Code reads its own login
  for (const c of s.calls) assert.equal(path.normalize(String(c.configDir)), path.normalize(s.userConfigDir));
  // the user's settings are not loaded, no MCP server, and a direct run writes no transcript
  assert.equal(run.args[run.args.indexOf('--setting-sources') + 1], 'project,local');
  assert.ok(run.args.includes('--strict-mcp-config') && run.args.includes('--no-session-persistence') && !run.args.includes('--bare'), run.args.join(' '));
  // one workspace folder for the run and the readings
  const ws = fs.realpathSync(path.join(s.work, 'sub-ws', 'repo'));
  for (const c of s.calls) assert.equal(fs.realpathSync(c.cwd), ws);
  assert.deepEqual(s.readings[0]!.args.slice(0, 2), ['-p', '/usage']);
  const [rec] = records(s.out);
  assert.deepEqual([rec!.subscription, rec!.apiKeySource, rec!.claudeVersion, rec!.transcript, rec!.costUsd], [true, 'none', '2.1.326', false, 0.01]);
  // graded for real in the shared workspace: nothing was changed there, so the hidden tests fail
  assert.equal(rec!.passed, false);
  assert.match(String(rec!.grade), /^tests pass=[1-9]\d* fail=[1-9]\d*$/);
  assert.deepEqual(rec!.meters, { weekly_all: { from: 10, to: 12, delta: 2, valid: true } });
  assert.deepEqual(rec!.limitEvents, [{ status: 'allowed', type: 'seven_day', utilization: 0.1, resetsAt: null, usingOverage: false }]);
  assert.deepEqual(s.ledger.map(e => [e.costUsd, e.subscription]), [[0.01, true]]);
  assert.ok(fs.existsSync(path.join(s.out, 'patches', 'c-l1-01_direct.diff')), 'the changes made in the shared workspace are kept');
  assert.equal(fs.readFileSync(path.join(s.out, 'readings.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.match(s.text, /on the subscription login of this machine's Claude Code, no API key/);
  assert.match(s.text, /\/usage is read before each run: no run starts with a meter at 80% or more/);
  assert.match(s.text, /^\/usage: weekly_all 10%$/m);
  // a folder holds runs paid for one way; and the two ways do not mix on one command line
  const key = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--api-key-helper', 'not-a-real-helper', '--only-plan', '--arrangements', 'direct', '--tasks', 'c-l1-02', '--out', s.out, '--work', s.work], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(key.status, 2, key.stdout + key.stderr);
  assert.match(key.stderr, /holds runs made on the subscription login: give the API-key runs an --out of their own/);
  const both = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--subscription', '--api-key-helper', 'not-a-real-helper', '--only-plan', '--out', path.join(tmp, 'out-both'), '--work', s.work], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(both.status, 2, both.stdout + both.stderr);
  assert.match(both.stderr, /--subscription and --api-key-helper are two ways to pay for a run/);
});

test('measure107 --subscription stops: a meter at the guard or a reading off the login before any run; a key, a limit or paid extra usage after one', () => {
  // the meter is at the guard: nothing is started, nothing is counted
  const high = subRun('high', { calls: [runSteps()], usage: [usageSteps(85)] });
  assert.equal(high.r.status, 3, high.text);
  assert.match(high.text, /stopped before c-l1-01\|direct: weekly_all is at 85%: no run starts at 80% or more/);
  assert.deepEqual([high.runs.length, high.ledger.length, records(high.out).length], [0, 0, 0]);
  // --max-percent moves the guard
  assert.match(subRun('low', { calls: [runSteps()], usage: [usageSteps(10)] }, ['--max-percent', '5']).text, /weekly_all is at 10%: no run starts at 5% or more/);
  // the reading itself ran on a key: no run follows
  const keyed = subRun('keyed', { calls: [runSteps()], usage: [usageSteps(10, { apiKeySource: 'ANTHROPIC_API_KEY' })] });
  assert.equal(keyed.r.status, 3, keyed.text);
  assert.match(keyed.text, /stopped before c-l1-01\|direct: the \/usage reading is not usable: apiKeySource is "ANTHROPIC_API_KEY"/);
  assert.equal(keyed.runs.length, 0);
  // the run shows a key: counted in the ledger, no record (it is run again), the measurement stops
  const off = subRun('off', { calls: [runSteps({ apiKeySource: 'apiKeyHelper' })] }, ['--no-meter']);
  assert.equal(off.r.status, 3, off.text);
  assert.match(off.text, /stopped after c-l1-01\|direct \(\$0\.010 counted for it\): apiKeySource is "apiKeyHelper": the run did not use the subscription login/);
  assert.deepEqual([off.readings.length, records(off.out).length, off.ledger.map(e => e.subscription)], [0, 0, [true]]);
  assert.match(off.text, /no \/usage readings \(--no-meter\)/);
  // a plugin of the user's in the session: the same
  assert.match(subRun('plug', { calls: [runSteps({ plugins: [{ name: 'someone-elses', path: '/plugins/someone-elses' }] })] }, ['--no-meter']).text, /stopped after .*other plugins are loaded: someone-elses/);
  // the login reached a limit during the run: it may have been cut short, so no record
  const limited = subRun('limited', { calls: [runSteps({}, { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1795000000 })] }, ['--no-meter']);
  assert.equal(limited.r.status, 3, limited.text);
  assert.match(limited.text, /stopped after c-l1-01\|direct \(\$0\.010 counted for it\): the login reached a limit \(five_hour at 100%, resets 2026-11-\d\dT/);
  assert.equal(records(limited.out).length, 0);
  // paid extra usage was drawn on: the run was served and is recorded, and nothing more starts
  const over = subRun('over', { calls: [runSteps({}, { status: 'allowed', rateLimitType: 'overage', isUsingOverage: true })] }, ['--no-meter', '--tasks', 'c-l1-01,c-l1-02']);
  assert.equal(over.r.status, 3, over.text);
  assert.match(over.text, /stopped after c-l1-01\|direct \(recorded\): paid extra usage was drawn on \(overage\)/);
  assert.deepEqual([records(over.out).map(x => x.taskId), over.runs.length, records(over.out)[0]!.meters], [['c-l1-01'], 1, null]);
});

test('measure107 --subscription, a router run: the plugin and its transcript as in a session of the user, a router home of the run, still no key', () => {
  const tools = ['router_get_plan', 'router_report_triage'].map(t => `${ROUTER_TOOL_PREFIX}${t}`);
  const init = { mcp_servers: [ROUTER_SERVER], tools, plugins: [{ name: 'do-it-all-claude-code', path: path.join(ROOT, 'plugin') }] };
  const s = subRun('subrouter', { calls: [runSteps(init)], usage: [usageSteps(10)] }, [], 'auto');
  assert.equal(s.r.status, 0, s.text);
  const run = s.runs[0]!;
  assert.equal(run.args[run.args.indexOf('--plugin-dir') + 1], path.join(ROOT, 'plugin'));
  // the daemon reads the transcript, so this run keeps one; other MCP servers stay out by the switch, not by --strict-mcp-config
  assert.ok(!run.args.includes('--no-session-persistence') && !run.args.includes('--strict-mcp-config'), run.args.join(' '));
  // CLAUDE_CODE_SKIP_PROMPT_HISTORY turns session persistence off as a whole: with it in the environment Claude
  // Code writes no transcript, the router reads none and records no cost of the lead. The run goes without it;
  // the reading, which nothing reads back, keeps it.
  assert.ok(!run.env.includes('CLAUDE_CODE_SKIP_PROMPT_HISTORY'), 'the switch that turns persistence off reached a run that keeps its transcript');
  assert.ok(s.readings[0]!.env.includes('CLAUDE_CODE_SKIP_PROMPT_HISTORY'));
  // a router run is the one that waits for workers: print mode's ceiling on that wait is off
  assert.equal(run.bgWaitCeiling, '0');
  const parentEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'not-a-real-key' };
  assert.deepEqual(['CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'ANTHROPIC_API_KEY'].map(k => k in subscriptionRunEnv('sonnet', '/home-of-the-run', parentEnv, true)), [false, true, false]);
  assert.deepEqual(['CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'ANTHROPIC_API_KEY'].map(k => k in subscriptionRunEnv('sonnet', '/home-of-the-run', parentEnv)), [true, false], 'a run that keeps none (--no-transcripts, direct)');
  // the lead's share is the router's own row, read from the transcript: a run where it recorded none says so, not $0.000
  assert.match(s.text, /-> (PASS|FAIL) .* lead not recorded \/ workers \$0\.000;/);
  // a transcript Claude Code named to the router and did not write: the run is not the arrangement being measured
  assert.equal(transcriptUnread(['/c/projects/-ws/0f1e.jsonl', '/c/projects/-ws/0f1e.jsonl'], () => true), null);
  assert.equal(transcriptUnread([]), null);
  assert.match(String(transcriptUnread(['/c/projects/-ws/0f1e.jsonl', '/c/projects/-ws/0f1e.jsonl'], () => false)), /^the router could not read the session's transcript \(not on disk: \/c\/projects\/-ws\/0f1e\.jsonl\): it had no request text for its workers and recorded no cost of the lead$/);
  assert.ok(run.env.includes('DO_IT_ALL_CLAUDE_CODE_HOME') && run.env.includes('ENABLE_CLAUDEAI_MCP_SERVERS') && !run.env.includes('ANTHROPIC_API_KEY'));
  assert.equal(path.normalize(String(run.configDir)), path.normalize(s.userConfigDir));
  assert.match(s.text, /router runs keep their transcript \(the daemon reads it\), in Claude Code's own projects folder/);
  const [rec] = records(s.out);
  assert.deepEqual([rec!.subscription, rec!.transcript, rec!.routerMcp, rec!.apiKeySource], [true, true, true, 'none']);
  // the router's own files are in the run's folder, the workspace is the shared one
  assert.ok(fs.existsSync(path.join(s.work, 'c-l1-01-auto', 'router-home', 'config.json')));
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(path.join(s.work, 'sub-ws', 'repo')));
  // the last line names the folder the transcripts are in, for the user to remove: here by Claude Code's naming
  // rule (the fake session started no worker, so the router was given no path); a later invocation with nothing
  // left to run says it again
  const name = fs.realpathSync.native(path.join(s.work, 'sub-ws', 'repo')).replace(/[^a-zA-Z0-9]/g, '-');
  const last = (text: string) => text.trim().split('\n').at(-1)!.trim();
  assert.ok(last(String(s.r.stdout)).startsWith(`transcripts of the router runs: projects${path.sep}${name} in Claude Code's config folder`), last(String(s.r.stdout)));
  const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--subscription', '--arrangements', 'auto', '--tasks', 'c-l1-01', '--lead', 'sonnet', '--out', s.out, '--work', s.work], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.ok(last(again.stdout).startsWith(`transcripts of the router runs: projects${path.sep}${name} `), last(again.stdout));
  // a path Claude Code gave the router is used as given; a name over 200 characters is cut by Claude Code
  assert.equal(projectFolderOf('/home/u/.claude/projects/-work-sub-ws-repo/0f1e/subagents/agent-a1.jsonl'), ['', 'home', 'u', '.claude', 'projects', '-work-sub-ws-repo'].join(path.sep));
  assert.equal(projectFolderOf('/somewhere/else/agent-a1.jsonl'), null);
  assert.match(transcriptsLine('/work/sub-ws/repo', ['C:\\Users\\u\\.claude\\projects\\C--work-sub-ws-repo\\0f1e\\subagents\\agent-a1.jsonl']), /^transcripts of the router runs: C:.Users.u.\.claude.projects.C--work-sub-ws-repo \(the folder Claude Code named to the router/);
  assert.deepEqual(projectFolderName('C:\\ar dc1\\sub-ws\\repo'), { name: 'C--ar-dc1-sub-ws-repo', cut: false });
  assert.deepEqual([projectFolderName('x'.repeat(201)).cut, projectFolderName('x'.repeat(201)).name.length], [true, 200]);
  // --no-transcripts: the plan says what that costs
  const plan = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--subscription', '--no-transcripts', '--only-plan', '--arrangements', 'auto', '--tasks', 'c-l1-01', '--out', path.join(tmp, 'out-nt'), '--work', s.work], { encoding: 'utf8', timeout: 60_000 });
  assert.match(plan.stdout, /router runs write no transcript \(--no-transcripts\): the router works from estimates/);
});
