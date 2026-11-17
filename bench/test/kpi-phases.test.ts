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
import { runCaptured, TIMING_FLAGS } from '../src/kpi/capture.ts';
import { ROUTER_TOOL_PREFIX, mcpSeen } from '../src/kpi/router-mcp.ts';

const BENCH = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.resolve(BENCH, '..');
let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-kpi-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
    { pauseMs: 300, line: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'key sk-ant-api03-abcdefghijklmnop' }] } } },
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

test('measure107 smoke run with a fake claude: the timing flags are passed, the stream is kept, the record has phases', () => {
  const fakeDir = path.join(tmp, 'fake');
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify([
    { line: { type: 'system', subtype: 'init' } },
    { pauseMs: 200, line: { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'src/case.ts' } }] } } },
    { pauseMs: 100, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 2, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
  ]));
  const out = path.join(tmp, 'out');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--api-key-helper', 'not-a-real-helper', '--arrangements', 'direct', '--tasks', 'c-l1-01', '--lead', 'sonnet', '--out', out, '--work', path.join(tmp, 'work')], {
    encoding: 'utf8', timeout: 240_000, env: { ...process.env, BENCH_CLAUDE_BIN: fake },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const call = JSON.parse(fs.readFileSync(path.join(fakeDir, 'calls.jsonl'), 'utf8').trim().split('\n')[0]!) as { args: string[] };
  for (const f of TIMING_FLAGS) assert.ok(call.args.includes(f), f);
  assert.ok(!call.args.includes('json') || call.args[call.args.indexOf('--output-format') + 1] === 'stream-json');
  // decision 213: router off has the Agent tool, as a user's session has, and no plugin; the record says so
  assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,Bash,Agent');
  assert.ok(!call.args.includes('--plugin-dir'));
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1] ?? '', /wait until every subagent you started has finished/);
  assert.match(r.stdout, /direct runs with the Agent tool/);
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim()) as { costUsd: number; leadCalls: number; agentTool: boolean; phases: { startupSeconds: number; leadToolCalls: number; notMeasured: string[] } };
  assert.equal(rec.agentTool, true);
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
function routerRun(name: string, init: Record<string, unknown>, extra: string[] = []): { r: ReturnType<typeof spawnSync>; args: string[]; out: string } {
  const fakeDir = path.join(tmp, `fake-${name}`);
  fs.mkdirSync(fakeDir);
  const fake = path.join(fakeDir, 'kpi-fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'kpi-fake-claude.mjs'), fake);
  fs.writeFileSync(path.join(fakeDir, 'scenario.json'), JSON.stringify([
    { line: { type: 'system', subtype: 'init', ...init } },
    { pauseMs: 50, line: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1, modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.01 } } } },
  ]));
  const out = path.join(tmp, `out-${name}`);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'measure107.ts'), '--api-key-helper', 'not-a-real-helper', '--arrangements', 'auto', '--tasks', 'c-l1-01', '--lead', 'sonnet',
    '--out', out, '--work', path.join(tmp, `work-${name}`), ...extra], { encoding: 'utf8', timeout: 240_000, env: { ...process.env, BENCH_CLAUDE_BIN: fake } });
  const calls = path.join(fakeDir, 'calls.jsonl');
  const args = fs.existsSync(calls) ? (JSON.parse(fs.readFileSync(calls, 'utf8').trim().split('\n')[0]!) as { args: string[] }).args : [];
  return { r, args, out };
}
const records = (out: string) => (fs.existsSync(path.join(out, 'runs.jsonl')) ? fs.readFileSync(path.join(out, 'runs.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>) : []);

test('measure107 router run: the plugin\'s MCP server is loaded as in a session, checked before and after the run, and recorded', () => {
  const tools = ['router_get_plan', 'router_report_triage'].map(t => `${ROUTER_TOOL_PREFIX}${t}`);
  const { r, args, out } = routerRun('mcp', { mcp_servers: [ROUTER_SERVER], tools });
  assert.equal(r.status, 0, String(r.stdout) + String(r.stderr));
  // no --strict-mcp-config: the plugin's own declaration is what loads the server; the plugin is there
  assert.ok(!args.includes('--strict-mcp-config') && !args.includes('--mcp-config'), args.join(' '));
  assert.equal(args[args.indexOf('--plugin-dir') + 1], path.join(ROOT, 'plugin'));
  assert.match(String(r.stdout), /router runs with the router's MCP server/);
  // before the run, with no model call: the server starts, lists its tools and reaches this run's daemon
  assert.match(String(r.stdout), /router MCP server: 6 tools, the daemon answered/);
  const [rec] = records(out);
  assert.deepEqual([rec!.routerMcp, rec!.mcp], [true, { seen: true, servers: ['plugin:do-it-all-claude-code:router (connected)'], routerTools: 2 }]);
  assert.equal(rec!.agentTool, undefined);
});

test('measure107 router run: --no-router-mcp is the earlier arrangement; a session with the wrong servers stops the measurement and leaves no record', () => {
  const old = routerRun('strict', { mcp_servers: [] }, ['--no-router-mcp']);
  assert.equal(old.r.status, 0, String(old.r.stdout) + String(old.r.stderr));
  assert.ok(old.args.includes('--strict-mcp-config'));
  assert.match(String(old.r.stdout), /router runs without the router's MCP server/);
  assert.doesNotMatch(String(old.r.stdout), /router MCP server: /);
  assert.deepEqual([records(old.out)[0]!.routerMcp, records(old.out)[0]!.mcp.servers], [false, []]);

  // asked for the server, the session does not have it: exit 3, the cost is in the ledger, no record (it is run again)
  const missing = routerRun('missing', { mcp_servers: [] });
  assert.equal(missing.r.status, 3, String(missing.r.stdout) + String(missing.r.stderr));
  assert.match(String(missing.r.stderr), /stopped after c-l1-01\|auto \(\$0\.010 spent on it\): the router's MCP server is not in the session/);
  assert.deepEqual(records(missing.out), []);
  assert.match(fs.readFileSync(path.join(missing.out, 'ledger.jsonl'), 'utf8'), /"costUsd":0\.01/);
});
