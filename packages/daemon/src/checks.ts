// How verify ended, one entry per kind of check.
//
// A role's verify list can hold several commands of one kind: `npm ci` and the build script are both "build",
// `npm test` and pytest are both "test". Each command leaves a signal of its own. Told command by command, a
// project with only a test script read "build skipped, build ok, ... test ok (2 passed), test skipped": the
// same name twice, with two answers. What the lead, the office and the Work tab show is one entry per kind:
//
//   failed   when any command of the kind failed
//   ok       when none failed and at least one ran
//   skipped  when none ran (its condition did not hold, its script is not in package.json, no related tests)
//
// Test counts are the sum over the commands of the kind that ran.

/** True for a verify command that was not run: skipped by its condition, or with nothing to run on. Neither is a pass. */
export const notRun = (detail: string | undefined): boolean => /: (?:skipped \(|no related tests \()/.test(detail ?? '');

export type CheckResult = 'ok' | 'failed' | 'skipped';

export interface KindCheck {
  kind: string;
  attempt: number;
  result: CheckResult;
  testsPassed?: number;
  testsFailed?: number;
  durationMs?: number;
}

interface SignalLike {
  kind: string;
  attempt?: number;
  ok: boolean;
  detail?: string | undefined;
  testsPassed?: number | undefined;
  testsFailed?: number | undefined;
  durationMs?: number | undefined;
}

/** One entry per attempt and kind, in the order the kinds first appear. */
export function checksByKind(signals: readonly SignalLike[]): KindCheck[] {
  const out: KindCheck[] = [];
  for (const x of signals) {
    const attempt = x.attempt ?? 0;
    let c = out.find(k => k.kind === x.kind && k.attempt === attempt);
    if (!c) { c = { kind: x.kind, attempt, result: 'skipped' }; out.push(c); }
    const skipped = x.ok && notRun(x.detail);
    if (!x.ok) c.result = 'failed';
    else if (!skipped && c.result === 'skipped') c.result = 'ok';
    if (skipped) continue;
    if (x.testsPassed !== undefined) c.testsPassed = (c.testsPassed ?? 0) + x.testsPassed;
    if (x.testsFailed !== undefined) c.testsFailed = (c.testsFailed ?? 0) + x.testsFailed;
    if (x.durationMs !== undefined) c.durationMs = (c.durationMs ?? 0) + x.durationMs;
  }
  return out;
}

/** "test ok (3 passed), scope ok": the phrase the lead reads. */
export function checksPhrase(checks: readonly KindCheck[]): string {
  return checks.map(c => `${c.kind} ${c.result}${c.kind === 'test' && c.result !== 'skipped' && c.testsPassed !== undefined
    ? ` (${c.testsPassed} passed${c.testsFailed ? `, ${c.testsFailed} failed` : ''})` : ''}`).join(', ');
}
