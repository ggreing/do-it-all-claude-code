// Decision 186: the team office's read route (/router/v1/office) and the office's helper (plugin/office/bridge.mjs),
// which makes the sealed calls for the office module and writes what it read as JSON lines. A real test daemon; a
// temporary router home; never the user's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKOFF_MS, LINE_VERSION, applyBody, parentAlive, parseArgs, run, runApply, withoutPrompt } from '../../../plugin/office/bridge.mjs';
import { call as sealedApi, makeRepo, postHook, request, rmrf, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
const BRIDGE = fileURLToPath(new URL('../../../plugin/office/bridge.mjs', import.meta.url));
const TOKEN_FILE = (home: string) => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
type Line = { v: number; type: string; reach?: string; view?: any; data?: any; error?: string; period?: string; id?: string; status?: number };

/** A daemon with one L2 request whose coder A passed verify with 3 tests; config.json holds the daemon's port. */
async function withTeam(fn: (d: TestDaemon, sid: string) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n', 'README.md': 'x\n' });
  let script = '';
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [{ kind: 'test' as const, command: `node "${script}"` }] } });
  script = path.join(d.home, 'count.cjs').split(path.sep).join('/');
  fs.writeFileSync(script, "console.log('\\u2139 pass 3'); console.log('\\u2139 fail 0');\n");
  const cfg = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(d.home, 'config.json'), JSON.stringify({ ...cfg, daemonPort: d.port }));
  const sid = 'office-1';
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: sid, cwd: repo, transcript_path: path.join(d.home, `${sid}.jsonl`), ...h });
    assert.equal(r.status, 200, r.text);
  };
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_o1',
      tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] work\n[scope: src/**]', model: 'sonnet', effort: 'medium' } });
    await post({ hook_event_name: 'SubagentStart', agent_id: 'ag-1', agent_type: 'do-it-all-claude-code:coder' });
    write(repo, 'src/b.ts', 'b\n');
    await post({ hook_event_name: 'SubagentStop', agent_id: 'ag-1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
    await fn(d, sid);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

/** Runs the helper's loop in this process until `until` holds for the lines written so far. */
async function lines(opts: Parameters<typeof run>[0], home: string | null, until: (l: Line[]) => boolean, ms = 8000): Promise<Line[]> {
  const out: Line[] = [];
  const stop = run(opts, { home, write: (line: string) => { out.push(JSON.parse(line)); return true; } });
  const t0 = Date.now();
  try {
    while (!until(out) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 50));
  } finally { stop(); }
  return out;
}

// ------------------------------------------------------------------ the route

test('decision 186: /router/v1/office: level, the subtask with its plan, the checks with test counts; no paths or output', () => withTeam(async (d, sid) => {
  const r = await sealedApi(d.port, { path: `/router/v1/office?session_id=${sid}` });
  assert.equal(r.status, 200, r.text);
  const v = r.body as Record<string, any>;
  assert.equal(v.request.level, 'L2');
  const s = v.subtasks[0];
  assert.deepEqual([s.id, s.role, s.step, s.model, s.effort, s.status, s.agentId], ['A', 'coder', 's3', 'sonnet', 'medium', 'passed', 'ag-1']);   // decision 226: moderate default coder
  assert.deepEqual(s.checks, [{ kind: 'test', result: 'ok', testsPassed: 3, testsFailed: 0 }, { kind: 'scope', result: 'ok' }]);
  assert.deepEqual(s.scope, ['src/**']);
  assert.equal('clients' in v, false);
  assert.doesNotMatch(JSON.stringify(v), /pass 3|count\.cjs|node "/);
}));

test('decision 186: /router/v1/office needs a session id, and only a sealed call gets in', () => withTeam(async d => {
  assert.equal((await sealedApi(d.port, { path: '/router/v1/office' })).status, 400);
  assert.equal((await request(d.port, { path: '/router/v1/office?session_id=office-1' })).status, 401);
  const none = await sealedApi(d.port, { path: '/router/v1/office?session_id=nobody' });
  assert.equal(none.status, 200);
  assert.equal((none.body as { request: unknown }).request, null);
}));

// ------------------------------------------------------------------ the helper

test('decision 186 helper: the office line from a running daemon; the token is in no line', () => withTeam(async (d, sid) => {
  const out = await lines(parseArgs(['--session', sid, '--interval', '200']), d.home, l => l.some(x => x.type === 'office' && x.reach === 'ok'));
  const office = out.find(x => x.type === 'office' && x.reach === 'ok')!;
  assert.ok(office, JSON.stringify(out));
  assert.equal(office.v, LINE_VERSION);
  assert.equal(office.view.subtasks[0].id, 'A');
  assert.doesNotMatch(JSON.stringify(out), new RegExp(TOKEN_FILE(d.home)));
}));

test('decision 186 helper: a line only when something changed', () => withTeam(async (d, sid) => {
  const out: Line[] = [];
  const stop = run(parseArgs(['--session', sid, '--interval', '200']), { home: d.home, write: (line: string) => { out.push(JSON.parse(line)); return true; } });
  await new Promise(r => setTimeout(r, 1500));
  stop();
  assert.equal(out.filter(x => x.type === 'office').length, 1, 'a quiet team writes one line');
}));

test('decisions 193, 194 helper: the tabs Work, Savings, Team, Settings; a request detail never carries the prompt', () => withTeam(async (d, sid) => {
  for (const tab of ['work', 'savings', 'team', 'settings'] as const) {
    const out = await lines(parseArgs(['--session', sid, '--tab', tab, '--period', '24h', '--interval', '200']), d.home, l => l.some(x => x.type === tab));
    const line = out.find(x => x.type === tab)!;
    assert.ok(line, `${tab}: ${JSON.stringify(out)}`);
    // data, or (where a route is not in yet) the daemon's answer as an error line
    assert.ok(line.data !== undefined && (line.data !== null || typeof line.error === 'string'), JSON.stringify(line));
    if (tab === 'savings' || tab === 'team') assert.equal(line.period, '24h');
  }
  const det = await lines(parseArgs(['--session', sid, '--tab', 'work', '--detail', 'r-nope', '--interval', '200']), d.home, l => l.some(x => x.type === 'work-detail'));
  const dl = det.find(x => x.type === 'work-detail')!;
  assert.ok(dl && dl.id === 'r-nope' && !('prompt' in (dl.data ?? {})), JSON.stringify(dl));
  assert.doesNotMatch(JSON.stringify(det), new RegExp(TOKEN_FILE(d.home)));
  // the prompt is dropped from a detail, and only its being there is said
  assert.deepEqual(withoutPrompt({ requestId: 'r', prompt: 'secret words', hasPrompt: true }), { requestId: 'r', hasPrompt: true });
  assert.deepEqual(withoutPrompt({ requestId: 'r', prompt: null, hasPrompt: false }), { requestId: 'r', hasPrompt: false });
}));

test('decision 194 helper: a settings change is one sealed POST and one line; a change of another shape is not sent', () => withTeam(async (d, sid) => {
  const out: Line[] = [];
  await runApply(parseArgs(['--session', sid, '--apply']), JSON.stringify({ revision: { config: 'r' }, set: { profile: 'quality' } }), { home: d.home, write: (l: string) => { out.push(JSON.parse(l)); return true; } });
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0]!.type, 'applied');
  // the daemon's answer as it came (the route's own tests say what it writes)
  assert.equal(typeof out[0]!.status, 'number', JSON.stringify(out));
  assert.doesNotMatch(JSON.stringify(out), new RegExp(TOKEN_FILE(d.home)));
  const refused: Line[] = [];
  for (const bad of ['not json', '{"set":{}}', '{"set":{"a b":1}}', '{"set":{"x":{"y":1}}}', '{"set":{"__proto__":1}}', JSON.stringify({ set: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])) })]) {
    assert.equal(applyBody(bad), null, bad);
    await runApply(parseArgs(['--apply']), bad, { home: d.home, write: (l: string) => { refused.push(JSON.parse(l)); return true; } });
  }
  assert.ok(refused.every(x => x.type === 'applied' && typeof x.error === 'string' && x.status === undefined), JSON.stringify(refused));
  assert.deepEqual(applyBody(JSON.stringify({ revision: { config: 'a', presets: 'b', other: 'c' }, set: { 'budgetsUsd.L2': 3, 'team.L2.coder.count': 2, office: null } })),
    { revision: { config: 'a', presets: 'b' }, set: { 'budgetsUsd.L2': 3, 'team.L2.coder.count': 2, office: null } });
  // no router home: said so, nothing sent
  const none: Line[] = [];
  await runApply(parseArgs(['--apply']), '{"set":{"profile":"save"}}', { home: null, write: (l: string) => { none.push(JSON.parse(l)); return true; } });
  assert.match(String(none[0]?.error), /not set up/);
}));

test('decision 186 helper: no router home, no session: a setup line; a stopped daemon: down, waiting 1 s, 5 s, 30 s', async () => {
  const none = await lines(parseArgs(['--session', 's']), null, l => l.length > 0);
  assert.deepEqual(none, [{ v: 1, type: 'office', reach: 'setup', view: null }]);
  assert.deepEqual(BACKOFF_MS, [1000, 5000, 30_000]);
  const d = await startTestDaemon();
  const cfg = JSON.parse(fs.readFileSync(path.join(d.home, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(d.home, 'config.json'), JSON.stringify({ ...cfg, daemonPort: d.port }));
  await d.close();
  try {
    const t0 = Date.now();
    const writes: number[] = [];
    const stop = run(parseArgs(['--session', 's', '--interval', '200']), { home: d.home, write: () => { writes.push(Date.now() - t0); return true; } });
    await new Promise(r => setTimeout(r, 1800));
    stop();
    assert.equal(writes.length, 1, 'one down line, then quiet while it waits');
  } finally { rmrf(d.home); }
});

test('decision 186 helper: arguments outside the allowed set fall back; a session or request id with odd characters is refused', () => {
  assert.deepEqual(parseArgs(['--session', 'a b', '--tab', 'history', '--period', '1y', '--detail', '../x', '--interval', '5']),
    { session: '', tab: 'office', period: '7d', detail: '', interval: 200, apply: false });
  assert.equal(parentAlive(process.pid), true);
  assert.equal(parentAlive(0), false);
});

test('decision 186 helper: as a process it writes JSON lines, and it ends when its parent is gone', async () => {
  const home = tmpDir('office-bridge');
  try {
    // a parent that starts the helper and exits at once
    const parent = `const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, [${JSON.stringify(BRIDGE)}, '--session', 's'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true,
        env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: ${JSON.stringify(home)}, HOME: ${JSON.stringify(home)}, USERPROFILE: ${JSON.stringify(home)} } });
      c.stdout.once('data', d => { process.stdout.write(c.pid + ' ' + d.toString()); process.exit(0); });`;
    const r = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8', timeout: 20_000 });
    const [pid, ...rest] = r.stdout.trim().split(' ');
    const line = JSON.parse(rest.join(' ')) as Line;
    assert.equal(line.type, 'office');
    assert.equal(line.reach, 'setup');
    const childPid = Number(pid);
    let alive = true;
    const t0 = Date.now();
    while (alive && Date.now() - t0 < 10_000) {
      await new Promise(res => setTimeout(res, 250));
      try { process.kill(childPid, 0); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the helper ended after its parent');
  } finally { rmrf(home); }
});

test('decision 186 helper: it ends when its stdout is closed', async () => {
  const home = tmpDir('office-bridge');
  try {
    const c = spawn(process.execPath, [BRIDGE, '--session', 's', '--interval', '200'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      env: { ...process.env, DO_IT_ALL_CLAUDE_CODE_HOME: home, HOME: home, USERPROFILE: home } });
    await new Promise<void>(res => c.stdout!.once('data', () => res()));
    const ended = new Promise<number | null>(res => c.on('exit', code => res(code)));
    c.stdout!.destroy();
    const code = await Promise.race([ended, new Promise<string>(res => setTimeout(() => res('still running'), 40_000))]);
    if (code === 'still running') c.kill();
    assert.notEqual(code, 'still running');
  } finally { rmrf(home); }
});
