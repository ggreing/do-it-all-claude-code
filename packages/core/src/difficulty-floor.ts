// Decision 230 (item 2): the router's difficulty FLOOR. A request's difficulty is the higher of the lead's
// report and this floor (see maxDifficulty in ladder.ts). The floor only ever raises to 'hard', and only on a
// STRONG cue that the request is a genuinely hard bug — not on a bare expected/actual example or the word "bug"
// (decision 230 choice C+B). It never fires for a stage-1-L0 request (a typo/format/one-constant change), and
// never when the request names a test that already reproduces the problem (the repro is the safety net). The
// unverified retry (item 3) is the backstop for hard bugs this floor misses, which is cheap.
import type { Difficulty, Level } from './types.ts';

// A strong cue: a traceback, or an exception raised in running code (a crash / unexpected error) ...
const TRACEBACK = /Traceback \(most recent call last\)|^\s*File ".+", line \d+/m;
const EXC_RUNTIME = /\bcrash(?:es|ed|ing)?\b|크래시|\bsegfault\b|core dumped|stack overflow|\bRecursionError\b|\bMemoryError\b|예기치\s*(?:못한|않은)|unexpected(?:ly)?\s+(?:error|exception|[A-Z]\w*(?:Error|Exception))\b|\b[A-Z]\w*(?:Error|Exception)\b[^.\n]{0,24}\bunexpected\b/i;
// ... or instability (regression / intermittent / flaky / race / deadlock / non-deterministic) ...
const INSTABILITY = /\b(?:regression|intermittent|flak(?:y|iness)|race condition|\brace\b|deadlock|non-?deterministic)\b|회귀/i;
// ... or "sometimes" ...
const SOMETIMES = /\bsometimes\b|가끔|때때로|이따금|ときどき|たまに|間歇|时好时坏|時好時壞/i;
// ... or an order- / chunk-dependent / concurrent symptom.
const ORDER_DEP = /depend(?:s|ing)? on (?:the )?(?:order|chunk|timing|sequence|split|how|where)|order[- ]?dependent|chunk[- ]?dependent|어디서 (?:잘리|나[뉘누])|자르는 위치|순서에 따라|청크|동시에|동시 |병렬|concurrent(?:ly)?|concurrency/i;

/** True when the prompt shows a strong cue of a hard bug (not a bare expected/actual example or the word "bug"). */
export function hasStrongHardCue(prompt: string): boolean {
  return TRACEBACK.test(prompt) || EXC_RUNTIME.test(prompt) || INSTABILITY.test(prompt) || SOMETIMES.test(prompt) || ORDER_DEP.test(prompt);
}

// The request names a test that already reproduces the problem (a test file, or "the failing test"/"reproduces").
const TEST_FILE = /\b[\w./-]*(?:[._-](?:test|spec)|test_[\w-]+)\.\w+\b|\btests?\/|__tests__/i;
const NAMES_TEST = /(?:failing|reproduc\w+|existing|this) tests?\b|\btest (?:that|which) (?:fails|reproduces|shows)|테스트(?:가|를|에서)?\s*(?:실패|재현|깨)|재현.*테스트/i;
/** True when the request names a reproducing test (then the floor does not fire). */
export function namesReproTest(prompt: string): boolean {
  return TEST_FILE.test(prompt) || NAMES_TEST.test(prompt);
}

/**
 * Decision 230 (item 2): the router's difficulty floor for a request. Returns 'hard' when the prompt shows a strong
 * hard-bug cue, names no reproducing test, and was not settled as stage-1 L0; otherwise null (no floor). The caller
 * takes the higher of this and the lead's reported difficulty, recording difficultySource 'router' when the floor wins.
 */
export function difficultyFloor(prompt: string, stage1Level: Level): Difficulty | null {
  if (stage1Level === 'L0') return null;
  return hasStrongHardCue(prompt) && !namesReproTest(prompt) ? 'hard' : null;
}
