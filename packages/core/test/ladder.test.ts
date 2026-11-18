import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRESETS, DIFFICULTIES, GRID, applyPresetFile, cellOf, cellId, crossesTier, memberStartCell, modelJump, redact, startCellFor, stepDown, stepUp, topStep } from '@do-it-all-claude-code/core';

test('the grid has 4 models x 5 efforts, with the six legacy cells measured (decision 225)', () => {
  assert.equal(GRID.length, 20);
  const measured = GRID.filter(c => !c.estimated).map(c => c.id).sort();
  assert.deepEqual(measured, ['s1', 's2', 's3', 's4', 's5', 's6'].sort());
  // legacy aliases map to the right cells
  assert.equal(cellId('haiku', 'low'), 's1');
  assert.equal(cellId('sonnet', 'medium'), 's3');
  assert.equal(cellId('opus', 'high'), 's5');
  assert.equal(cellId('fable', 'high'), 's7');
  // a non-legacy cell keeps its model-effort id, and s7 is estimated
  assert.equal(cellId('sonnet', 'xhigh'), 'sonnet-xhigh');
  assert.equal(cellOf('s7').estimated, true);
});

test('step-up goes in big legacy steps: s1 -> s2 -> s3 -> s4 -> s5 -> s6 (decision 229)', () => {
  assert.equal(stepUp('s1'), 's2');
  assert.equal(stepUp('s2'), 's3');
  assert.equal(stepUp('s3'), 's4');
  assert.equal(stepUp('s4'), 's5');
  assert.equal(stepUp('s5'), 's6');                 // opus xhigh = ceiling (no Fable)
  assert.equal(stepUp('s6'), null);
  assert.equal(topStep(false), 's6');
  assert.equal(topStep(true), 's7');
  // three raises carry a routine coder (s1) to s4 and a moderate coder (s3) to s6
  assert.equal(stepUp(stepUp(stepUp('s1')!)!), 's4');
  assert.equal(stepUp(stepUp(stepUp('s3')!)!), 's6');
  // an off-path cell (teams.yaml / step-down in-between) goes to the cheapest up-path cell that costs more
  assert.equal(stepUp('haiku-medium'), 's2');       // 1.6 -> s2 (3.1)
  assert.equal(stepUp('sonnet-low'), 's3');         // 7.5 -> s3 (9.1)
  assert.equal(stepUp('opus-low'), 's5');           // 21.6 -> s5 (44.9); s4 is cheaper
});

test('with Fable opted in, step-up is s5 -> s7 and s6 is off the up-path (decisions 226, 229)', () => {
  assert.equal(stepUp('s5', true), 's7');
  assert.equal(stepUp('s7', true), null);
  assert.equal(stepUp(stepUp(stepUp('s3', true)!, true)!, true), 's7');   // moderate + Fable: three raises reach s7
});

test('step-down lowers effort first, then drops a model (decisions 225, 226)', () => {
  assert.equal(stepDown('s5'), 'opus-medium');      // lower effort within opus
  assert.equal(stepDown('opus-low'), 's4');         // drop to sonnet's top auto effort
  assert.equal(stepDown('s1'), null);               // bottom
  assert.equal(stepDown('s6'), 's5');               // opus-xhigh down to opus-high
  assert.equal(stepDown('s7'), 'fable-medium');     // fable-high down the Fable path
  assert.equal(stepDown('fable-low'), 's5');        // Fable entry drops back to opus-high
});

test('modelJump goes straight to the next model up (decisions 225, 226)', () => {
  assert.equal(cellOf(modelJump('s1')!).model, 'sonnet');   // from haiku-low, jump to sonnet
  assert.equal(cellOf(modelJump('s3')!).model, 'opus');     // from sonnet-medium, jump to opus
  assert.equal(modelJump('s6'), null);                      // opus is the top model without Fable
  assert.equal(cellOf(modelJump('s5', true)!).model, 'fable');   // opus-high jumps to Fable
});

test('decision 226: the ladder pins Fable 5.2 and its cells are estimated', () => {
  assert.equal(cellOf('s7').modelId, 'claude-fable-5-2');
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) assert.equal(cellOf(cellId('fable', e)).estimated, true);
});

test('startCellFor is the decision-226 difficulty table, same at every level', () => {
  // coder/tester: haiku-low, sonnet-medium, opus-high
  assert.equal(startCellFor('coder', 'routine'), 's1');
  assert.equal(startCellFor('coder', 'moderate'), 's3');
  assert.equal(startCellFor('coder', 'hard'), 's5');
  assert.equal(startCellFor('tester', 'moderate'), 's3');
  // architect/reviewer: coder's model one effort richer, floor sonnet-medium; hard -> opus-xhigh
  assert.equal(startCellFor('architect', 'routine'), 's3');
  assert.equal(startCellFor('reviewer', 'moderate'), 's4');
  assert.equal(startCellFor('architect', 'hard'), 's6');
  // ui-designer: sonnet-medium, sonnet-medium, sonnet-high
  assert.equal(startCellFor('ui-designer', 'routine'), 's3');
  assert.equal(startCellFor('ui-designer', 'moderate'), 's3');
  assert.equal(startCellFor('ui-designer', 'hard'), 's4');
});

test('decision 226: a teams.yaml start wins by provenance (even equal to the default); an omitted one falls to the table', () => {
  // a user teams.yaml (userSet) that sets coder start s1 — s1 is also the L2 default, but the file set it, so it wins
  const user = applyPresetFile({ L2: { roles: [{ role: 'coder', count: 1, start: 's1' }] } }, DEFAULT_PRESETS, { userSet: true });
  const m = user.L2.roles.find(r => r.role === 'coder')!;
  assert.equal(m.startSet, true);
  assert.equal(memberStartCell('coder', m.start, m.startSet, 'moderate'), 's1', 'the file start wins over the moderate table cell s3');
  // a profile layer (not userSet) setting the same value does NOT mark it, so the difficulty table applies
  const prof = applyPresetFile({ L2: { roles: [{ role: 'coder', count: 1, start: 's1' }] } }, DEFAULT_PRESETS, { userSet: false });
  assert.equal(prof.L2.roles.find(r => r.role === 'coder')!.startSet, undefined);
  assert.equal(memberStartCell('coder', 's1', undefined, 'moderate'), 's3', 'no override -> the table');
});

test('startCellFor: the profile notch shifts the table, a user override wins (decision 226)', () => {
  // quality nudges up one auto-step, save down one
  assert.equal(startCellFor('coder', 'moderate', { notch: 1 }), 's4');   // s3 -> sonnet-high
  assert.equal(startCellFor('coder', 'moderate', { notch: -1 }), 'sonnet-low');
  // an explicit override (teams.yaml / role override) is used as-is for any difficulty
  for (const d of DIFFICULTIES) assert.equal(startCellFor('coder', d, { override: 'sonnet-xhigh' }), 'sonnet-xhigh');
});

test('a model change happens only across model boundaries', () => {
  assert.equal(crossesTier('s1', 'haiku-medium'), false);   // same model, effort change
  assert.equal(crossesTier('haiku-xhigh', 'sonnet-low'), true);
  assert.equal(crossesTier('s5', 's6'), false);             // opus high -> xhigh
});

test('L3 workers and reviewer start at s5 (decisions 46-47)', () => {
  const l3 = DEFAULT_PRESETS.L3.roles;
  assert.equal(l3.find(r => r.role === 'coder')?.start, 's5');
  assert.equal(l3.find(r => r.role === 'reviewer')?.start, 's5');
});

test('redact masks Anthropic keys and bearer tokens', () => {
  const s = redact('key=sk-ant-api03-abcdefghijklmnop and Authorization: Bearer abcdefghijklmnopqrstuvwx');
  assert.ok(!s.includes('abcdefghijklmnop'));
});
