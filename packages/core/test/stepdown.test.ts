// Spec 3.5 step-down and floor lock (decision 135): the rule itself, without a ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EASY_PASSES_FOR_STEP_DOWN, FLOOR_LOCK_TASKS, afterEasyPass, afterOtherResult, afterRaise, atDispatch, newSlotAdjust, type SlotAdjust,
} from '../src/ladder.ts';

/** Runs a slot through events: e = easy pass, o = other result, d = dispatch, or a raise to a step. */
function run(start: SlotAdjust, events: Array<'e' | 'o' | 'd' | { raise: SlotAdjust['step'] }>): SlotAdjust {
  let s = start;
  for (const ev of events) {
    if (ev === 'e') s = afterEasyPass(s).state;
    else if (ev === 'o') s = afterOtherResult(s);
    else if (ev === 'd') s = atDispatch(s);
    else s = afterRaise(s, ev.raise);
  }
  return s;
}

test('two easy passes in a row move the slot one step down; one alone does not', () => {
  assert.equal(EASY_PASSES_FOR_STEP_DOWN, 2);
  const s = newSlotAdjust('s5');
  const one = afterEasyPass(atDispatch(s));
  assert.deepEqual([one.steppedDownTo, one.state.step, one.state.easyStreak, one.state.lastEasy], [undefined, 's5', 1, true]);
  const two = afterEasyPass(atDispatch(one.state));
  assert.deepEqual([two.steppedDownTo, two.state.step, two.state.easyStreak, two.state.downCount], ['opus-medium', 'opus-medium', 0, 1]);   // opus-high -> opus-medium: effort first (decision 226)
  // and again from there: a new streak is needed
  assert.equal(run(two.state, ['d', 'e']).step, 'opus-medium');
  assert.equal(run(two.state, ['d', 'e', 'd', 'e']).step, 'opus-low');
});

test('anything that is not an easy pass ends the streak', () => {
  const s = newSlotAdjust('s3');
  assert.equal(run(s, ['d', 'e', 'd', 'o', 'd', 'e']).step, 's3', 'a plain accept or a reject in between');
  assert.equal(run(s, ['d', 'e', 'd', 'd', 'e']).step, 's3', 'a result nobody reported as easy');
  assert.equal(run(s, ['d', 'e', 'o', 'd', 'e']).step, 's3', 'the easy result judged again as not easy');
  assert.equal(run(s, ['d', 'e', 'd', 'e']).step, 'sonnet-low');   // stepDown('s3') = sonnet-low (decision 226)
  assert.deepEqual((x => [x.easyStreak, x.lastEasy])(run(s, ['d', 'e', 'd'])), [1, false], 'a dispatch keeps the streak of an easy result and waits for the new one');
});

test('the bottom step stays; the streak stays full and harmless', () => {
  const r = afterEasyPass(run(newSlotAdjust('s1'), ['d', 'e', 'd']));
  assert.deepEqual([r.steppedDownTo, r.state.step, r.state.easyStreak, r.state.downCount], [undefined, 's1', 2, 0]);
  assert.equal(run(r.state, ['d', 'e', 'd', 'e']).step, 's1');
});

test('floor lock: after a raise the slot runs two tasks at the new step before it can go down', () => {
  assert.equal(FLOOR_LOCK_TASKS, 2);
  const raised = afterRaise(run(newSlotAdjust('s1'), ['d', 'e']), 's2');
  assert.deepEqual(raised, { step: 's2', upCount: 1, easyStreak: 0, lastEasy: false, lockStep: 's2', lockLeft: 2, downCount: 0 });
  // task 1 easy, task 2 easy -> task 3 runs lower: the two locked tasks may be the two easy ones
  const t1 = run(raised, ['d', 'e']);
  assert.deepEqual([t1.step, t1.lockLeft, t1.easyStreak], ['s2', 1, 1]);
  const t2 = afterEasyPass(atDispatch(t1));
  assert.deepEqual([t2.steppedDownTo, t2.state.step, t2.state.lockLeft, t2.state.lockStep], ['haiku-medium', 'haiku-medium', 0, null]);   // stepDown('s2') = haiku-medium
  // an easy streak that fills while the lock still holds does not move the slot; the next easy pass does
  const held = afterEasyPass({ ...raised, easyStreak: 1, lastEasy: true, lockLeft: 1 });
  assert.deepEqual([held.steppedDownTo, held.state.step, held.state.easyStreak], [undefined, 's2', 2]);
  assert.equal(afterEasyPass(atDispatch(held.state)).steppedDownTo, 'haiku-medium');
  // the lock holds only below its step: a slot raised twice may come down to the locked step
  const twice = afterRaise(afterRaise(newSlotAdjust('s1'), 's2'), 's3');
  assert.deepEqual([twice.lockStep, twice.lockLeft, twice.upCount], ['s3', 2, 2]);
});

test('a step-down gives one raise back to the limit, never below zero', () => {
  const up2 = run(newSlotAdjust('s1'), [{ raise: 's2' }, { raise: 's3' }]);
  const down = run(up2, ['d', 'e', 'd', 'e']);
  assert.deepEqual([down.step, down.upCount, down.downCount], ['sonnet-low', 1, 1]);   // stepDown('s3') = sonnet-low
  const preset = run(newSlotAdjust('s3'), ['d', 'e', 'd', 'e']);   // a slot that starts at s3 and was never raised
  assert.deepEqual([preset.step, preset.upCount, preset.downCount], ['sonnet-low', 0, 1]);
  // a failure after the step-down raises again and locks again
  const back = afterRaise(down, 's3');
  assert.deepEqual([back.step, back.upCount, back.lockStep, back.lockLeft, back.easyStreak], ['s3', 2, 's3', 2, 0]);
});
