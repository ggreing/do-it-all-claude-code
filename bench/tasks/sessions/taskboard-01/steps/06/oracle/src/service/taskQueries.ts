import type { Task } from '../models/task.ts';
import { isOverdue, isValidDateString } from '../models/task.ts';
import type { TaskPage, TaskQuery } from '../models/query.ts';
import { DEFAULT_PAGE_SIZE, validateTaskQuery } from '../models/query.ts';
import type { InMemoryTaskRepo } from '../repo/taskRepo.ts';
import { NotFoundError, ValidationError } from '../errors.ts';

/** The read side of the task service: lookups and listings, no changes. */
export class TaskQueries {
  #tasks: InMemoryTaskRepo;

  constructor(tasks: InMemoryTaskRepo) {
    this.#tasks = tasks;
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

  /** Filtered, sorted, paginated listing. */
  queryTasks(query: TaskQuery = {}): TaskPage {
    const errors = validateTaskQuery(query);
    if (errors.length > 0) throw new ValidationError(errors);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const { items, total } = this.#tasks.query(
      { status: query.status, assigneeId: query.assigneeId, priority: query.priority, search: query.search, overdue: query.overdue },
      (page - 1) * pageSize,
      pageSize,
      { key: query.sort, order: query.order },
    );
    return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
  }
}
