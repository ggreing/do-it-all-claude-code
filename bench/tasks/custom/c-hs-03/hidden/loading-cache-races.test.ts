import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoadingCache } from '../src/index.ts';

interface Call { key: string; resolve: (value: string) => void; reject: (error: Error) => void }

/** A loader whose every call waits until the test settles it. */
function manualLoader(): { calls: Call[]; loader: (key: string) => Promise<string> } {
  const calls: Call[] = [];
  return { calls, loader: key => new Promise<string>((resolve, reject) => { calls.push({ key, resolve, reject }); }) };
}

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('callers at the same time share one load', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const waiting = [cache.get('k'), cache.get('k'), cache.get('k')];
  await settle();
  assert.equal(calls.length, 1);
  calls[0]!.resolve('v');
  assert.deepEqual(await Promise.all(waiting), ['v', 'v', 'v']);
  assert.equal(cache.has('k'), true);
  assert.equal(await cache.get('k'), 'v');
  assert.equal(calls.length, 1);
});

test('a load that invalidate overtook answers its callers and is not stored', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const first = cache.get('k');
  await settle();
  cache.invalidate('k');
  calls[0]!.resolve('old');
  assert.equal(await first, 'old');
  await settle();
  assert.equal(cache.has('k'), false);
  const second = cache.get('k');
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('new');
  assert.equal(await second, 'new');
  assert.equal(await cache.get('k'), 'new');
  assert.equal(calls.length, 2);
});

test('a caller after invalidate does not join the load started before it, and the new load is shared', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const before = cache.get('k');
  await settle();
  cache.invalidate('k');
  const after = [cache.get('k'), cache.get('k')];
  await settle();
  assert.equal(calls.length, 2, 'one new load for the callers after invalidate');
  calls[0]!.resolve('old');
  assert.equal(await before, 'old');
  await settle();
  assert.equal(cache.has('k'), false, 'the overtaken load stores nothing while the new one runs');
  after.push(cache.get('k'));
  await settle();
  assert.equal(calls.length, 2, 'a caller while the new load runs joins it, also after the old load finished');
  calls[1]!.resolve('new');
  assert.deepEqual(await Promise.all(after), ['new', 'new', 'new']);
  assert.equal(await cache.get('k'), 'new');
  assert.equal(calls.length, 2);
});

test('an overtaken load that finishes last does not replace the newer value', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const before = cache.get('k');
  await settle();
  cache.invalidate('k');
  const after = cache.get('k');
  await settle();
  calls[1]!.resolve('new');
  assert.equal(await after, 'new');
  calls[0]!.resolve('old');
  assert.equal(await before, 'old');
  await settle();
  assert.equal(await cache.get('k'), 'new');
  assert.equal(calls.length, 2);
});

test('set during a load: the set value stays, and callers after it get it at once', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const before = cache.get('k');
  await settle();
  cache.set('k', 'direct');
  assert.equal(await cache.get('k'), 'direct');
  calls[0]!.resolve('loaded');
  assert.equal(await before, 'loaded');
  await settle();
  assert.equal(await cache.get('k'), 'direct');
  assert.equal(calls.length, 1);
});

test('a failed load reaches every waiting caller and is not kept', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const failing = [assert.rejects(cache.get('k'), /backend down/), assert.rejects(cache.get('k'), /backend down/)];
  await settle();
  assert.equal(calls.length, 1);
  calls[0]!.reject(new Error('backend down'));
  await Promise.all(failing);
  await settle();
  assert.equal(cache.has('k'), false);
  const retry = cache.get('k');
  await settle();
  assert.equal(calls.length, 2, 'the next get loads again');
  calls[1]!.resolve('ok');
  assert.equal(await retry, 'ok');
});

test('an overtaken load that fails does not disturb the load after it', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const before = assert.rejects(cache.get('k'), /backend down/);
  await settle();
  cache.invalidate('k');
  const after = [cache.get('k')];
  await settle();
  calls[0]!.reject(new Error('backend down'));
  await before;
  await settle();
  after.push(cache.get('k'));
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('fine');
  assert.deepEqual(await Promise.all(after), ['fine', 'fine']);
  assert.equal(await cache.get('k'), 'fine');
});

test('keys do not affect each other', async () => {
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader);
  const a = cache.get('a');
  const b = cache.get('b');
  await settle();
  assert.deepEqual(calls.map(c => c.key), ['a', 'b']);
  cache.invalidate('a');
  calls[1]!.resolve('B');
  calls[0]!.resolve('A');
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  await settle();
  assert.deepEqual([cache.has('a'), cache.has('b')], [false, true]);
});

test('a value expires ttlMs after its load finished, and callers of an expired key share the reload', async () => {
  let now = 1_000;
  const { calls, loader } = manualLoader();
  const cache = new LoadingCache(loader, { ttlMs: 50, now: () => now });
  const first = cache.get('k');
  await settle();
  now = 1_040;
  calls[0]!.resolve('v1');
  assert.equal(await first, 'v1');
  now = 1_089;
  assert.equal(await cache.get('k'), 'v1');
  now = 1_090;
  const reload = [cache.get('k'), cache.get('k')];
  await settle();
  assert.equal(calls.length, 2);
  calls[1]!.resolve('v2');
  assert.deepEqual(await Promise.all(reload), ['v2', 'v2']);
});
