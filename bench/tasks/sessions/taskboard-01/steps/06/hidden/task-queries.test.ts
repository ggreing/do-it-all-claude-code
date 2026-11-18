import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as taskboard from '../src/index.ts';

type T = { id: string; title: string };
type Page = { items: T[]; page: number; pageSize: number; total: number; totalPages: number };
// Loose views so the test does not depend on how the new members are typed.
type Queries = {
  getTask(id: string): T;
  listTasks(): T[];
  queryTasks(query?: Record<string, unknown>): Page;
  listOverdueTasks(today: string): T[];
};
type QueriesClass = new (tasks: unknown) => Queries;
const { NotFoundError, ValidationError, createApp } = taskboard;
const TaskQueries = (taskboard as unknown as { TaskQueries: QueriesClass }).TaskQueries;

function setup() {
  let t = Date.UTC(2024, 4, 1, 9, 0, 0);
  const app = createApp({ now: () => new Date((t += 60_000)) });
  const make = (title: string, priority: string, dueDate?: string) => app.service.createTask({ title, priority, dueDate } as never) as T;
  const a = make('a', 'medium', '2024-06-10');
  const b = make('b', 'high');
  const c = make('c', 'low', '2024-05-01');
  return { app, a, b, c, service: app.service as unknown as Queries & { queries: Queries } };
}

test('TaskQueries is exported, lives in src/service/taskQueries.ts and works on a task repo alone', () => {
  assert.equal(typeof TaskQueries, 'function');
  assert.ok(fs.existsSync(new URL('../src/service/taskQueries.ts', import.meta.url)), 'src/service/taskQueries.ts exists');
  const { app, a, c } = setup();
  const queries = new TaskQueries(app.taskRepo);
  assert.deepEqual(queries.getTask(a.id), app.service.getTask(a.id));
  assert.deepEqual(queries.listTasks().map((t) => t.title), ['a', 'b', 'c']);
  assert.deepEqual(queries.queryTasks({ sort: 'dueDate', pageSize: 2 }).items.map((t) => t.title), ['c', 'a']);
  assert.deepEqual(queries.queryTasks().total, 3);
  assert.deepEqual(queries.listOverdueTasks('2024-06-01').map((t) => t.id), [c.id]);
});

test('TaskQueries reports problems exactly as the service did', () => {
  const { app } = setup();
  const queries = new TaskQueries(app.taskRepo);
  assert.throws(() => queries.getTask('task-999'), (err: unknown) => err instanceof NotFoundError && err.message === 'Task not found: task-999');
  assert.throws(() => queries.listOverdueTasks('soon'), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.deepEqual(err.details, ['today must be a valid date in YYYY-MM-DD format']);
    return true;
  });
  assert.throws(() => queries.queryTasks({ pageSize: 0 }), ValidationError);
  assert.throws(() => queries.queryTasks({ sort: 'title' }), ValidationError);
});

test('the service and the app expose the same TaskQueries instance', () => {
  const { app, service } = setup();
  assert.ok(service.queries instanceof TaskQueries);
  assert.equal((app as unknown as { queries: Queries }).queries, service.queries);
});

test('the service reads through its TaskQueries on every call', () => {
  const { service, a } = setup();
  const marker = { items: [], page: 9, pageSize: 9, total: 9, totalPages: 9 };
  const calls: string[] = [];
  service.queries.queryTasks = (query) => { calls.push(`queryTasks ${JSON.stringify(query ?? null)}`); return marker; };
  service.queries.listTasks = () => { calls.push('listTasks'); return []; };
  service.queries.listOverdueTasks = (today) => { calls.push(`listOverdueTasks ${today}`); return []; };
  service.queries.getTask = (id) => { calls.push(`getTask ${id}`); return { id, title: 'from queries' }; };
  assert.equal(service.queryTasks({ page: 2 }), marker);
  assert.deepEqual(service.listTasks(), []);
  assert.deepEqual(service.listOverdueTasks('2024-06-01'), []);
  assert.equal(service.getTask(a.id).title, 'from queries');
  assert.deepEqual(calls, ['queryTasks {"page":2}', 'listTasks', 'listOverdueTasks 2024-06-01', `getTask ${a.id}`]);
});

test('nothing else changed: the handlers and the write side behave as before', () => {
  const { app, a, b } = setup();
  const handlers = app.handlers as unknown as Record<string, (req: Record<string, unknown>) => { status: number; body: unknown }>;
  const list = handlers.listTasks!({ query: { sort: 'priority', order: 'desc' } });
  assert.deepEqual((list.body as Page).items.map((t) => t.title), ['b', 'a', 'c']);
  assert.equal(handlers.getTask!({ params: { id: 'task-999' } }).status, 404);
  assert.equal(handlers.listOverdueTasks!({ query: { today: '2024-07-01' } }).status, 200);
  const started = handlers.updateStatus!({ params: { id: b.id }, body: { status: 'in_progress' }, userId: 'u1' });
  assert.equal(started.status, 200);
  const history = handlers.getTaskHistory!({ params: { id: b.id } });
  assert.deepEqual((history.body as { items: Array<{ type: string }> }).items.map((e) => e.type), ['task.created', 'task.status_changed']);
  assert.equal(handlers.setDueDate!({ params: { id: a.id }, body: { dueDate: null } }).status, 200);
});
