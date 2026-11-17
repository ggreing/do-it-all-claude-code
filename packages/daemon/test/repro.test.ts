// Decisions 175, 177, 179: reproduce first. A coder's test file is run when it is written (PostToolUse) while
// nothing but tests changed; at the stop the same file, unchanged, must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger, SCHEMA_VERSION } from '../src/ledger.ts';
import {
  DEFAULT_REPRO_TEMPLATES, classifyRun, defaultRepro, isTestFile, isTestSupport, leadNote, parseReproTag, pickTemplate, projectReproTemplates, reportedNone, reproCommand,
  reproMode, resolveReproTemplates, treePath, type ReproRecord,
} from '../src/repro.ts';
import { readConfig } from '../src/config.ts';
import { git, makeRepo, postHook, rmrf, rows, startTestDaemon, write, type HookInput, type TestDaemon } from './helpers.ts';

// ------------------------------------------------------------------ unit

test('the tag line: required, off with a reason, malformed, absent', () => {
  assert.deepEqual(parseReproTag('[subtask:A]\n[scope: src/**]\n[repro: required]\nfix it'), { ok: true, required: true });
  assert.deepEqual(parseReproTag('[subtask:A]\n[repro: off refactor]\nspec'), { ok: true, required: false, reason: 'refactor' });
  assert.deepEqual(parseReproTag('[subtask:A]\n[scope: a/**]\n[repro: OFF not-testable]'), { ok: true, required: false, reason: 'not-testable' });
  assert.equal(parseReproTag('[subtask:A]\n[scope: a/**]\n[repro: off]')?.ok, false);
  assert.equal(parseReproTag('[subtask:A]\n[scope: a/**]\n[repro: off because]')?.ok, false);
  assert.equal(parseReproTag('[subtask:A]\n[scope: a/**]\n[repro: maybe]')?.ok, false);
  assert.equal(parseReproTag('[subtask:A]\n[scope: a/**]\nspec\n[repro: required]'), undefined);   // only the tag lines are read
  assert.equal(parseReproTag('[subtask:A]\nspec'), undefined);
});

test('the default: required unless the work is a refactor or the scope holds only documentation or configuration', () => {
  assert.deepEqual(defaultRepro('debug', ['src/**'], false), { required: true });
  assert.deepEqual(defaultRepro('feature', ['**'], true), { required: true });
  assert.deepEqual(defaultRepro('edit', ['src/**', 'test/**'], false), { required: true });
  assert.deepEqual(defaultRepro('refactor', ['src/**'], false), { required: false, reason: 'refactor' });
  assert.deepEqual(defaultRepro('edit', ['docs/**', 'README.md'], false), { required: false, reason: 'docs' });
  assert.deepEqual(defaultRepro('edit', ['package.json', '.github/**'], false), { required: false, reason: 'config' });
  assert.deepEqual(defaultRepro('edit', ['docs/**', 'src/**'], false), { required: true });
});

test('the report line: "Repro: none (<reason>)" is read; an echoed list of reasons says nothing', () => {
  assert.equal(reportedNone('- Changed files: a\n- Repro: none (not-testable)\n'), 'not-testable');
  assert.equal(reportedNone('**Repro:** none (cannot-reproduce)'), 'cannot-reproduce');
  assert.equal(reportedNone('Repro: none'), 'no-reason');
  assert.equal(reportedNone('Repro: none (no-tests | not-testable | cannot-reproduce)'), 'no-tests');
  assert.equal(reportedNone('Repro: none (no-tests)\nRepro: none (not-testable)'), undefined);
  assert.equal(reportedNone('Repro: test/a.test.js'), undefined);
  assert.equal(reportedNone(undefined), undefined);
});

test('which files are tests', () => {
  for (const f of ['test/a.test.ts', 'src/a.spec.mjs', 'tests/test_x.py', 'pkg/x_test.py', 'pkg/x_test.go', 'tests/regress/tests.py', 'test/unit/pagination.js', '__tests__/a.jsx']) assert.equal(isTestFile(f), true, f);
  for (const f of ['src/a.ts', 'tests/conftest.py', 'tests/__init__.py', 'test/fixtures/data.js', 'tests/data.json', 'README.md', 'src/contest.py']) assert.equal(isTestFile(f), false, f);
  assert.equal(isTestSupport('test/fixtures/data.json'), true);
  assert.equal(isTestSupport('tests/conftest.py'), true);
  assert.equal(isTestSupport('src/a.ts'), false);
});

test('a tool path becomes a repo-relative path, or nothing when it is outside the tree', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ar-rp-'));
  try {
    assert.equal(treePath(root, root, path.join(root, 'test', 'a b.test.js')), 'test/a b.test.js');
    assert.equal(treePath(root, root, 'test/a.test.js'), 'test/a.test.js');
    assert.equal(treePath(root, path.join(root, 'sub'), '../test/a.test.js'), 'test/a.test.js');
    assert.equal(treePath(root, root, path.join(root, '..', 'elsewhere.test.js')), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the command: the file is one quoted word and never an option', () => {
  const node = DEFAULT_REPRO_TEMPLATES.find(t => t.runner === 'node')!;
  assert.equal(reproCommand(node, 'test/a.test.js'), "node --test 'test/a.test.js'");
  assert.equal(reproCommand(node, "test/it's $(x) .test.js"), "node --test 'test/it'\\''s $(x) .test.js'");
  assert.equal(reproCommand(node, '--import=x.test.js'), "node --test './--import=x.test.js'");
  const go = DEFAULT_REPRO_TEMPLATES.find(t => t.runner === 'go')!;
  assert.equal(reproCommand(go, 'pkg/store/store_test.go'), "go test './pkg/store'");
  assert.equal(reproCommand(go, 'main_test.go'), "go test '.'");
});

test('the template: by file type and by what the tree holds; a project list replaces the defaults', async () => {
  const repo = makeRepo({ 'package.json': '{"devDependencies":{"vitest":"1"}}\n', 'pyproject.toml': '\n' });
  try {
    assert.equal(pickTemplate(DEFAULT_REPRO_TEMPLATES, repo, 'test/a.test.ts')?.runner, 'vitest');
    assert.equal(pickTemplate(DEFAULT_REPRO_TEMPLATES, repo, 'tests/test_a.py')?.runner, 'pytest');
    assert.equal(pickTemplate(DEFAULT_REPRO_TEMPLATES, repo, 'pkg/a_test.go'), undefined);   // no go.mod
    write(repo, 'package.json', '{}\n');
    assert.equal(pickTemplate(DEFAULT_REPRO_TEMPLATES, repo, 'test/a.test.ts')?.runner, 'node');
    assert.equal((await resolveReproTemplates(repo, 'HEAD')).templates, DEFAULT_REPRO_TEMPLATES);
    // the project's list is read at the start commit: an uncommitted edit of it is not seen
    write(repo, '.do-it-all-claude-code/verify.json', JSON.stringify({ repro: [{ command: 'npx mocha {reproFiles}', files: '\\.js$' }] }));
    assert.equal((await resolveReproTemplates(repo, 'HEAD')).templates, DEFAULT_REPRO_TEMPLATES);
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'verify');
    assert.deepEqual((await resolveReproTemplates(repo, 'HEAD')).templates, [{ command: 'npx mocha {reproFiles}', files: '\\.js$' }]);
  } finally { rmrf(repo); }
  assert.throws(() => projectReproTemplates({ repro: [{ command: 'npm test' }] }), /needs \{reproFiles\}/);
  assert.throws(() => projectReproTemplates({ repro: [{ command: 'x {reproFiles}', ifExists: '../x' }] }), /ifExists/);
  assert.throws(() => projectReproTemplates({ repro: [{ command: 'x {reproFiles}', files: '(' }] }), /regular expression/);
  assert.equal(projectReproTemplates({ coder: ['npm test'] }), undefined);
});

test('what a run says, from the exit code and the summary', () => {
  const c = (runner: string | undefined, out: string, code: number | null, timedOut = false) => classifyRun(runner, 'cmd', out, code, timedOut, false);
  assert.deepEqual(c('node', 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n', 0), { result: 'passed' });
  assert.deepEqual(c('node', "AssertionError [ERR_ASSERTION]: x\nℹ tests 1\nℹ pass 0\nℹ fail 1\n", 1), { result: 'failed', kind: 'body', failed: 1 });
  assert.deepEqual(c('node', "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'x'\nℹ tests 1\nℹ pass 0\nℹ fail 1\n", 1), { result: 'failed', kind: 'load', failed: 1 });
  assert.deepEqual(c('node', 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n', 0), { result: 'no-tests', what: 'node --test: tests 0' });
  assert.deepEqual(c('pytest', '1 failed, 2 passed in 0.1s', 1), { result: 'failed', kind: 'body', failed: 1 });
  assert.deepEqual(c('pytest', 'ERROR tests/test_a.py\n1 error in 0.1s', 2), { result: 'failed', kind: 'load' });
  assert.deepEqual(c('jest', 'Test suite failed to run\nTests: 0 total', 1), { result: 'failed', kind: 'load' });
  assert.deepEqual(c('jest', 'Tests:       1 failed, 1 total', 1), { result: 'failed', kind: 'body', failed: 1 });
  assert.deepEqual(c('go', '--- FAIL: TestX (0.00s)\nFAIL', 1), { result: 'failed', kind: 'body' });
  assert.deepEqual(c('go', 'FAIL pkg [build failed]', 1), { result: 'failed', kind: 'load' });
  assert.deepEqual(c(undefined, 'boom', 3), { result: 'failed', kind: 'unknown' });
  assert.deepEqual(c('node', 'bash: line 1: node: command not found', 127), { result: 'not-checked', why: 'node not found' });
  assert.equal(c('node', '', null, true).result, 'not-checked');
});

test('config.reproduceFirst: on, observe or off; off unless set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-rc-'));
  try {
    const file = path.join(dir, 'config.json');
    const read = (v: unknown) => { fs.writeFileSync(file, JSON.stringify({ reproduceFirst: v })); const w: string[] = []; return { c: readConfig(file, w), w }; };
    assert.equal(reproMode(read('on').c), 'on');
    assert.equal(reproMode(read('observe').c), 'observe');
    assert.equal(reproMode(read(undefined).c), 'off');
    const bad = read('yes');
    assert.equal(reproMode(bad.c), 'off');
    assert.match(bad.w.join(), /reproduceFirst ignored/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the lead\'s line', () => {
  const f = { 'test/a.test.js': { fingerprint: 'x', kind: 'body' as const } };
  assert.equal(leadNote(null), '');
  assert.equal(leadNote({ required: false, by: 'lead', reason: 'docs' }), '');
  assert.match(leadNote({ required: true, by: 'router', state: 'reproduced', files: f }), /test\/a\.test\.js failed before the change and passes after it, unchanged\.$/);
  assert.match(leadNote({ required: true, by: 'router', state: 'reproduced', files: { a: { fingerprint: 'x', kind: 'unknown' } } }), /how it failed before: unknown/);
  assert.match(leadNote({ required: true, by: 'router', state: 'unconfirmed', reason: 'test-changed', files: f }), /unconfirmed \(test\/a\.test\.js was changed after it was seen failing\)/);
  assert.match(leadNote({ required: true, by: 'router', state: 'unconfirmed', reason: 'not-testable' }), /unconfirmed \(not-testable\)/);
});

// ------------------------------------------------------------------ the router, with real `node --test` runs

const PROMPT = 'Fix the bug in the pagination module so the last page is returned across multiple files';
type Out = { decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string; permissionDecisionReason?: string } };
const BUGGY = 'exports.add = (a, b) => a - b;\n';
const FIXED = 'exports.add = (a, b) => a + b;\n';
const TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../src/add.js');\ntest('adds', () => { assert.equal(add(2, 3), 5); });\n";
const PASSING = "const { test } = require('node:test');\ntest('nothing', () => {});\n";

interface Flow { d: TestDaemon; repo: string; post: (h: HookInput) => Promise<Out>; edit: (rel: string, body: string, agent?: string) => Promise<string>; repro: () => ReproRecord | null }

async function flow(mode: 'on' | 'observe' | 'off', fn: (f: Flow) => Promise<void>, files: Record<string, string> = {}): Promise<void> {
  const repo = makeRepo({ 'package.json': '{"name":"t"}\n', 'src/add.js': BUGGY, ...files });
  const d = await startTestDaemon({ config: { reproduceFirst: mode }, verify: { resolveCommands: async () => [] } });
  const post = async (h: HookInput): Promise<Out> => {
    const r = await postHook(d.port, { session_id: 's', cwd: repo, transcript_path: path.join(d.home, 's.jsonl'), ...h });
    assert.equal(r.status, 200, r.text);
    return r.body as Out;
  };
  const edit = async (rel: string, body: string, agent = 'a1'): Promise<string> => {
    write(repo, rel, body);
    const out = await post({ hook_event_name: 'PostToolUse', tool_name: 'Write', agent_id: agent, agent_type: 'do-it-all-claude-code:coder', tool_input: { file_path: path.join(repo, rel) } });
    return out.hookSpecificOutput?.additionalContext ?? '';
  };
  const repro = () => {
    const r = rows(d, "SELECT repro FROM subtasks WHERE id = 'A'")[0]!.repro;
    return r === null ? null : JSON.parse(String(r)) as ReproRecord;
  };
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    await fn({ d, repo, post, edit, repro });
  } finally { await d.close(); rmrf(d.home); rmrf(repo); }
}
let seq = 0;
const call = (lines = '[scope: src/**, test/**]'): HookInput => ({
  hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: `toolu_rp${++seq}`,
  tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: `[subtask:A]\n${lines}\nfix add()`, model: 'haiku', effort: 'low' },
});
const start = (id = 'a1'): HookInput => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'do-it-all-claude-code:coder' });
const stop = (last = '- Changed files: src/add.js', again = false, id = 'a1'): HookInput => ({
  hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'do-it-all-claude-code:coder', stop_hook_active: again, last_assistant_message: last,
});
const notify = (id = 'a1'): HookInput => ({ hook_event_name: 'UserPromptSubmit', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` });
const begin = async (f: Flow, lines?: string): Promise<string> => {
  assert.deepEqual(await f.post(call(lines)), {});
  return (await f.post(start())).hookSpecificOutput?.additionalContext ?? '';
};
const agentFile = (f: Flow) => JSON.parse(fs.readFileSync(path.join(f.d.home, 'agents', 'a1.json'), 'utf8')) as { repro?: boolean };
const signals = (f: Flow) => rows(f.d, "SELECT kind, ok FROM signals WHERE kind = 'repro' ORDER BY id");
const subtask = (f: Flow) => rows(f.d, "SELECT status, verdict FROM subtasks WHERE id = 'A'")[0]!;

test('test first, then the fix: the test is seen failing when it is written, and passes unchanged at the stop', () => flow('on', async f => {
  assert.match(await begin(f, '[scope: src/**, test/**]\n[repro: required]'), /needs a reproduction first/);
  assert.deepEqual(f.repro(), { required: true, by: 'lead', state: 'pending' });
  assert.equal(agentFile(f).repro, true);

  const told = await f.edit('test/add.test.js', TEST);
  assert.match(told, /^\[do-it-all-claude-code\] reproduction for subtask A: test\/add\.test\.js fails on the unchanged code \(1 failed\), as a reproduction should\. Now make the change\./);
  const seen = f.repro()!;
  assert.equal(seen.state, 'confirmed');
  assert.equal(seen.files!['test/add.test.js']!.kind, 'body');
  assert.equal(seen.runs, 1);

  assert.equal(await f.edit('src/add.js', FIXED), '');   // a source file: nothing runs
  assert.deepEqual(await f.post(stop()), {});
  assert.equal(f.repro()!.state, 'reproduced');
  assert.deepEqual(signals(f), [{ kind: 'repro', ok: 1 }]);
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
  const lead = (await f.post(notify())).hookSpecificOutput?.additionalContext ?? '';
  assert.match(lead, /verify passed — repro ok, scope ok/);
  assert.match(lead, /Reproduction: test\/add\.test\.js failed before the change and passes after it, unchanged\./);
}));

test('the test still fails after the change: a verify failure, one fix round, then a miss and a raised slot', () => flow('on', async f => {
  await begin(f);
  assert.deepEqual(f.repro(), { required: true, by: 'router', state: 'pending' });   // no tag line: the router's default
  await f.edit('test/add.test.js', TEST);
  await f.edit('src/add.js', 'exports.add = (a, b) => a * b;\n');
  const first = await f.post(stop());
  assert.equal(first.decision, 'block');
  assert.match(first.reason ?? '', /- repro: node --test 'test\/add\.test\.js': the reproduction test test\/add\.test\.js still fails after the change \(exit 1\)/);
  assert.equal(f.repro()!.state, 'failed');
  // fixed in the fix round: the same test passes
  await f.edit('src/add.js', FIXED);
  assert.deepEqual(await f.post(stop('done', true)), {});
  assert.equal(f.repro()!.state, 'reproduced');
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
}));

test('still failing twice is a miss: the slot is raised as for any verify failure', () => flow('on', async f => {
  await begin(f);
  await f.edit('test/add.test.js', TEST);
  await f.edit('src/add.js', 'exports.add = (a, b) => a * b;\n');
  assert.equal((await f.post(stop())).decision, 'block');
  assert.deepEqual(await f.post(stop('gave up', true)), {});
  assert.deepEqual(subtask(f), { status: 'failed', verdict: 'miss' });
  assert.deepEqual(signals(f), [{ kind: 'repro', ok: 0 }, { kind: 'repro', ok: 0 }]);
  assert.deepEqual(rows(f.d, "SELECT step FROM slots WHERE role = 'coder' AND slot = 0"), [{ step: 's2' }]);
  assert.match((await f.post(notify())).hookSpecificOutput?.additionalContext ?? '', /verify failed again after one fix attempt \(miss\) — repro failed/);
}));

test('a test that passes on the unchanged code is not a reproduction; corrected, it is run again', () => flow('on', async f => {
  await begin(f);
  assert.match(await f.edit('test/add.test.js', PASSING), /passes on the unchanged code, so it does not show the problem/);
  assert.deepEqual(f.repro(), { required: true, by: 'router', state: 'pending', files: {}, runs: 1, reason: 'cannot-reproduce' });
  assert.match(await f.edit('test/add.test.js', TEST), /fails on the unchanged code/);
  assert.equal(f.repro()!.state, 'confirmed');
  assert.equal(f.repro()!.reason, undefined);
}));

test('never shown: unconfirmed with the reason, a pass that is not an easy one, and the lead is told', () => flow('on', async f => {
  await begin(f);
  await f.edit('test/add.test.js', PASSING);
  await f.edit('src/add.js', FIXED);
  assert.deepEqual(await f.post(stop('- Changed files: src/add.js\n- Repro: none (cannot-reproduce)')), {});
  assert.deepEqual(f.repro(), { required: true, by: 'router', state: 'unconfirmed', files: {}, runs: 1, reason: 'cannot-reproduce' });
  assert.deepEqual(signals(f), []);
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
  assert.match((await f.post(notify())).hookSpecificOutput?.additionalContext ?? '', /Reproduction unconfirmed \(the coder could not make a test fail on the unchanged code\)/);
}));

test('the fix before the test: the test is not run, the coder is told once, and the edits are no longer sent', () => flow('on', async f => {
  await begin(f);
  await f.edit('src/add.js', FIXED);
  assert.match(await f.edit('test/add.test.js', TEST), /other files were changed before a test was seen failing \(src\/add\.js\)/);
  assert.deepEqual(f.repro(), { required: true, by: 'router', state: 'unconfirmed', reason: 'changed-first' });
  assert.equal(agentFile(f).repro, undefined);
  assert.equal(await f.edit('test/add.test.js', `${TEST}\n`), '');
  assert.deepEqual(await f.post(stop()), {});
  assert.equal(f.repro()!.state, 'unconfirmed');
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
}));

test('the confirmed test is edited after the fix: a warning at once, unconfirmed (test-changed) at the stop', () => flow('on', async f => {
  await begin(f);
  await f.edit('test/add.test.js', TEST);
  await f.edit('src/add.js', FIXED);
  assert.match(await f.edit('test/add.test.js', PASSING), /was seen failing on the unchanged code and has now been edited/);
  assert.deepEqual(await f.post(stop()), {});
  assert.equal(f.repro()!.state, 'unconfirmed');
  assert.equal(f.repro()!.reason, 'test-changed');
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
}));

test('the confirmed test is deleted: a verify failure', () => flow('on', async f => {
  await begin(f);
  await f.edit('test/add.test.js', TEST);
  await f.edit('src/add.js', FIXED);
  fs.rmSync(path.join(f.repo, 'test/add.test.js'));
  const out = await f.post(stop());
  assert.equal(out.decision, 'block');
  assert.match(out.reason ?? '', /the test file is gone/);
}));

test('a failure of unknown kind is accepted when the unchanged test passes, labelled', async () => {
  const d = { reproTemplates: [{ command: 'node {reproFiles}', files: '\\.js$' }] };
  const repo = makeRepo({ 'package.json': '{}\n', 'src/add.js': BUGGY });
  const daemon = await startTestDaemon({ config: { reproduceFirst: 'on' }, verify: { resolveCommands: async () => [], ...d } });
  const post = async (h: HookInput) => (await postHook(daemon.port, { session_id: 's', cwd: repo, transcript_path: path.join(daemon.home, 's.jsonl'), ...h })).body as Out;
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    await post(call());
    await post(start());
    write(repo, 'test/add.test.js', "const assert = require('node:assert');\nassert.equal(require('../src/add.js').add(2, 3), 5);\n");
    const told = (await post({ hook_event_name: 'PostToolUse', tool_name: 'Write', agent_id: 'a1', tool_input: { file_path: path.join(repo, 'test/add.test.js') } })).hookSpecificOutput?.additionalContext ?? '';
    assert.match(told, /fails on the unchanged code, as a reproduction should\. The router could not tell how it failed/);
    write(repo, 'src/add.js', FIXED);
    assert.deepEqual(await post(stop()), {});
    const rec = JSON.parse(String(rows(daemon, "SELECT repro FROM subtasks WHERE id = 'A'")[0]!.repro)) as ReproRecord;
    assert.equal(rec.state, 'reproduced');
    assert.equal(rec.files!['test/add.test.js']!.kind, 'unknown');
    assert.match((await post(notify())).hookSpecificOutput?.additionalContext ?? '', /how it failed before: unknown/);
  } finally { await daemon.close(); rmrf(daemon.home); rmrf(repo); }
});

test('no test command for the file: the coder is told, the result is unconfirmed', () => flow('on', async f => {
  await begin(f, '[scope: **]');
  assert.match(await f.edit('tests/test_add.py', 'def test_x():\n    assert False\n'), /has no test command for tests\/test_add\.py/);
  write(f.repo, 'src/add.js', FIXED);
  assert.deepEqual(await f.post(stop()), {});
  assert.equal(f.repro()!.state, 'unconfirmed');
  assert.equal(f.repro()!.reason, 'no-tests');
}));

test('an install step that is still due: the test is not run until the dependencies are there', async () => {
  const repo = makeRepo({ 'package.json': '{}\n', 'package-lock.json': '{}\n', 'src/add.js': BUGGY, '.gitignore': 'node_modules\n' });
  const daemon = await startTestDaemon({ config: { reproduceFirst: 'on' }, verify: { resolveCommands: async () => [{ kind: 'build', command: 'true', ifExists: 'package-lock.json', ifMissing: 'node_modules' }] } });
  const post = async (h: HookInput) => (await postHook(daemon.port, { session_id: 's', cwd: repo, transcript_path: path.join(daemon.home, 's.jsonl'), ...h })).body as Out;
  const edit = async () => (await post({ hook_event_name: 'PostToolUse', tool_name: 'Write', agent_id: 'a1', tool_input: { file_path: path.join(repo, 'test/add.test.js') } })).hookSpecificOutput?.additionalContext ?? '';
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    await post(call());
    await post(start());
    write(repo, 'test/add.test.js', TEST);
    assert.match(await edit(), /the dependencies are not installed \(node_modules missing\), so the router did not run test\/add\.test\.js\. Install them \(true\), then save test\/add\.test\.js once more/);
    fs.mkdirSync(path.join(repo, 'node_modules'));
    assert.match(await edit(), /fails on the unchanged code/);
  } finally { await daemon.close(); rmrf(daemon.home); rmrf(repo); }
});

test('off by the lead, with its reason; a malformed line is refused', () => flow('on', async f => {
  const bad = await f.post(call('[scope: src/**]\n[repro: off]'));
  assert.equal(bad.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(bad.hookSpecificOutput?.permissionDecisionReason ?? '', /needs a reason: refactor, docs, config, no-tests, not-testable/);
  assert.equal(await begin(f, '[scope: src/**, test/**]\n[repro: off refactor]'), '');
  assert.deepEqual(f.repro(), { required: false, by: 'lead', reason: 'refactor' });
  assert.equal(agentFile(f).repro, undefined);
  assert.equal(await f.edit('test/add.test.js', TEST), '');
  write(f.repo, 'src/add.js', FIXED);
  assert.deepEqual(await f.post(stop()), {});
  assert.deepEqual(signals(f), []);
  assert.doesNotMatch((await f.post(notify())).hookSpecificOutput?.additionalContext ?? '', /Reproduction/);
}));

test('observe: the test is run and recorded, but a test that still fails does not fail the subtask', () => flow('observe', async f => {
  assert.match(await begin(f), /needs a reproduction first/);
  assert.match(await f.edit('test/add.test.js', TEST), /fails on the unchanged code/);
  await f.edit('src/add.js', 'exports.add = (a, b) => a * b;\n');
  assert.deepEqual(await f.post(stop()), {});
  assert.equal(f.repro()!.state, 'failed');
  assert.equal(f.repro()!.observe, true);
  assert.deepEqual(signals(f), []);
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
  assert.match((await f.post(notify())).hookSpecificOutput?.additionalContext ?? '', /Reproduction \(recorded only\): test\/add\.test\.js still fails after the change\./);
}));

test('config off (the default): no record, no context, the brief says nothing, a tag line is ignored', () => flow('off', async f => {
  assert.equal(await begin(f, '[scope: src/**, test/**]\n[repro: nonsense]'), '');
  assert.equal(f.repro(), null);
  assert.equal(agentFile(f).repro, undefined);
  assert.equal(await f.edit('test/add.test.js', TEST), '');
  write(f.repo, 'src/add.js', FIXED);
  assert.deepEqual(await f.post(stop()), {});
  assert.deepEqual(signals(f), []);
}));

test('the brief names the tag line only when the feature is on', async () => {
  for (const mode of ['on', 'off'] as const) {
    const d = await startTestDaemon({ config: { reproduceFirst: mode } });
    try {
      const r = await postHook(d.port, { session_id: 's', cwd: d.home, hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
      const brief = (r.body as Out).hookSpecificOutput?.additionalContext ?? '';
      assert.equal(/\[repro: required\]/.test(brief), mode === 'on');
    } finally { await d.close(); rmrf(d.home); }
  }
});

test('what the test run wrote is not counted as the subagent\'s change', () => flow('on', async f => {
  await begin(f, '[scope: src/**, test/**]');
  // the test writes a file outside the scope when it runs
  await f.edit('test/add.test.js', `${TEST}require('node:fs').writeFileSync('run.log', 'x');\n`);
  await f.edit('src/add.js', FIXED);
  assert.deepEqual(await f.post(stop()), {});
  assert.deepEqual(subtask(f), { status: 'passed', verdict: 'meet' });
}));

test('a v16 ledger gains subtasks.repro', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ar-v16-'));
  const file = path.join(dir, 'router.db');
  try {
    const l = new Ledger(file);
    l.db.exec('ALTER TABLE subtasks DROP COLUMN repro; PRAGMA user_version = 16;');
    l.close();
    const again = new Ledger(file);
    assert.equal(Number((again.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version), SCHEMA_VERSION);
    assert.ok((again.db.prepare('PRAGMA table_info(subtasks)').all() as Array<{ name: string }>).some(c => c.name === 'repro'));
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the relay sends a subagent\'s edit to the daemon only while the router marked that agent', () => flow('on', async f => {
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const relay = await import(pathToFileURL(fileURLToPath(new URL('../../../plugin/hooks/relay.mjs', import.meta.url))).href) as {
    relay(raw: string, o: { home: string; write(s: string): void }): Promise<void>; reproWanted(home: string, agentId: string): boolean;
  };
  fs.writeFileSync(path.join(f.d.home, 'config.json'), JSON.stringify({ daemonPort: f.d.port, reproduceFirst: 'on' }));
  await begin(f);
  assert.equal(relay.reproWanted(f.d.home, 'a1'), true);
  assert.equal(relay.reproWanted(f.d.home, 'other'), false);
  write(f.repo, 'test/add.test.js', TEST);
  const send = async (agent: string) => {
    const out: string[] = [];
    await relay.relay(JSON.stringify({
      hook_event_name: 'PostToolUse', session_id: 's', cwd: f.repo, agent_id: agent, tool_name: 'Write',
      tool_input: { file_path: path.join(f.repo, 'test/add.test.js'), content: TEST },
    }), { home: f.d.home, write: s => { out.push(s); } });
    return out.join('');
  };
  assert.equal(await send('other'), '{}');                       // answered by the relay itself
  assert.equal(f.repro()!.runs, undefined);
  const answer = JSON.parse(await send('a1')) as Out;
  assert.match(answer.hookSpecificOutput?.additionalContext ?? '', /test\/add\.test\.js fails on the unchanged code/);
  assert.equal(f.repro()!.state, 'confirmed');
}));

test('two writers in one work tree: with the other writer\'s changes there, the test is not run', () => flow('on', async f => {
  await begin(f, '[scope: src/**, test/**]');
  assert.deepEqual(await f.post({
    hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_rpB',
    tool_input: { subagent_type: 'do-it-all-claude-code:coder', prompt: '[subtask:B]\n[scope: lib/**]\n[repro: off refactor]\ntidy', model: 'haiku', effort: 'low' },
  }), {});
  await f.post(start('b1'));
  write(f.repo, 'lib/other.js', 'exports.x = 1;\n');   // B's change, in the same tree
  assert.match(await f.edit('test/add.test.js', TEST), /another subtask is changing files in this work tree \(lib\/other\.js\)/);
  assert.deepEqual(f.repro(), { required: true, by: 'router', state: 'unconfirmed', reason: 'shared-tree' });
}));
