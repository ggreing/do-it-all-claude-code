// Decision 192: writers with disjoint scopes may share the user's checkout. While another writer of the request is
// still changing that tree, a writer that stops gets the scope check only (a build or a test would judge the
// other's half-made changes); its verdict is held, neither pass nor miss. The last writer's stop runs the commands
// on the whole tree: a pass covers the held ones, a failure names them to the lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeProjectState } from '@do-it-all-claude-code/core';
import { pinRoutine, call as sealed, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } };

// the shipped role files: the router reads from them which roles write
const PLUGIN_DIR = fileURLToPath(new URL('../../../plugin', import.meta.url));

// verify passes only when docs/ok.md exists; every run is counted
const CHECK = 'const fs = require("node:fs"); fs.appendFileSync(process.env.RUNS, "x"); process.exit(fs.existsSync("docs/ok.md") ? 0 : 1)\n';

async function withTwoWriters(fn: (d: TestDaemon, repo: string, post: (h: HookInput) => Promise<Out>, runs: () => number) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n', 'docs/x.md': 'x\n' });
  let counter = '';
  const d = await startTestDaemon({ config: { pluginDir: PLUGIN_DIR }, verify: { resolveCommands: async () => [{ kind: 'test', command: `RUNS="${counter}" node "${counter}.cjs"` }] } });
  counter = path.join(d.home, 'runs').split(path.sep).join('/');
  write(d.home, 'runs.cjs', CHECK);
  write(d.home, 'runs', '');
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const fs = await import('node:fs');
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    pinRoutine(d);
    await d.router.drain();
    await fn(d, repo, post, () => fs.readFileSync(path.join(d.home, 'runs'), 'utf8').length);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
let seq = 0;
const dispatch = (tag: string, scope: string): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_st${++seq}`,
  tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work\n[scope: ${scope}]`, model: 'haiku', effort: 'low' },
});
const start = (id: string): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' });
const stop = (id: string, again = false): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: again });
const notify = (id: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
const subtasks = (d: TestDaemon) => Object.fromEntries(rows(d, 'SELECT id, status, verdict FROM subtasks').map(r => [String(r.id), `${r.status}/${r.verdict}`]));

/** Both writers run in the checkout; A changes src and stops while B is still working. */
async function firstStops(post: (h: HookInput) => Promise<Out>, repo: string): Promise<string> {
  assert.deepEqual(await post(dispatch('A', 'src/**')), {});
  await post(start('a1'));
  assert.deepEqual(await post(dispatch('B', 'docs/**')), {});
  await post(start('b1'));
  write(repo, 'src/a.ts', 'a changed\n');
  write(repo, 'docs/half.md', 'B is in the middle of this\n');
  assert.deepEqual(await post(stop('a1')), {}, 'not blocked: nothing failed');
  return (await post(notify('a1'))).hookSpecificOutput?.additionalContext ?? '';
}

test('decision 192: a writer that stops while another still changes the shared tree gets the scope check only (held)', () => withTwoWriters(async (d, repo, post, runs) => {
  const told = await firstStops(post, repo);
  assert.equal(runs(), 0, 'the verify command did not run');
  assert.deepEqual(subtasks(d), { A: 'hitl/held', B: 'running/null' });
  assert.match(told, /subtask A .*: scope ok, not verified on its own .*: subtask B was still changing files in the same work tree/);
  assert.doesNotMatch(told, /verify failed|ask the user/i);
  const scope = rows(d, "SELECT kind, ok, detail FROM signals WHERE subtask_id = 'A'");
  assert.deepEqual(scope.map(x => [x.kind, x.ok]), [['scope', 1]]);
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM step_changes')[0]!.c, 0);
}));

test('decision 192: the last writer\'s verify runs on the whole tree; when it passes, the held writer passes with it', () => withTwoWriters(async (d, repo, post, runs) => {
  await firstStops(post, repo);
  write(repo, 'docs/ok.md', 'ok\n');
  assert.deepEqual(await post(stop('b1')), {});
  assert.equal(runs(), 1);
  assert.deepEqual(subtasks(d), { A: 'passed/meet', B: 'passed/meet' });
}));

test('decision 192: when the last writer\'s verify fails, the lead is told whose changes it also saw; the miss stays with the last writer', () => withTwoWriters(async (d, repo, post, runs) => {
  await firstStops(post, repo);
  assert.equal((await post(stop('b1'))).decision, 'block');
  assert.deepEqual(await post(stop('b1', true)), {});
  assert.equal(runs(), 2);
  assert.deepEqual(subtasks(d), { A: 'hitl/held', B: 'failed/miss' });
  const told = (await post(notify('b1'))).hookSpecificOutput?.additionalContext ?? '';
  assert.match(told, /subtask B .*verify failed again after one fix attempt \(miss\)/);
  assert.match(told, /also saw the changes of subtask A \(src\/a\.ts\), which were not verified on their own: the failure may come from them\./);
  assert.deepEqual(rows(d, 'SELECT subtask_id, reason FROM step_changes').map(x => [x.subtask_id, x.reason]), [['B', 'miss']]);
}));

test('decision 192: two writers that stop together do not wait for each other; a lone writer is verified as before', () => withTwoWriters(async (d, repo, post, runs) => {
  assert.deepEqual(await post(dispatch('A', 'src/**')), {});
  await post(start('a1'));
  assert.deepEqual(await post(dispatch('B', 'docs/**')), {});
  await post(start('b1'));
  write(repo, 'src/a.ts', 'a changed\n');
  write(repo, 'docs/ok.md', 'ok\n');
  const [a, b] = await Promise.all([post(stop('a1')), post(stop('b1'))]);
  assert.deepEqual([a, b], [{}, {}]);
  const s = subtasks(d);
  assert.equal(Object.values(s).filter(v => v === 'passed/meet').length, 2, JSON.stringify(s));
  assert.ok(runs() >= 1, 'at least one of them ran the commands on the finished tree');
  // a third, alone; the lead has not read the first two results yet, so they come next to this call, one line each
  const third = await post(dispatch('C', 'src/**')) as { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string } };
  assert.equal(third.hookSpecificOutput?.permissionDecision, undefined);
  const lines = (third.hookSpecificOutput?.additionalContext ?? '').split('\n');
  assert.deepEqual(lines.map(l => /subtask ([AB]) \(coder /.exec(l)?.[1]).sort(), ['A', 'B'], lines.join(' | '));
  assert.ok(lines.every(l => /do not re-run the test suite/.test(l)), 'both are told as verified: the one that waited passed with the other');
  await post(start('c1'));
  write(repo, 'src/c.ts', 'c\n');
  const before = runs();
  assert.deepEqual(await post(stop('c1')), {});
  assert.equal(runs(), before + 1);
  assert.equal(subtasks(d).C, 'passed/meet');
}));

test('decision 192: the office and the settings name the session\'s project and its work tree setting', () => withTwoWriters(async (d, repo, post) => {
  const office = async () => (await sealed(d.port, { path: '/router/v1/office?session_id=s' })).body as { project: unknown };
  assert.deepEqual((await office()).project, { name: path.basename(repo), worktree: null }, 'not asked yet');
  writeProjectState({ path: repo, worktree: 'off', askedAt: '2026-11-17T00:00:00.000Z' }, d.home);
  assert.deepEqual((await office()).project, { name: path.basename(repo), worktree: 'off' });
  const settings = (await sealed(d.port, { path: '/router/v1/office/settings?session_id=s' })).body as { project: unknown; text: Array<{ key: string; value: string; command: string }> };
  assert.deepEqual(settings.project, { name: path.basename(repo), worktree: 'off' });
  const line = settings.text.find(t => t.key === 'project.worktree')!;
  assert.match(line.value, /^off: writers share the checkout/);
  assert.equal(line.command, 'do-it-all-claude-code project enable');
  assert.equal(((await sealed(d.port, { path: '/router/v1/office?session_id=nobody' })).body as { project: unknown }).project, null);
  assert.doesNotMatch(JSON.stringify(await office()), new RegExp(path.dirname(repo).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')), 'the folder name only');
  void post;
}));
