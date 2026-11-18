import type { NewTaskInput, Task, TaskStatus } from '../models/task.ts';
import {
  DEFAULT_PRIORITY,
  TASK_STATUSES,
  isOverdue,
  isTaskStatus,
  isValidDateString,
  validateNewTask,
} from '../models/task.ts';
import type { TaskPage, TaskQuery } from '../models/query.ts';
import { DEFAULT_PAGE_SIZE, validateTaskQuery } from '../models/query.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import type { InMemoryUserRepo } from '../repo/userRepo.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { createIdGenerator } from '../ids.ts';
import { canTransition } from './transitions.ts';

export interface TaskServiceOptions {
  /** Clock used for createdAt/updatedAt. Defaults to the system clock. */
  now?: () => Date;
  nextId?: () => string;
}

export class TaskService {
  #tasks: InMemoryTaskRepo;
  #users: InMemoryUserRepo;
  #now: () => Date;
  #nextId: () => string;

  constructor(tasks: InMemoryTaskRepo, users: InMemoryUserRepo, options: TaskServiceOptions = {}) {
    this.#tasks = tasks;
    this.#users = users;
    this.#now = options.now ?? (() => new Date());
    this.#nextId = options.nextId ?? createIdGenerator('task');
  }

  createTask(input: NewTaskInput): Task {
    const errors = validateNewTask(input);
    if (errors.length > 0) throw new ValidationError(errors);
    const timestamp = this.#now().toISOString();
    return this.#tasks.insert({
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
  }

  getTask(id: string): Task {
    const task = this.#tasks.findById(id);
    if (!task) throw new NotFoundError(`Task not found: ${id}`);
    return task;
  }

  listTasks(): Task[] {
    return this.#tasks.list();
  }

  /** Open tasks whose dueDate is before `today` ('YYYY-MM-DD'), earliest deadline first. */
  listOverdueTasks(today: string): Task[] {
    if (!isValidDateString(today)) {
      throw new ValidationError(['today must be a valid date in YYYY-MM-DD format']);
    }
    return this.#tasks
      .list()
      .filter((task) => isOverdue(task, today))
      // Array.prototype.sort is stable, so equal dates keep creation order.
      .sort((a, b) => ((a.dueDate as string) < (b.dueDate as string) ? -1 : a.dueDate === b.dueDate ? 0 : 1));
  }

  /** Filtered, paginated listing in creation order. */
  queryTasks(query: TaskQuery = {}): TaskPage {
    const errors = validateTaskQuery(query);
    if (errors.length > 0) throw new ValidationError(errors);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = this.#tasks.query(
      { status: query.status, assigneeId: query.assigneeId, priority: query.priority, search: query.search, overdue: query.overdue },
      (page - 1) * pageSize,
      pageSize,
    );
    return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }

  /** Assign the task to `userId`, or unassign it with `null`. */
  assignTask(taskId: string, userId: string | null): Task {
    const task = this.getTask(taskId);
    if (userId !== null) {
      const user = this.#users.findById(userId);
      if (!user) throw new NotFoundError(`User not found: ${userId}`);
      if (!user.active) throw new ConflictError(`User is inactive: ${userId}`);
    }
    return this.#save({ ...task, assigneeId: userId });
  }

  changeStatus(taskId: string, status: TaskStatus): Task {
    if (!isTaskStatus(status)) {
      throw new ValidationError([`status must be one of: ${TASK_STATUSES.join(', ')}`]);
    }
    const task = this.getTask(taskId);
    // Re-applying the current status is a no-op: nothing is saved, updatedAt stays.
    if (status === task.status) return task;
    if (!canTransition(task.status, status)) {
      throw new ConflictError(`Invalid status transition: ${task.status} -> ${status}`);
    }
    return this.#save({ ...task, status });
  }

  startTask(taskId: string): Task {
    return this.changeStatus(taskId, 'in_progress');
  }

  completeTask(taskId: string): Task {
    return this.changeStatus(taskId, 'done');
  }

  cancelTask(taskId: string): Task {
    return this.changeStatus(taskId, 'cancelled');
  }

  #save(task: Task): Task {
    return this.#tasks.update({ ...task, updatedAt: this.#now().toISOString() });
  }
}
