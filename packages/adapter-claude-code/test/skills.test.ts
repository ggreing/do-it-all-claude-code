import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, formatTriageContext, triage, L3_SIZE_RULE, L3_SIGNS, l3SignalRoles } from '@do-it-all-claude-code/core';

const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugin');
const read = (p: string) => fs.readFileSync(path.join(pluginDir, p), 'utf8');

function frontMatter(md: string): { fm: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  assert.ok(m, 'SKILL.md has front matter');
  return { fm: m![1]!, body: m![2]! };
}

test('lead-orchestrator skill: front matter names the trigger and the delegate-even-small rule', () => {
  const { fm } = frontMatter(read('skills/lead-orchestrator/SKILL.md'));
  assert.match(fm, /^name:\s*lead-orchestrator/m);
  assert.match(fm, /description:/);
  // description must make the trigger and the "don't do it yourself, even small" point discoverable
  assert.match(fm, /\[do-it-all-claude-code\] level/);
  assert.match(fm, /small/i);
  assert.match(fm, /delegat/i);
});

test('lead-orchestrator skill: body spells out the Agent call with the real parameter names', () => {
  const { body } = frontMatter(read('skills/lead-orchestrator/SKILL.md'));
  for (const token of ['subagent_type', 'description', 'prompt', 'model', 'effort'])
    assert.ok(body.includes(token), `body mentions ${token}`);
  // decision 84: cost comes from the subagent transcript, so the skill must not require foreground.
  assert.ok(!/run_in_background:\s*false/.test(body), 'skill no longer mandates foreground (run_in_background: false)');
  assert.match(body, /\[subtask:<ID>\]/);
  assert.match(body, /\[scope:/);
  assert.match(body, /do-it-all-claude-code:coder/);
  assert.match(body, /\[router:awaiting-user\]/);
  // the later detail sections are retained
  for (const re of [/verify/i, /step/i, /HITL/i, /merge/i])
    assert.match(body, re);
});

test('skill covers async task-notifications and the before-done verification gate', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // async: Agent calls return later as task-notifications; wait for all before merging/answering
  assert.match(body, /task-notification/i);
  assert.match(body, /asynchronous/i);
  assert.match(body, /every\*{0,2}\s*subtask/i);   // tolerate markdown bold: **every** subtask
  // before reporting done: confirm the change is in the user's working tree, not just a worktree
  assert.match(body, /git status|git diff/i);
  assert.match(body, /working tree/i);
  assert.match(body, /worktree/i);
});

test('skill is brief-driven (decision 87/88): handle-yourself vs delegate, no hardcoded level, no source reading, trust verify', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // the brief decides; lead-direct is configurable via teams.yaml lead_direct (not a fixed level)
  assert.match(body, /handle it \*{0,2}yourself|handle the small change \*{0,2}yourself/i);
  assert.match(body, /lead[_-]direct/i);
  assert.match(body, /teams\.yaml/i);
  assert.match(body, /delegat/i);
  // don't read source to plan — hand the request as the spec
  assert.match(body, /do not open or read source files|not\*{0,2} from reading the source/i);
  // trust the router's injected verify result; don't re-run build/tests; check with git diff --stat
  assert.match(body, /do not re-run/i);
  assert.match(body, /verify result/i);
  assert.match(body, /git diff --stat/);
});

test('skill encodes the isolation rule of decisions 83 and 219 and the worktree merge procedure', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.match(body, /isolation:\s*"worktree"/);              // the Agent param, for the exception
  assert.match(body, /runs alone|writer that ran alone|alone gets no/i); // lone writer: no isolation
  assert.match(body, /two or more/i);
  // decision 219: writers sent together share the working tree; a worktree each only with project isolation on
  // and no uncommitted input, since a worktree starts from the last commit
  assert.match(body, /share the working tree/);
  assert.match(body, /after: none/);
  assert.match(body, /turned on worktree isolation for this project and\s+no part needs a file that is not committed/);
  assert.doesNotMatch(body, /snapshot-commit/);
  // merge only worktree writers, with concrete commands
  assert.match(body, /git merge --no-ff/);
  assert.match(body, /git worktree remove/);
  assert.match(body, /worktree-agent-<agentId>/);
});

test('skill does not contradict the injected brief: the lead does not edit files itself', () => {
  const md = read('skills/lead-orchestrator/SKILL.md');
  // The injected formatTriageContext says "Do not edit or write files yourself"; the skill must agree
  // and must NOT tell the lead to handle a level by editing directly (the old "L0: do it yourself" line).
  assert.match(md, /do not edit or write files yourself/i);
  assert.ok(!/do it yourself \(or (a|one) /i.test(md), 'no "do it yourself" delegation-bypass remains');
});

test('skill subagent types line up with every role the presets can assign', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  const roles = new Set<string>();
  for (const preset of Object.values(DEFAULT_PRESETS)) for (const r of preset.roles) roles.add(r.role);
  for (const role of roles)
    assert.ok(body.includes(`do-it-all-claude-code:${role}`), `skill lists do-it-all-claude-code:${role}`);
});

test('the injected brief and the skill share the same prompt-line markers', () => {
  // Guard against drift: if core changes the marker wording, this fails so the skill is updated too.
  // Use a DELEGATING preset (some levels are lead-direct, decision 87+); the markers only appear there.
  const delegating = Object.values(DEFAULT_PRESETS).find(p => !p.leadDirect);
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.ok(body.includes('[subtask:<ID>]') && body.includes('[scope:') && body.includes('do-it-all-claude-code:'), 'skill documents the markers');
  if (!delegating) { assert.ok(true, 'all presets are lead-direct; no delegating brief to compare'); return; }
  const brief = formatTriageContext({ ...triage({ prompt: 'x' }), level: delegating.level, preset: delegating.id }, delegating);
  assert.ok(brief.includes('[subtask:<ID>]'), 'brief has [subtask:<ID>]');
  assert.ok(brief.includes('[scope:'), 'brief has [scope:');
  assert.ok(brief.includes('do-it-all-claude-code:'), 'brief has do-it-all-claude-code:');
  assert.match(brief, /Do not edit or write files yourself/);
});

test('skill covers the uncertain-size escalation and shares the brief\'s rubric/markers (decisions 104-113)', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // the uncertain brief: lead-direct preset + stage-1 kind 'uncertain' -> rubric + L2/L3 call values.
  const t = triage({ prompt: 'improve this' });
  assert.equal((t as { kind?: string }).kind, 'uncertain', 'test prompt yields an uncertain stage-1 result');
  // escalation defaults to DEFAULT_PRESETS ({ L2, L3 }), so the brief carries the L3 path (decision 113).
  const brief = formatTriageContext(t, DEFAULT_PRESETS[t.level]);
  assert.match(brief, /could not tell the size/i);

  // the L2 size rubric numbers must match between the brief and the skill (drift guard)
  assert.match(brief, /\b4 or more files\b/);
  assert.match(brief, /\b2 or more\b/);
  assert.match(body, /4 or more files/);
  assert.match(body, /2 or more/);
  assert.match(body, /take one quick look, then decide/i);   // decision 220: the rubric flip, consistent with the uncertain-team brief

  // the L3 escalation threshold + signs come from core, so this follows if the provisional values change
  assert.ok(brief.includes(`${L3_SIZE_RULE.files} or more files`), 'brief states the L3 file threshold');
  assert.ok(brief.includes(L3_SIGNS), 'brief lists the L3 signs');
  assert.ok(body.includes(`${L3_SIZE_RULE.files} or more files`), 'skill states the L3 file threshold');
  assert.ok(body.includes(L3_SIGNS), 'skill lists the L3 signs');

  // the way up to L3 (decision 226): the lead reports the level in router_report_triage, the brief and the skill
  // both say so, and neither asks for a first call that shows the level
  assert.ok(brief.includes('first call router_report_triage with kind "team", level "L2" or "L3"'), 'brief: the switch is the report');
  assert.match(body, /report level \*\*L3\*\* in that `router_report_triage` call/, 'skill: L3 by the report');
  for (const text of [brief, body]) assert.doesNotMatch(text, /make your \*{0,2}first\*{0,2} call the|signals L3/, 'no first-call role');
  assert.ok(l3SignalRoles(DEFAULT_PRESETS.L2, DEFAULT_PRESETS.L3).length > 0, 'the router can still read one, unasked');

  // the escalation brief carries the team Agent-call markers the skill also documents
  assert.ok(brief.includes('do-it-all-claude-code:') && body.includes('do-it-all-claude-code:'));
  assert.ok(brief.includes('[subtask:<ID>]') && brief.includes('[scope:'));
  assert.match(body, /re-plans|re-plan/i);
});

test('decision 230: the lead coordinates, splits by difficulty and does not accept an unverified result', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // a thin lead: the first look judges size and difficulty only
  assert.match(body, /only to judge the size and the difficulty/);
  assert.match(body, /Do not trace the root cause, read source files in depth, or draft the fix yourself/);
  // a bug report in code the lead has not traced is hard; the router's floor wins when higher
  assert.match(body, /wrong behaviour or an error in code you have not fully traced/);
  assert.match(body, /higher of your report and the floor is used/);
  // a subtask the lead tags carries its difficulty on the prompt's third line
  assert.match(body, /the third `\[difficulty: <routine\|moderate\|hard>\]` when you tag the subtask/);
  assert.match(body, /\[difficulty: hard\]\\n…"\)\nAgent\(.*\n.*\[scope: CHANGELOG\.md\]\\n…"\)/, 'the parallel example sends a hard part and an untagged changelog together');
  // an unverified result with a retry: the same subtask once more, before anything is accepted
  assert.match(body, /\*\*unverified\*\*/);
  assert.match(body, /\*\*do not accept it yet\*\*/);
  assert.match(body, /`retry`/);
  // from L1 up even a small change is delegated: no one-file hand-back to the lead
  assert.doesNotMatch(body, /hands the request to you \(`leadDirect` true\)/);
});

test('decision 231: the router sets the values, the lead says where to look and does not check results itself', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  // no table to read values from: the router's answer gives them, from the difficulty and whether it can check the result
  assert.doesNotMatch(body, /\| coder, tester \|/);
  assert.match(body, /use the values in the router's answer/);
  assert.match(body, /whether the router can check the result/);
  assert.match(body, /starts once on Opus at high effort/);
  // untagged: a source-changing coder at the request's difficulty, the rest routine
  assert.match(body, /tag the hard parts/);
  assert.match(body, /Untagged, a coder that changes source code runs at the request's difficulty, and a tag never puts it below that; any other untagged subtask \(a test, the changelog, a summary\) runs as routine/);
  // the notes say where to look, never how or where to fix; acceptance is the request's behaviour
  assert.match(body, /\*\*never how or where to fix it\*\* \(decision 231\)/);
  assert.match(body, /The acceptance check is the behaviour the request asks for, not a design/);
  // a retry is the same subtask with the earlier attempt as a candidate
  assert.match(body, /A retry is \*\*the same subtask\*\*, with the same spec and scope, not a narrower one/);
  // a cause outside the coder's scope: grant the path and send the same subtask again, no workaround
  assert.match(body, /grant that path with `router_request_scope`, then dispatch the same subtask once more with the same scope/);
  assert.match(body, /Do not ask it to review that attempt or to keep the change minimal/);
  // the lead does not verify a worker's result itself
  assert.match(body, /do not write or run checks of your own/);
  assert.doesNotMatch(body, /targeted run|run only the tests of|run the changed code's tests/);
  assert.match(body, /When the line names no retry \(decision 231/);
});

test('decision 232: values listed in the brief need no report; the router\'s last line names the changed files', () => {
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.match(body, /When the brief lists each role's values \(decision 232: the router already knows whether the tests run\), tag each subtask with its difficulty and pass that difficulty's values; no report is needed\./);
  assert.match(body, /When the brief already lists them \(decision 232\), you need it only to raise the level\./);
  assert.match(body, /The router's last result line names the changed files \(decision 232\)/);
  assert.doesNotMatch(body, /Confirm the edits landed with a single `git diff --stat`/);
});

test('decision 231: the coder diagnoses a bug before it fixes it', () => {
  const coder = read('agents/coder.md');
  assert.match(coder, /For a bug, the lead's notes on where to look are hypotheses\. Reproduce the problem first .*trace the cause, then fix it at the cause\./);
  assert.match(coder, /If the cause is outside your allowed paths, do not work around it inside them: name it under Scope request and stop\./);
});

test('decision 234: the coder runs only the related tests, and the lead asks for behaviour, not a test run', () => {
  const coder = read('agents/coder.md');
  assert.doesNotMatch(coder, /run the build, typecheck, lint and tests yourself/);
  assert.doesNotMatch(coder, /confirms the build and tests/);
  assert.match(coder, /Run only the tests related to what you changed .*once or twice\. Never run the whole suite or a command that takes over about 2 minutes, and never start a command in the background\./);
  assert.match(coder, /Run lint, format or type tools only when the project or the task names them\./);
  assert.match(coder, /If the test runner does not start here .*do not repair the environment: no `pip install`, no `PYTHONPATH` or plugin tricks\. Say so under Remaining issues and finish\./);
  // the router still runs the full checks when the coder finishes
  assert.match(coder, /When your session ends, the router runs the build, typecheck, lint and tests/);
  assert.doesNotMatch(coder, /npm test 2>&1/);
  const body = read('skills/lead-orchestrator/SKILL.md');
  assert.match(body, /not a design and not a test run \(decision 234\): checking is the router's job, so never write "run the existing tests to check" or invite a quick sanity run; to point at a test, name one test file\./);
  assert.doesNotMatch(body, /Acceptance: npm test passes/);
  // no tester subtask just to run the checks
  assert.match(body, /send a tester only for tests the request asks for, never to run the checks\./);
  assert.doesNotMatch(body, /running the checks|a tester running the checks/);
  // the tester follows the same rules as the coder
  const tester = read('agents/tester.md');
  assert.match(tester, /Run only the tests you wrote and those of the code the spec names, once or twice\. Never run the whole suite or a command that takes over about 2 minutes, and never start a command in the background\./);
  assert.match(tester, /If the test runner does not start here .*do not repair the environment: no `pip install`, no `PYTHONPATH` or plugin tricks\./);
  assert.match(tester, /install the project's dependencies if they are missing, inside the project .*Install nothing outside it\./);
  assert.match(tester, /When your session ends, the router runs the tests/);
  assert.doesNotMatch(tester, /npm test 2>&1|broke a test that passed before/);
});

test('router skill documents both commands', () => {
  const md = read('skills/router/SKILL.md');
  assert.match(md, /^name:\s*router/m);
  assert.match(md, /\/router level/);
  assert.match(md, /\/router resume/);
});
