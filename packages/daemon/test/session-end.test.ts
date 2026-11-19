// Session-end cleanup: a Claude Code session can end (quit, /clear, logout, a killed or crashed `-p` run) while a
// worker it dispatched is still running. Claude Code then sends no SubagentStop, so the subtask would stay 'running',
// its request stay open, and the worker's cost be lost. There is no reliable SessionEnd signal for every such path,
// and the daemon must not touch a running subtask at its own shutdown (a restart replays the real stop), so the next
// LIVE SessionStart reconciles OTHER sessions: a subtask running far longer than any worker + verify could take is
// closed as cut off (status 'cancelled', verdict 'unverified') and, once its request has nothing else running, the
// request is closed and the worker cost is read from the transcript as for any close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mainTranscriptFromSubagent, subagentTranscriptPath } from '../src/transcript.ts';
import { pinRoutine, makeRepo, postHook, rmrf, rows, startTestDaemon, type HookInput, type TestDaemon } from './helpers.ts';

const DELEGATING = 'Refactor the validation module across multiple files and add an audit log';
const ORPHAN_MS = 60 * 60_000;
const call = (id: string, model: string, n: number) => JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: n, output_tokens: n } } }) + '\n';

/** A daemon whose clock we control, so a worker can be aged past the orphan threshold without touching the DB. */
async function withClock(fn: (d: TestDaemon, clock: { advance(ms: number): void }) => Promise<void>): Promise<void> {
  let t = Date.parse('2026-11-11T10:00:00.000Z');
  const d = await startTestDaemon({ now: () => new Date(t) });
  try { await fn(d, { advance: ms => { t += ms; } }); } finally { await d.close(); rmrf(d.home); }
}

/** Dispatch one coder worker in `sid` and leave it running (SubagentStart, no SubagentStop). Writes its transcript. */
async function dispatch(d: TestDaemon, sid: string, repo: string, agentId: string, tag: string): Promise<void> {
  const main = path.join(d.home, `${sid}.jsonl`);
  fs.writeFileSync(main, '');
  const sub = subagentTranscriptPath(main, agentId)!;
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, call('x1', 'claude-opus-5-5', 1000) + call('x2', 'claude-opus-5-5', 1000) + call('x3', 'claude-opus-5-5', 1000));
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: sid, cwd: repo, transcript_path: main, ...h });
    assert.equal(r.status, 200, r.text);
    return r.body;
  };
  await post({ hook_event_name: 'UserPromptSubmit', prompt: DELEGATING });
  pinRoutine(d);
  await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_${agentId}`,
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:${tag}] fix\n[scope: pkg/**]`, model: 'haiku', effort: 'low' } });
  await post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'do-it-all-claude-code:coder',
    agent_transcript_path: sub });
}

const sessionStart = (d: TestDaemon, sid: string, repo: string) =>
  postHook(d.port, { session_id: sid, cwd: repo, transcript_path: path.join(d.home, `${sid}.jsonl`), hook_event_name: 'SessionStart', source: 'startup' });

test('an orphaned running worker is closed as cut off (unverified) at the next session start, its request closed and its cost read from the transcript', () => withClock(async (d, clock) => {
  const repo = makeRepo({ 'pkg/a.py': 'a = 1\n' });
  try {
    await dispatch(d, 'orph', repo, 'o1', 'A');
    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'running', verdict: null }]);
    assert.deepEqual(rows(d, 'SELECT status FROM requests'), [{ status: 'open' }]);

    clock.advance(ORPHAN_MS + 60_000);                       // the 'orph' session has ended; its worker never stopped
    assert.equal((await sessionStart(d, 's2', repo)).status, 200);
    await d.router.drain();                                  // the request-close reads the worker cost in the background

    assert.deepEqual(rows(d, 'SELECT status, verdict FROM subtasks'), [{ status: 'cancelled', verdict: 'unverified' }]);
    assert.deepEqual(rows(d, 'SELECT status, outcome FROM requests'), [{ status: 'closed', outcome: 'delegated' }]);
    const cost = rows(d, "SELECT calls FROM costs WHERE agent_id = 'o1' AND source = 'transcript'");
    assert.equal(cost.length, 1);
    assert.equal(cost[0]!.calls, 3);                         // all three API calls in the worker transcript are counted
  } finally { rmrf(repo); }
}));

test('a worker that is not yet stale, and the starting session\'s own worker, are left running', () => withClock(async (d, clock) => {
  const repo = makeRepo({ 'pkg/a.py': 'a = 1\n' });
  try {
    await dispatch(d, 'recent', repo, 'r1', 'A');
    clock.advance(5 * 60_000);                               // only 5 min: well within a real worker + verify
    assert.equal((await sessionStart(d, 's2', repo)).status, 200);
    await d.router.drain();
    assert.deepEqual(rows(d, "SELECT status FROM subtasks WHERE id = 'A'"), [{ status: 'running' }], 'a recent worker is not reaped');
    assert.deepEqual(rows(d, 'SELECT status FROM requests'), [{ status: 'open' }]);

    // the SAME session resuming is excluded: its own stale worker is legitimately continuing, not orphaned
    clock.advance(ORPHAN_MS + 60_000);
    assert.equal((await postHook(d.port, { session_id: 'recent', cwd: repo, transcript_path: path.join(d.home, 'recent.jsonl'), hook_event_name: 'SessionStart', source: 'resume' })).status, 200);
    await d.router.drain();
    assert.deepEqual(rows(d, "SELECT status FROM subtasks WHERE id = 'A'"), [{ status: 'running' }], 'the starting session is excluded from its own sweep');
  } finally { rmrf(repo); }
}));

test('mainTranscriptFromSubagent is the inverse of subagentTranscriptPath', () => {
  const main = path.join(path.sep === '\\' ? 'C:\\u\\p' : '/u/p', 'sess-1.jsonl');
  const sub = subagentTranscriptPath(main, 'ag_1-2')!;
  assert.equal(mainTranscriptFromSubagent(sub), main);
  // not in the expected shape -> undefined (a relative path, a non-subagents layout, a bad basename)
  assert.equal(mainTranscriptFromSubagent(undefined), undefined);
  assert.equal(mainTranscriptFromSubagent('agent-x.jsonl'), undefined);
  assert.equal(mainTranscriptFromSubagent(path.join(path.sep === '\\' ? 'C:\\u\\p' : '/u/p', 'sess', 'notsub', 'agent-x.jsonl')), undefined);
  assert.equal(mainTranscriptFromSubagent(path.join(path.sep === '\\' ? 'C:\\u\\p' : '/u/p', 'sess', 'subagents', 'notanagent.jsonl')), undefined);
});
