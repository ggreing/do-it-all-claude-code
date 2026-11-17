# Design note: reproduce first (decision 175)

For a bug fix or a new behavior, the coder first writes a test that fails because of the problem. The
router checks that the test fails before the fix and passes after it.

**Status: the router side is built and off by default (`reproduceFirst`); it has not been run with a
model.** The section "As built" says what the first version does and where it is narrower than the design
below it. Points marked *to verify* are assumptions about Claude Code or about a test runner's output;
[session-checks.md](session-checks.md) puts the ones that need a real session in the order to check them in.

## As built (first version)

The mechanism is the `PostToolUse` variant (decision 179), not the two stops of section 3:

1. At dispatch the router stores, per coder subtask, whether a reproduction is required: the lead's
   `[repro: required]` or `[repro: off <reason>]` line after the scope line, else the default of section 1.
2. When the coder starts, the `SubagentStart` hook tells it to write a failing test before any other
   change. The router marks the agent's file, and while that mark is set the hook relay sends the
   subagent's `Write` and `Edit` events to the daemon (path only, never content). Other subagents' edits
   are answered by the relay itself, as before.
3. When a test file is saved and the subagent's changes so far are tests only, the router runs that file
   with its own command and returns what it saw as `additionalContext`: it fails (go on with the change),
   it passes (not a reproduction), no tests ran, or it could not be run. The fingerprint of a file seen
   failing is stored. Saving the test again while the tree is still tests only runs it again, so a
   mistake in the test can be corrected. A run is limited to 60 s and at most six runs are made per
   subtask; a run that reaches the limit is "not checked". The hook's own limit is 100 s and the relay
   waits 90 s.
4. When other files had already changed before a test was seen failing, nothing is run: the coder is told
   once and the result is unconfirmed (`changed-first`). When a file that was seen failing is edited after
   the change began, the coder is told at once that only the same file counts.
5. At the stop the confirmed files are run first (90 s in all, taken out of verify's total). A failure,
   or a file that is gone, is a verify signal of kind `repro`: the verify commands are skipped, the stop is
   blocked for the one fix round, and a second failure is a miss that raises the slot. A pass with
   unchanged files is `reproduced`; a pass with a changed file is unconfirmed (`test-changed`).
6. Nothing confirmed at the stop is unconfirmed, with the reason from the coder's `Repro: none (<reason>)`
   line when there is one. An unconfirmed result passes verify as before, is never an easy pass, and the
   lead's result line says so.
7. `observe` runs and records the same, tells the coder the same, and fails nothing: no `repro` signal is
   stored and the easy-pass rule is untouched.

What the measured hook behavior allows (Claude Code 2.1.325, a Haiku lead and worker): a subagent's
`PostToolUse` hook runs inside the subagent; `additionalContext`, a block reason and exit 2 with stderr
reach it; plain stdout and exit 1 do not; a hook that answered after 75 s under a 120 s limit was still
delivered; a hook that passed its limit was cut off and the worker went on.

Narrower than the design, on purpose:

- **Selection is by file.** The router knows the file from the hook, before any report exists, so a test
  name is not used; the whole file must pass at the stop. `Repro:` lines that name files are not read,
  only `Repro: none (<reason>)`. Rust is not in the default templates (no file-level selection); a
  project adds its own command in `verify.json`.
- **Templates** are built into the daemon, with the project's `verify.json` `"repro"` list (read at the
  start commit) replacing them. The role file's `x-router.repro` key is not built.
- **A failure while loading is accepted like one of unknown kind**: the unchanged file must pass
  afterwards, the result is labelled (`load`, `unknown`) in the lead's line and is never an easy pass. The
  finer rule of section 4 (a load failure counts only for new behavior, and only for a name inside the
  scope) is not built.
- **No install step is run from the hook.** When an install step of the verify list is still due
  (`node_modules` missing), the test is not run and the coder is asked to install and save the test again.
  A Python project has no such step, so a missing third-party module shows as a `load` failure.
- **No block for a changed test** at the stop (the coder was already told when it edited the file), and no
  transcript fallback (mechanism C): with the hook, a test written first is always seen by the router.
- **The setting** is `do-it-all-claude-code config set reproduceFirst on|observe|off`; it applies to subtasks
  dispatched after the change.
- **One signal row** (`repro`, at the stop). What was seen before the change is kept with the subtask
  (`subtasks.repro`, schema v17): paths, fingerprints, failure kind, counts; no output.
- Not built yet: the guard allowlist additions of section 2, turning a subtask off at dispatch when no
  template applies (it ends unconfirmed with `no-tests` instead), the reviewer and tester being handed the
  test and its results, and the History tab's reproduction marks (the team office shows a subtask's
  reproduction state beside its checks).

**To verify with a real session**: that `additionalContext` of `SubagentStart` reaches the subagent (the
experiment covered `PostToolUse` only; if it does not, the coder still learns of the requirement from the
first hook answer, provided it writes a test first); that a first-step coder follows the order.

## Why

Today's verification answers "did the change break a related test?". It does not answer "is the reported
problem gone?". In the Sonnet-lead measurement
([decision123-sonnet-lead.md](../measurements/decision123-sonnet-lead.md), finding 4) two public L3 tasks
(sympy, pylint) passed the router's verify and failed SWE-bench grading, so no step-up happened. In the
third (django) the lead ended the request after a verify failure.

What this design can and cannot do:

- It catches a fix that does not change the reported behavior, and it turns "the symptom is still there"
  into a verify failure, which is what drives a step-up.
- It does not catch a coder that misreads the request: the test and the fix then share the same mistake.
  Whether it would have changed the sympy and pylint results is unknown until measured (section 9).

## Recommendation in short

1. The lead marks each coder subtask with a third tag line, `[repro: required]` or `[repro: off <reason>]`.
   The router proposes the default from the request; the lead can turn it off, and that is recorded.
2. The coder writes the test and changes nothing else. The router runs that test in the work tree as it is
   (start state plus the test) from the hook that follows the file write, records the failure, and tells
   the coder to make the fix. No second work tree is made and the coder does not end its turn in between
   (decision 179; the two-stop form of section 3 was the design before the hook experiment).
3. At the final stop the router runs the same test first. It must pass, and the test file must be the one
   that was seen failing, byte for byte.
4. The router builds the test command from a template in the role file or the project's `verify.json`. The
   coder reports files and test names, never a command.
5. A test that still fails after the fix is a verify failure and counts toward a step-up. A reproduction
   that could not be confirmed is not a failure, but it is never an "easy" pass, and the lead is told.
6. A new config key `reproduceFirst` (`on`, `observe`, `off`). The measurement runs with `on`; the release
   default is chosen from its result. Until then the default is `off`, so that other measurements are not
   changed by it.

## 1. When it applies

**Where there is an enforcement point.** The check runs at a subagent's stop, so it applies to **coder
subtasks**, at whatever level the lead delegates from (decision 124: L1 for Sonnet- and Opus-class leads).
A lead-direct request (L0, and L1 for other leads) has no stop to check and no verify today; this note
does not change that.

**By kind of work.** The router's `taskType` (`question`, `debug`, `refactor`, `design`, `feature`, `edit`)
is a wording guess for the whole request, and `edit` holds many plain bug fixes. So it only sets the
default the brief shows the lead; the lead, who writes each subtask's spec, has the last word.

| Work | Default | Before the fix, the test must |
|---|---|---|
| Bug fix (`debug`, or the bug-fix rule matched) | required | fail in the test body |
| New behavior (`feature`) | required | fail in the test body, or fail to load because the new symbol or module is missing |
| `edit` (unclassified change) | required when the scope holds source files | as for a bug fix |
| Refactor | off (`refactor`): behavior must not change, so there is nothing to see fail | |
| Docs, comments, config only (every scope glob is documentation or config) | off (`docs`, `config`) | |
| `question`, `design` | does not apply (no coder subtask, or no code yet) | |

**Turning it off.** `[repro: off <reason>]`, with the reason one of `refactor`, `docs`, `config`,
`no-tests` (the project has no test setup), `not-testable` (section 5). No user confirmation: this is a
quality setting, not a permission. The mode and reason are stored per subtask and shown in the team office,
so a lead that turns it off everywhere is visible. A subtask without the tag line gets the router's
default.

**Global switch.** `reproduceFirst` in `config.json`:

- `on`: as described here.
- `observe`: the coder is asked and the results are recorded, but nothing is blocked for it and nothing
  counts toward a step-up. It shows how often coders comply and what it costs before it can slow anyone
  down.
- `off`: the tag is ignored and the role text asks for nothing.

**Who writes the test.** The coder, in every team. An alternative for L2 and L3 is a tester subtask that
runs before the coder and whose success is "the test fails": an author who works from the request alone
does not share the coder's reading of it, which is the failure mode of sympy and pylint. It costs one more
subagent start (about 20 to 40 s and a brief). Recommended as a second step, for L3 only, if the
measurement shows shared misreadings remain.

## 2. What the coder reports

Workers cannot call the router's MCP tools (`disallowedTools` is locked by the role floor), so the report
is a line in the last message, read the way a reviewer's `Verdict:` line is read (decision 145):

```
Repro: tests/test_pagination.py::test_exact_multiple
Repro: test/paginate.test.ts :: returns the last page for an exact multiple
Repro: none (no-tests)
```

- Up to three `Repro:` lines. Each is a repo-relative test file, optionally followed by `::` and a test
  name. `none` takes one of the reasons `no-tests`, `not-testable`, `cannot-reproduce`.
- The path is normalized (backslashes, the `/c/...` spelling Git Bash prints) and must be inside the work
  tree, inside the subtask's write scope, and among the files the subagent changed or added. Otherwise the
  line is ignored and the coder is told why.
- The name is limited to letters, digits, spaces and `_ . , : ( ) [ ] -`, at most 120 characters. For Go
  and Rust it is required, since those runners select by name, not by file.
- A report that only repeats its instructions (a placeholder such as `<path>`) says nothing, as with
  `Verdict:`.

**The command is the router's, not the coder's.** Verify commands come from the role file or from the
project's `verify.json` at the start commit, so a subagent cannot choose what the daemon runs as the user.
Reproduction keeps that rule: the coder names *what* to run, and the router fills a template. The new
`repro` key sits beside `verify` in `x-router` and in `verify.json`:

```yaml
x-router:
  repro:
    - { command: 'python -m pytest -q -x {reproTests}', ifAnyExists: [pytest.ini, pyproject.toml, setup.cfg, tox.ini, conftest.py] }
    - { command: 'npx vitest run {reproFiles} {reproName:-t}', ifDependency: vitest }
    - { command: 'npx jest {reproFiles} {reproName:-t}', ifDependency: jest }
    - { command: 'node --test {reproName:--test-name-pattern} {reproFiles}', ifExists: package.json }
    - { command: 'go test {reproPackages} -run {reproNameRegex}', ifExists: go.mod }
    - { command: 'cargo test {reproNameExact} -- --exact', ifExists: Cargo.toml }
```

The first entry whose condition holds is used; the conditions are read at the start commit.

| Ecosystem | How one test is selected | Notes |
|---|---|---|
| pytest | node id `path::Class::test` | parametrized ids (`[...]`) select by prefix; the file alone also works |
| node --test | file, plus `--test-name-pattern` | the name is regex-escaped by the router |
| vitest, jest | file, plus `-t <name>` | `-t` is a pattern: escaped the same way |
| mocha | file, plus `--grep` | not in the default list; a project adds it in `verify.json` |
| go test | package directory of the file, plus `-run '^Name$'` | file-level selection does not exist |
| cargo test | name with `--exact` | compiles the crate first |
| `npm test -- <file>` | whatever the project's script does | fallback when no runner is recognized; see section 4 |

Every placeholder becomes single-quoted words. A file argument that starts with `-` gets `./` in front, so
a file name cannot become an option.

**Relation to the guard's allowlist and the user's permission rules.**

- The router's own run does not go through Claude Code, so it needs no Bash rule and works under
  `claude -p` with no allow rules. This is the main reason the router runs the test itself instead of
  relying on the coder's run.
- The coder may also run the test. The targeted forms above already start with allowlisted prefixes
  (`node --test`, `npx vitest`, `npx jest`, `pytest`, `python -m pytest`, `go test`, `cargo test`,
  `npm test`). Proposed additions: `npx mocha`, `pnpm exec vitest`, `pnpm exec jest`, `yarn vitest`,
  `yarn jest`, mirrored in core. Anything else goes through the project policy (`bashAllow`), as today.
- The guard never approves Bash; the user's rules do. `docs/worker-permissions.md` needs the targeted
  forms as examples (`Bash(node --test *)`, `Bash(python -m pytest *)`, `Bash(npx vitest run *)`), and a
  line that a coder without such a rule can still complete a reproduction, because the router runs it.

## 3. How the router sees the test fail before the fix

**Chosen after the hook experiment (decision 179): mechanism D without the stop round.** The test is run
from the `PostToolUse` hook of the file write, in the same tree state D uses, and the answer goes back as
hook context ("As built" above). What follows is the comparison that led to D, kept for its reasons
against A and B; D's two stops and the fallback C are not built.

Four ways were considered.

| | A. Second work tree at the start commit | B. Take the fix out in place, run, put it back | C. Read the coder's own run from its transcript | D. Two stops (recommended) |
|---|---|---|---|---|
| How | `git worktree add --detach` at the start commit, copy the test in, run | save the changed non-test files, restore their start state, run, restore | find the Bash call that ran the test, and its result, before the first non-test edit | the coder stops with only the test written; the router runs it where it is |
| Dependencies and build output present | no | yes | yes | yes |
| Writes to the user's files | no | yes | no | no |
| Extra cost | checkout, and usually an install | two runs and file copies | none | one stop round |
| Works when the coder may not run Bash | yes | yes | no | yes |
| Who observed the failure | router | router | Claude Code's tool result | router |

**A is not recommended.** The costs are in what a fresh tree lacks, not in the checkout:

- No `node_modules`, no virtualenv, no build output. An install per reproduction is tens of seconds at
  best, against decision 174.
- A Python project installed in editable mode points at the original folder. A test run in the second tree
  can import the **fixed** code from the first and report a result about the wrong tree, silently.
- Linking the original `node_modules` in is the obvious shortcut and a hazard on Windows: removing a tree
  that holds a junction can empty the junction's target.
- Windows paths: a tree under the router home or the temp folder adds to every path and can pass 260
  characters; the folder would need a short root and `core.longpaths`. Virus scanners and indexers hold
  files open, `git worktree remove` then fails, and a registered tree is left behind for the user to see
  in `git worktree list`.
- The daemon's git runs with hooks off and filter drivers emptied, so LFS files would be pointers.
- Checkout time grows with the repository (a few seconds for several thousand files on Linux, more on
  Windows; not measured here).

**B is not recommended.** The daemon would edit the user's checkout (a lone writer works there, decision
83), which it never does today. A crash between "taken out" and "put back" leaves the user without the
fix until a journal is replayed; editors and dev servers see the files flip; and for a file the user had
already modified before the subtask, the start snapshot keeps a fingerprint, not the content, so it could
not be restored without storing copies of the user's uncommitted work.

**D, in detail.**

1. First stop. The scope check runs as today. If the subagent's changes are exactly the files its `Repro:`
   lines name (other new test files and fixtures under the same test folder are allowed; any change to a
   non-test file is not), the tree is "start state plus the test". The router runs the install step when
   its `ifMissing` condition holds, then the reproduction command. Build, typecheck and lint are skipped at
   this stop.
2. The test failed for a reason that counts (section 4): the router stores the test files' fingerprints
   and the result, and blocks the stop with
   `[do-it-all-claude-code] reproduction confirmed for subtask A: <file> fails on the unfixed code (1 failed). Now make the fix. Do not change this test file again; put further tests in another file.`
   This block is not a failure: `failCount` stays 0.
3. The test passed, did not run, or failed for a reason that does not count: one block that says which, and
   asks for a test that fails for the reported reason, or `Repro: none (cannot-reproduce)`. A second such
   stop ends the attempt to reproduce: the subtask continues as **unconfirmed**.
4. Final stop. The reproduction command runs **first**. If it fails, the rest of verify is skipped and the
   stop is handled as a verify failure. If it passes, the files' fingerprints are compared with the stored
   ones, then verify runs as today.

One thing in today's code has to change for this: the single fix round is given only when
`stop_hook_active` is not set, and after a reproduction block it always is. The fix round must be decided
from the ledger (`failCount`), which already bounds it. *To verify:* that Claude Code puts no limit of its
own on consecutive stop blocks of one subagent. (This belongs to the two stops, which were not built: the
built form blocks a stop once, as verify does.)

**C as the fallback.** Models that practise test-first usually write the test, run it, see it fail and go
straight on to the fix without ending the turn. When the first stop already holds non-test changes, the
router reads the transcript, as it already does for edited paths: a Bash call whose command is a targeted
run of a reported file, whose result shows a failure that counts, placed before the first edit of a
non-test file, with no edit of the test file after it. That is recorded as **confirmed (worker-run)**,
shown apart from a router-run confirmation. If there is no such call, the reproduction is unconfirmed.
A and B are not used as further fallbacks in the first version; the share of unconfirmed subtasks under
`observe` says whether one is needed.

**Paths.** Commands run in bash with the work tree as the working directory (decision 98), and the router
passes repo-relative paths with forward slashes, so drive letters, spaces and non-ASCII folder names above
the repository never enter the command line. Names inside the repository are single-quoted.

**A daemon restart between the two stops** loses nothing: the confirmation and fingerprints are in the
ledger. (The forwarded verify variables of decision 142 are lost, as they are today.)

## 4. Keeping it honest

**The main rule is identity.** The test that passes after the fix must be byte-identical to the one that
was seen failing. A test that failed because of its own syntax error cannot pass unchanged; a test that
failed because a module was missing passes unchanged only if the fix adds that module, which is what a new
behavior is. Most of what follows is a second line behind this rule.

**Which failures count.**

| Runner | Fails in the test body | Does not count | Can they be told apart |
|---|---|---|---|
| pytest | exit 1, `N failed`, no `error` in the summary | exit 2 (collection error), `N error`, exit 5 (no tests) | yes, from exit code and summary |
| jest | `Tests: N failed` | `Test suite failed to run`, `Tests: 0 total` | yes |
| vitest | `Tests N failed` | `Failed Suites`, a failed import | yes (*to verify* on the current reporter) |
| go test | `--- FAIL: Name` | `[build failed]`, `no tests to run` | yes |
| cargo test | `test name ... FAILED`, `test result: FAILED` | `error: could not compile` | yes |
| node --test | `fail N` with `ERR_ASSERTION` or an error thrown in a test | a file that fails to load is also reported as one failed test (`ERR_MODULE_NOT_FOUND`, `SyntaxError`) | yes, from the error code: checked on Node 24, where a missing module and a syntax error read as a load failure and an assertion or a thrown error as a failure in the body |
| mocha | `N failing` | a crash before any test (no summary) | mostly |
| unrecognized (`npm test -- file`) | exit code only | | no |

- An exception raised in the test body counts, not only a failed assertion: "it throws" is a common bug
  report.
- For new behavior, a load failure counts only when the missing name is inside the subtask's scope. For a
  bug fix it does not count.
- A zero-test run never counts (the existing `zeroTestsRan` rule), before or after.
- When the runner is not recognized, the failure is recorded as **kind unknown**. Recommended: accept it
  with the identity rule, label it, and never count it as an easy pass.
- With a name, exactly the named test must fail before and pass after. Without one, the file must have at
  least one failure before and none after; failures that were already in the file must then be gone too,
  which is strict but cannot be satisfied by pointing at a file that was already red.

**The test is changed after it was seen failing.** A weakened test and a corrected one look the same to
the router. At the final stop a differing fingerprint gives one block ("the test changed after it was seen
failing; restore it, or say why in Remaining issues"). If it still differs, the reproduction is
**unconfirmed (test changed)** with the count of changed lines; it is not a verify failure, and the lead
and the reviewer are told. The role text asks the coder to leave the confirmed file alone and add further
cases elsewhere.

**The test is deleted.** The file must exist and be among the subagent's changes at the final stop. If it
is gone the command finds no tests, which is a failure: one fix round, then a miss.

**The test passes for a reason unrelated to the request** (for example it asserts a constant the fix
adds). The router cannot judge relevance. The notification to the lead names the test and its before and
after results, and a reviewer subtask gets the same line with the instruction to reject (`wrong_behavior`)
when the test does not express the request. At L1, with no reviewer, this stays open.

**Verify inputs.** A reproduction that needs a change to the runner's configuration or to `package.json`
scripts is held, as any verify is (decision 91). A new `conftest.py` is treated the same way.

## 5. No test setup, and requests that cannot be reproduced by a test

- **No test setup**: no `repro` template's condition holds at the start commit. The router knows this at
  dispatch, sets the subtask to off (`no-tests`) itself, and the role text's request is not added. The
  coder is not asked to introduce a test framework; that is a change to verify inputs and a decision for
  the user.
- **Not testable in this way** (layout and styling, performance, timing, behavior that needs a service or
  a device): the lead writes `[repro: off not-testable]`, or the coder reports `Repro: none
  (not-testable)`. `ui-designer` subtasks are off by default.
- **Cannot reproduce**: the coder tried and the test passes on the unfixed code. The subtask continues, the
  result is unconfirmed, and the lead's notification says so in words it can pass on to the user: the
  reported problem was not seen, so the fix is not shown to address it.

In all three cases verify runs as it does today. The record keeps the reason, so the team office can show
how much of the work was covered.

## 6. Step-up

| What happened | Counts as | Effect |
|---|---|---|
| Test failed before, passes after, unchanged | pass | `reproduced`; may be an easy pass under the existing rule |
| Test still fails after the fix | **verify failure** (signal kind `repro`) | first time: block and one fix round; second: miss and step-up, exactly as a failed test today |
| Test missing at the final stop | verify failure | same |
| Could not be seen failing (two tries), `Repro: none`, test changed, kind unknown, not checked | not a failure | pass with `unconfirmed`; **never an easy pass**, so it cannot lead to a step-down; the lead is told and may call `router_request_escalation` with the existing reason `verify_gap` |
| Reproduction off, with a reason | nothing | as today |

The rule for a raise stays two failed stops in a row. Reproduction does not raise a slot faster; it makes
a wrong fix fail where it used to pass.

**A lead that stops after a failure (django).** Two changes, built ahead of reproduction and independent
of it (`daemon/src/router.ts`, tests in `daemon/test/lead-stop.test.ts`):

1. The result of a failed subtask used to end with "Decide: dispatch a new attempt with what failed, or
   report to the user." While the slot was raised and the budget is not used up, it now ends with
   "Dispatch subtask A again now with these values, and include what failed in its prompt. Do not report
   to the user before that attempt has finished." The old sentence stays when the slot was not raised or
   the budget is spent; a subtask with no raise left goes to the user as before.
2. The lead's `Stop` hook, which never blocked before, blocks **once per request** when all of these hold:
   - a coder subtask is `failed`, and its slot was raised or can still be raised;
   - it is the latest subtask on its slot, so no newer attempt was dispatched, under the same tag or
     another;
   - no subtask of the request is still pending or running (the lead gets another turn when one ends);
   - the budget is not used up;
   - the last message does not carry `[router:awaiting-user]`, and the request is not already waiting for
     the user.

   The reason names the subtask, the step, and the model and effort to use. A `Stop` that follows a block
   (`stop_hook_active`) is never blocked, and the count is kept in the ledger (`requests.stop_blocks`,
   schema v16), so a daemon restart does not allow a second one.

**To verify with a real session.** The tests cover the router's decision and the hook output
(`{"decision":"block","reason":…}`). They cannot show that Claude Code hands the reason of a blocked `Stop`
to the lead as something to act on. To check:

1. Start the daemon and a session with the plugin in a small repository whose verify command always fails
   (a `.do-it-all-claude-code/verify.json` with `{"coder": ["node -e \"process.exit(1)\""]}`, committed
   before the session starts).
2. Give a request that is delegated, and let the coder miss (two failed stops).
3. Watch the lead's turn after the task notification. Expected, in order: its first attempt to end the
   turn is blocked; the transcript shows the reason text as the next input to the lead; the lead calls
   the Agent tool again with the raised model and effort, or asks the user with the marker.
4. In the ledger: `SELECT stop_blocks, status FROM requests` gives `1` and an open request while the new
   attempt runs; the daemon log has "lead stop blocked".

If the lead ignores the reason and stops again, the second `Stop` passes (by design), and the request
closes as it did before this change. That outcome would mean the wording, not the mechanism, needs work.

## 7. Time (decision 174)

What is added to a subtask, with estimates only (none of this is measured):

| Step | Added time |
|---|---|
| Writing the test, when the coder would not have written one | 1 to 3 model turns, about 5 to 15 s on the first ladder step |
| First stop: hook round trip and the targeted run | `node --test` on one file under 1 s; vitest 1 to 3 s; jest 3 to 8 s; pytest 2 to 10 s in a large project (imports and `conftest.py`); `go test` 2 to 20 s; `cargo test` 10 s to over a minute cold |
| Continuing after the block | one model request on a cached context, about 2 to 4 s |
| Final stop: the targeted run again | the same run once more |

For a small L1 fix in a Node project that is about **10 to 25 s on top of the 57 s measured for an L1
team run** (decision 123, finding 2); in a large Python project 15 to 40 s. Rust is the outlier.

How the design keeps it down:

- Only the named test runs for the reproduction, never the suite; build, typecheck and lint are skipped at
  the first stop.
- The install step is not added, only moved earlier: it runs once, at whichever stop needs it first.
- The reproduction has its own limit, 60 s per run, outside verify's 240 s. A timeout is "not checked",
  not a failure.
- The role text tells the coder not to run the test itself before the first stop, since the router does.
- At the final stop the reproduction runs first, and a failure skips the rest of verify, so a wrong fix is
  answered sooner than today.
- Under `observe` the first stop is not blocked for a second try, so the cost there is one targeted run.

The `PostToolUse` variant that was built removes the rows "first stop" and "continuing after the block":
the targeted run happens inside the hook of the file write, and the coder goes on in the same turn. What
it adds instead is a git status and the run itself, once per save of a test file while only tests have
changed. These estimates are to be replaced by measured numbers (decision 174).

## 8. What changes, and where

| Area | Change |
|---|---|
| Brief and lead skill (`core/triage.ts`, `skills/lead-orchestrator/SKILL.md`) | the third tag line and its reasons; put the test folder in a coder's scope; what `reproduced` and `unconfirmed` in a notification mean; dispatch again after a miss instead of stopping |
| `agents/coder.md` | order of work (test first, end the turn, then fix), the `Repro:` line in the report format, leave the confirmed test alone; the `x-router.repro` templates |
| `agents/reviewer.md`, `agents/tester.md` | given the test and its results; reject when the test does not express the request |
| Role floor and settings editing (`core/roles.ts`, `role-overrides.ts`) | `x-router.repro` accepted and validated like `verify` (it is a command that runs as the user: same notice in the CLI) |
| `.do-it-all-claude-code/verify.json` | optional `repro` list, read at the start commit; `ifDependency` condition |
| `daemon/policy.ts`, `payload.ts` | parse and strip the `[repro: …]` line |
| `daemon/review.ts` | `Repro:` line parser |
| `daemon/verify.ts`, `verify-source.ts`, `shell.ts` | reproduction plan, placeholders, failure classification per runner |
| `daemon/router.ts` | the first-stop path, the fix round decided from `failCount`, notification texts, the easy-pass rule, the lead `Stop` block |
| `daemon/transcript.ts` | the worker-run evidence reader |
| MCP tools (`mcp/tools.json`, `core/tools.ts`) | no new tool and no new input. `router_get_plan` output gains each subtask's reproduction mode and state; `router_request_escalation`'s description names `verify_gap` for an unconfirmed reproduction |
| Ledger | signal kind `repro`, two rows per check (`before`, `after`) with exit code, duration and counts as today; subtask columns for mode, reason, state, files and fingerprints; added with `ALTER TABLE` like earlier columns. Only paths, names and numbers are stored; output tails follow `recordPrompts` as today |
| Config (`daemon/config.ts`, settings schema) | `reproduceFirst`: `on`, `observe`, `off` |
| Guard (`hooks/guard.mjs`, core mirror) | the allowlist additions of section 2 |
| Team office (History tab; the browser dashboard was removed, decision 183) | timeline: a reproduction mark beside the verify mark (reproduced, worker-run, unconfirmed, failed, off); request detail: the two signals and the reason; overview: share of bug and feature subtasks reproduced, and the off rate by reason; four languages |
| Docs | `worker-permissions.md` (targeted rules), README, release notes |

## 9. Test plan without the API

**Unit.**

- `Repro:` parser: several lines, markdown around the words, an echoed instruction, paths with
  backslashes, `/c/` spelling, spaces and non-ASCII names, a path outside the tree or scope, a name with
  quotes or `$(…)`.
- Command building: every template and placeholder, a file that starts with `-`, regex characters in a
  name.
- Failure classification from stored runner output. Fixtures are text captured once from small projects
  for each runner and case: assertion failure, exception in the body, missing import, syntax error, no
  tests, a failure that was already there. `node --test` cases also run live, since they need no
  dependency; pytest cases run live where Python is present and are skipped elsewhere.

**Router, with temp repositories and the existing event-driven tests** (no model; the verify shell and
command source are already replaceable there):

1. Only the test at the first stop, it fails: block text, `failCount` 0; fix at the second stop: pass,
   `reproduced`.
2. The test passes on the unfixed code twice: `unconfirmed`, subtask still passes verify, not easy.
3. Fix and test together, no evidence in the transcript: `unconfirmed`.
4. The same with a transcript fixture showing the failing run before the first edit: worker-run.
5. Test edited after confirmation: one block, then `unconfirmed (test changed)`.
6. Test deleted, and test still failing after the fix: block, then miss, and the slot is raised as for a
   verify miss.
7. A verify failure after a reproduction block still gets its fix round (`stop_hook_active` set).
8. `off` with each reason, `observe`, and the global `off`.
9. No template matches: off (`no-tests`) at dispatch.
10. A daemon restart between the two stops.
11. A worktree writer (install step at the first stop) and a lone writer in a tree with the user's
    uncommitted changes.
12. The lead `Stop` block: once, not with the marker, not without budget, not when no raise is left.

**End to end without a model.** Recorded hook inputs for one subtask (start, tool calls, two stops) are
replayed through the hook relay into a daemon on a temp home, on Windows, Linux and macOS, to cover the
block round trip, the 300 s stop limit and path spellings.

**What only a model run can show**, and so needs approval and budget:

- Whether coders on the first ladder steps follow the order and write the `Repro:` line. Under `observe`
  this is read from the ledger of ordinary use.
- Whether results improve. The smallest useful run is the five public tasks of the decision 123
  measurement plus the five custom L1 tasks, team arrangement, with and without reproduction: pass rate,
  step-ups, and time. That arm cost about $2 there.

## Decided

1. **Modes.** All three of `on`, `observe` and `off` are built. The wider public-task measurement runs with
   `on`. The default for 0.5.0 follows its result: `on` if the pass rate rises and the added time is
   small, otherwise `observe`.
2. **`edit` requests** default to required when the scope holds source files.
3. **A tester that writes the test before the coder at L3** waits for the measurement.
4. **The lead `Stop` block and the changed wording after a miss** go in ahead of reproduction, on their
   own (section 6).
5. **A failure of unknown kind** is accepted when the test is unchanged and passes after the change. It is
   labelled "kind unknown" and is never an easy pass.
6. **The `PostToolUse` variant** was tried first with a short real run and works (results under "As
   built"), so it is the mechanism; the two-stop path is not built (decision 179).
7. **A run that passes its time limit** is "not checked", not a failure.

## Open points

1. The default of `reproduceFirst` for the release, after the measurement with `on`. Until then: `off`.
2. The time estimates of section 7 are to be redone against the per-stage timing measurement of decision
   174 once it is in.
3. Whether `SubagentStart` context reaches the subagent, and whether first-step coders follow the order
   (both need a model run).
4. The parts listed as not built yet under "As built".
