import type { Task } from '../models/task.ts';
import type { SortOrder, TaskFilter, TaskSortKey } from '../models/query.ts';
import { matchesFilter, sortTasks } from '../models/query.ts';

/** Map-backed task storage. Returns copies so callers cannot mutate stored state. */
export class InMemoryTaskRepo {
  #tasks = new Map<string, Task>();

  insert(task: Task): Task {
    if (this.#tasks.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    this.#tasks.set(task.id, { ...task });
    return { ...task };
  }

  findById(id: string): Task | undefined {
    const task = this.#tasks.get(id);
    return task ? { ...task } : undefined;
  }

  update(task: Task): Task {
    if (!this.#tasks.has(task.id)) throw new Error(`Unknown task id: ${task.id}`);
    this.#tasks.set(task.id, { ...task });
    return { ...task };
  }

  /** All tasks in insertion (creation) order. */
  list(): Task[] {
    return [...this.#tasks.values()].map((task) => ({ ...task }));
  }

  /**
   * Tasks matching `filter`, ordered by `sort` (creation order by default), sliced to
   * [offset, offset + limit), plus the total number of matches before slicing.
   */
  query(filter: TaskFilter, offset: number, limit: number, sort?: { key?: TaskSortKey; order?: SortOrder }): { items: Task[]; total: number } {
    const matches = sortTasks([...this.#tasks.values()].filter((task) => matchesFilter(task, filter)), sort?.key, sort?.order);
    return {
      items: matches.slice(offset, offset + limit).map((task) => ({ ...task })),
      total: matches.length,
    };
  }

  delete(id: string): boolean {
    return this.#tasks.delete(id);
  }
}
