// Decisions 117-118 (the team plan follows the lead's model) and 119 (an automatic L3 is planned with the
// L2 team; the lead can still take the L3 team with its first call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { StatusView } from '../src/router.ts';
import { call, claudeAdapter, getStatus, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const L1_PROMPT = 'Fix the bug where parse() fails on empty input in src/parse.ts';
const L3_SIGN_PROMPT = '결제 처리를 위한 신규 서비스를 처음부터 설계하고 구현해줘. 아키텍처 문서도 함께.';
type Out = { hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };

async function withDaemon(fn: (d: TestDaemon) => Promise<void>, config: Record<string, unknown> = {}): Promise<void> {
  const d = await startTestDaemon({ config });
  try { await fn(d); } finally { await d.close(); rmrf(d.home); }
}
/** A main transcript whose latest assistant message used `model`. */
const transcript = (d: TestDaemon, name: string, model: string) => {
  const f = path.join(d.home, `${name}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { id: `m-${name}`, model, usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  return f;
};
const ask = async (d: TestDaemon, sid: string, prompt: string, transcriptPath?: string): Promise<Out> => {
  const r = await postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) });
  assert.equal(r.status, 200, r.text);
  return r.body as Out;
};
const req = async (d: TestDaemon, sid: string) => ((await getStatus(d.port, sid)).body as StatusView).request!;

// A request of unclear size: the wording names no size, so the level's team decides (L2 when L1 is delegated).
const UNCLEAR_PROMPT = 'Make the date picker remember the last chosen month';

test('decisions 117, 124, 144, 211: an Opus-class lead delegates what the wording settles as small; a Sonnet lead and an unknown one keep it, and delegate from L1 otherwise; a Haiku lead delegates from L2; L0 is always the lead\'s', () => withDaemon(async d => {
  const ctx = (o: Out) => o.hookSpecificOutput?.additionalContext ?? '';
  await ask(d, 'opus', L1_PROMPT, transcript(d, 'opus', 'claude-opus-5-5'));
  let r = await req(d, 'opus');
  assert.deepEqual([r.level, r.leadDirect, r.leadModel, r.leadClass], ['L1', false, 'claude-opus-5-5', 'opus']);
  assert.deepEqual(JSON.parse(String(rows(d, "SELECT team FROM requests WHERE session_id = 'opus'")[0]!.team)).roles, [{ role: 'coder', count: 1, start: 's1' }]);
  await ask(d, 'opus', 'fix the typo in README.md', transcript(d, 'opus', 'claude-opus-5-5'));
  assert.deepEqual([(await req(d, 'opus')).level, (await req(d, 'opus')).leadDirect], ['L0', true]);

  // decision 211: small by a rule (stage 1 answers direct, L1): a Sonnet lead does it, with the short brief
  const small = ctx(await ask(d, 'sonnet', L1_PROMPT, transcript(d, 'sonnet', 'claude-sonnet-5-5')));
  r = await req(d, 'sonnet');
  assert.deepEqual([r.level, r.leadDirect, r.leadClass], ['L1', true, 'sonnet']);
  assert.match(small, /^\[do-it-all-claude-code\] level L1 \(source=rule, confidence=0\.75\): .*; small by its wording, so the lead does it\nLevel L1 is handled by you directly/);
  assert.doesNotMatch(small, /subagent_type|Routing is ON|router_report_triage/);
  assert.ok(small.length < 500, `the short brief: ${small.length} characters`);
  // ... and still delegates from L1: a request of unclear size gets the L2 team, where the lead staffs it
  const unclear = ctx(await ask(d, 'sonnet', UNCLEAR_PROMPT, transcript(d, 'sonnet', 'claude-sonnet-5-5')));
  r = await req(d, 'sonnet');
  assert.deepEqual([r.level, r.leadDirect], ['L2', false]);
  assert.match(unclear, /source=default.*-> L2 team, the lead picks the roles/);
  assert.match(unclear, /- Otherwise delegate, and the staffing is yours/);

  await ask(d, 'haiku', L1_PROMPT, transcript(d, 'haiku', 'claude-haiku-5-5'));
  r = await req(d, 'haiku');
  assert.deepEqual([r.leadDirect, r.leadClass], [true, 'haiku']);

  // the first prompt of a session names no model: it follows Sonnet (decisions 144, 211)
  await ask(d, 'unknown', L1_PROMPT);
  r = await req(d, 'unknown');
  assert.deepEqual([r.level, r.leadDirect, r.leadModel, r.leadClass], ['L1', true, null, 'other']);
  await ask(d, 'unknown', UNCLEAR_PROMPT);
  r = await req(d, 'unknown');
  assert.deepEqual([r.level, r.leadDirect], ['L2', false], 'decision 144: an unknown lead delegates from L1, like Opus and Sonnet');
  // a lead-direct request by decision 211 is direct by configuration: it is in no arm of the auto-release
  assert.deepEqual(rows(d, "SELECT holdout FROM requests WHERE session_id IN ('sonnet', 'unknown') AND level = 'L1'").map(x => x.holdout), [null, null]);
}, { delegateFrom: undefined }));   // the real defaults (the test homes pin other: L2)

test('decision 211: a delegateFrom the user set for the lead\'s class wins, and so does /router level', () => withDaemon(async d => {
  await ask(d, 'own', L1_PROMPT, transcript(d, 'own', 'claude-sonnet-5-5'));
  let r = await req(d, 'own');
  assert.deepEqual([r.level, r.leadDirect, r.leadClass], ['L1', false, 'sonnet'], 'delegateFrom.sonnet L1, set by the user: small requests are delegated as before');
  // the class the user did not set follows the rule
  await ask(d, 'first', L1_PROMPT);
  r = await req(d, 'first');
  assert.deepEqual([r.level, r.leadDirect, r.leadClass], ['L1', true, 'other']);
  // a level the user sets by hand gets that level's team: the open request is planned again, as the L1 team
  await ask(d, 'first', '/router level L1');
  r = await req(d, 'first');
  assert.deepEqual([r.level, r.leadDirect], ['L1', false]);
  assert.equal(JSON.parse(String(rows(d, "SELECT triage FROM requests WHERE session_id = 'first'")[0]!.triage)).source, 'manual');
}, { delegateFrom: { sonnet: 'L1' } }));

test('decision 117: the lead model is decided at each request (a /model switch), else from the session\'s SessionStart', () => withDaemon(async d => {
  // SessionStart names the model; the first prompt has no transcript yet
  await postHook(d.port, { session_id: 's', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  await ask(d, 's', L1_PROMPT);
  assert.deepEqual([(await req(d, 's')).leadClass, (await req(d, 's')).leadDirect], ['opus', false]);
  // after /model haiku the transcript's latest assistant line shows the new model
  await ask(d, 's', 'Fix the bug where format() fails on empty input in src/format.ts', transcript(d, 's', 'claude-haiku-5-5'));
  assert.deepEqual([(await req(d, 's')).leadClass, (await req(d, 's')).leadDirect], ['haiku', true]);
  const rec = rows(d, "SELECT lead_model, lead_class FROM requests WHERE session_id = 's' ORDER BY created_at, rowid");
  assert.deepEqual(rec, [{ lead_model: 'claude-opus-5-5', lead_class: 'opus' }, { lead_model: 'claude-haiku-5-5', lead_class: 'haiku' }]);
}));

// ---- decision 218: the lead model on a session's first prompt, and which observation counts

/** A main transcript whose latest assistant message used `model` at `at`, as Claude Code writes the line. */
const transcriptAt = (d: TestDaemon, name: string, model: string, at: string) => {
  const f = path.join(d.home, `${name}.jsonl`);
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: at, message: { id: `m-${name}`, model, usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
  return f;
};
const token = (d: TestDaemon) => fs.readFileSync(path.join(d.home, 'token'), 'utf8').trim();
/** What the status line posts when it renders (plugin/statusline.mjs): the session's current model. */
const statusLine = async (d: TestDaemon, sid: string, model: string) =>
  assert.equal((await call(d.port, { method: 'POST', path: '/router/v1/limits', body: JSON.stringify({ sessionId: sid, model }), token: token(d) })).status, 200);
const classOf = async (d: TestDaemon, sid: string) => { const r = await req(d, sid); return [r.leadClass, r.leadDirect]; };
const LONG_AGO = '2020-01-01T00:00:00.000Z';
const FAR_AHEAD = '2099-01-01T00:00:00.000Z';

test('decision 218: a -p run\'s first prompt takes ANTHROPIC_MODEL as the relay hook saw it, so an Opus lead delegates a small fix', () => withDaemon(async d => {
  // a -p run: SessionStart names no model, there is no status line and no answer in the transcript yet
  await postHook(d.port, { session_id: 'p', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup' });
  const first = await postHook(d.port, { session_id: 'p', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, routerLaunchModel: 'claude-opus-5-5',
    transcript_path: path.join(d.home, 'p.jsonl') });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(await classOf(d, 'p'), ['opus', false]);
  assert.match((first.body as Out).hookSpecificOutput?.additionalContext ?? '', /coder x1/);
  assert.deepEqual(rows(d, "SELECT lead_model, lead_class FROM requests WHERE session_id = 'p'"), [{ lead_model: 'claude-opus-5-5', lead_class: 'opus' }]);
  // an alias counts too; without the variable the lead is not known and keeps the small fix (decision 211)
  await postHook(d.port, { session_id: 'alias', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, routerLaunchModel: 'opus' });
  assert.deepEqual(await classOf(d, 'alias'), ['opus', false]);
  await ask(d, 'none', L1_PROMPT);
  assert.deepEqual(await classOf(d, 'none'), ['other', true]);
  // it is a hint: --model wins over the variable in Claude Code, so anything that names the model counts before it
  transcriptAt(d, 'p', 'claude-sonnet-5-5', new Date().toISOString());
  await postHook(d.port, { session_id: 'p', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug where trim() fails on empty input in src/trim.ts',
    routerLaunchModel: 'claude-opus-5-5', transcript_path: path.join(d.home, 'p.jsonl') });
  assert.deepEqual(await classOf(d, 'p'), ['sonnet', true]);
  await postHook(d.port, { session_id: 'i', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku-5-5' });
  await postHook(d.port, { session_id: 'i', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, routerLaunchModel: 'claude-opus-5-5' });
  assert.deepEqual(await classOf(d, 'i'), ['haiku', true]);
}));

test('decision 218: the observation seen later counts: the status line right after /model, the transcript once another model has answered', () => withDaemon(async d => {
  // the session started on Sonnet and Sonnet answered; then /model opus, and the status line rendered
  await postHook(d.port, { session_id: 'm', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' });
  const answered = transcriptAt(d, 'm', 'claude-sonnet-5-5', LONG_AGO);
  await ask(d, 'm', L1_PROMPT, answered);
  assert.deepEqual(await classOf(d, 'm'), ['sonnet', true]);
  await statusLine(d, 'm', 'claude-opus-5-5');
  await ask(d, 'm', 'Fix the bug where split() fails on empty input in src/split.ts', answered);
  assert.deepEqual(await classOf(d, 'm'), ['opus', false], 'the request right after the switch is planned for the new model');
  // no status line: the record is from SessionStart, and a later answer by another model is the newer observation
  await postHook(d.port, { session_id: 'n', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  await ask(d, 'n', L1_PROMPT, transcriptAt(d, 'n', 'claude-haiku-5-5', FAR_AHEAD));
  assert.deepEqual(await classOf(d, 'n'), ['haiku', true]);
  // a resumed interactive session: SessionStart names the model now, the transcript's last answer is older
  await postHook(d.port, { session_id: 'r', cwd: d.home, hook_event_name: 'SessionStart', source: 'resume', model: 'claude-opus-5-5' });
  await ask(d, 'r', L1_PROMPT, transcriptAt(d, 'r', 'claude-haiku-5-5', LONG_AGO));
  assert.deepEqual(await classOf(d, 'r'), ['opus', false]);
}));

test('decision 218: a SessionStart replayed from the spool gives the session its model from the time the hook ran, and does not replace a later record', () => withDaemon(async d => {
  const replay = (sid: string, model: string, receivedAt: string) =>
    d.router.process(claudeAdapter.toRouterEvent({ session_id: sid, cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model }, { spooled: true, receivedAt }));
  // the daemon was down when the session started (it is started by that hook): the model arrives with the replay
  await replay('late', 'claude-opus-5-5', new Date(Date.now() - 5_000).toISOString());
  assert.deepEqual(d.ledger.sessionLead('late')?.model, 'claude-opus-5-5');
  await ask(d, 'late', L1_PROMPT);
  assert.deepEqual(await classOf(d, 'late'), ['opus', false]);
  // the status line already named a newer model when the old SessionStart is replayed
  await statusLine(d, 'kept', 'claude-sonnet-5-5');
  await replay('kept', 'claude-opus-5-5', LONG_AGO);
  assert.equal(d.ledger.sessionLead('kept')?.model, 'claude-sonnet-5-5');
  await ask(d, 'kept', L1_PROMPT);
  assert.deepEqual(await classOf(d, 'kept'), ['sonnet', true]);
}));

test('decision 118: config.delegateFrom changes the start; an explicit lead_direct in teams.yaml still wins', () => withDaemon(async d => {
  await ask(d, 'a', L1_PROMPT, transcript(d, 'a', 'claude-sonnet-5-5'));
  assert.equal((await req(d, 'a')).leadDirect, true);                           // sonnet: from L2 by config
  fs.writeFileSync(path.join(d.home, 'teams.yaml'), 'L1:\n  lead_direct: true\n');
  await ask(d, 'b', L1_PROMPT, transcript(d, 'b', 'claude-opus-5-5'));
  assert.deepEqual([(await req(d, 'b')).leadDirect, (await req(d, 'b')).presetSource], [true, 'user']);
}, { delegateFrom: { sonnet: 'L2' } }));

test('decision 119: an automatic L3 is planned with the L2 team; the first call at an L3 signal step takes the L3 team', () => withDaemon(async d => {
  const sid = 'l3';
  const ctx = (await ask(d, sid, L3_SIGN_PROMPT)).hookSpecificOutput?.additionalContext ?? '';
  let r = await req(d, sid);
  assert.deepEqual([r.level, r.budgetUsd, r.leadDirect], ['L2', 5, false]);
  assert.match(ctx, /Larger team/);
  const call = (tag: string, role: string, model: string, effort: string) => postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: `do-it-all-claude-code:${role}`, prompt: `[subtask:${tag}] work`, model, effort } });
  assert.equal(((await call('X', 'architect', 'opus', 'high')).body as Out).hookSpecificOutput?.permissionDecision, undefined);
  r = await req(d, sid);
  assert.deepEqual([r.level, r.budgetUsd, r.replannedFrom], ['L3', 15, 'L2']);
  // a second request with L3 signs whose first call is at the L2 step stays L2
  const sid2 = 'l3-stays';
  await ask(d, sid2, L3_SIGN_PROMPT);
  await postHook(d.port, { session_id: sid2, cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:architect', prompt: '[subtask:X] work', model: 'sonnet', effort: 'medium' } });
  assert.deepEqual([(await req(d, sid2)).level, (await req(d, sid2)).replannedFrom], ['L2', null]);
  // and the record keeps the triage's L3 signs
  await postHook(d.port, { session_id: sid, cwd: d.home, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  await d.router.drain();
  const record = JSON.parse(String(rows(d, "SELECT r.record FROM request_records r JOIN requests q ON q.id = r.request_id WHERE q.session_id = 'l3'")[0]!.record));
  assert.deepEqual([record.triage.level, record.triage.l3Signs, record.plan.level, record.plan.replannedFrom], ['L2', true, 'L3', 'L2']);
}));

test('decision 119: a request set by /router level or by forceLevel is not raised by a call', () => withDaemon(async d => {
  await ask(d, 'forced', L3_SIGN_PROMPT);
  await postHook(d.port, { session_id: 'forced', cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:architect', prompt: '[subtask:X] work', model: 'opus', effort: 'high' } });
  assert.equal((await req(d, 'forced')).level, 'L2');
}, { forceLevel: 'L2' }));

void (null as unknown as HookInput);
