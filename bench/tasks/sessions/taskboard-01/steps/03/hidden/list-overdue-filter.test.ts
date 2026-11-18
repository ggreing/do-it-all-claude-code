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
  const app = createApp({ users: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', active: true }], now: () => new Date((t += 60_000)) });
  const { service } = app;
  const make = (title: string, dueDate?: string | null) => service.createTask({ title, dueDate } as never);
  const late = make('late report', '2024-05-10');
  const today = make('due today', '2024-05-20');
  const later = make('later', '2024-06-01');
  const none = make('no deadline');
  const lateDone = make('late but done', '2024-05-01');
  service.startTask(lateDone.id);
  service.completeTask(lateDone.id);
  const lateCancelled = make('late but cancelled', '2024-05-02');
  service.cancelTask(lateCancelled.id);
  const lateStarted = make('late and started', '2024-05-05');
  service.startTask(lateStarted.id);
  service.assignTask(lateStarted.id, 'u1');
  const query = (service as unknown as { queryTasks: QueryFn }).queryTasks.bind(service);
  const list = (app.handlers as unknown as { listTasks: ListFn }).listTasks;
  return { query, list, late, today, later, none, lateDone, lateCancelled, lateStarted };
}

const titles = (p: Page) => p.items.map((t) => t.title);

test('overdue filter: open tasks with a deadline before the given day, in creation order', () => {
  const s = seed();
  const page = s.query({ overdue: '2024-05-20' });
  assert.deepEqual(titles(page), ['late report', 'late and started']);
  assert.equal(page.total, 2);
  assert.equal(page.totalPages, 1);
  // a deadline on the given day is not overdue; the day after, it is
  assert.deepEqual(titles(s.query({ overdue: '2024-05-21' })), ['late report', 'due today', 'late and started']);
  assert.deepEqual(titles(s.query({ overdue: '2024-05-05' })), []);
});

test('overdue filter combines with the other conditions and with paging', () => {
  const s = seed();
  assert.deepEqual(titles(s.query({ overdue: '2024-05-20', status: ['in_progress'] })), ['late and started']);
  assert.deepEqual(titles(s.query({ overdue: '2024-05-20', assigneeId: null })), ['late report']);
  assert.deepEqual(titles(s.query({ overdue: '2024-05-20', search: 'REPORT' })), ['late report']);
  const second = s.query({ overdue: '2024-07-01', page: 2, pageSize: 2 });
  assert.deepEqual(titles(second), ['later', 'late and started']);
  assert.deepEqual([second.total, second.totalPages], [4, 2]);
});

test('overdue filter: a value that is not a real date is a validation error', () => {
  const s = seed();
  for (const bad of ['2024-02-30', '20240520', 'yesterday', '', 20240520]) {
    assert.throws(() => s.query({ overdue: bad }), (err: unknown) => {
      assert.ok(err instanceof ValidationError, `overdue=${String(bad)}`);
      assert.ok(err.details.length >= 1);
      return true;
    });
  }
});

test('overdue filter without the option: the list is as before', () => {
  const s = seed();
  assert.equal(s.query({}).total, 7);
  assert.equal(s.query().total, 7);
});

test('handler: ?overdue=YYYY-MM-DD filters, a bad date is 400', () => {
  const s = seed();
  const ok = s.list({ query: { overdue: '2024-05-20' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(titles(ok.body as Page), ['late report', 'late and started']);
  const both = s.list({ query: { overdue: '2024-05-20', status: 'in_progress', page: '1', pageSize: '5' } });
  assert.deepEqual(titles(both.body as Page), ['late and started']);
  const bad = s.list({ query: { overdue: 'soon' } });
  assert.equal(bad.status, 400);
  assert.equal((bad.body as { error: string }).error, 'Validation failed');
  assert.ok((bad.body as { details: string[] }).details.length >= 1);
});
