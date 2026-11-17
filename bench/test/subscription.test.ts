// The bench's subscription mode, with a fake claude (bench/test/fake-claude.mjs): nothing here starts the real
// Claude Code, reads a login or touches the network. Temp folders only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStream, decimalsOf, isBuiltinPlugin } from '../src/subscription/stream.ts';
import { loadoutProblems, meterArgs, subscriptionEnv, taskArgs } from '../src/subscription/isolation.ts';
import { meterDeltas, type Reading } from '../src/subscription/meter.ts';
import { estimateBlock, fullPlan, loadSubConfig, pilotPlan, primaryMeter, tasksToMove } from '../src/subscription/plan.ts';
import { bootstrap, countedBlocks, decideLevel, pairsFor, ratioOf } from '../src/subscription/report.ts';
import type { BlockRecord } from '../src/subscription/run.ts';
import { cmdSub, realDeps } from '../src/subscription/cli.ts';
import { analyseCalibration, blockOutlook, blockPpd, type CalBlockRecord } from '../src/subscription/calibrate.ts';

const BENCH = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(BENCH, 'src', 'cli.ts');
const FAKE_KEY = 'sk-ant-api03-abcdefghijklmnop';
let tmp = '', fake = '', results = '';
const state = (s: Record<string, unknown> = {}) => fs.writeFileSync(path.join(path.dirname(fake), 'state.json'), JSON.stringify({
  version: '2.1.400', session: 10, sessionReset: new Date(Date.now() + 4 * 3600_000).toISOString(), weekly: 20, opus: 5,
  weeklyReset: new Date(Date.now() + 5 * 86400_000).toISOString(), directStep: 1.5, routerStep: 1, benchDir: BENCH, ...s,
}));
const calls = (): Array<{ args: string[]; env: string[]; cwd: string; input: string; started: number; ended: number }> => {
  const f = path.join(path.dirname(fake), 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sub-'));
  fs.mkdirSync(path.join(tmp, 'fake'));
  fake = path.join(tmp, 'fake', 'fake-claude.mjs');
  fs.copyFileSync(path.join(BENCH, 'test', 'fake-claude.mjs'), fake);
  results = path.join(tmp, 'results');
  state();
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 300_000,
  env: { ...process.env, BENCH_CLAUDE_BIN: fake, ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-from-the-parent', ANTHROPIC_AUTH_TOKEN: 'x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ...env },
});
const fast = ['--results-dir', '', '--lag-seconds', '0', '--late-seconds', '0', '--read-gap-seconds', '0'];
const fastArgs = () => { const a = [...fast]; a[1] = results; return a; };

test('stream-json: the init message, usage_report rows (scoped ones told apart), the result and rate-limit events', () => {
  const out = [
    { type: 'system', subtype: 'init', apiKeySource: 'none', claude_code_version: '2.1.400', model: 'claude-opus-5-5', plugins: [{ name: 'p' }], mcp_servers: [{ name: 'm', status: 'connected' }] },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Usage' }] }, usage_report: { rate_limits: { limits: [
      { kind: 'session', group: 'session', percent: 12.5, resets_at: '2026-11-16T15:00:00Z', is_active: true },
      { kind: 'weekly_scoped', percent: 3, resets_at: null, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 1, resets_at: null, scope: { model: { display_name: 'Sonnet' } } },
      { kind: 'weekly_all', percent: 'x' },
    ], extra_usage: { is_enabled: true } } } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } },
    { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, modelUsage: {} },
  ].map(x => JSON.stringify(x)).join('\n') + '\nnot json\n';
  const s = parseStream(out);
  assert.deepEqual([s.init?.apiKeySource, s.init?.version, s.init?.plugins, s.init?.mcpServers], ['none', '2.1.400', ['p'], [{ name: 'm', status: 'connected' }]]);
  assert.deepEqual(s.usageReport?.rows.map(r => [r.key, r.percent, r.resetsAt]), [['session', 12.5, '2026-11-16T15:00:00Z'], ['weekly_scoped:Opus', 3, null], ['weekly_scoped:Sonnet', 1, null]]);
  assert.equal(s.usageReport?.extraUsageEnabled, true);
  assert.deepEqual(s.rateLimitEvents, [{ status: 'allowed_warning', resetsAt: null, utilization: 0.9 }]);
  assert.deepEqual([s.result?.costUsd, s.badLines], [0, 1]);
  const plain = parseStream(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Current session: 12%' }] } }));
  assert.deepEqual([plain.usageReport, plain.usageText], [null, 'Current session: 12%']);
  assert.equal(decimalsOf([12, 12.5, 3.25]), 2);
});

test('isolation: no credential variable reaches the child, the login is the user\'s own (no --bare, no config dir of ours)', () => {
  const parent = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_AUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_BASE_URL: 'http://x', AWS_SECRET_ACCESS_KEY: 's', GITHUB_TOKEN: 'g', DO_IT_ALL_CLAUDE_CODE_HOME: '/r' };
  const direct = subscriptionEnv('direct', parent);
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CLAUDE_CONFIG_DIR', 'DO_IT_ALL_CLAUDE_CODE_HOME', 'DISABLE_TELEMETRY']) assert.ok(!(k in direct), k);
  assert.deepEqual([direct.CLAUDE_CODE_DISABLE_CLAUDE_MDS, direct.CLAUDE_CODE_DISABLE_AUTO_MEMORY, direct.ENABLE_CLAUDEAI_MCP_SERVERS, direct.DISABLE_AUTOUPDATER], ['1', '1', 'false', '1']);
  assert.equal(subscriptionEnv('router', parent).DO_IT_ALL_CLAUDE_CODE_HOME, '/r');
  assert.equal(subscriptionEnv('direct', { ...parent, CLAUDE_CONFIG_DIR: '/mine' }).CLAUDE_CONFIG_DIR, '/mine', 'the user\'s own config dir is passed on as it is');
  const o = { arm: 'direct' as const, settingSources: 'project,local', probeOut: '/p.jsonl' };
  for (const args of [meterArgs(o), taskArgs(o, { model: 'claude-opus-5-5', effort: 'high' }, 8), taskArgs({ ...o, arm: 'router', pluginDir: '/pl' }, { model: 'm', effort: 'e' }, 1)]) {
    assert.ok(!args.includes('--bare') && !args.includes('--dangerously-skip-permissions') && !args.some(a => /bypassPermissions/.test(a)));
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local');
    assert.ok(args.includes('--no-session-persistence'));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions: { deny: string[] }; statusLine: { command: string } };
    assert.ok(settings.permissions.deny.includes('Read(~/.claude/**)'));
    assert.match(settings.statusLine.command, /statusline-probe\.mjs" "\/p\.jsonl"$/);
  }
  assert.ok(meterArgs(o).includes('--strict-mcp-config'));
  assert.deepEqual(meterArgs(o).slice(0, 2), ['-p', '/usage'], 'the documented claude -p "/usage" form');
  const r = taskArgs({ ...o, arm: 'router', pluginDir: '/pl' }, { model: 'm', effort: 'e' }, 1);
  assert.deepEqual([r.includes('--strict-mcp-config'), r[r.indexOf('--plugin-dir') + 1], r[r.indexOf('--tools') + 1]], [false, '/pl', 'Read,Edit,Write,Glob,Grep,Bash,Agent']);
});

test('loadout: the subscription login, and per arm exactly the plugins and MCP servers it should have', () => {
  const init = (o: Record<string, unknown> = {}) => parseStream(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5', ...o })).init;
  assert.deepEqual(loadoutProblems(init(), 'direct', { lead: { model: 'claude-opus-5-5' } }), []);
  assert.match(loadoutProblems(init({ apiKeySource: 'ANTHROPIC_API_KEY' }), 'direct').join(), /would not use the subscription login/);
  assert.match(loadoutProblems(init({ plugins: [{ name: 'do-it-all-claude-code' }] }), 'direct').join(), /router plugin is loaded in the direct arm/);
  assert.match(loadoutProblems(init(), 'router').join(), /router plugin did not load.*router MCP server is missing/);
  const router = { plugins: [{ name: 'do-it-all-claude-code' }], mcp_servers: [{ name: 'plugin:do-it-all-claude-code:router', status: 'connected' }] };
  assert.deepEqual(loadoutProblems(init(router), 'router'), []);
  assert.match(loadoutProblems(init({ ...router, mcp_servers: [...router.mcp_servers, { name: 'claude.ai Figma', status: 'connected' }] }), 'router').join(), /other MCP servers loaded: claude\.ai Figma/);
  assert.match(loadoutProblems(init({ model: 'claude-sonnet-5-5' }), 'direct', { lead: { model: 'claude-opus-5-5' } }).join(), /not claude-opus-5-5/);
  assert.match(loadoutProblems(null, 'direct').join(), /no init message/);
});

test('meter deltas: a reset between readings, a window that ended, a value that went down, a meter that appeared', () => {
  const r = (rows: Array<[string, number, string | null]>): Reading => ({ rows: rows.map(([key, percent, resetsAt]) => ({ key, kind: key.split(':')[0]!, group: null, percent, resetsAt, scope: null, severity: null, isActive: false })) } as Reading);
  const t = '2026-11-16T15:00:00Z';
  const d = meterDeltas(r([['session', 10, t], ['weekly_all', 20, t], ['x', 5, t], ['y', 5, t]]), r([['session', 14.5, t], ['weekly_all', 2, '2026-11-23T15:00:00Z'], ['x', 4, t], ['y', 6, null], ['weekly_scoped:Opus', 1, t]]));
  assert.deepEqual(d.session, { from: 10, to: 14.5, delta: 4.5, valid: true });
  assert.deepEqual([d.weekly_all!.valid, d.weekly_all!.reason], [false, 'the window reset between the readings']);
  assert.deepEqual([d.x!.valid, d.y!.valid, d['weekly_scoped:Opus']!.valid, d['weekly_scoped:Opus']!.delta], [false, false, true, 1]);
  assert.equal(meterDeltas(r([['session', 1, t]]), r([['session', 2, '2026-11-16T15:00:30Z']]), 60).session!.valid, true, 'a few seconds of jitter is not a reset');
});

test('plan: the pilot is four tasks, one per level, in the direct arm; the full run alternates the first arm within each level', () => {
  const cfg = loadSubConfig();
  const p = pilotPlan(cfg);
  assert.deepEqual([p.blocks.length, p.blocks[0]!.arm, p.blocks[0]!.tasks.map(t => t.level)], [1, 'direct', ['L0', 'L1', 'L2', 'L3']]);
  const f = fullPlan(cfg, { levels: ['L2', 'L3'], pairs: 2 });
  assert.deepEqual(f.blocks.map(b => b.id), ['L2-p1-direct', 'L2-p1-router', 'L3-p1-router', 'L3-p1-direct', 'L2-p2-router', 'L2-p2-direct', 'L3-p2-direct', 'L3-p2-router']);
  const e = estimateBlock(f.blocks[0]!, cfg, f.lead, { meter: 'session', pointsPerTask: { L2: 4 }, minutesPerTask: {}, at: '' });
  assert.deepEqual([e.points, e.measured], [12, true]);
});

test('report: the outlier rule, the ratio of sums, a seeded bootstrap interval, and the stop rule', () => {
  const cfg = { ...loadSubConfig(), bootstrapResamples: 500 };
  const b = (pair: number, arm: 'direct' | 'router', delta: number, completed: number, costUsd: number, extra: Partial<BlockRecord> = {}): BlockRecord => ({
    blockId: `L2-p${pair}-${arm}`, kind: 'block', pair, order: 1, level: 'L2', arm, account: 'a', lead: 's5', leadModel: 'm', leadEffort: 'e', version: 'v',
    startedAt: '', wallMs: 0, before: '', after: '', runIds: [], tasks: 3, completed, costUsd, meters: { session: { from: 0, to: delta, delta, valid: true } }, discarded: null, notes: [], ...extra,
  });
  const blocks = [b(1, 'direct', 9, 3, 1), b(1, 'router', 6, 3, 1), b(2, 'direct', 10, 3, 1), b(2, 'router', 7, 3, 1), b(3, 'direct', 8, 2, 1), b(3, 'router', 5, 3, 1), b(4, 'direct', 40, 3, 1), b(4, 'router', 6, 3, 1)];
  const { counted, excluded } = countedBlocks(blocks, 'session', cfg);
  assert.deepEqual(excluded.map(e => e.block.blockId), ['L2-p4-direct'], 'moved far more than its tokens explain');
  assert.match(excluded[0]!.reason, /more than its tokens explain/);
  const pairs = pairsFor(counted, 'L2');
  assert.deepEqual(pairs.map(p => p.pair), [1, 2, 3]);
  const r = ratioOf(pairs);
  assert.deepEqual([r.direct, Math.round(r.router! * 1000) / 1000, Math.round(r.ratio! * 1000) / 1000], [27 / 8, 2, 0.593]);
  const iv = bootstrap(pairs, 500)!;
  assert.deepEqual(bootstrap(pairs, 500), iv, 'seeded: the same interval every time');
  assert.ok(iv.hi < 1);
  assert.equal(bootstrap(pairs.slice(0, 2), 500), null, 'fewer than three pairs: no interval');
  assert.match(decideLevel(blocks, 'L2', 'session', cfg).text, /the router uses less/);
  const same = [1, 2, 3].flatMap(p => [b(p, 'direct', 6, 3, 1), b(p, 'router', 6, 3, 1)]);
  assert.match(decideLevel(same, 'L2', 'session', cfg).text, /no difference beyond ±10%/);
  // a discarded block and an invalid delta do not count
  const { excluded: ex2 } = countedBlocks([b(1, 'direct', 9, 3, 1, { discarded: 'x: a rate-limit event' }), b(1, 'router', 6, 3, 1, { meters: { session: { from: 1, to: 0, delta: -1, valid: false, reason: 'the window reset between the readings' } } })], 'session', cfg);
  assert.deepEqual(ex2.map(e => e.reason), ['x: a rate-limit event', 'the window reset between the readings']);
});

test('the pilot through the CLI: --dry-run and a missing --subscription never start claude; the run makes the three checks', () => {
  let r = cli(['sub', '--pilot', '--dry-run', ...fastArgs()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  r = cli(['sub', '--pilot', ...fastArgs()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /add --subscription to run it/);
  assert.deepEqual(calls(), [], 'claude was never started');
  r = cli(['sub', '--pilot', '--subscription', '--plan', 'test-plan', ...fastArgs()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const p = JSON.parse(fs.readFileSync(path.join(results, 'pilot.json'), 'utf8'));
  assert.deepEqual([p.usageReport.ok, p.readingMovesMeter.met, p.statusLine.met, p.decimals], [true, true, true, 2], "the weekly rows carry two decimals");
  assert.deepEqual(p.perTask.map((t: { taskId: string; delta: number; pass: boolean }) => [t.taskId, t.delta, t.pass]),
    [['c-l0-01', 1.5, true], ['c-l1-01', 1.5, true], ['c-l2-01', 1.5, true], ['c-l3-01', 1.5, true]]);
  assert.equal(p.recommendedTasksPerBlock, 4);
  assert.match(r.stdout, /Check: reading \/usage does not move the meter: met/);
  // what claude was given: never a credential variable, never --bare, the user's settings not loaded, one workspace
  const c = calls();
  assert.equal(c.length, 1 + 3 + 4 + 4 + 1, 'the version, three readings, four tasks, a reading after each, a late one');
  for (const x of c) {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'BENCH_CLAUDE_BIN']) assert.ok(!x.env.includes(k), `${k} reached claude`);
    assert.ok(!x.args.includes('--bare'));
  }
  const tasks = c.filter(x => x.args.includes('--effort'));
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every(x => x.args.includes('--strict-mcp-config') && x.args[x.args.indexOf('--model') + 1] === 'claude-opus-5-5' && x.env.includes('CLAUDE_CODE_DISABLE_CLAUDE_MDS')));
  assert.equal(new Set(tasks.map(x => fs.realpathSync(x.cwd))).size, 1, 'one fixed workspace path');
  for (const f of ['readings.jsonl', 'runs.jsonl', 'blocks.jsonl']) assert.ok(!fs.readFileSync(path.join(results, f), 'utf8').includes(FAKE_KEY));
  r = cli(['sub-report', '--results-dir', results]);
  assert.match(r.stdout, /## Pilot[\s\S]*reading \/usage leaves the meter as it was: yes[\s\S]*\| direct \| claude-opus-5-5 \| 4 \|/);
});

test('the pilot stops at the first check when /usage has no usage_report, and when the run is not on the subscription login', () => {
  state({ noUsageReport: true });
  let r = cli(['sub', '--pilot', '--subscription', ...fastArgs()]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /usage_report: NOT MET/);
  assert.equal(calls().filter(x => x.args.includes('--effort')).length, 0, 'no task ran');
  fs.rmSync(path.join(tmp, 'fake', 'calls.jsonl'));
  state({ apiKeySource: 'ANTHROPIC_API_KEY' });
  r = cli(['sub', '--pilot', '--subscription', ...fastArgs()]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /would not use the subscription login/);
  assert.equal(calls().filter(x => x.args.includes('--effort')).length, 0);
  state({ session: 79 });
  r = cli(['sub', '--pilot', '--subscription', ...fastArgs()]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /STOP: session is at 79% and the next work needs about 6\.5 points/);
});

test('when the status line does run under -p, the pilot says so and keeps only rate_limits and the model', () => {
  state({ runStatusLine: true });
  const r = cli(['sub', '--pilot', '--subscription', ...fastArgs()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /the status line does not run under -p: NOT MET \(4 status line runs recorded\)/);
  const dir = path.join(results, 'statusline');
  const lines = fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)).map(l => JSON.parse(l));
  assert.equal(lines.length, 4);
  for (const l of lines) assert.deepEqual(Object.keys(l).sort(), ['at', 'model', 'rate_limits']);
});

test('the full run: paired blocks with both arms, guards before a block, a rerun resumes, the stop rule, the report', async () => {
  const home = path.join(tmp, 'router-home');
  const plugin = path.join(tmp, 'plugin');
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ daemonPort: 47999, pluginDir: plugin }));
  const prevHome = process.env.DO_IT_ALL_CLAUDE_CODE_HOME, prevBin = process.env.BENCH_CLAUDE_BIN;
  process.env.DO_IT_ALL_CLAUDE_CODE_HOME = home;
  process.env.BENCH_CLAUDE_BIN = fake;
  const out: string[] = [];
  let healthy = true;
  const deps = () => ({
    ...realDeps(), out: (l: string) => { out.push(l); }, sleep: async () => {}, daemonHealthy: async () => healthy, patch: async () => '',
    prepare: async (_t: unknown, root: string) => { fs.mkdirSync(path.join(root, 'repo'), { recursive: true }); return { repo: path.join(root, 'repo') }; },
    grade: async () => ({ pass: true, detail: 'ok' }),
  });
  const flags = (o: Record<string, string | boolean> = {}) => ({ subscription: true, levels: 'L3', pairs: '5', 'results-dir': results, 'lag-seconds': '0', plan: 'test-plan', ...o });
  try {
    healthy = false;
    assert.equal(await cmdSub(flags(), deps), 2);
    assert.match(out.join('\n'), /router daemon does not answer on 127\.0\.0\.1:47999/);
    assert.deepEqual(calls(), [], 'nothing ran');
    healthy = true;
    state({ session: 70 });
    assert.equal(await cmdSub(flags(), deps), 3);
    assert.match(out.join('\n'), /STOP: session is at 70%/);
    state({ session: 10, sessionReset: new Date(Date.now() + 10 * 60_000).toISOString() });
    assert.equal(await cmdSub(flags(), deps), 3);
    assert.match(out.join('\n'), /too soon for about \d+ min of work/);
    // room enough: pairs run until the stop rule decides L3 (three pairs: the router uses less)
    state({ session: 10 });
    fs.rmSync(path.join(tmp, 'fake', 'calls.jsonl'), { force: true });
    assert.equal(await cmdSub(flags({ pairs: '2' }), deps), 0);
    assert.equal(await cmdSub(flags(), deps), 0, 'a rerun with more pairs resumes');
    const blocks = fs.readFileSync(path.join(results, 'blocks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as BlockRecord);
    assert.deepEqual(blocks.map(b => b.blockId), ['L3-p1-direct', 'L3-p1-router', 'L3-p2-router', 'L3-p2-direct', 'L3-p3-direct', 'L3-p3-router']);
    assert.match(out.join('\n'), /skip L3-p1 \(recorded\)[\s\S]*L3: ratio 0\.67 \[0\.67, 0\.67\]: the router uses less \(stop rule[\s\S]*skip L3-p4: the L3 result is already decided/);
    assert.deepEqual(blocks.map(b => b.meters.session!.delta), [3, 2, 2, 3, 3, 2]);
    const routerCalls = calls().filter(x => x.args.includes('--plugin-dir'));
    assert.ok(routerCalls.length > 0 && routerCalls.every(x => x.env.includes('DO_IT_ALL_CLAUDE_CODE_HOME') && !x.args.includes('--strict-mcp-config')));
    const report = spawnSync(process.execPath, [CLI, 'sub-report', '--results-dir', results], { encoding: 'utf8' }).stdout;
    assert.match(report, /\| L3 \| session \| 1\.50 \| 1\.00 \| 0\.67 \| 0\.67 to 0\.67 \| 3 \| the router uses less \|/);
  } finally {
    if (prevHome === undefined) delete process.env.DO_IT_ALL_CLAUDE_CODE_HOME; else process.env.DO_IT_ALL_CLAUDE_CODE_HOME = prevHome;
    if (prevBin === undefined) delete process.env.BENCH_CLAUDE_BIN; else process.env.BENCH_CLAUDE_BIN = prevBin;
  }
});

test('Claude Code\'s built-in plugins are a baseline: allowed in both arms, recorded, and the same in every reading', () => {
  const builtins = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map(name => ({ name, path: 'builtin', source: `${name}@builtin` }));
  const init = (plugins: unknown[], mcp: unknown[] = []) => parseStream(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', plugins, mcp_servers: mcp })).init!;
  const d = init(builtins);
  assert.deepEqual(d.builtinPlugins, ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-privacy', 'cc-plugin-telemetry']);
  assert.deepEqual(d.pluginEntries[0], { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }, 'the entries as sent');
  assert.deepEqual(loadoutProblems(d, 'direct'), []);
  const r = init([...builtins, { name: 'do-it-all-claude-code' }], [{ name: 'plugin:do-it-all-claude-code:router', status: 'connected' }, { name: 'plugin:cc-plugin-telemetry:t', status: 'connected' }]);
  assert.deepEqual(loadoutProblems(r, 'router', { builtinBaseline: d.builtinPlugins }), [], 'a built-in plugin\'s own MCP server is baseline too');
  assert.match(loadoutProblems(init([...builtins, { name: 'my-plugin' }]), 'direct').join(), /other plugins loaded: my-plugin/);
  assert.match(loadoutProblems(init(builtins.slice(1)), 'direct', { builtinBaseline: d.builtinPlugins }).join(), /built-in plugins differ from the first reading/);
  // explicit markers win over the name
  // the marker decides: a cc-plugin-* name with a real path or another source is the user's
  assert.ok(isBuiltinPlugin({ name: 'x', path: 'builtin', source: 'x@builtin' }) && isBuiltinPlugin({ name: 'anything', builtin: true }) && isBuiltinPlugin({ name: 'cc-plugin-old' }));
  assert.ok(!isBuiltinPlugin({ name: 'cc-plugin-fake', path: '/home/x/plugins/cc-plugin-fake' }) && !isBuiltinPlugin({ name: 'cc-plugin-fake', source: 'cc-plugin-fake@my-marketplace' }));
  assert.ok(!isBuiltinPlugin({ name: 'cc-plugin-' }) && !isBuiltinPlugin({ name: 'my-cc-plugin-x' }) && !isBuiltinPlugin({ name: 'do-it-all-claude-code', path: '/home/x/plugin' }));
});

test('integer meters: tasks needed to move a meter measurably, with the range its resolution leaves; the primary meter', () => {
  assert.deepEqual(tasksToMove(2, 4, 5, 0), { perTask: 0.5, needed: 10, low: 7, high: 20, text: 'about 10 tasks to move it 5 points (7 to 20 with its 1-point resolution)' });
  assert.deepEqual([tasksToMove(0, 4, 5, 0).low, tasksToMove(0, 4, 5, 0).needed], [20, null]);
  assert.match(tasksToMove(0, 4, 5, 0).text, /did not move over 4 task\(s\): at least 20 tasks/);
  assert.deepEqual([tasksToMove(1, 4, 5, 0).needed, tasksToMove(1, 4, 5, 0).high], [20, null], 'a 1-point move could be almost nothing');
  assert.equal(tasksToMove(6, 4, 5, 1).needed, 4);
  assert.deepEqual([primaryMeter(['weekly_all', 'session']), primaryMeter(['weekly_scoped:Fable', 'weekly_all']), primaryMeter(['x']), primaryMeter([])], ['session', 'weekly_all', 'x', null]);
});

test('an account without the 5-hour row and with whole-number percents: the pilot runs on the weekly meters and says how many tasks they need', () => {
  state({ noSession: true, integer: true, weekly: 10, opus: 8, scopedName: 'Fable', weeklyStep: 0.6, scopedStep: 0 });
  let r = cli(['sub', '--pilot', '--subscription', '--plan', 'max-20x', ...fastArgs()]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Claude Code's built-in plugins \(a baseline, the same in both arms\): cc-plugin-agents-md, cc-plugin-plugin-authoring, cc-plugin-privacy, cc-plugin-telemetry/);
  assert.match(r.stdout, /no 5-hour \(session\) row, so the pilot judges on weekly_all/);
  assert.match(r.stdout, /weekly_all \(0 decimals\): moved 2 over 4 tasks \(\$1\.60 API-priced\); about 10 tasks to move it 5 points \(7 to 20 with its 1-point resolution\); by level, tasks to move it 5: L0 10, L1 10, L2 10, L3 10/);
  assert.match(r.stdout, /weekly_scoped:Fable \(0 decimals\): moved 0 over 4 tasks .*did not move over 4 task\(s\): at least 20 tasks/);
  const p = JSON.parse(fs.readFileSync(path.join(results, 'pilot.json'), 'utf8'));
  assert.deepEqual([p.noSessionRow, p.primaryMeter, p.meters.weekly_all.total, p.meters.weekly_all.decimals, p.recommendedTasksPerBlock], [true, 'weekly_all', 2, 0, 10]);
  const readings = fs.readFileSync(path.join(results, 'readings.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(readings.every(x => x.builtinPlugins.length === 4 && x.plugins.length === 4), 'every reading records the built-ins');
  // the dry runs afterwards: the meters the account has, and estimates on weekly_all from the pilot
  r = cli(['sub', '--pilot', '--dry-run', ...fastArgs()]);
  assert.match(r.stdout, /meters at the last reading \([^)]*\): weekly_all 12%[^\n]*weekly_scoped:Fable 8%/);
  assert.match(r.stdout, /no 5-hour \(session\) row on this account: the estimates and the judgement are on weekly_all/);
  r = cli(['sub', '--levels', 'L2', '--pairs', '2', '--dry-run', ...fastArgs()]);
  assert.match(r.stdout, /points of weekly_all \(per-task points measured by the pilot\)/);
  assert.match(r.stdout, /weekly_all has room for ~68 points before the 80% guard/);
});

test('a plugin the user installed still stops the pilot at the first reading', () => {
  state({ userPlugins: ['my-plugin'] });
  const r = cli(['sub', '--pilot', '--subscription', ...fastArgs()]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /other plugins loaded: my-plugin/);
  assert.equal(calls().filter(x => x.args.includes('--effort')).length, 0);
});

const calRecord = (model: string, from: number, to: number, usd: number, perModel: Record<string, number> = { [model]: usd }): CalBlockRecord => ({
  blockId: `cal-${model}`, config: 'x', model, effort: 'high', concurrency: 1, account: 'a', version: 'v', startedAt: '', wallMs: 0, before: '', after: '', runIds: [],
  tasks: 4, completed: 4, usd, meters: { weekly_all: { from, to, delta: to - from, valid: true } }, steps: { weekly_all: 1 }, stopReason: 'target', discarded: null, builtinPlugins: [],
  perModel: Object.fromEntries(Object.entries(perModel).map(([m, u]) => [m, { runs: 1, usd: u, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }])),
});

test('calibration maths: points per dollar with ±1 rounding, the ratio and its range, the joint solve with a helper model, the claim', () => {
  const opus = calRecord('claude-opus-5-5', 12, 17, 10), haiku = calRecord('claude-haiku-5-5', 17, 22, 1);
  assert.deepEqual(blockPpd(opus, 'weekly_all'), { model: 'claude-opus-5-5', family: 'opus', points: 5, step: 1, usd: 10, ppd: 0.5, low: 0.4, high: 0.6 });
  const a = analyseCalibration([opus, haiku], { claim: 0.33 })!;
  assert.deepEqual([a.meter, a.ratio!.of, a.ratio!.to, a.ratio!.value], ['weekly_all', 'haiku', 'opus', 10]);
  assert.deepEqual([Math.round(a.ratio!.low * 100) / 100, Math.round(a.ratio!.high * 100) / 100], [6.67, 15]);
  assert.equal(a.solved, null, 'single-model blocks need no joint solve');
  const half = a.implication.find(i => i.share === 0.5)!;
  assert.equal(Math.round(half.breakEven * 100) / 100, 1.99);
  assert.ok(Math.abs(half.atValue! - 0.67 * 5.5) < 1e-9, 'at r = 10 the router would cost 3.7 times direct on the meter');
  // a helper Haiku inside the Opus sessions: the joint solve splits it out
  const mixed = analyseCalibration([calRecord('claude-opus-5-5', 12, 17, 10, { 'claude-opus-5-5': 8, 'claude-haiku-5-5': 2 }), haiku], { claim: 0.33 })!;
  assert.ok(mixed.solved);
  assert.ok(mixed.solved!.rateB[0] <= 5 && mixed.solved!.rateB[1] >= 5);
  // zero movement: the low side is 0 and the ratio's top is unbounded
  const flat = analyseCalibration([calRecord('claude-opus-5-5', 12, 12, 10), haiku], { claim: 0.33 })!;
  assert.deepEqual([flat.ratio!.value, flat.ratio!.high], [null, Infinity]);
  // a block's outlook: the target or a cap, whichever comes first
  const plan = { config: { id: 's2', label: '', model: 'claude-haiku-5-5', effort: 'high', group: '' }, concurrency: 4, caps: { usd: 3, tasks: 600, minutes: 150 }, tasks: [], meanUsd: 0.0127, meanMinutes: 1.5, sources: [] };
  assert.equal(blockOutlook(plan, 0.45, 5).endsAt, 'the $3 cap');
  assert.equal(blockOutlook(plan, 18, 5).endsAt, 'the 5-point target');
});

test('calibration through the CLI: --dry-run and a missing --subscription start nothing; a run measures both blocks, the second in parallel', () => {
  state({ noSession: true, integer: true, weekly: 12, opus: 10, scopedName: 'Fable', scopedStep: 0, pointsPerDollar: { opus: 0.5, haiku: 5 }, costByModel: { opus: 2.5, haiku: 0.1 }, taskMs: 300 });
  const args = ['sub', '--calibrate', ...fastArgs(), '--read-every-seconds', '0', '--concurrency', '3'];
  let r = cli([...args, '--dry-run', '--plan', 'max-20x']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /block 2 {2}s2 · Haiku 5\.5 · high {2}concurrency 3/);
  assert.match(r.stdout, /if it counted haiku tokens like opus tokens \(40x per dollar\): ends at the 5-point target/);
  r = cli(args);
  assert.equal(r.status, 2);
  assert.deepEqual(calls(), [], 'claude was never started');
  r = cli([...args, '--subscription', '--plan', 'max-20x']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const recs = fs.readFileSync(path.join(results, 'calibration.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as CalBlockRecord);
  assert.deepEqual(recs.map(x => [x.blockId, x.model]), [['cal-s5', 'claude-opus-5-5'], ['cal-s2', 'claude-haiku-5-5']]);
  assert.deepEqual([recs[0]!.tasks, recs[0]!.usd, recs[0]!.meters.weekly_all!.delta, Object.keys(recs[0]!.perModel), Object.keys(recs[1]!.perModel)], [4, 10, 5, ['claude-opus-5-5'], ['claude-haiku-5-5']]);
  assert.ok(recs[1]!.tasks >= 9 && recs[1]!.tasks <= 11, `${recs[1]!.tasks} Haiku tasks`);
  assert.match(recs[1]!.stopReason, /weekly_all moved [56] points \(the target is 5\)/);
  const a = analyseCalibration(recs, { claim: 0.33 })!;
  assert.ok(a.ratio!.value! > 7 && a.ratio!.value! < 13 && a.ratio!.low > 3, JSON.stringify(a.ratio));
  assert.match(r.stdout, /haiku ÷ opus, points per API-priced dollar: \d/);
  // the Haiku tasks ran up to three at a time, each in its own workspace; every task was the block's model at high effort
  const tasks = calls().filter(x => x.args.includes('--effort'));
  const hk = tasks.filter(x => x.args[x.args.indexOf('--model') + 1] === 'claude-haiku-5-5');
  const overlap = Math.max(...hk.map(x => hk.filter(y => y.started < x.ended && y.ended > x.started).length));
  assert.ok(overlap >= 2 && overlap <= 3, `at most 3 at a time, and some together (${overlap})`);
  assert.ok(new Set(hk.map(x => path.basename(path.dirname(x.cwd)))).size >= 2);
  assert.ok(tasks.every(x => x.args[x.args.indexOf('--effort') + 1] === 'high' && !x.env.includes('ANTHROPIC_API_KEY')));
  const report = cli(['sub-report', '--results-dir', results]).stdout;
  assert.match(report, /## Calibration: does the weekly meter follow API prices across models\?[\s\S]*\| cal-s5 \| claude-opus-5-5 \| 4 \(4\) \| 1 \| 10\.000 \| 12→17 \| 10→10 \|/);
});

test('calibration guards: the weekly reset too near, the 80% guard, the calibration total; a rerun skips recorded blocks', () => {
  const base = { noSession: true, integer: true, weekly: 12, opus: 10, scopedStep: 0, pointsPerDollar: { opus: 0.5, haiku: 5 }, costByModel: { opus: 2.5, haiku: 0.1 } };
  const args = ['sub', '--calibrate', '--subscription', ...fastArgs(), '--read-every-seconds', '0'];
  state({ ...base, weeklyReset: new Date(Date.now() + 40 * 60_000).toISOString() });
  let r = cli(args);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /STOP before cal-s5: the weekly_all window resets at .*too soon/);
  state({ ...base, weekly: 76 });
  r = cli(args);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /STOP before cal-s5: weekly_all is at 76% and the next work needs about 5\.0 points/);
  assert.equal(calls().filter(x => x.args.includes('--effort')).length, 0, 'no task ran');
  state(base);
  r = cli([...args, '--max-total-points', '6']);
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /STOP before cal-s2: 5 weekly points used so far: another 5 would pass the 6-point total/);
  r = cli([...args, '--cap-tasks', '3']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skip cal-s5 \(recorded\)[\s\S]*cal-s2: 3 tasks .*stopped: the 3-task cap/);
});
