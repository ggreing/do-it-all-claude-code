import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError, createApp } from '../src/index.ts';

type T = { id: string; title: string };
type Page = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };
type Res = { status: number; body: unknown };
// Loose views so the test does not depend on how the new members are typed.
type QueryFn = (query?: Record<string, unknown>) => Page;
type ListFn = (req: { query?: Record<string, string> }) => Res;

function seed() {
  let t = Date.UTC(2024, 4, 1, 9, 0, 0);
  const app = createApp({ now: () => new Date((t += 60_000)) });
  const { service } = app;
  const make = (title: string, priority: string, dueDate?: string) => service.createTask({ title, priority, dueDate } as never);
  make('a', 'medium', '2024-06-10');
  make('b', 'high');
  make('c', 'low', '2024-05-01');
  make('d', 'high', '2024-06-10');
  make('e', 'low');
  make('f', 'medium', '2024-07-04');
  const query = (service as unknown as { queryTasks: QueryFn }).queryTasks.bind(service);
  const list = (app.handlers as unknown as { listTasks: ListFn }).listTasks;
  return { service, query, list };
}

const titles = (p: Page) => p.items.map((t) => t.title).join('');

test('sort: creation order by default, reversed with order desc', () => {
  const s = seed();
  assert.equal(titles(s.query()), 'abcdef');
  assert.equal(titles(s.query({ sort: 'createdAt' })), 'abcdef');
  assert.equal(titles(s.query({ order: 'asc' })), 'abcdef');
  assert.equal(titles(s.query({ order: 'desc' })), 'fedcba');
  assert.equal(titles(s.query({ sort: 'createdAt', order: 'desc' })), 'fedcba');
});

test('sort by dueDate: earliest first (or latest first), equal dates in creation order, no deadline last either way', () => {
  const s = seed();
  assert.equal(titles(s.query({ sort: 'dueDate' })), 'cadfbe');
  assert.equal(titles(s.query({ sort: 'dueDate', order: 'asc' })), 'cadfbe');
  assert.equal(titles(s.query({ sort: 'dueDate', order: 'desc' })), 'fadcbe');
});

test('sort by priority: low to high (or high to low), equal priorities in creation order', () => {
  const s = seed();
  assert.equal(titles(s.query({ sort: 'priority' })), 'ceafbd');
  assert.equal(titles(s.query({ sort: 'priority', order: 'desc' })), 'bdafce');
});

test('sort applies to the filtered list, before paging', () => {
  const s = seed();
  const first = s.query({ sort: 'dueDate', page: 1, pageSize: 4 });
  const second = s.query({ sort: 'dueDate', page: 2, pageSize: 4 });
  assert.deepEqual([titles(first), titles(second)], ['cadf', 'be']);
  assert.deepEqual([first.total, first.totalPages, second.page], [6, 2, 2]);
  assert.equal(titles(s.query({ priority: 'high', sort: 'dueDate' })), 'db');
  assert.equal(titles(s.query({ overdue: '2024-06-30', sort: 'priority', order: 'desc' })), 'dac');
});

test('sort: an unknown key or order is a validation error', () => {
  const s = seed();
  for (const bad of [{ sort: 'title' }, { sort: '' }, { order: 'down' }, { sort: 'dueDate', order: 'ASC' }, { sort: 5 }]) {
    assert.throws(() => s.query(bad), (err: unknown) => {
      assert.ok(err instanceof ValidationError, JSON.stringify(bad));
      assert.ok(err.details.length >= 1);
      return true;
    });
  }
});

test('handler: ?sort= and ?order= are passed on, bad values are 400', () => {
  const s = seed();
  const byDue = s.list({ query: { sort: 'dueDate', order: 'desc', pageSize: '3' } });
  assert.equal(byDue.status, 200);
  assert.equal(titles(byDue.body as Page), 'fad');
  assert.equal(titles(s.list({ query: { sort: 'priority', priority: 'low' } }).body as Page), 'ce');
  assert.equal(titles(s.list({}).body as Page), 'abcdef');
  for (const query of [{ sort: 'name' }, { order: 'up' }]) {
    const bad = s.list({ query });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: string }).error, 'Validation failed');
  }
});
