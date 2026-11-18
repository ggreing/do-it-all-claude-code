// How verify ended is told once per kind of check, with one answer.
//
// The coder's verify list holds two "build" commands (npm ci, the build script) and two "test" commands (npm
// test, pytest). In a project whose package.json has a test script and nothing else, the lead read:
//   verify passed — repro ok, build skipped, build ok, typecheck ok, lint ok, test ok (2 passed), test skipped, scope ok
// The same name twice with two answers, and "ok" for scripts that do not exist (`npm run build --if-present`
// exits 0 when there is no build script). It now reads:
//   verify passed — repro ok, build skipped, typecheck skipped, lint skipped, test ok (2 passed), scope ok
// The office and the Work tab show the same entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksByKind, checksPhrase, notRun } from '../src/checks.ts';
import { officeView } from '../src/office.ts';
import { workDetail } from '../src/tabs.ts';
import { resolveVerifyCommands } from '../src/verify-source.ts';
import { hasPackageScript, ifPresentScript, runVerify, type VerifyCommand } from '../src/verify.ts';
import { pinRoutine, makeRepo, postHook, rmrf, rows, startTestDaemon, tmpDir, write, type HookInput } from './helpers.ts';

const PLUGIN_DIR = fileURLToPath(new URL('../../../plugin', import.meta.url));
const TEST_FILE = "import { test } from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n";
/** A project with a test script and nothing else. */
const ONLY_TESTS = { 'package.json': '{ "name": "textkit", "type": "module", "scripts": { "test": "node --test" } }\n', 'src/slug.js': 'export const a = 1;\n', 'test/slug.test.js': TEST_FILE };

/**
 * The shipped coder role's verify list, with `npm test --if-present` run as the script it names, so that the test
 * needs no npm: the conditions and the kinds are the role's own.
 */
async function coderCommands(): Promise<VerifyCommand[]> {
  const r = await resolveVerifyCommands({ role: 'coder', pluginDir: PLUGIN_DIR });
  assert.equal(r.source, 'role');
  assert.deepEqual(r.commands.map(c => c.kind), ['build', 'build', 'typecheck', 'lint', 'test', 'test'], 'two commands for build and for test: the case this file is about');
  return r.commands.map(c => (c.command === 'npm test --if-present' ? { ...c, command: RUN_TESTS } : c));
}
// this file itself runs under `node --test`: with the variable set, an inner run skips its files and exits 0
const RUN_TESTS = 'env -u NODE_TEST_CONTEXT node --test';

test('the signals of a project with only a test script: one entry per kind, each with one answer', () => {
  // as the router recorded them for that project, before and after scripts that do not exist were told as skipped
  const before = [
    { kind: 'repro', attempt: 1, ok: true, detail: 'test/slug-accents.test.js: failed before the change, passes after it, unchanged', durationMs: 145 },
    { kind: 'build', attempt: 1, ok: true, detail: 'npm ci: skipped (no package-lock.json)' },
    { kind: 'build', attempt: 1, ok: true, detail: 'npm run build --if-present: exit 0', durationMs: 610 },
    { kind: 'typecheck', attempt: 1, ok: true, detail: 'npm run typecheck --if-present: exit 0', durationMs: 505 },
    { kind: 'lint', attempt: 1, ok: true, detail: 'npm run lint --if-present: exit 0', durationMs: 505 },
    { kind: 'test', attempt: 1, ok: true, detail: 'npm test --if-present: exit 0', durationMs: 662, testsPassed: 2, testsFailed: 0 },
    { kind: 'test', attempt: 1, ok: true, detail: 'python -m pytest -q -x {relatedTests}: skipped (none of pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py)' },
    { kind: 'scope', attempt: 1, ok: true, detail: "shared work tree (the user's checkout): 2 file(s) changed during the subtask" },
  ];
  assert.equal(checksPhrase(checksByKind(before)), 'repro ok, build ok, typecheck ok, lint ok, test ok (2 passed), scope ok');
  const after = before.map(x => (/--if-present: exit 0$/.test(x.detail) && x.kind !== 'test'
    ? { kind: x.kind, attempt: 1, ok: true, detail: x.detail.replace(/: exit 0$/, `: skipped (no "${x.kind}" script in package.json)`) } : x));
  const checks = checksByKind(after);
  assert.equal(checksPhrase(checks), 'repro ok, build skipped, typecheck skipped, lint skipped, test ok (2 passed), scope ok');
  assert.deepEqual(checks.find(c => c.kind === 'test'), { kind: 'test', attempt: 1, result: 'ok', testsPassed: 2, testsFailed: 0, durationMs: 662 });
});

test('one kind, several commands: failed when any failed, ok when one ran, skipped when none did; counts add up; attempts stay apart', () => {
  const s = (kind: string, ok: boolean, detail: string, extra: Record<string, number> = {}, attempt = 1) => ({ kind, attempt, ok, detail, ...extra });
  assert.deepEqual(checksByKind([
    s('test', true, 'npm test: exit 0', { testsPassed: 3, testsFailed: 0, durationMs: 100 }),
    s('test', false, 'pytest: exit 1', { testsPassed: 4, testsFailed: 1, durationMs: 50 }),
    s('build', true, 'npm ci: skipped (node_modules present)'),
    s('lint', true, 'eslint: exit 0', {}, 2),
    s('test', true, 'pytest {relatedTests}: no related tests (not run; neither a pass nor a miss)', {}, 2),
  ]), [
    { kind: 'test', attempt: 1, result: 'failed', testsPassed: 7, testsFailed: 1, durationMs: 150 },
    { kind: 'build', attempt: 1, result: 'skipped' },
    { kind: 'lint', attempt: 2, result: 'ok' },
    { kind: 'test', attempt: 2, result: 'skipped' },
  ]);
  assert.equal(checksPhrase(checksByKind([s('test', false, 'npm test: exit 1', { testsPassed: 2, testsFailed: 1 })])), 'test failed (2 passed, 1 failed)');
  assert.equal(notRun('pytest: no related tests (not run; neither a pass nor a miss)'), true);
  assert.equal(notRun('npm test: exit 0'), false);
  assert.deepEqual(checksByKind([]), []);
});

test('a script that package.json does not have is not run and not a pass', async () => {
  assert.deepEqual(['npm run build --if-present', 'npm run --if-present lint', 'npm test --if-present', 'pnpm run type:check --if-present', 'npm run-script build --if-present'].map(ifPresentScript),
    ['build', 'lint', 'test', 'type:check', 'build']);
  assert.deepEqual(['npm run build', 'npm test', 'npm run build --if-present && npm test', 'yarn build', 'npm ci', 'npx tsc --noEmit'].map(ifPresentScript),
    [undefined, undefined, undefined, undefined, undefined, undefined]);
  const dir = tmpDir('scripts');
  try {
    assert.equal(hasPackageScript(dir, 'build'), undefined, 'no package.json: the command decides');
    write(dir, 'package.json', '{ "scripts": { "test": "node --test", "lint": "" } }');
    assert.deepEqual(['test', 'build', 'lint'].map(n => hasPackageScript(dir, n)), [true, false, false]);
    write(dir, 'package.json', '{ "name": "x" }');
    assert.equal(hasPackageScript(dir, 'test'), false);
    write(dir, 'package.json', '{ not json');
    assert.equal(hasPackageScript(dir, 'test'), undefined, 'unreadable: the command decides');
  } finally { rmrf(dir); }
});

test('the coder\'s verify list in a project with only a test script: build, typecheck and lint are skipped, the tests ran once', async () => {
  const repo = makeRepo(ONLY_TESTS);
  try {
    const signals = await runVerify({ cwd: repo, root: repo, commands: await coderCommands() });
    assert.deepEqual(signals.map(x => [x.kind, x.ok, (x.detail ?? '').split('\n')[0]]), [
      ['build', true, 'npm ci: skipped (no package-lock.json)'],
      ['build', true, 'npm run build --if-present: skipped (no "build" script in package.json)'],
      ['typecheck', true, 'npm run typecheck --if-present: skipped (no "typecheck" script in package.json)'],
      ['lint', true, 'npm run lint --if-present: skipped (no "lint" script in package.json)'],
      ['test', true, `${RUN_TESTS}: exit 0`],
      ['test', true, 'python -m pytest -q -x {relatedTests}: skipped (none of pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py)'],
    ]);
    assert.equal(checksPhrase(checksByKind(signals)), 'build skipped, typecheck skipped, lint skipped, test ok (2 passed)');
  } finally { rmrf(repo); }
});

test('the lead\'s line, the office and the Work tab tell that project\'s verify the same way', async () => {
  const repo = makeRepo(ONLY_TESTS);
  const commands = await coderCommands();
  const d = await startTestDaemon({ verify: { resolveCommands: async () => commands } });
  const post = async (h: HookInput) => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as { hookSpecificOutput?: { additionalContext?: string } };
  };
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the validation module across multiple files and add an audit log' });
    pinRoutine(d);
    assert.deepEqual(await post({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_ck',
      tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:A] fix\n[scope: src/**, test/**]', model: 'haiku', effort: 'low' } }), {});
    await post({ hook_event_name: 'SubagentStart', agent_id: 'c1', agent_type: 'do-it-all-claude-code:coder' });
    write(repo, 'src/slug.js', 'export const a = 2;\n');
    assert.deepEqual(await post({ hook_event_name: 'SubagentStop', agent_id: 'c1', agent_type: 'do-it-all-claude-code:coder', stop_hook_active: false }), {});
    const line = (await post({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>c1</task-id>\n<status>completed</status>\n</task-notification>' })).hookSpecificOutput?.additionalContext ?? '';
    assert.match(line, /: verify passed — build skipped, typecheck skipped, lint skipped, test ok \(2 passed\), scope ok \(1 file\(s\), working tree\)/);
    assert.match(line, /already verified by the router: do not re-run the test suite/);
    assert.equal(/verify passed — (.*?) \(\d+ file/.exec(line)?.[1], 'build skipped, typecheck skipped, lint skipped, test ok (2 passed), scope ok', 'each kind is named once');

    const expected = [
      { kind: 'build', result: 'skipped' }, { kind: 'typecheck', result: 'skipped' }, { kind: 'lint', result: 'skipped' },
      { kind: 'test', result: 'ok', testsPassed: 2, testsFailed: 0 }, { kind: 'scope', result: 'ok' },
    ];
    const office = officeView({ status: sid => d.router.status(sid), ledger: d.ledger }, 's');
    assert.deepEqual(office.subtasks[0]!.checks, expected);
    const requestId = String(rows(d, 'SELECT id FROM requests')[0]!.id);
    const work = workDetail({ ledger: d.ledger, config: {} }, requestId);
    assert.deepEqual(work!.subtasks[0]!.checks.map(({ durationMs: _d, attempt: _a, ...c }) => c), expected);
    assert.deepEqual(work!.subtasks[0]!.checks.map(c => c.attempt), [1, 1, 1, 1, 1]);
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
});
