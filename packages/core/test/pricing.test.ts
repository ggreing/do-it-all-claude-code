// The price table against the models the router can start. A model without a price has no cost in the ledger
// (costUsd returns null), so every model a ladder cell pins must be priced, and so must the model Claude Code's
// `fable` alias resolves to (2.1.326: claude-fable-5-2), whichever of the two the ladder pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_LADDER } from '../src/ladder.ts';
import { PRICING_PER_MTOK, costUsd } from '../src/pricing.ts';

const M = 1_000_000;

test('every model a ladder cell pins has a price', () => {
  const pinned = [...new Set(GRID_LADDER.map(s => s.modelId))];
  assert.ok(pinned.length >= 4, pinned.join(', '));
  for (const id of pinned) assert.ok(PRICING_PER_MTOK[id], `${id} has no price`);
});

test('Fable 5.2, the model the fable alias resolves to, is priced at $8 / $40 with cache reads at $0.20', () => {
  assert.deepEqual([PRICING_PER_MTOK['claude-fable-5-2']!.input, PRICING_PER_MTOK['claude-fable-5-2']!.output], [8, 40]);
  assert.equal(costUsd('claude-fable-5-2', { input_tokens: M, output_tokens: M }), 48);
  assert.equal(costUsd('claude-fable-5-2', { cache_read_input_tokens: M }), 0.2);
  // 5.1 stays priced: transcripts of earlier sessions name it
  assert.equal(costUsd('claude-fable-5-1', { input_tokens: M, output_tokens: M }), 60);
  assert.equal(costUsd('claude-fable-9-9', { input_tokens: M }), null);
});
