import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS, PROTECTED_WRITE_PATHS } from '@do-it-all-claude-code/core';
import { AWAITING_USER_MARKER, awaitsUser, classifyPrompt } from '../src/continuation.ts';
import { checkAgentCall, defaultStartStep, managedRole, parseScope, parseTag, scopeFileBody, stepOf, type AgentCallInput } from '../src/policy.ts';

test('only do-it-all-claude-code:<role> agent types are managed', () => {
  assert.equal(managedRole('do-it-all-claude-code:coder'), 'coder');
  assert.equal(managedRole('do-it-all-claude-code:ui-designer'), 'ui-designer');
  assert.equal(managedRole('do-it-all-claude-code:lead'), null);
  assert.equal(managedRole('Explore'), undefined);
  assert.equal(managedRole(''), undefined);
  assert.equal(managedRole(undefined), undefined);
});

test('subtask tag is read from the first line only', () => {
  assert.equal(parseTag('[subtask:A] Write file a.txt'), 'A');
  assert.equal(parseTag('  [subtask: B-2.x ]\nmore'), 'B-2.x');
  assert.equal(parseTag('Do it\n[subtask:A]'), undefined);
  assert.equal(parseTag('[subtask:../../etc]'), undefined);
  assert.equal(parseTag(undefined), undefined);
});

test('scope line: second line, repo-relative globs; missing means the whole repo (decision Q5)', () => {
  assert.deepEqual(parseScope('[subtask:A] x\n[scope: src/a/**, test/a/**]'), { ok: true, allowed: ['src/a/**', 'test/a/**'], unscoped: false });
  assert.deepEqual(parseScope('[subtask:A] x\n[scope: .\\src\\b.ts]'), { ok: true, allowed: ['src/b.ts'], unscoped: false });
  assert.deepEqual(parseScope('[subtask:A] x\nplain text'), { ok: true, allowed: ['**'], unscoped: true });
  assert.equal(parseScope('[subtask:A]\n[scope: ]').ok, false);
  // decision 219: on a role that cannot write, an empty line means it writes nothing
  assert.deepEqual(parseScope('[subtask:R]\n[scope: ]', { readOnly: true }), { ok: true, allowed: [], unscoped: false });
  assert.deepEqual(parseScope('[subtask:R]\n[scope:  , ]', { readOnly: true }), { ok: true, allowed: [], unscoped: false });
  assert.equal(parseScope('[subtask:A]\n[scope: ]', { readOnly: false }).ok, false);
  assert.equal(parseScope('[subtask:R]\n[scope: ../x/**]', { readOnly: true }).ok, false, 'a bad glob stays refused');
  assert.equal(parseScope('[subtask:A]\n[scope: ../outside/**]').ok, false);
  assert.equal(parseScope('[subtask:A]\n[scope: /etc/**]').ok, false);
  assert.equal(parseScope('[subtask:A]\n[scope: C:/x/**]').ok, false);
  const body = scopeFileBody(['**'], true);
  assert.deepEqual(body.protected, [...PROTECTED_WRITE_PATHS]);
  assert.equal(body.unscoped, true);
});

test('model/effort map to ladder steps by alias or pinned id', () => {
  assert.equal(stepOf('haiku', 'low')?.step, 's1');
  assert.equal(stepOf('sonnet', 'high')?.step, 's4');
  assert.equal(stepOf('claude-opus-5-5', 'xhigh')?.step, 's6');
  assert.equal(stepOf('haiku', 'medium')?.step, 'haiku-medium');   // decision 226: now a real grid cell
  assert.equal(stepOf(undefined, 'low'), undefined);
});

test('default start steps of roles a preset lacks (decision Q3)', () => {
  assert.equal(defaultStartStep('L1', 'architect'), 's3');
  assert.equal(defaultStartStep('L3', 'architect'), 's5');
  assert.equal(defaultStartStep('L2', 'ui-designer'), 's3');
  assert.equal(defaultStartStep('L1', 'coder'), 's1');
  assert.equal(defaultStartStep('L3', 'coder'), 's5');
  assert.equal(defaultStartStep('L2', 'reviewer'), 's3');
  assert.equal(defaultStartStep('L1', 'reviewer'), 's1');
  assert.equal(defaultStartStep('L3', 'reviewer'), 's5');
  assert.equal(defaultStartStep('L3', 'tester'), 's1');
});

const call = (o: Partial<AgentCallInput>): AgentCallInput => ({
  // decision 226: pin difficulty routine so the coder's cell is s1 (haiku/low) and the Q3 strict-match table reads as before
  tag: 'A', role: 'coder', model: 'haiku', effort: 'low', level: 'L1', preset: DEFAULT_PRESETS.L1, difficulty: 'routine',
  budgetUsd: 2, spentUsd: 0, fableOptIn: false, busySlots: [], tagBusy: false, ...o,
});

test('agent call check table (decision Q3: strict)', () => {
  const ok = (o: Partial<AgentCallInput>) => checkAgentCall(call(o));
  const deny = (o: Partial<AgentCallInput>, re: RegExp) => {
    const r = checkAgentCall(call(o));
    assert.equal(r.ok, false, `expected deny for ${JSON.stringify(o)}`);
    if (!r.ok) assert.match(r.reason, re);
  };
  assert.deepEqual(ok({}), { ok: true, slot: 0, step: 's1' });
  deny({ model: 'sonnet', effort: 'high' }, /model="haiku", effort="low"/);
  deny({ model: undefined }, /pass model and effort/);
  deny({ effort: undefined }, /pass model and effort/);
  deny({ spentUsd: 2 }, /budget is used up/);
  deny({ tagBusy: true }, /already running/);
  // L0: fixed team, one coder
  deny({ level: 'L0', preset: DEFAULT_PRESETS.L0, role: 'reviewer', model: 'haiku', effort: 'low' }, /team is fixed/);
  deny({ level: 'L0', preset: DEFAULT_PRESETS.L0, busySlots: [0] }, /slot\(s\) of the L0 team are busy/);
  // L1 lead may add an architect at its default start step s3 (sonnet/medium) and a second coder slot
  deny({ role: 'architect' }, /step s3 \(model="sonnet", effort="medium"\)/);
  assert.deepEqual(ok({ role: 'architect', model: 'sonnet', effort: 'medium' }), { ok: true, slot: 0, step: 's3' });
  assert.deepEqual(ok({ busySlots: [0] }), { ok: true, slot: 1, step: 's1' });
  // L2 coders x2 at s1: slots 0 and 1 are the preset, 2 is an extra
  assert.deepEqual(ok({ level: 'L2', preset: DEFAULT_PRESETS.L2, busySlots: [0] }), { ok: true, slot: 1, step: 's1' });
  assert.deepEqual(ok({ level: 'L2', preset: DEFAULT_PRESETS.L2, busySlots: [0, 1] }), { ok: true, slot: 2, step: 's1' });
  // Fable (s7) needs the opt-in
  deny({ model: 'fable', effort: 'high' }, /opt-in/);
});

test('prompt classification (decision Q1: explicit markers; /router level)', () => {
  const kind = (p: string, status?: 'open' | 'awaiting_user' | 'closed') => classifyPrompt(p, status ? { status } : undefined);
  assert.deepEqual(kind('fix the bug'), { kind: 'new' });
  assert.deepEqual(kind('fix the bug', 'closed'), { kind: 'new' });
  assert.deepEqual(kind('yes, use option B', 'awaiting_user'), { kind: 'continue' });
  assert.deepEqual(kind('/router resume', 'closed'), { kind: 'resume' });
  assert.deepEqual(kind('/do-it-all-claude-code:router resume now', 'closed'), { kind: 'resume' });
  assert.deepEqual(kind('/router resume'), { kind: 'command' });
  assert.deepEqual(kind('/router level L2', 'open'), { kind: 'level', level: 'L2' });
  assert.deepEqual(kind('/do-it-all-claude-code:router level l3'), { kind: 'level', level: 'L3' });
  assert.deepEqual(kind('/router level L7'), { kind: 'level', level: null });
  assert.deepEqual(kind('/router level'), { kind: 'level', level: null });
  assert.deepEqual(kind('/compact', 'awaiting_user'), { kind: 'command' });
  assert.deepEqual(kind('/src/app.ts crashes on start'), { kind: 'new' });
  assert.equal(awaitsUser(`Which option? ${AWAITING_USER_MARKER}`), true);
  assert.equal(awaitsUser('Done.'), false);
  assert.equal(awaitsUser(undefined), false);
});

test('decision 178: write scopes overlap unless they part at a fixed directory or file; case does not matter', async () => {
  const { globsMayMeet, scopesOverlap } = await import('../src/policy.ts');
  const meet: Array<[string, string]> = [['src/**', 'src/a/**'], ['src/index.ts', 'src/*.ts'], ['**/*.ts', 'lib/x/y.ts'], ['src/a.ts', 'src/a.ts'], ['Src/A/**', 'src/a/b.ts'], ['**', 'docs/**']];
  const apart: Array<[string, string]> = [['src/a/**', 'src/b/**'], ['src/a.ts', 'src/b/**'], ['src/**', 'test/**'], ['src/a.ts', 'src/b.ts'], ['src/a/*.ts', 'src/b/*.ts']];
  for (const [a, b] of meet) assert.equal(globsMayMeet(a, b), true, `${a} / ${b}`);
  for (const [a, b] of apart) assert.equal(globsMayMeet(a, b), false, `${a} / ${b}`);
  assert.deepEqual(scopesOverlap(['src/api/**', 'docs/api.md'], ['src/web/**', 'docs/**']), ['docs/api.md', 'docs/**']);
  assert.equal(scopesOverlap(['src/api/**'], ['src/web/**', 'test/web/**']), undefined);
});

test('decision 178: a writer sent while another runs needs a scope of its own; the reason says what to do', async () => {
  const { concurrentWriterProblem } = await import('../src/policy.ts');
  const running = [{ id: 'A', role: 'coder' as const, scope: ['src/api/**'] }];
  assert.equal(concurrentWriterProblem({ tag: 'B', role: 'coder', scope: ['src/web/**'], isolation: 'worktree', running }), null);
  const o = concurrentWriterProblem({ tag: 'B', role: 'coder', scope: ['src/**'], isolation: 'worktree', running })!;
  assert.equal(o.kind, 'overlap');
  assert.match(o.reason, /subtask B: its write scope overlaps subtask A's, which is still running \("src\/\*\*" and "src\/api\/\*\*"/);
  assert.match(o.reason, /give the two subtasks scopes that share no file .* or send B after A has finished/);
  // a disjoint writer without a worktree is not refused: the worktree stays the instruction (decision 83)
  assert.equal(concurrentWriterProblem({ tag: 'B', role: 'coder', scope: ['src/web/**'], isolation: undefined, running }), null);
  // not a writer, nothing else running, the same subtask again, or a read-only role running: no problem
  assert.equal(concurrentWriterProblem({ tag: 'R', role: 'reviewer', scope: ['**'], isolation: undefined, running }), null);
  assert.equal(concurrentWriterProblem({ tag: 'B', role: 'coder', scope: ['**'], isolation: undefined, running: [] }), null);
  assert.equal(concurrentWriterProblem({ tag: 'A', role: 'coder', scope: ['src/**'], isolation: undefined, running }), null);
  assert.equal(concurrentWriterProblem({ tag: 'B', role: 'coder', scope: ['src/**'], isolation: undefined, running: [{ id: 'R', role: 'reviewer', scope: ['**'] }] }), null);
});
