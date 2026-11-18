import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError, ValidationError, createApp } from '../src/index.ts';

type T = { id: string; dueDate: string | null; updatedAt: string };
type Event = { id: string; taskId: string; type: string; actorId: string | null; at: string; changes: Record<string, { from: unknown; to: unknown }> };
type Res = { status: number; body: unknown };
type Req = { params?: Record<string, string>; body?: unknown; userId?: string };
// Loose views so the test does not depend on how the new members are typed.
type Svc = {
  createTask(input: Record<string, unknown>, actorId?: string | null): T;
  getTask(id: string): T;
  setDueDate(taskId: string, dueDate: unknown, actorId?: string | null): T;
  getTaskHistory(taskId: string): Event[];
  listOverdueTasks(today: string): T[];
};
type Handlers = Record<'setDueDate' | 'getTaskHistory', (req: Req) => Res>;

function setup() {
  let t = Date.UTC(2024, 5, 1, 9, 0, 0);
  const app = createApp({ now: () => new Date((t += 60_000)) });
  return { service: app.service as unknown as Svc, handlers: app.handlers as unknown as Handlers };
}

test('setDueDate sets, changes and clears the deadline and records each change', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'ship' }, 'u1');
  const set = service.setDueDate(task.id, '2024-07-01', 'u2');
  assert.equal(set.dueDate, '2024-07-01');
  assert.notEqual(set.updatedAt, task.updatedAt);
  assert.equal(service.getTask(task.id).dueDate, '2024-07-01');
  const moved = service.setDueDate(task.id, '2024-07-15');
  const cleared = service.setDueDate(task.id, null, 'u1');
  assert.equal(cleared.dueDate, null);
  const events = service.getTaskHistory(task.id);
  assert.deepEqual(events.map((e) => e.type), ['task.created', 'task.due_date_changed', 'task.due_date_changed', 'task.due_date_changed']);
  assert.deepEqual(events.slice(1).map((e) => e.changes), [
    { dueDate: { from: null, to: '2024-07-01' } },
    { dueDate: { from: '2024-07-01', to: '2024-07-15' } },
    { dueDate: { from: '2024-07-15', to: null } },
  ]);
  assert.deepEqual(events.slice(1).map((e) => e.actorId), ['u2', null, 'u1']);
  assert.deepEqual(events.slice(1).map((e) => e.at), [set.updatedAt, moved.updatedAt, cleared.updatedAt]);
  assert.equal(new Set(events.map((e) => e.id)).size, events.length);
});

test('setDueDate with the deadline the task already has changes nothing and records nothing', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'ship', dueDate: '2024-07-01' });
  const same = service.setDueDate(task.id, '2024-07-01', 'u1');
  assert.equal(same.updatedAt, task.updatedAt);
  const none = service.createTask({ title: 'later' });
  assert.equal(service.setDueDate(none.id, null).updatedAt, none.updatedAt);
  assert.deepEqual(service.getTaskHistory(task.id).map((e) => e.type), ['task.created']);
  assert.deepEqual(service.getTaskHistory(none.id).map((e) => e.type), ['task.created']);
});

test('setDueDate: a bad date or an unknown task fails and records nothing', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'ship' });
  for (const bad of ['2024-02-30', '07/01/2024', '', 20240701, undefined]) {
    assert.throws(() => service.setDueDate(task.id, bad), (err: unknown) => {
      assert.ok(err instanceof ValidationError, `dueDate=${String(bad)}`);
      assert.deepEqual(err.details, ['dueDate must be a valid date in YYYY-MM-DD format']);
      return true;
    });
  }
  assert.throws(() => service.setDueDate('task-999', '2024-07-01'), NotFoundError);
  assert.equal(service.getTask(task.id).dueDate, null);
  assert.deepEqual(service.getTaskHistory(task.id).map((e) => e.type), ['task.created']);
});

test('a deadline set later counts for the overdue list', () => {
  const { service } = setup();
  const task = service.createTask({ title: 'ship' });
  assert.deepEqual(service.listOverdueTasks('2024-08-01'), []);
  service.setDueDate(task.id, '2024-07-01');
  assert.deepEqual(service.listOverdueTasks('2024-08-01').map((t) => t.id), [task.id]);
  service.setDueDate(task.id, null);
  assert.deepEqual(service.listOverdueTasks('2024-08-01'), []);
});

test('handler setDueDate: 200 with the task, the caller as actor; 400 and 404 as elsewhere', () => {
  const { service, handlers } = setup();
  const task = service.createTask({ title: 'ship' });
  const ok = handlers.setDueDate({ params: { id: task.id }, body: { dueDate: '2024-07-01' }, userId: 'u7' });
  assert.equal(ok.status, 200);
  assert.equal((ok.body as T).dueDate, '2024-07-01');
  const cleared = handlers.setDueDate({ params: { id: task.id }, body: { dueDate: null } });
  assert.deepEqual([cleared.status, (cleared.body as T).dueDate], [200, null]);
  const history = handlers.getTaskHistory({ params: { id: task.id } });
  const items = (history.body as { items: Event[] }).items;
  assert.deepEqual(items.map((e) => [e.type, e.actorId]), [['task.created', null], ['task.due_date_changed', 'u7'], ['task.due_date_changed', null]]);
  for (const body of [{ dueDate: 'tomorrow' }, { dueDate: 5 }, {}, undefined]) {
    const bad = handlers.setDueDate({ params: { id: task.id }, body });
    assert.equal(bad.status, 400, JSON.stringify(body));
    assert.deepEqual(bad.body, { error: 'Validation failed', details: ['dueDate must be a valid date in YYYY-MM-DD format'] });
  }
  const missing = handlers.setDueDate({ params: { id: 'task-999' }, body: { dueDate: '2024-07-01' } });
  assert.deepEqual([missing.status, missing.body], [404, { error: 'Task not found: task-999' }]);
});
