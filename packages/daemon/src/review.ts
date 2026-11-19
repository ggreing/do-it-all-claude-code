// The verdict of a reviewer or tester, read from the two lines its report begins with (decision 145):
//
//   Verdict: accept | reject
//   Margin: easy | normal
//
// The daemon reads them from the subagent's last message when the subagent stops and applies them as a
// router_report_result by that role would be applied. Only these tokens leave this module: the report's
// text is not stored anywhere (decision 141).

export interface ReportVerdict { verdict: 'accept' | 'reject'; margin?: 'easy' | 'normal'; subtasks?: string[] }

const MAX_REPORT_CHARS = 20_000;
// markdown emphasis, a list dash or a quote mark may surround the words; "accepted" / "rejected" are read too
const VERDICT = /(?:^|[\s>*_`~|-])verdict[*_`]*\s*:\s*[*_`]*\s*(accept|reject)(?:ed)?\b/gi;
const MARGIN = /(?:^|[\s>*_`~|-])margin[*_`]*\s*:\s*[*_`]*\s*(easy|normal)\b/gi;
// Appendix B: a judge that reviewed more than one writer names which writer subtask(s) the verdict is about:
//   Subtask: <id>[, <id>...]
const SUBTASK = /(?:^|[\s>*_`~|-])subtasks?[*_`]*\s*:\s*[*_`]*\s*([^\n]+)/gi;

function only<T extends string>(text: string, re: RegExp): T | undefined {
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[1]!.toLowerCase());
  return found.size === 1 ? ([...found][0] as T) : undefined;
}

/** The subtask ids a "Subtask:" line names, or undefined when there is none. A line with a placeholder (the
 *  echoed instruction, `<id>`) or no id-shaped token names nothing. The ids are not checked here; the caller
 *  compares them against the writers the judge actually reviewed. */
function subtaskIds(text: string): string[] | undefined {
  const ids = new Set<string>();
  for (const m of text.matchAll(SUBTASK)) {
    const line = m[1]!;
    if (/[<>]/.test(line)) continue;                               // an echoed instruction placeholder, not real ids
    for (const id of line.match(/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}/g) ?? []) if (!/^(?:none|all|n\/?a)$/i.test(id)) ids.add(id);
  }
  return ids.size ? [...ids] : undefined;
}

/**
 * The verdict a report states, or undefined when it states none or more than one (a report that repeats
 * its instructions, "Verdict: accept or Verdict: reject", says nothing). A margin counts with an accept only;
 * two different margins count as none. `subtasks` are the ids of a "Subtask:" line when one is present.
 */
export function parseReportVerdict(lastMessage: unknown): ReportVerdict | undefined {
  if (typeof lastMessage !== 'string' || !lastMessage) return undefined;
  const text = lastMessage.slice(0, MAX_REPORT_CHARS);
  const verdict = only<'accept' | 'reject'>(text, VERDICT);
  if (!verdict) return undefined;
  const margin = verdict === 'accept' ? only<'easy' | 'normal'>(text, MARGIN) : undefined;
  const subtasks = subtaskIds(text);
  return { verdict, ...(margin ? { margin } : {}), ...(subtasks ? { subtasks } : {}) };
}

const SCOPE_REQUEST = /(?:^|[\s>*_`~|-])scope request[*_`]*\s*:\s*[*_`]*\s*([^\n]*)/i;
const NOTHING = /^(?:none|no|n\/a|nothing|-|—)?[.*_`\s]*$/i;

// Decision 231 (item 8): phrases that name the real cause of a bug in a file. 17630's worker wrote "Scope request:
// none needed. The real cause is in matexpr.py …" — a file outside its scope, which the "none" line hid. A file
// token is a path with a code-ish extension; ":123" line numbers are ignored.
const FILE = String.raw`([A-Za-z0-9_][\w./-]*\.[A-Za-z0-9]{1,6})(?::\d+)?`;
const CAUSE_RES = [
  new RegExp(String.raw`\b(?:real|actual|root|underlying|true)\s+(?:cause|bug|problem|issue|fault)\b[^.\n]{0,60}?\bin\s+${FILE}`, 'gi'),
  new RegExp(String.raw`\b(?:cause|bug|problem|issue|fault|fix)\b\s+(?:is|lies|sits|lives|belongs|originates)\b[^.\n]{0,40}?\b(?:in|at)\s+${FILE}`, 'gi'),
  new RegExp(String.raw`\b(?:needs?|requires?|must)\b[^.\n]{0,40}?\b(?:change|edit|fix|modif\w+|patch)\b[^.\n]{0,20}?\b(?:in|to)\s+${FILE}`, 'gi'),
];

/** The cause files a report names (code-ish paths), de-duplicated and slash-normalised. */
export function reportCauseFiles(text: string): string[] {
  const out = new Set<string>();
  for (const re of CAUSE_RES) for (const m of text.matchAll(re)) out.add(m[1]!.replace(/\\/g, '/').replace(/^\.\//, ''));
  return [...out];
}

/** Whether a named cause file falls within a subtask's write scope (conservative: a bare name matches a scoped file by basename). */
function fileInScope(file: string, allowed: readonly string[]): boolean {
  const base = file.split('/').pop()!;
  return allowed.some(raw => {
    const g = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (g === '**' || g === '**/*' || g === '*') return true;
    const dir = g.replace(/\/?\*{1,2}.*$/, '').replace(/\/+$/, '');   // a subtree glob's fixed base
    if (dir && file.includes('/') && (file === dir || file.startsWith(dir + '/'))) return true;
    const gbase = g.split('/').pop()!;
    if (gbase === base) return true;
    if (/[*?]/.test(gbase)) { try { return new RegExp('^' + gbase.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(base); } catch { return false; } }
    return false;
  });
}

/**
 * Whether a worker's report asks for paths outside its scope: either its "Scope request:" item is not "none",
 * or (decision 231, item 8) it names a real cause in a file OUTSIDE the given scope even while that line says none.
 * Without a scope only the "Scope request:" line is read (the cause-file rule needs the scope to say "outside").
 */
export function reportAsksForScope(lastMessage: unknown, scope?: { allowed: readonly string[]; unscoped: boolean }): boolean {
  if (typeof lastMessage !== 'string') return false;
  const text = lastMessage.slice(0, MAX_REPORT_CHARS);
  const m = SCOPE_REQUEST.exec(text);
  if (m && !NOTHING.test(m[1]!.trim())) return true;
  if (scope && !scope.unscoped) {
    for (const f of reportCauseFiles(text)) if (!fileInScope(f, scope.allowed)) return true;
  }
  return false;
}
