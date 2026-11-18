// Decision 175: after a miss the lead is told to dispatch the subtask again (not offered "report to the
// user") while the slot was raised and the budget allows; and the lead's Stop is blocked once per request
// while a failed coder subtask can still be tried again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import { makeRepo, pinRoutine, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } };

// verify passes only when src/a.ts says "ok"
const CHECK = 'const fs = require("node:fs"); process.exit(fs.readFileSync("src/a.ts", "utf8").includes("ok") ? 0 : 1)\n';

async function withRepo(fn: (d: TestDaemon, repo: string, post: (h: HookInput) => Promise<Out>) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n', 'check.cjs': CHECK });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [{ kind: 'test', command: 'node check.cjs' }] } });
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    pinRoutine(d, 's');   // decision 226: coder starts at s1 (haiku·low); a miss raises to haiku-medium
    await fn(d, repo, post);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
let seq = 0;
const call = (tag: string, model: string, effort: string, scope = 'src/**'): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_ls${++seq}`,
  tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work\n[scope: ${scope}]`, model, effort },
});
const start = (id: string): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' });
const subStop = (id: string, again = false): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: again });
const notify = (id: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
const leadStop = (last = 'The coder could not get the tests to pass.', again = false): HookInput => ({ hook_event_name: 'Stop', stop_hook_active: again, last_assistant_message: last });
const request = (d: TestDaemon) => rows(d, 'SELECT status, stop_blocks FROM requests')[0]!;

/** One subtask whose verify fails twice (a miss); returns what the lead is told. */
async function miss(post: (h: HookInput) => Promise<Out>, repo: string, tag: string, agent: string, model: string, effort: string): Promise<string> {
  assert.deepEqual(await post(call(tag, model, effort)), {});
  await post(start(agent));
  write(repo, 'src/a.ts', `${tag} wrong\n`);
  assert.equal((await post(subStop(agent))).decision, 'block');
  assert.deepEqual(await post(subStop(agent, true)), {});
  return (await post(notify(agent))).hookSpecificOutput?.additionalContext ?? '';
}

test('after a miss with the slot raised, the lead is told to dispatch again, not offered a report to the user', () => withRepo(async (d, repo, post) => {
  const told = await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  assert.match(told, /now runs one step higher, at haiku-medium \(model="haiku", effort="medium"\): a new attempt must use these values\. Dispatch subtask A again now with these values, and include what failed in its prompt\. Do not report to the user before that attempt has finished\.$/);
  assert.doesNotMatch(told, /Decide:|or report to the user/);
}));

test('with the budget used up, the result keeps the choice and the Stop is not blocked', () => withRepo(async (d, repo, post) => {
  assert.deepEqual(await post(call('A', 'haiku', 'low')), {});
  await post(start('a1'));
  write(repo, 'src/a.ts', 'wrong\n');
  await post(subStop('a1'));
  await post(subStop('a1', true));
  d.ledger.db.exec('UPDATE requests SET used_usd = budget_usd');
  const told = (await post(notify('a1'))).hookSpecificOutput?.additionalContext ?? '';
  assert.match(told, /a new attempt must use these values\. Decide: dispatch a new attempt with what failed, or report to the user\.$/);
  assert.deepEqual(await post(leadStop()), {});
  assert.deepEqual(request(d), { status: 'closed', stop_blocks: 0 });
}));

test('the lead\'s Stop is blocked once while a failed coder subtask can be tried again', () => withRepo(async (d, repo, post) => {
  await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  const out = await post(leadStop());
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /^\[do-it-all-claude-code\] subtask A \(coder\) failed and no new attempt was dispatched\. Its slot now runs at haiku-medium: call the Agent tool for it again now with model="haiku", effort="medium", and include what failed in the prompt\./);
  assert.match(out.reason ?? '', /end your message with \[router:awaiting-user\]\.$/);
  assert.deepEqual(request(d), { status: 'open', stop_blocks: 1 });   // the request stays open: the turn goes on
  assert.equal(rows(d, 'SELECT COUNT(*) AS c FROM request_records')[0]!.c, 0);

  // the lead dispatches again; that attempt misses too; a second block does not happen in this request
  await miss(post, repo, 'A', 'a2', 'haiku', 'medium');   // decision 226: re-dispatch at the raised cell haiku-medium
  assert.deepEqual(rows(d, "SELECT status, step FROM subtasks WHERE id = 'A'"), [{ status: 'failed', step: 'haiku-medium' }]);   // decision 226: a miss from s1 raises to haiku-medium
  assert.deepEqual(await post(leadStop()), {});
  assert.deepEqual(request(d), { status: 'closed', stop_blocks: 1 });
}));

test('a Stop that continues from a block is never blocked again', () => withRepo(async (d, repo, post) => {
  await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  assert.equal((await post(leadStop())).decision, 'block');
  assert.deepEqual(await post(leadStop('Stopping anyway.', true)), {});
  assert.deepEqual(request(d), { status: 'closed', stop_blocks: 1 });
}));

test('not blocked: the lead asks the user', () => withRepo(async (d, repo, post) => {
  await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  assert.deepEqual(await post(leadStop('Subtask A failed twice. Try once more at a higher step, or stop?\n[router:awaiting-user]')), {});
  assert.deepEqual(request(d), { status: 'awaiting_user', stop_blocks: 0 });
}));

test('not blocked: a newer attempt on the slot was dispatched, under the same tag or another', () => withRepo(async (d, repo, post) => {
  await miss(post, repo, 'A', 'a1', 'haiku', 'low');
  // another tag on the same slot, still running: the lead is waiting for it
  assert.deepEqual(await post(call('A2', 'haiku', 'medium')), {});   // decision 226: the raised cell is haiku-medium
  await post(start('a2'));
  assert.deepEqual(await post(leadStop('Waiting for the new attempt.')), {});
  assert.equal(request(d).stop_blocks, 0);
  // it passes: A stays failed in the ledger, but it is no longer the latest on its slot
  write(repo, 'src/a.ts', 'ok\n');
  assert.deepEqual(await post(subStop('a2')), {});
  await post(notify('a2'));
  assert.deepEqual(rows(d, 'SELECT id, status FROM subtasks ORDER BY id'), [{ id: 'A', status: 'failed' }, { id: 'A2', status: 'passed' }]);
  assert.deepEqual(await post(leadStop('Done.')), {});
  assert.deepEqual(request(d), { status: 'closed', stop_blocks: 0 });
}));

test('not blocked: another subtask of the request is still running', () => withRepo(async (d, repo, post) => {
  // B writes elsewhere: two writers running at once need disjoint scopes (decision 178)
  assert.deepEqual(await post(call('B', 'haiku', 'low', 'lib/**')), {});
  await post(start('b1'));
  // A runs on the second coder slot and misses while B is still working
  assert.deepEqual(await post(call('A', 'haiku', 'low')), {});
  await post(start('a1'));
  write(repo, 'src/a.ts', 'wrong\n');
  await post(subStop('a1'));
  await post(subStop('a1', true));
  await post(notify('a1'));
  assert.deepEqual(rows(d, "SELECT status FROM subtasks WHERE id = 'A'"), [{ status: 'failed' }]);
  assert.deepEqual(await post(leadStop('Waiting for B.')), {});
  assert.equal(request(d).stop_blocks, 0);
}));

test('not blocked: no raise is left (the subtask is the user\'s decision)', () => withRepo(async (d, repo, post) => {
  const req = String(rows(d, 'SELECT id FROM requests')[0]!.id);
  d.ledger.setSlot(req, 'coder', 0, 's4', 3, new Date().toISOString());
  const told = await miss(post, repo, 'A', 'a1', 'sonnet', 'high');
  assert.match(told, /Ask the user how to continue/);
  assert.deepEqual(await post(leadStop()), {});
  assert.deepEqual(request(d), { status: 'closed', stop_blocks: 0 });
}));

test('a v15 ledger gains requests.stop_blocks', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ar-v15-'));
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('ALTER TABLE requests DROP COLUMN stop_blocks; PRAGMA user_version = 15;');
    l.close();
    const again = new Ledger(file);
    assert.equal(Number((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
    const cols = (again.db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(cols.includes('stop_blocks'));
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
