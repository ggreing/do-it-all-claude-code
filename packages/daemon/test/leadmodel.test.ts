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

test('decision 230: every lead class delegates from L1 (one coder); only L0 is lead-direct; the lead is a coordinator', () => withDaemon(async d => {
  const ctx = (o: Out) => o.hookSpecificOutput?.additionalContext ?? '';
  // a small L1 fix is now DELEGATED for every lead class (the decision-211 "small stays with the lead" path is gone)
  for (const [sid, model, cls] of [['opus', 'claude-opus-5-5', 'opus'], ['sonnet', 'claude-sonnet-5-5', 'sonnet'], ['haiku', 'claude-haiku-5-5', 'haiku']] as const) {
    const brief = ctx(await ask(d, sid, L1_PROMPT, transcript(d, sid, model)));
    const r = await req(d, sid);
    assert.deepEqual([r.level, r.leadDirect, r.leadModel, r.leadClass], ['L1', false, model, cls], `${cls}: small L1 delegated`);
    assert.deepEqual(JSON.parse(String(rows(d, `SELECT team FROM requests WHERE session_id = '${sid}'`)[0]!.team)).roles, [{ role: 'coder', count: 1, start: 's1' }], `${cls}: one-coder L1 team`);
    assert.match(brief, /subagent_type "do-it-all-claude-code:coder"/, `${cls}: the brief delegates`);
    assert.doesNotMatch(brief, /handled by you directly|small by its wording/, `${cls}: no lead-direct path`);
  }
  // L0 (a typo) stays the lead's
  await ask(d, 'opus', 'fix the typo in README.md', transcript(d, 'opus', 'claude-opus-5-5'));
  assert.deepEqual([(await req(d, 'opus')).level, (await req(d, 'opus')).leadDirect], ['L0', true]);

  // an unclear-size request gets the L2 team, where the lead staffs it
  const unclear = ctx(await ask(d, 'sonnet', UNCLEAR_PROMPT, transcript(d, 'sonnet', 'claude-sonnet-5-5')));
  assert.deepEqual([(await req(d, 'sonnet')).level, (await req(d, 'sonnet')).leadDirect], ['L2', false]);
  assert.match(unclear, /source=default.*-> L2 team, the lead picks the roles/);
  assert.match(unclear, /The staffing is yours/);

  // an unknown lead model ('other') also delegates from L1
  await ask(d, 'unknown', L1_PROMPT);
  assert.deepEqual([(await req(d, 'unknown')).level, (await req(d, 'unknown')).leadDirect, (await req(d, 'unknown')).leadModel, (await req(d, 'unknown')).leadClass], ['L1', false, null, 'other']);
  await ask(d, 'unknown', UNCLEAR_PROMPT);
  assert.deepEqual([(await req(d, 'unknown')).level, (await req(d, 'unknown')).leadDirect], ['L2', false]);
}, { delegateFrom: undefined }));   // the real defaults (the test homes pin other: L2)

test('decision 230: a user delegateFrom override still decides where delegation starts, and /router level wins', () => withDaemon(async d => {
  // sonnet set to L2 by the user: an L1 request stays lead-direct for a Sonnet lead (the override wins)
  await ask(d, 'own', L1_PROMPT, transcript(d, 'own', 'claude-sonnet-5-5'));
  let r = await req(d, 'own');
  assert.deepEqual([r.level, r.leadDirect, r.leadClass], ['L1', true, 'sonnet'], 'delegateFrom.sonnet L2: L1 kept with the lead');
  // a class the user did not set follows the default (decision 230: delegate from L1)
  await ask(d, 'first', L1_PROMPT);
  r = await req(d, 'first');
  assert.deepEqual([r.level, r.leadDirect, r.leadClass], ['L1', false, 'other']);
  // a level the user sets by hand gets that level's team: the open request is planned again, as the L1 team
  await ask(d, 'first', '/router level L1');
  r = await req(d, 'first');
  assert.deepEqual([r.level, r.leadDirect], ['L1', false]);
  assert.equal(JSON.parse(String(rows(d, "SELECT triage FROM requests WHERE session_id = 'first'")[0]!.triage)).source, 'manual');
}, { delegateFrom: { sonnet: 'L2' } }));

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
  // an alias counts too; without the variable the lead is 'other' (and the test home pins other -> L2, so lead-direct)
  await postHook(d.port, { session_id: 'alias', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, routerLaunchModel: 'opus' });
  assert.deepEqual(await classOf(d, 'alias'), ['opus', false]);
  await ask(d, 'none', L1_PROMPT);
  assert.deepEqual(await classOf(d, 'none'), ['other', true]);
  // it is a hint: --model wins over the variable in Claude Code, so anything that names the model counts before it
  transcriptAt(d, 'p', 'claude-sonnet-5-5', new Date().toISOString());
  await postHook(d.port, { session_id: 'p', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the bug where trim() fails on empty input in src/trim.ts',
    routerLaunchModel: 'claude-opus-5-5', transcript_path: path.join(d.home, 'p.jsonl') });
  assert.deepEqual(await classOf(d, 'p'), ['sonnet', false]);   // decision 230: a Sonnet lead delegates L1
  await postHook(d.port, { session_id: 'i', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku-5-5' });
  await postHook(d.port, { session_id: 'i', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: L1_PROMPT, routerLaunchModel: 'claude-opus-5-5' });
  assert.deepEqual(await classOf(d, 'i'), ['haiku', false]);   // decision 230: a Haiku lead delegates L1 too
}));

test('decision 218: the observation seen later counts: the status line right after /model, the transcript once another model has answered', () => withDaemon(async d => {
  // the session started on Sonnet and Sonnet answered; then /model opus, and the status line rendered
  await postHook(d.port, { session_id: 'm', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5' });
  const answered = transcriptAt(d, 'm', 'claude-sonnet-5-5', LONG_AGO);
  await ask(d, 'm', L1_PROMPT, answered);
  assert.deepEqual(await classOf(d, 'm'), ['sonnet', false]);   // decision 230: a Sonnet lead delegates L1
  await statusLine(d, 'm', 'claude-opus-5-5');
  await ask(d, 'm', 'Fix the bug where split() fails on empty input in src/split.ts', answered);
  assert.deepEqual(await classOf(d, 'm'), ['opus', false], 'the request right after the switch is planned for the new model');
  // no status line: the record is from SessionStart, and a later answer by another model is the newer observation
  await postHook(d.port, { session_id: 'n', cwd: d.home, hook_event_name: 'SessionStart', source: 'startup', model: 'claude-opus-5-5' });
  await ask(d, 'n', L1_PROMPT, transcriptAt(d, 'n', 'claude-haiku-5-5', FAR_AHEAD));
  assert.deepEqual(await classOf(d, 'n'), ['haiku', false]);   // decision 230: a Haiku lead delegates L1 too
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
  assert.deepEqual(await classOf(d, 'kept'), ['sonnet', false]);   // decision 230: a Sonnet lead delegates L1
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
  // decision 226: the L3 signal role is the one L3 has that L2 lacks (ui-designer); its moderate L3 cell is sonnet/medium.
  // (The brief now raises to L3 through router_report_triage; this first-call path stays as a silent fallback.)
  assert.equal(((await call('X', 'ui-designer', 'sonnet', 'medium')).body as Out).hookSpecificOutput?.permissionDecision, undefined);
  r = await req(d, sid);
  assert.deepEqual([r.level, r.budgetUsd, r.replannedFrom], ['L3', 15, 'L2']);
  // a second request with L3 signs whose first call is a non-signal role at its L2 cell stays L2
  const sid2 = 'l3-stays';
  await ask(d, sid2, L3_SIGN_PROMPT);
  await postHook(d.port, { session_id: sid2, cwd: d.home, hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:X] work', model: 'sonnet', effort: 'medium' } });
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
