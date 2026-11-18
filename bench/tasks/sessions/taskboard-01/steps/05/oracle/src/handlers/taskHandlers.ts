import type { NewTaskInput, Priority, TaskStatus } from '../models/task.ts';
import type { SortOrder, TaskQuery, TaskSortKey } from '../models/query.ts';
import type { TaskService } from '../service/taskService.ts';
import { DUE_DATE_ERROR } from '../models/task.ts';
import { ValidationError } from '../errors.ts';
import type { Request } from './http.ts';
import { bodyRecord, handle, ok, requireParam } from './http.ts';

export function createTaskHandlers(service: TaskService) {
  return {
    /** POST /tasks */
    createTask: handle((req) => ok(service.createTask(req.body as NewTaskInput, req.userId ?? null), 201)),

    /** GET /tasks/:id */
    getTask: handle((req) => ok(service.getTask(requireParam(req, 'id')))),

    /** GET /tasks?status=todo,in_progress&assigneeId=u1|none&priority=high&q=login&page=1&pageSize=20 */
    listTasks: handle((req) => ok(service.queryTasks(parseTaskQuery(req)))),

    /** GET /tasks/overdue?today=YYYY-MM-DD */
    listOverdueTasks: handle((req) => ok({ items: service.listOverdueTasks(req.query?.today ?? '') })),

    /** GET /tasks/:id/history */
    getTaskHistory: handle((req) => ok({ items: service.getTaskHistory(requireParam(req, 'id')) })),

    /** PUT /tasks/:id/assignee  body: { userId: string | null } */
    assignTask: handle((req) => {
      const { userId } = bodyRecord(req);
      if (userId !== null && typeof userId !== 'string') {
        throw new ValidationError(['userId must be a string or null']);
      }
      return ok(service.assignTask(requireParam(req, 'id'), userId, req.userId ?? null));
    }),

    /** PUT /tasks/:id/due-date  body: { dueDate: 'YYYY-MM-DD' | null } */
    setDueDate: handle((req) => {
      const { dueDate } = bodyRecord(req);
      if (dueDate !== null && typeof dueDate !== 'string') throw new ValidationError([DUE_DATE_ERROR]);
      return ok(service.setDueDate(requireParam(req, 'id'), dueDate, req.userId ?? null));
    }),

    /** PUT /tasks/:id/status  body: { status } */
    updateStatus: handle((req) => {
      const { status } = bodyRecord(req);
      return ok(service.changeStatus(requireParam(req, 'id'), status as TaskStatus, req.userId ?? null));
    }),
  };
}

export type TaskHandlers = ReturnType<typeof createTaskHandlers>;

/** Turn query-string values (all strings) into a TaskQuery; the service validates the values. */
function parseTaskQuery(req: Request): TaskQuery {
  const q = req.query ?? {};
  const query: TaskQuery = {};
  if (q.status !== undefined) {
    const statuses = q.status.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (statuses.length > 0) query.status = statuses as TaskStatus[];
  }
  if (q.assigneeId !== undefined) query.assigneeId = q.assigneeId === 'none' ? null : q.assigneeId;
  if (q.priority !== undefined) query.priority = q.priority as Priority;
  if (q.q !== undefined) query.search = q.q;
  if (q.overdue !== undefined) query.overdue = q.overdue;
  if (q.sort !== undefined) query.sort = q.sort as TaskSortKey;
  if (q.order !== undefined) query.order = q.order as SortOrder;
  if (q.page !== undefined) query.page = toInteger(q.page);
  if (q.pageSize !== undefined) query.pageSize = toInteger(q.pageSize);
  return query;
}

/** Strict integer parsing: anything but an optional sign and digits becomes NaN (rejected later). */
function toInteger(value: string): number {
  return /^[+-]?\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
}
