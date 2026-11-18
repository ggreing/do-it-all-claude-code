// The hard-small tasks (c-hs-*, decision 226): a small change that takes reasoning to get right. For each one,
// without a model: the fixture as it is fails the hidden tests, the reference solution passes them, and each
// plausible wrong fix kept beside the task (decoys/) fails them, so a pass is not reached by the easy patch.
// They are a set of their own: a selection by level or source does not include them, one by id does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeNodeTest } from '../src/graders/node-test.ts';
import { loadCustomTasks, loadTasks } from '../src/tasks.ts';
import { applyOracle, prepare } from '../src/workspace.ts';
import { copyDir } from '../src/util.ts';

const HARD = loadCustomTasks().filter(t => t.set === 'hard-small');
let tmp = '';
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-hs-'));
  // The grade command is `node --test`. Started from a test file it would see the runner's NODE_TEST_CONTEXT,
  // take itself for a nested run, run no file and exit 0: every grade would pass. The grades here must be real
  // ones. (Removed here, not at the top of the file: this file's own reporting is set up by then.)
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test('the hard-small tasks are loaded by id only', () => {
  assert.deepEqual(HARD.map(t => t.id), ['c-hs-01', 'c-hs-02', 'c-hs-03']);
  const ids = HARD.map(t => t.id);
  assert.deepEqual(loadTasks({ ids }).map(t => t.id), ids);
  assert.deepEqual(loadTasks({ ids: ['c-hs-02', 'c-l1-01'] }).map(t => t.id), ['c-hs-02', 'c-l1-01']);
  for (const selection of [{}, { levels: ['L1'] }, { sources: ['custom'] }]) {
    assert.deepEqual(loadTasks(selection).filter(t => t.set).map(t => t.id), [], JSON.stringify(selection));
  }
  for (const t of HARD) assert.deepEqual([t.level, t.fixture, t.source], ['L1', 'datakit', 'custom'], t.id);
});

for (const task of HARD) {
  test(`${task.id}: the fixture fails the hidden tests, the reference solution passes, each decoy fails`, async () => {
    const base = await prepare(task, path.join(tmp, task.id, 'base'));
    const baseGrade = await gradeNodeTest(task, base.repo);
    assert.equal(baseGrade.pass, false, `the fixture as it is: ${baseGrade.detail}`);

    const solved = await prepare(task, path.join(tmp, task.id, 'oracle'));
    applyOracle(task, solved.repo);
    const solvedGrade = await gradeNodeTest(task, solved.repo);
    assert.equal(solvedGrade.pass, true, `the reference solution: ${solvedGrade.detail}`);

    const decoys = fs.readdirSync(path.join(task.dir!, 'decoys'));
    assert.ok(decoys.length >= 2, 'at least two wrong fixes are kept');
    for (const name of decoys) {
      const ws = await prepare(task, path.join(tmp, task.id, `decoy-${name}`));
      copyDir(path.join(task.dir!, 'decoys', name), ws.repo);
      const grade = await gradeNodeTest(task, ws.repo);
      assert.equal(grade.pass, false, `the wrong fix "${name}" passes: ${grade.detail}`);
      // a decoy is a fix someone would hand in: the fixture's own tests pass with it
      const own = await gradeNodeTest({ ...task, hidden_tests: [], grade: { cmd: 'node --test "test/**/*.test.ts"' } }, ws.repo);
      assert.equal(own.pass, true, `the wrong fix "${name}" breaks the fixture's own tests: ${own.detail}`);
    }
  });
}
