import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatakitError, LoadingCache } from '../src/index.ts';

test('get loads a missing value once and then serves it from the cache', async () => {
  const calls: string[] = [];
  const cache = new LoadingCache(async key => { calls.push(key); return key.toUpperCase(); });
  assert.equal(await cache.get('a'), 'A');
  assert.equal(await cache.get('a'), 'A');
  assert.equal(await cache.get('b'), 'B');
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(cache.has('a'), true);
});

test('set stores a value directly; invalidate makes the next get load again', async () => {
  let n = 0;
  const cache = new LoadingCache(async () => ++n);
  cache.set('k', 100);
  assert.equal(await cache.get('k'), 100);
  cache.invalidate('k');
  assert.equal(cache.has('k'), false);
  assert.equal(await cache.get('k'), 1);
});

test('a value expires ttlMs after it was stored', async () => {
  let now = 1_000;
  let n = 0;
  const cache = new LoadingCache(async () => ++n, { ttlMs: 50, now: () => now });
  assert.equal(await cache.get('k'), 1);
  now += 49;
  assert.equal(await cache.get('k'), 1);
  now += 1;
  assert.equal(cache.has('k'), false);
  assert.equal(await cache.get('k'), 2);
  assert.throws(() => new LoadingCache(async () => 0, { ttlMs: 0 }), DatakitError);
});

test('a loader error reaches the caller', async () => {
  const cache = new LoadingCache<number>(async () => { throw new Error('backend down'); });
  await assert.rejects(cache.get('k'), /backend down/);
});
