// A test command that failed before any test ran (decision 212).
//
// pytest ends with exit code 2 when it could not collect the tests (an import fails), 3 on an internal error (a
// plugin that does not load) and 4 on a usage error (a conftest that does not import, a bad option). None of
// these says a test failed. Run with -x it ends a collection error with exit 1 instead, like a failed test; the
// output still says which it was (the fair re-measure: one such end was counted as a miss and raised a slot). On the quality baseline five of seven delegated subtasks ended this way because of
// the machine's Python (a removed numpy alias, a pytest plugin that does not load on the installed Python), not
// because of the change; counted as misses, they raised the slot step after step.
//
// Such an end can still be the subagent's doing: a syntax error, a missing import, a rule table it made
// inconsistent. pytest prints the traceback of the failed import, so the error is taken as the subagent's when
// a frame of that traceback, or one of its "E" lines, names a file the subagent changed. That reading leans to
// the subagent's side on purpose: a changed module that is only passed through on the way to the failing one
// also counts, and the failure is then handled as any other.
//
// Only pytest is read here. Other runners report a test file that does not load as a failed test.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Marks a test signal whose command failed before any test ran, by an error outside the subagent's changes. */
export const NOT_STARTED_MARK = 'tests did not start: ';

export const isNotStarted = (s: { ok: boolean; kind: string; detail?: string | undefined }): boolean =>
  !s.ok && s.kind === 'test' && (s.detail ?? '').includes(`: ${NOT_STARTED_MARK}`);

export interface NotStarted {
  /** How the runner ended: "pytest: collection error", "pytest: internal error", "pytest: usage error". */
  what: string;
  /** The runner's own line for the error, at most 160 characters. */
  error: string;
  /** The files the subagent changed that the traceback or an "E" line names; empty when the error is elsewhere. */
  inChanged: string[];
}

const slashes = (s: string) => s.replace(/\\/g, '/');

/**
 * What kept the tests from starting, or undefined when the command is not pytest, when it ended in another way
 * (0: passed, 1: tests failed or a test's setup failed, 5: nothing collected), or when its summary counts a test
 * that ran. Exit 1 counts only as a collection error pytest stopped at (-x).
 * `changed` holds the repository-relative paths of the files the subagent changed.
 */
export function testsDidNotStart(command: string, output: string, code: number | null, changed: readonly string[] = []): NotStarted | undefined {
  if (!/\b(?:pytest|py\.test)\b/.test(command)) return undefined;
  const text = output.replace(ANSI, '');
  if (/\b[1-9]\d* (?:passed|failed|xfailed|xpassed)\b/.test(text)) return undefined;   // tests ran: an ordinary result
  // With -x (or --maxfail) pytest stops at the first collection error and ends with exit 1, the code of a failed
  // test, and without its "errors during collection" line. What tells it apart: the "ERROR collecting <file>"
  // header, and a summary that counts errors and no test (an error in a test's setup has another header).
  const stoppedCollecting = code === 1 && /^\s*_* ?ERROR collecting \S/m.test(text) && /\b[1-9]\d* errors? in [\d.]+ ?s\b/.test(text);
  const what = (code === 2 && /\b\d+ errors? during collection\b/.test(text)) || stoppedCollecting ? 'pytest: collection error'
    : code === 3 ? 'pytest: internal error'
      : code === 4 ? 'pytest: usage error' : undefined;
  if (!what) return undefined;
  const lines = text.split(/\r?\n/);
  const first = (re: RegExp) => { for (const l of lines) { const m = re.exec(l); if (m) return m[1]!.trim(); } return undefined; };
  const error = (first(/^\s*ERROR (\S+ - .+)$/) ?? first(/^\s*E\s+(\S.*)$/) ?? first(/^\s*(Error while loading plugin .+)$/)
    ?? first(/^\s*(ImportError while loading conftest .+)$/) ?? first(/^\s*ERROR: (.+)$/) ?? 'no error line in the output').slice(0, 160);
  const files = changed.map(slashes).filter(Boolean);
  const named = new Set<string>();
  const fileOf = (frame: string) => files.find(f => frame === f || frame.endsWith(`/${f}`));
  // One traceback is a run of frame lines ("path.py:12: in name") closed by its "E" lines. Its first frame is the
  // test module being collected: that module is where every collection starts, so a changed test file counts
  // only when the error is raised in it (it is also the last frame), not when it is merely the way in.
  let frames: string[] = [];
  const close = () => {
    frames.forEach((frame, i) => { const f = fileOf(frame); if (f && (i > 0 || i === frames.length - 1)) named.add(f); });
    frames = [];
  };
  for (const raw of lines) {
    const line = slashes(raw);
    const frame = /^\s*(\S.*?\.py):\d+: in \S/.exec(line)?.[1];
    if (frame) { frames.push(frame); continue; }
    if (/^\s*E\s/.test(line) || /^\s*ImportError while loading conftest /.test(line)) {
      close();
      for (const f of files) if (line.includes(f)) named.add(f);   // File "<path>", line N; cannot import name ... (<path>)
    }
  }
  close();
  return { what, error, inChanged: [...named].sort() };
}
