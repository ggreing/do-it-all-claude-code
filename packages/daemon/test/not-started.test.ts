// Decision 212: a test command that failed before any test ran.
//
// What counts as "did not start": pytest exit 2 with errors during collection, exit 3 (internal error, a plugin
// that does not load), exit 4 (usage error, a conftest that does not import), and no test counted in the
// summary. The error is the subagent's when the traceback, or an "E" line, names a file it changed.
//
// What the router does with it: the subagent gets its one fix attempt as for any failure. When its next stop
// fails the same way, the slot is not raised: the subtask ends unverified and the lead is told once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { NOT_STARTED_MARK, isNotStarted, testsDidNotStart } from '../src/not-started.ts';
import { runVerify, type VerifyCommand } from '../src/verify.ts';
import { makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, write, type HookInput, type TestDaemon } from './helpers.ts';

const PYTEST = "python -m pytest -q -x 'pkg/tests/test_variable.py'";

// ---- outputs, in the shape pytest prints them (paths made neutral)

/** A numpy alias the installed numpy no longer has, used by a module the subagent did not change. */
const REMOVED_ALIAS = `
==================================== ERRORS ====================================
________________ ERROR collecting pkg/tests/test_variable.py _________________
pkg/tests/test_variable.py:12: in <module>
    from pkg.core import dtypes
pkg/core/__init__.py:3: in <module>
    from .variable import Variable
pkg/core/dtypes.py:41: in <module>
    (np.bytes_, np.unicode_),
/usr/lib/python3/site-packages/numpy/__init__.py:400: in __getattr__
    raise AttributeError(
E   AttributeError: \`np.unicode_\` was removed in the NumPy 2.0 release. Use \`np.str_\` instead.
=========================== short test summary info ===========================
ERROR pkg/tests/test_variable.py - AttributeError: \`np.unicode_\` was remov...
!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
13 warnings, 1 error in 1.14s
`;

/** A pytest plugin that does not load on the installed Python: exit 3, every frame outside the repository. */
const PLUGIN = `
Error while loading plugin "pytest11".
C:\\Python\\Lib\\site-packages\\pytest_asyncio\\__init__.py:6: in <module>
    from .plugin import fixture, is_async_test
C:\\Python\\Lib\\site-packages\\pytest_asyncio\\plugin.py:14: in <module>
    from asyncio import AbstractEventLoop, AbstractEventLoopPolicy
C:\\Python\\Lib\\asyncio\\__init__.py:56: in __getattr__
    warnings._deprecated(f"asyncio.{name}", remove=(3, 16))
E   DeprecationWarning: 'asyncio.AbstractEventLoopPolicy' is deprecated and slated for removal in Python 3.16
`;

/**
 * The subagent's own doing, seen through a conftest: it edited pkg/core/assumptions.py, the package no longer
 * imports, and the error is raised two frames further down, in a file it did not touch. Exit 4.
 */
const BROKEN_BY_CHANGE = `
ImportError while loading conftest '/work/repo/conftest.py'.
conftest.py:5: in <module>
    import pkg
pkg\\__init__.py:57: in <module>
    from .core import *
pkg\\core\\numbers.py:2619: in <module>
    class Infinity(with_metaclass(Singleton, Number)):
pkg\\core\\assumptions.py:336: in __init__
    cls.default_assumptions = StdFactKB(defs)
pkg\\core\\facts.py:493: in _tell
    raise InconsistentAssumptions(self, k, v)
E   pkg.core.facts.InconsistentAssumptions: {
E   	finite: False,
E   	infinite: True}, positive=True
`;

const SYNTAX_ERROR = `
________________ ERROR collecting pkg/tests/test_variable.py _________________
/usr/lib/python3/site-packages/_pytest/python.py:507: in importtestmodule
    mod = import_path(
pkg/tests/test_variable.py:3: in <module>
    from pkg.core.variable import Variable
E     File "/work/repo/pkg/core/variable.py", line 12
E       def as_variable(obj,
E                      ^
E   SyntaxError: '(' was never closed
=========================== short test summary info ===========================
ERROR pkg/tests/test_variable.py
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.20s
`;

const MISSING_NAME = `
________________ ERROR collecting pkg/tests/test_variable.py _________________
ImportError while importing test module '/work/repo/pkg/tests/test_variable.py'.
pkg/tests/test_variable.py:3: in <module>
    from pkg.core.variable import as_variable
E   ImportError: cannot import name 'as_variable' from 'pkg.core.variable' (/work/repo/pkg/core/variable.py)
=========================== short test summary info ===========================
ERROR pkg/tests/test_variable.py
!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!
1 error in 0.11s
`;

/**
 * What pytest -x prints for the same removed alias: it stops at the first collection error and ends with exit 1,
 * the code of a failed test, without the "errors during collection" line (the fair re-measure, on Windows).
 */
const STOPPED_AT_FIRST = `
=================================== ERRORS ====================================
________________ ERROR collecting pkg/tests/test_dataset.py ________________
C:\\Python\\Lib\\site-packages\\_pytest\\python.py:528: in importtestmodule
    mod = import_path(
pkg\\__init__.py:9: in <module>
    from .core.alignment import align, broadcast
pkg\\core\\alignment.py:10: in <module>
    from . import dtypes, utils
pkg\\core\\dtypes.py:41: in <module>
    {np.bytes_, np.unicode_},  # numpy promotes to unicode
     ^^^^^^^^^^^
C:\\Python\\Lib\\site-packages\\numpy\\__init__.py:778: in __getattr__
    raise AttributeError(
E   AttributeError: \`np.unicode_\` was removed in the NumPy 2.0 release. Use \`np.str_\` instead.
============================== warnings summary ===============================
-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
=========================== short test summary info ===========================
ERROR pkg/tests/test_dataset.py - AttributeError: \`np.unicode_\` was remove...
!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!
13 warnings, 1 error in 2.44s
`;

/** A fixture that raises: exit 1 and "1 error" too, but a test was reached, so this is an ordinary failure. */
const SETUP_ERROR = `
E
==================================== ERRORS ====================================
_________________________ ERROR at setup of test_copy _________________________
pkg/tests/conftest.py:9: in dataset
    raise RuntimeError("no fixture data")
E   RuntimeError: no fixture data
=========================== short test summary info ===========================
ERROR pkg/tests/test_variable.py::test_copy - RuntimeError: no fixture data
!!!!!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!!!!
1 error in 0.08s
`;

const TESTS_FAILED = `
F.
=================================== FAILURES ===================================
pkg/tests/test_variable.py:20: in test_copy
    assert v.dtype == "U3"
E   AssertionError: assert dtype('O') == 'U3'
=========================== short test summary info ===========================
FAILED pkg/tests/test_variable.py::test_copy - AssertionError
1 failed, 1 passed in 0.31s
`;

test('which ends count as "the tests did not start": pytest exit 2 on collection errors, 3 and 4, and no test in the summary', () => {
  const none: string[] = [];
  assert.deepEqual(testsDidNotStart(PYTEST, REMOVED_ALIAS, 2, none), { what: 'pytest: collection error', error: 'pkg/tests/test_variable.py - AttributeError: `np.unicode_` was remov...', inChanged: [] });
  assert.deepEqual(testsDidNotStart(PYTEST, PLUGIN, 3, none), { what: 'pytest: internal error', error: "DeprecationWarning: 'asyncio.AbstractEventLoopPolicy' is deprecated and slated for removal in Python 3.16", inChanged: [] });
  assert.equal(testsDidNotStart(PYTEST, BROKEN_BY_CHANGE, 4, none)?.what, 'pytest: usage error');
  assert.equal(testsDidNotStart(PYTEST, "ERROR: usage: __main__.py [options] [file_or_dir]\n__main__.py: error: unrecognized arguments: --cov\n", 4, none)?.error, 'usage: __main__.py [options] [file_or_dir]');
  assert.equal(testsDidNotStart('py.test tests', REMOVED_ALIAS, 2, none)?.what, 'pytest: collection error');

  // tests ran and failed, or passed, or none were collected: ordinary results
  assert.equal(testsDidNotStart(PYTEST, TESTS_FAILED, 1, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, '2 passed in 0.10s\n', 0, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, 'no tests ran in 0.01s\n', 5, none), undefined);
  // exit 2 without a collection error (interrupted by hand), and a collection error next to tests that ran
  assert.equal(testsDidNotStart(PYTEST, '!!!!!!!!!! KeyboardInterrupt !!!!!!!!!!\n', 2, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, '3 passed, 1 error in 0.50s\n!!! Interrupted: 1 error during collection !!!\n', 2, none), undefined);
  // pytest -x stops at the first collection error with exit 1: still "did not start", by an error outside the change
  assert.deepEqual(testsDidNotStart(PYTEST, STOPPED_AT_FIRST, 1, ['pkg/core/variable.py', 'pkg/core/dataset.py']),
    { what: 'pytest: collection error', error: 'pkg/tests/test_dataset.py - AttributeError: `np.unicode_` was remove...', inChanged: [] });
  // the same end when the import breaks in a file the subagent changed: its failure (the signal is then an ordinary one)
  assert.deepEqual(testsDidNotStart(PYTEST, STOPPED_AT_FIRST, 1, ['pkg/core/dtypes.py'])?.inChanged, ['pkg/core/dtypes.py']);
  // exit 1 in every other shape stays an ordinary failure: a test ran and failed, a test's setup raised,
  // a collection error next to tests that ran, an error count without the collection header
  assert.equal(testsDidNotStart(PYTEST, SETUP_ERROR, 1, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, STOPPED_AT_FIRST.replace('13 warnings, 1 error', '2 passed, 13 warnings, 1 error'), 1, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, STOPPED_AT_FIRST.replace('13 warnings, 1 error', '1 failed, 1 error'), 1, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, '1 error in 0.10s\n', 1, none), undefined);
  assert.equal(testsDidNotStart(PYTEST, STOPPED_AT_FIRST, 0, none), undefined);
  // another runner with the same exit code is not read
  assert.equal(testsDidNotStart('npm test', STOPPED_AT_FIRST, 1, none), undefined);
  assert.equal(testsDidNotStart('npm test', REMOVED_ALIAS, 2, none), undefined);
  assert.equal(testsDidNotStart('node --test', 'ℹ tests 1\nℹ fail 1\n', 1, none), undefined);
  // color codes do not hide the summary
  assert.equal(testsDidNotStart(PYTEST, '\x1b[31m!!! Interrupted: 1 error during collection !!!\x1b[0m\n', 2, none)?.what, 'pytest: collection error');
});

test('whose error it is: the subagent\'s when the traceback or an "E" line names a file it changed', () => {
  const inChanged = (out: string, code: number, changed: string[]) => testsDidNotStart(PYTEST, out, code, changed)!.inChanged;
  // an error of the machine's packages, with the subagent's change somewhere else in the repository
  assert.deepEqual(inChanged(REMOVED_ALIAS, 2, ['pkg/core/indexing.py']), []);
  assert.deepEqual(inChanged(PLUGIN, 3, ['pkg/core/variable.py', 'pkg/tests/test_variable.py']), []);
  // the import the subagent broke: the error is raised in a file it did not touch, its file is a frame on the way
  assert.deepEqual(inChanged(BROKEN_BY_CHANGE, 4, ['pkg/core/assumptions.py']), ['pkg/core/assumptions.py']);
  assert.deepEqual(inChanged(BROKEN_BY_CHANGE, 4, ['pkg/core/other.py']), []);
  // a syntax error and a name that is gone are told in "E" lines, with the file's path
  assert.deepEqual(inChanged(SYNTAX_ERROR, 2, ['pkg/core/variable.py']), ['pkg/core/variable.py']);
  assert.deepEqual(inChanged(MISSING_NAME, 2, ['pkg/core/variable.py']), ['pkg/core/variable.py']);
  // a changed module that the import only passes through counts as well: the reading leans to the subagent's side
  assert.deepEqual(inChanged(REMOVED_ALIAS, 2, ['pkg/core/dtypes.py', 'pkg/core/__init__.py']), ['pkg/core/__init__.py', 'pkg/core/dtypes.py']);
  // the test module being collected is where every collection starts: a changed test file is not blamed for an
  // error raised further down, and is blamed when the error is raised in it
  assert.deepEqual(inChanged(REMOVED_ALIAS, 2, ['pkg/tests/test_variable.py']), []);
  assert.deepEqual(inChanged(MISSING_NAME, 2, ['pkg/tests/test_variable.py']), ['pkg/tests/test_variable.py']);
  // Windows separators in the output, a repository path given with slashes
  assert.deepEqual(inChanged(BROKEN_BY_CHANGE, 4, ['pkg/core/facts.py']), ['pkg/core/facts.py']);
});

// ---- the verify signal and the router's handling, with a stand-in for pytest that prints a stored output

/** `sh tools/pytest.sh <state dir>` prints tools/out<N>.txt and exits with tools/code<N> on its N-th run (the last pair repeats). */
const FAKE = ['n=$(cat "$1/n" 2>/dev/null || echo 0)', 'n=$((n+1))', 'echo $n > "$1/n"', 'while [ ! -f "tools/out$n.txt" ] && [ $n -gt 1 ]; do n=$((n-1)); done', 'cat "tools/out$n.txt"', 'exit $(cat "tools/code$n")', ''].join('\n');
const repoWith = (runs: Array<[string, number]>) => makeRepo({
  'pkg/core/variable.py': 'A = 1\n', 'pkg/core/assumptions.py': 'B = 1\n', 'tools/pytest.sh': FAKE,
  ...Object.fromEntries(runs.flatMap(([out, code], i) => [[`tools/out${i + 1}.txt`, out], [`tools/code${i + 1}`, `${code}\n`]])),
});
const commandsFor = (state: string): VerifyCommand[] => [{ kind: 'test', command: `sh tools/pytest.sh '${state.replace(/\\/g, '/')}'` }];

test('the verify signal: marked when the error is outside the subagent\'s changes, an ordinary failure when it is in them or when the changes are not known', async () => {
  const state = tmpDir('fake-pytest');
  const repo = repoWith([[REMOVED_ALIAS, 2]]);
  try {
    // no start snapshot: what the subagent changed is not known, so nothing is told apart
    const blind = await runVerify({ cwd: repo, root: repo, commands: commandsFor(state) });
    assert.deepEqual([blind[0]!.ok, isNotStarted(blind[0]!), (blind[0]!.detail ?? '').split('\n')[0]], [false, false, `${commandsFor(state)[0]!.command}: exit 2`]);
  } finally { rmrf(repo); rmrf(state); }
  assert.equal(isNotStarted({ ok: false, kind: 'test', detail: `pytest: ${NOT_STARTED_MARK}x (pytest: collection error; exit 2)` }), true);
  assert.equal(isNotStarted({ ok: false, kind: 'build', detail: `make: ${NOT_STARTED_MARK}x` }), false);
  assert.equal(isNotStarted({ ok: true, kind: 'test', detail: 'pytest: exit 0' }), false);
});

interface Flow { d: TestDaemon; repo: string; state: string; post: (h: HookInput) => Promise<{ decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } }>; close: () => Promise<void> }
async function flow(runs: Array<[string, number]>): Promise<Flow> {
  const state = tmpDir('fake-pytest');
  const repo = repoWith(runs);
  const d = await startTestDaemon({ verify: { resolveCommands: async () => commandsFor(state) } });
  const close = async () => { await d.close(); rmrf(d.home); rmrf(repo); rmrf(state); };
  // close the daemon if setup throws, so a failed assertion fails the test instead of leaking a listening daemon (no node --test timeout)
  try {
    const post: Flow['post'] = async h => {
      const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
      assert.equal(r.status, 200, r.text);
      return r.body as never;
    };
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the validation module across multiple files and add an audit log' });
    // decision 231: a checkable repo (test default), default difficulty moderate -> the source coder starts at s1 (haiku/low).
    assert.deepEqual(await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_ns',
      tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] fix\n[scope: pkg/**]', model: 'haiku', effort: 'low' } }), {});
    await post({ hook_event_name: 'SubagentStart', agent_id: 'c1', agent_type: 'do-it-all-claude-code:coder' });
    return { d, repo, state, post, close };
  } catch (e) { await close(); throw e; }
}
const stop = (f: Flow, again: boolean) => f.post({ hook_event_name: 'SubagentStop', agent_id: 'c1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: again });
const notify = async (f: Flow) => (await f.post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>c1</task-id>\n<status>completed</status>\n</task-notification>' })).hookSpecificOutput?.additionalContext ?? '';
const subtask = (f: Flow) => rows(f.d, 'SELECT status, verdict, step FROM subtasks')[0];
const coderSlot = (f: Flow) => rows(f.d, "SELECT step, up_count FROM slots WHERE role = 'coder' AND slot = 0")[0];

test('decision 234 (item 4) + 230: a moderate subtask whose tests never start is finalized on the FIRST stop (no fix-bounce), with one stronger retry set up', async () => {
  const f = await flow([[REMOVED_ALIAS, 2]]);
  try {
    write(f.repo, 'pkg/core/variable.py', 'A = 2\n');
    // decision 234 (item 4): the tests did not start, by an error in no file the subtask changed, so a fix cannot
    // make them start — the worker is not bounced. The first stop finalizes it and tells the lead directly.
    assert.deepEqual(await stop(f, false), {});
    // decision 230 (item 3): a moderate subtask that ends unverified gets one stronger retry (the slot jumps a
    // model) before the hand-back. decision 231 (item 3): it started below s5 (s1), so the retry fires.
    assert.deepEqual(subtask(f), { status: 'failed', verdict: 'fail_once', step: 's1' });
    assert.deepEqual(coderSlot(f), { step: 's3', up_count: 1 });   // modelJump s1 (haiku) -> s3 (sonnet)
    assert.equal(rows(f.d, 'SELECT COUNT(*) AS c FROM step_changes')[0]!.c, 1);
    assert.equal(rows(f.d, 'SELECT detail FROM step_changes')[0]!.detail, 'unverified-retry');

    const line = await notify(f);
    assert.match(line, /could not be verified here \(verify did not run\)\. Because this is a moderate subtask, the router set up one stronger attempt: its slot now runs at s3 \(model="sonnet", effort="medium"\)\. Dispatch subtask A again now with these values and the SAME scope/);
  } finally { await f.close(); }
});

test('an import the subagent broke is its failure: the block asks for a fix, and a second failure raises the slot as any miss does', async () => {
  const f = await flow([[BROKEN_BY_CHANGE, 4]]);
  try {
    write(f.repo, 'pkg/core/assumptions.py', 'B = 2\n');
    const first = await stop(f, false);
    assert.equal(first.decision, 'block');
    assert.match(first.reason ?? '', /- test: sh tools\/pytest\.sh '[^']+': exit 4/);
    assert.match(first.reason ?? '', /Fix these, re-run the related tests, then finish again/);   // decision 234: related tests, not the whole suite
    assert.doesNotMatch(first.reason ?? '', /tests did not start/i);
    assert.deepEqual(await stop(f, true), {});
    assert.deepEqual(subtask(f), { status: 'failed', verdict: 'miss', step: 's1' });
    assert.deepEqual(coderSlot(f), { step: 's2', up_count: 1 });   // decision 231: a miss from s1 (haiku·low) raises to s2 (haiku·high)
    assert.match(await notify(f), /verify failed again after one fix attempt \(miss\)/);
  } finally { await f.close(); }
});

test('decision 234 (item 4): a not-started result is finalized on any stop, with no "repeat" requirement — an in-change failure is still bounced first', async () => {
  // the worker breaks the import (an in-change failure, bounced once to fix), then its tests do not start by an
  // error outside its change: that stop finalizes it (decision 230 retry), it is not bounced a second time nor
  // treated as a plain miss — decision 212's two-attempt requirement for not-started is superseded by item 4.
  const mixed = await flow([[BROKEN_BY_CHANGE, 4], [REMOVED_ALIAS, 2]]);
  try {
    write(mixed.repo, 'pkg/core/assumptions.py', 'B = 2\n');
    assert.equal((await stop(mixed, false)).decision, 'block');
    assert.deepEqual(await stop(mixed, true), {});
    assert.deepEqual(subtask(mixed), { status: 'failed', verdict: 'fail_once', step: 's1' });
    assert.deepEqual(coderSlot(mixed), { step: 's3', up_count: 1 });   // moderate -> one stronger retry (modelJump), not a miss step-up
  } finally { await mixed.close(); }
});

test('decision 234 (item 2): a verify failure the worker was asked to fix but never came back to is finalized on its notification, not left as "no result yet"', async () => {
  const f = await flow([[TESTS_FAILED, 1]]);
  try {
    write(f.repo, 'pkg/core/variable.py', 'A = 2\n');
    // first stop: a real verify failure (a test ran and failed) -> the worker is blocked once to fix it
    assert.equal((await stop(f, false)).decision, 'block');
    assert.deepEqual(subtask(f), { status: 'running', verdict: 'fail_once', step: 's1' });
    // the worker's turn ends without coming back (its task-notification arrives, no second stop): the router
    // finalizes the subtask with the verify result it already has; the lead line is a real result, not "no result yet".
    const line = await notify(f);
    assert.doesNotMatch(line, /no verification result yet|no final result yet/);
    assert.match(line, /verify failed again after one fix attempt \(miss\)/);
    assert.deepEqual(subtask(f), { status: 'failed', verdict: 'miss', step: 's1' });
    assert.deepEqual(coderSlot(f), { step: 's2', up_count: 1 });   // finalized as a miss, slot raised s1 -> s2
  } finally { await f.close(); }
});
