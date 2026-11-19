// Whether the router can CHECK a request's result here (decision 231).
//
// The lead's up-front difficulty turned out to be almost always "moderate", so it is no signal for where a
// coder should start. What matters is whether the repo's verify test command actually RUNS in this
// environment: the public SWE-bench repos never install here, so every result there is unverified and a
// strong worker is needed from the start; the custom fixtures run `node --test` cleanly, so a cheap worker
// that is checked and raised on a miss is enough.
//
// So at request open the daemon probes once, in the background, bounded (~60 s), cached per repo + HEAD: it
// resolves the coder's test command and runs it in a cheap "did the tests start" form (pytest collects only;
// other runners run as given — the fixtures are small). The decision-212 "tests did not start" reading, the
// missing-tool reading and the test-count reading then say whether tests actually ran. Only a clean start is
// `checkable`; a probe that could not start the tests, or that found no test command, routes as NOT checkable.
//
// Pure helpers live here (unit-tested); router.ts runs the probe (resolveVerifyCommands + runCommand) and
// caches and stores the result.
import type { Checkability } from '@do-it-all-claude-code/core';
import { missingTool, testCounts, type VerifyCommand } from './verify.ts';
import { zeroTestsRan } from './shell.ts';

const PYTEST = /\b(?:pytest|py\.test)\b/;

/** The first `test`-kind command of a resolved verify list — what the probe runs; undefined when there is none. */
export function probeTestCommand(commands: readonly VerifyCommand[]): string | undefined {
  return commands.find(c => c.kind === 'test')?.command;
}

/**
 * The bounded form of a test command the probe runs: pytest collects only (imports resolve, no test bodies
 * run), so a missing dependency surfaces in a second and a passing repo is not run twice. Other runners run
 * as given — the custom fixtures are small and finish well inside the probe timeout.
 */
export function probeCommand(testCommand: string): string {
  if (PYTEST.test(testCommand) && !/--collect-only/.test(testCommand)) return `${testCommand} --collect-only -q`;
  return testCommand;
}

/**
 * The probe's verdict from how its command ended: `checkable` only when tests actually started here.
 * A missing tool (pytest/node absent), a pytest collection error (exit != 0 under --collect-only), a runner
 * that collected no test, or any non-zero end with no test counts all mean the result could not be checked.
 */
export function classifyProbe(command: string, output: string, code: number | null): Extract<Checkability, 'checkable' | 'unchecked'> {
  if (missingTool(code, output)) return 'unchecked';
  if (/--collect-only/.test(command)) return code === 0 ? 'checkable' : 'unchecked';
  if (zeroTestsRan(command, output, code)) return 'unchecked';
  const counts = testCounts(output);
  if ((counts.testsPassed ?? 0) + (counts.testsFailed ?? 0) > 0) return 'checkable';
  return code === 0 ? 'checkable' : 'unchecked';
}

/** Whether a request's checkability means the router can check a result (decision 231): only a clean probe. */
export const isCheckable = (c: Checkability | null | undefined): boolean => c === 'checkable';

/** How long the background probe may run before it is treated as not-started (decision 231: a bounded run). */
export const PROBE_TIMEOUT_MS = 60_000;
