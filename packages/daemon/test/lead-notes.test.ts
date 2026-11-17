// Decision 205: a background subagent's result reaches the lead once, whichever of the lead's hooks comes next.
//
// What an interactive Claude Code does with a background Agent call: the subagent's report comes first, as a
// message of its own (`<agent-message from="<agent id>">`, a UserPromptSubmit) that can arrive before the stop is
// judged; the `<task-notification>` follows, and when the lead's turn is already running it is attached in the
// middle of the turn with no hook at all. So the result line is also left in <home>/lead-notes/, and the next hook
// of the lead hands it over: a prompt, an Agent call or a router tool (the daemon answers those), the lead's Stop,
// or the guard hook before the lead's Bash, Read and edit calls (it reads the folder itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LeadNotes, leadNotesDir, takeLeadNotes } from '../src/lead-notes.ts';
import { minimalPayload } from '../src/payload.ts';
import { makeHome, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

const L2_PROMPT = 'Refactor the validation module across multiple files and add an audit log';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; additionalContext?: string } };
type Guard = {
  takeLeadNotes(home: string, sessionId: string, now?: number): Array<{ agentId: string; subtaskId: string; text: string; at: string }>;
  leadNotesOutput(input: unknown, home?: string): Out | null;
};
const loadGuard = async () => await import(new URL('../../../plugin/hooks/guard.mjs', import.meta.url).href) as Guard;
const loadRelay = async () => await import(new URL('../../../plugin/hooks/relay.mjs', import.meta.url).href) as { minimalHookInput(x: unknown): unknown };

const REPORT = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n  Changed files:\n  - src/a.ts: the fix\n  secret words of the report';
const handback = (agent: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<agent-message from="${agent}">\n${REPORT}\n</agent-message>` });
const notify = (agent: string): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${agent}</task-id>\n<status>completed</status>\n<result>delivered as a message</result>\n</task-notification>` });
const dispatch = (tag: string): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_ln_${tag}`,
  tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] work\n[scope: src/**]`, model: 'haiku', effort: 'low' },
});
const start = (id: string): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' });
const stop = (id: string): HookInput => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false });
const leadStop = (): HookInput => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
const context = (o: Out) => o.hookSpecificOutput?.additionalContext ?? '';
const requests = (d: TestDaemon) => rows(d, 'SELECT id, status FROM requests ORDER BY created_at');

async function withSession(fn: (d: TestDaemon, repo: string, post: (h: HookInput) => Promise<Out>) => Promise<void>): Promise<void> {
  const repo = makeRepo({ 'src/a.ts': 'a\n' });
  const d = await startTestDaemon({ verify: { resolveCommands: async () => [] } });
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: L2_PROMPT });
    await fn(d, repo, post);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}

/** A coder subtask in the background: dispatched, started, the lead's turn ended, the file changed. */
async function background(post: (h: HookInput) => Promise<Out>, repo: string, tag = 'A', agent = 'a1'): Promise<void> {
  assert.deepEqual(await post(dispatch(tag)), {});
  await post(start(agent));
  await post({ ...dispatch(tag), hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched', isAsync: true, agentId: agent } });
  write(repo, `src/${tag}.ts`, `${tag}\n`);
}

test('a subagent\'s own report is not a new request; while its stop is being checked the lead is told to wait', () => withSession(async (d, repo, post) => {
  await background(post, repo);
  await post(leadStop());   // the lead's turn ends while the subagent works: the request closes
  assert.deepEqual(requests(d).map(r => r.status), ['closed']);

  // the report arrives before the stop is judged
  const early = context(await post(handback('a1')));
  assert.match(early, /^\[do-it-all-claude-code\] subtask A \(coder\): the message above is the subagent's own report\. The router is still checking it/);
  assert.match(early, /do not run the build or the tests yourself/);
  assert.doesNotMatch(early, /level L\d|You are the lead/, 'no triage brief: this is not a new request');
  assert.deepEqual(requests(d).map(r => r.status), ['open'], 'one request for one prompt of the user, open again while its subagent reports');

  // the stop is judged: the result waits for the lead, and the task notification brings it once
  assert.deepEqual(await post(stop('a1')), {});
  const told = context(await post(notify('a1')));
  assert.match(told, /subtask A \(coder @s1, model=haiku, effort=low\): verify passed/);
  assert.equal(context(await post(notify('a1'))), '', 'not repeated');
  assert.equal(requests(d).length, 1);

  // what is stored of the report: who sent it, never what it says
  const stored = rows(d, "SELECT payload FROM events WHERE type = 'prompt_submit' ORDER BY id").map(r => JSON.parse(String(r.payload)) as { prompt_kind: string; prompt?: string });
  assert.deepEqual(stored.map(p => p.prompt_kind), ['user', 'notification', 'notification', 'notification']);
  assert.equal(stored[1]!.prompt, '<agent-message from="a1"></agent-message>');
  assert.equal(fs.readFileSync(path.join(d.home, 'router.db')).includes('secret words of the report'), false);
}));

test('a report that arrives after the stop was judged carries the result; the notification after it adds nothing', () => withSession(async (d, repo, post) => {
  await background(post, repo);
  assert.deepEqual(await post(stop('a1')), {});
  assert.match(context(await post(handback('a1'))), /subtask A \(coder @s1, model=haiku, effort=low\): verify passed/);
  assert.equal(context(await post(notify('a1'))), '');
  assert.equal(requests(d).length, 1);
}));

test('a result the lead has not read stops its turn from ending once: the Stop hands it over, the next Stop closes the request', () => withSession(async (d, repo, post) => {
  await background(post, repo);
  assert.deepEqual(await post(stop('a1')), {});
  // the task notification was attached in the middle of the lead's turn: no hook, so the lead ends its turn unaware
  const first = await post(leadStop());
  assert.match(context(first), /subtask A \(coder @s1, model=haiku, effort=low\): verify passed/);
  assert.equal(first.decision, undefined, 'context, not a block');
  assert.deepEqual(requests(d).map(r => r.status), ['open'], 'the turn goes on');
  assert.deepEqual(await post(leadStop()), {});
  assert.deepEqual(requests(d).map(r => r.status), ['closed']);
}));

test('the next Agent call of the lead carries the waiting result and decides nothing about the call', () => withSession(async (d, repo, post) => {
  await background(post, repo);
  assert.deepEqual(await post(stop('a1')), {});
  const next = await post({ ...dispatch('B'), tool_input: { subagent_type: 'do-it-all-claude-code:reviewer', prompt: '[subtask:B] look', model: 'sonnet', effort: 'medium' } });
  assert.match(context(next), /subtask A \(coder @s1, model=haiku, effort=low\): verify passed/);
  assert.equal(next.hookSpecificOutput?.permissionDecision, undefined);
  assert.equal(context(await post(notify('a1'))), '', 'read already');
}));

test('the guard hands the waiting result to the lead\'s own tool call, not to a subagent\'s, and the daemon does not repeat it', () => withSession(async (d, repo, post) => {
  const guard = await loadGuard();
  await background(post, repo);
  assert.deepEqual(await post(stop('a1')), {});
  const dir = leadNotesDir(d.home, 's');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const note = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(note).sort(), ['agentId', 'at', 'subtaskId', 'text'], 'the result line only: no prompt, no report');
  assert.deepEqual([note.agentId, note.subtaskId], ['a1', 'A']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, files[0]!)).mode & 0o777, 0o600);
  }

  const bash = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'node --test' } };
  assert.equal(guard.leadNotesOutput({ ...bash, agent_id: 'x1', agent_type: 'Explore' }, d.home), null, 'a subagent\'s call is not the lead\'s');
  assert.equal(guard.leadNotesOutput({ ...bash, session_id: 'other' }, d.home), null, 'another session');
  const out = guard.leadNotesOutput(bash, d.home);
  assert.deepEqual(Object.keys(out!.hookSpecificOutput!).sort(), ['additionalContext', 'hookEventName'], 'no permission decision');
  assert.equal(out!.hookSpecificOutput!.hookEventName, 'PreToolUse');
  assert.equal(context(out!), note.text);
  assert.match(context(out!), /subtask A \(coder @s1, model=haiku, effort=low\): verify passed/);
  assert.equal(guard.leadNotesOutput(bash, d.home), null, 'once');
  assert.equal(fs.existsSync(dir), false, 'nothing is left behind');
  // the daemon knows the note is gone: neither the notification nor the Stop repeats it
  assert.equal(context(await post(notify('a1'))), '');
  assert.deepEqual(await post(leadStop()), {});
}));

test('lead notes: taken once, the latest per agent, old ones dropped; the guard\'s copy reads the same folder', async () => {
  const guard = await loadGuard();
  const home = makeHome();
  try {
    let now = Date.parse('2026-11-17T06:00:00Z');
    const notes = new LeadNotes(home, () => new Date(now));
    assert.equal(notes.delivered('a1'), false, 'never left');
    assert.ok(notes.add('s/1', { agentId: 'a1', subtaskId: 'A', text: 'A held' }));
    now += 10;
    assert.ok(notes.add('s/1', { agentId: 'b1', subtaskId: 'B', text: 'B passed' }));
    now += 10;
    assert.ok(notes.add('s/1', { agentId: 'a1', subtaskId: 'A', text: 'A passed' }));
    assert.ok(notes.add('s2', { agentId: 'c1', subtaskId: 'C', text: 'x'.repeat(5000) }));
    assert.equal(notes.delivered('a1'), false, 'still waiting');
    assert.equal(path.basename(leadNotesDir(home, 's/1')), 's_1', 'a session id is never a path');

    assert.deepEqual(guard.takeLeadNotes(home, 's/1', now).map(n => n.text), ['B passed', 'A passed']);
    assert.equal(notes.delivered('a1'), true);
    assert.deepEqual(notes.take('s/1'), [], 'the daemon finds nothing after the guard took them');
    assert.equal(takeLeadNotes(home, 's2', now)[0]!.text.length, 2000, 'cut');

    assert.ok(notes.add('s3', { agentId: 'd1', subtaskId: 'D', text: 'D passed' }));
    now += 25 * 3600_000;
    assert.deepEqual(notes.take('s3'), [], 'a day-old result is not told as news');
    assert.deepEqual(takeLeadNotes(home, 'never'), []);
  } finally { rmrf(home); }
});

test('the stored form of an agent message is the same in the daemon and in the relay, and is stable', async () => {
  const relay = await loadRelay();
  for (const prompt of [handback('a1').prompt, `Another Claude session sent a message:\n${handback('a1').prompt}\n\nThat "other Claude session" is an agent.`]) {
    const input = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt };
    const min = minimalPayload(input) as { prompt_kind: string; prompt: string; prompt_chars: number };
    assert.deepEqual([min.prompt_kind, min.prompt, min.prompt_chars], ['notification', '<agent-message from="a1"></agent-message>', String(prompt).length]);
    assert.deepEqual(relay.minimalHookInput(input), min);
    assert.deepEqual(minimalPayload(min), min);
  }
});
