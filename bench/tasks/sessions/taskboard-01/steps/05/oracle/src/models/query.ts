import type { Priority, Task, TaskStatus } from './task.ts';
import { PRIORITIES, TASK_STATUSES, isOverdue, isPriority, isTaskStatus, isValidDateString } from './task.ts';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Conditions are combined with AND. */
export interface TaskFilter {
  /** Matches any of the listed statuses. */
  status?: TaskStatus[];
  /** A user id, or null for unassigned tasks only. Omit for no assignee filter. */
  assigneeId?: string | null;
  priority?: Priority;
  /** Case-insensitive substring match on the title. */
  search?: string;
  /** A date 'YYYY-MM-DD': only tasks overdue on that day (open, with a deadline before it). */
  overdue?: string;
}

export const TASK_SORT_KEYS = ['createdAt', 'dueDate', 'priority'] as const;
export type TaskSortKey = typeof TASK_SORT_KEYS[number];
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = typeof SORT_ORDERS[number];

export interface TaskQuery extends TaskFilter {
  /** Defaults to 'createdAt' (creation order). */
  sort?: TaskSortKey;
  /** Defaults to 'asc'. */
  order?: SortOrder;
  /** 1-based page number. Defaults to 1. */
  page?: number;
  /** Defaults to DEFAULT_PAGE_SIZE, at most MAX_PAGE_SIZE. */
  pageSize?: number;
}

export interface TaskPage {
  items: Task[];
  page: number;
  pageSize: number;
  /** Number of tasks matching the filter, before paging. */
  total: number;
  totalPages: number;
}

export function validateTaskQuery(query: TaskQuery): string[] {
  const errors: string[] = [];
  if (query.status !== undefined) {
    if (!Array.isArray(query.status) || !query.status.every(isTaskStatus)) {
      errors.push(`status must be a list of: ${TASK_STATUSES.join(', ')}`);
    }
  }
  if (query.assigneeId !== undefined && query.assigneeId !== null && typeof query.assigneeId !== 'string') {
    errors.push('assigneeId must be a string or null');
  }
  if (query.priority !== undefined && !isPriority(query.priority)) {
    errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  if (query.search !== undefined && typeof query.search !== 'string') {
    errors.push('search must be a string');
  }
  if (query.overdue !== undefined && !isValidDateString(query.overdue)) {
    errors.push('overdue must be a valid date in YYYY-MM-DD format');
  }
  if (query.sort !== undefined && !(TASK_SORT_KEYS as readonly unknown[]).includes(query.sort)) {
    errors.push(`sort must be one of: ${TASK_SORT_KEYS.join(', ')}`);
  }
  if (query.order !== undefined && !(SORT_ORDERS as readonly unknown[]).includes(query.order)) {
    errors.push(`order must be one of: ${SORT_ORDERS.join(', ')}`);
  }
  if (query.page !== undefined && !(Number.isInteger(query.page) && query.page >= 1)) {
    errors.push('page must be a positive integer');
  }
  if (query.pageSize !== undefined
    && !(Number.isInteger(query.pageSize) && query.pageSize >= 1 && query.pageSize <= MAX_PAGE_SIZE)) {
    errors.push(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return errors;
}

export function matchesFilter(task: Task, filter: TaskFilter): boolean {
  if (filter.status !== undefined && !filter.status.includes(task.status)) return false;
  if (filter.assigneeId !== undefined && task.assigneeId !== filter.assigneeId) return false;
  if (filter.priority !== undefined && task.priority !== filter.priority) return false;
  if (filter.search !== undefined && !task.title.toLowerCase().includes(filter.search.toLowerCase())) return false;
  if (filter.overdue !== undefined && !isOverdue(task, filter.overdue)) return false;
  return true;
}

/**
 * Orders `tasks` (given in creation order). Ties keep creation order in both directions, and a task
 * without a deadline comes after every task that has one when sorting by dueDate.
 */
export function sortTasks(tasks: Task[], sort: TaskSortKey = 'createdAt', order: SortOrder = 'asc'): Task[] {
  const sign = order === 'desc' ? -1 : 1;
  if (sort === 'createdAt') return order === 'desc' ? [...tasks].reverse() : [...tasks];
  const rank = (task: Task): number | string | null =>
    sort === 'priority' ? PRIORITIES.indexOf(task.priority) : task.dueDate;
  // Array.prototype.sort is stable, so equal keys keep creation order.
  return [...tasks].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  });
}
