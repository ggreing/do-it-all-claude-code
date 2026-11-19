// Decision 230 (item 2): the router's difficulty floor and its effect on triage().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { difficultyFloor, hasStrongHardCue, maxDifficulty, namesReproTest, triage } from '@do-it-all-claude-code/core';

test('maxDifficulty takes the harder of two difficulties', () => {
  assert.equal(maxDifficulty('routine', 'moderate'), 'moderate');
  assert.equal(maxDifficulty('hard', 'moderate'), 'hard');
  assert.equal(maxDifficulty('routine', 'routine'), 'routine');
  assert.equal(maxDifficulty('moderate', 'hard'), 'hard');
});

test('difficultyFloor fires only on a strong hard-bug cue', () => {
  // strong cues -> hard (at L1/L2, not L0, and no reproducing test named)
  const hard = [
    'The call raises an error:\nTraceback (most recent call last):\n  File "a.py", line 3, in f',
    'It sometimes returns the wrong value for the same input',
    'A regression: copy(deep=True) now casts unicode indices',
    'Parsing depends on where the chunk is split, so results differ',
    'There is a race condition between set() and the loader',
    'the app crashes with a RecursionError on deep configs',
  ];
  for (const p of hard) assert.equal(difficultyFloor(p, 'L1'), 'hard', p);
  // no strong cue: a bare expected/actual example or the word "bug" does NOT floor
  for (const p of ['parseDuration(\'1h\') returns 360000 but should be 3600000', 'fix the bug in slugify, it drops accents', 'add an option to wordWrap']) {
    assert.equal(difficultyFloor(p, 'L1'), null, p);
  }
  // a stage-1 L0 request is never floored, even with a cue
  assert.equal(difficultyFloor('typo: the TypeError message says "vlaue"; it crashes', 'L0'), null);
  // a named reproducing test disables the floor
  assert.equal(difficultyFloor('Traceback ... see the failing test test_foo.py', 'L2'), null);
  assert.ok(hasStrongHardCue('it is flaky') && namesReproTest('the failing test reproduces it'));
});

test('triage() stamps difficulty hard / source router when the floor fires', () => {
  const floored = triage({ prompt: 'copy(deep=True) is a regression: it now casts the index to object dtype' });
  assert.equal(floored.difficulty, 'hard');
  assert.equal(floored.difficultySource, 'router');
  // a plain small fix carries no router difficulty (the lead reports one later; default is moderate)
  const plain = triage({ prompt: 'rename the exported function to listTasks' });
  assert.equal(plain.difficulty, undefined);
  assert.equal(plain.difficultySource, undefined);
  // a typo settled as L0 is not floored even if it names an error type
  const typo = triage({ prompt: 'fix the typo in the TypeError message "vlaue"' });
  assert.equal(typo.level, 'L0');
  assert.equal(typo.difficulty, undefined);
});
