// The office members' click reactions (plugin/office/reactions.ts): every shape draws as the scene expects, every
// reaction ends and leaves the member in its one shape, a click picks among the ten motions, and clicks in a row
// make it bigger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_REACTIONS, BODY, COMBO_MS, EVERYDAY, REACTIONS, SHAPES, frameAt, frameIndex, react, reactionLength,
  type ReactionId, type ReactionStatus,
} from '../../../plugin/office/reactions.ts';

const STATUSES: ReactionStatus[] = ['working', 'done', 'waiting', 'failed'];

test('office reactions: every shape is 11 across, whole cells high, at most a cell taller than the body, two eyes in one row of cells', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    assert.ok(shape.length % 2 === 0 && shape.length >= 8 && shape.length <= 10, `${name}: ${shape.length} rows`);
    for (const line of shape) assert.match(line, /^[.#o]{11}$/, `${name}: ${line}`);
    // the eyes: one cell row (a pair of pixel rows), one eye on each side of the middle column
    const eyeRows = new Set<number>();
    const eyeCols = new Set<number>();
    shape.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === 'o') { eyeRows.add(Math.floor(y / 2)); eyeCols.add(x); } }));
    assert.equal(eyeRows.size, 1, `${name}: eyes over ${eyeRows.size} cell rows`);
    const cols = [...eyeCols];
    assert.ok(cols.length === 2 && cols.some(x => x < 5) && cols.some(x => x > 5), `${name}: eyes at ${cols}`);
    // the feet stand on the same row as the body's: the last pixel row is empty
    assert.match(shape[shape.length - 1]!, /^\.+$/, `${name}: the last row`);
  }
});

test('office reactions: ten motions in every status, each ends, frames last 50 ms to half a second, marks are one-cell ASCII', () => {
  assert.equal(ALL_REACTIONS.length, 10);
  assert.equal(EVERYDAY.length, 8);
  for (const status of STATUSES) {
    for (const id of ALL_REACTIONS) {
      const frames = REACTIONS[status][id];
      assert.ok(frames.length >= 4, `${status} ${id}`);
      const total = reactionLength(id, status);
      assert.ok(total >= 500 && total <= 2500, `${status} ${id}: ${total} ms`);
      for (const fr of frames) {
        assert.ok(fr.ms >= 50 && fr.ms <= 500, `${id}: ${fr.ms} ms`);
        assert.ok(Object.values(SHAPES).includes(fr.shape), `${id}: a shape not in SHAPES`);
        assert.ok(fr.eyes.length === 1 || fr.eyes.length === 2, `${id}: eyes ${fr.eyes}`);
        assert.ok(fr.dy <= 0 && fr.dy >= -2 && Math.abs(fr.dx) <= 1, `${id}: moved ${fr.dx},${fr.dy}`);
        for (const [r, c, ch] of fr.fx) {
          assert.match(ch, /^[!-~]$/, `${id}: mark ${ch}`);
          assert.ok(r >= -1 && r <= 3 && c >= -1 && c <= 13, `${id}: mark at ${r},${c}`);
        }
      }
    }
  }
  // the motions differ from each other, and the speeds too: the quickest and the slowest are far apart
  const lengths = ALL_REACTIONS.map(id => reactionLength(id));
  assert.equal(new Set(ALL_REACTIONS.map(id => JSON.stringify(REACTIONS.working[id]))).size, 10);
  assert.ok(Math.max(...lengths) >= 2.5 * Math.min(...lengths), `${lengths}`);
  // a status shows in the eyes: done is happy, failed teary
  assert.ok(REACTIONS.done.nod.every(fr => fr.eyes === '^'));
  assert.ok(REACTIONS.failed.nod.some(fr => fr.eyes === 'T'));
});

test('office reactions: a reaction plays its frames in order, then the member is at rest in its one shape', () => {
  const r = react(undefined, 'demo-a', 'done', 1000);
  assert.equal(frameIndex(r, 999), -1);
  assert.equal(frameIndex(r, 1000), 0);
  const end = 1000 + reactionLength(r.id, r.status);
  assert.equal(frameIndex(r, end - 1), REACTIONS[r.status][r.id].length - 1);
  assert.equal(frameAt(r, end), null);
  assert.equal(frameAt(undefined, 5), null);
  // the manner is the status at the click, whatever the member does after
  assert.equal(r.status, 'done');
  assert.ok(SHAPES.BODY === BODY);
});

test('office reactions: a first click picks any of the eight everyday motions, at random but repeatable, never the same twice running', () => {
  for (const status of STATUSES) {
    const seen = new Set<ReactionId>();
    for (let now = 0; now < 400_000; now += 7_919) {
      const r = react(undefined, 'demo-b', status, now);
      assert.equal(r.combo, 1);
      assert.ok((EVERYDAY as readonly string[]).includes(r.id), `${status}: ${r.id}`);
      assert.deepEqual(react(undefined, 'demo-b', status, now), r);
      seen.add(r.id);
      const next = react(r, 'demo-b', status, now + COMBO_MS + 1);
      assert.equal(next.combo, 1);
      assert.notEqual(next.id, r.id);
    }
    assert.equal(seen.size, EVERYDAY.length, `${status}: only ${[...seen]}`);
  }
});

test('office reactions: clicks in a row get bigger (a startle or hop, then dizzy, then a huff), and a pause starts over', () => {
  let r = react(undefined, 'demo-r', 'waiting', 0);
  const ids: ReactionId[] = [r.id];
  for (let k = 1; k < 6; k++) { r = react(r, 'demo-r', 'waiting', k * 300); ids.push(r.id); }
  assert.deepEqual(ids.slice(1), ['startle', 'dizzy', 'dizzy', 'huff', 'huff']);
  assert.equal(r.combo, 6);
  assert.equal(react(r, 'demo-r', 'waiting', 5 * 300 + COMBO_MS + 1).combo, 1);
  assert.equal(react(react(undefined, 'x', 'done', 0), 'x', 'done', 100).id, 'hop');
});
