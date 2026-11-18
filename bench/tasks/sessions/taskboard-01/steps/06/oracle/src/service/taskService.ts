import type { NewTaskInput, Task, TaskStatus } from '../models/task.ts';
import {
  DEFAULT_PRIORITY,
  DUE_DATE_ERROR,
  TASK_STATUSES,
  isTaskStatus,
  isValidDateString,
  validateNewTask,
} from '../models/task.ts';
import type { TaskPage, TaskQuery } from '../models/query.ts';
import type { AuditEvent, AuditEventType, FieldChange } from '../models/audit.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { InMemoryAuditLog } from '../repo/auditRepo.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { createIdGenerator } from '../ids.ts';
import { TaskQueries } from './taskQueries.ts';
import { canTransition } from './transitions.ts';

export interface TaskServiceOptions {
  /** Clock used for createdAt/updatedAt and audit timestamps. Defaults to the system clock. */
  now?: () => Date;
  nextId?: () => string;
  /** Where change events are recorded. Defaults to a fresh in-memory log. */
  auditLog?: InMemoryAuditLog;
}

export class TaskService {
  /** The read side; the lookups and listings below go through it. */
  readonly queries: TaskQueries;
  #tasks: InMemoryTaskRepo;
  #users: InMemoryUserRepo;
  #audit: InMemoryAuditLog;
  #now: () => Date;
  #nextId: () => string;
  #nextEventId = createIdGenerator('evt');

  constructor(tasks: InMemoryTaskRepo, users: InMemoryUserRepo, options: TaskServiceOptions = {}) {
    this.queries = new TaskQueries(tasks);
    this.#tasks = tasks;
    this.#users = users;
    this.#audit = options.auditLog ?? new InMemoryAuditLog();
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? createIdGenerator('task');
  }

  createTask(input: NewTaskInput, actorId: string | null = null): Task {
    const errors = validateNewTask(input);
    if (errors.length > 0) throw new ValidationError(errors);
    const timestamp = this.#now().toISOString();
    const task = this.#tasks.insert({
      id: this.#nextId(),
      title: input.title.trim(),
      description: input.description ?? '',
      status: 'todo',
      priority: input.priority ?? DEFAULT_PRIORITY,
      assigneeId: null,
      dueDate: input.dueDate ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#record(task, 'task.created', actorId, {});
    return task;
  }

  getTask(id: string): Task {
    return this.queries.getTask(id);
  }

  listTasks(): Task[] {
    return this.queries.listTasks();
  }

  listOverdueTasks(today: string): Task[] {
    return this.queries.listOverdueTasks(today);
  }

  queryTasks(query?: TaskQuery): TaskPage {
    return this.queries.queryTasks(query);
  }

  /** Change events for one task, oldest first. */
  getTaskHistory(taskId: string): AuditEvent[] {
    this.getTask(taskId);
    return this.#audit.listByTask(taskId);
  }

  /** Assign the task to `userId`, or unassign it with `null`. */
  assignTask(taskId: string, userId: string | null, actorId: string | null = null): Task {
    const task = this.getTask(taskId);
    if (userId !== null) {
      const user = this.#users.findById(userId);
      if (!user) throw new NotFoundError(`User not found: ${userId}`);
      if (!user.active) throw new ConflictError(`User is inactive: ${userId}`);
    }
    if (task.assigneeId === userId) return task;
    const saved = this.#save({ ...task, assigneeId: userId });
    this.#record(saved, 'task.assigned', actorId, { assigneeId: { from: task.assigneeId, to: userId } });
    return saved;
  }

  changeStatus(taskId: string, status: TaskStatus, actorId: string | null = null): Task {
    if (!isTaskStatus(status)) {
      throw new ValidationError([`status must be one of: ${TASK_STATUSES.join(', ')}`]);
    }
    const task = this.getTask(taskId);
    // Re-applying the current status is a no-op: nothing is saved, updatedAt stays.
    if (status === task.status) return task;
    if (!canTransition(task.status, status)) {
      throw new ConflictError(`Invalid status transition: ${task.status} -> ${status}`);
    }
    const saved = this.#save({ ...task, status });
    this.#record(saved, 'task.status_changed', actorId, { status: { from: task.status, to: status } });
    return saved;
  }

  /** Set the deadline ('YYYY-MM-DD'), or clear it with `null`. */
  setDueDate(taskId: string, dueDate: string | null, actorId: string | null = null): Task {
    if (dueDate !== null && !isValidDateString(dueDate)) throw new ValidationError([DUE_DATE_ERROR]);
    const task = this.getTask(taskId);
    if (task.dueDate === dueDate) return task;
    const saved = this.#save({ ...task, dueDate });
    this.#record(saved, 'task.due_date_changed', actorId, { dueDate: { from: task.dueDate, to: dueDate } });
    return saved;
  }

  startTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'in_progress', actorId);
  }

  completeTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'done', actorId);
  }

  cancelTask(taskId: string, actorId: string | null = null): Task {
    return this.changeStatus(taskId, 'cancelled', actorId);
  }

  #save(task: Task): Task {
    return this.#tasks.update({ ...task, updatedAt: this.#now().toISOString() });
  }

  /** Record a change; `at` reuses the saved task's updatedAt so both agree exactly. */
  #record(task: Task, type: AuditEventType, actorId: string | null, changes: Record<string, FieldChange>): void {
    this.#audit.append({ id: this.#nextEventId(), taskId: task.id, type, actorId, at: task.updatedAt, changes });
  }
}
