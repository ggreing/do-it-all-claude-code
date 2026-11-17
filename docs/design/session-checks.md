# Checks that need a real Claude Code session

The design notes for the team office ([team-office.md](team-office.md)) and for reproduce first
([reproduce-first.md](reproduce-first.md)) mark some points *to verify*: assumptions about Claude Code that
the tests cannot show, because the tests run without a model and without the engine. This page puts those
points in the order to check them in, so that one sitting covers them with as few sessions and model requests
as possible.

The order is by cost and by what depends on what:

1. Part A needs a terminal only.
2. Part B needs a session and almost no model use. A failure here changes how the office is packaged, so it
   comes before the parts that use the office to read results.
3. Part C is one delegated request with reproduce first on. It answers the most points per request.
4. Part D is one delegated request whose verify always fails.
5. Part E is optional: slow or disruptive checks that nothing else waits for.
6. Part F is the 0.5.0 tabs and the profile (decisions 193, 194). Its first two checks need no model and can
   be done with part B; the rest read what parts C and D left in the ledger.
7. Part G is the project question and writers that share a checkout (decision 192): two delegated requests in a
   repository the router has not seen.

Write down for each check: passed, failed, or not checked, and what was seen. A check that fails names the
fallback the notes already hold.

## Before starting

- Claude Code 2.1.325 or newer (`claude --version`), the router installed (`do-it-all-claude-code init`),
  `do-it-all-claude-code doctor` without a blocking line, the daemon running.
- Note the Claude Code version, the operating system and the terminal's width in columns. The office opens by
  itself only from 144 columns.
- `<home>` below is the router home (`~/.do-it-all-claude-code` unless `DO_IT_ALL_CLAUDE_CODE_HOME` says
  otherwise). The daemon's log is under `<home>/logs`.
- Two scratch repositories, both committed before a session starts in them:
  - **R1, a small Node project with a real bug.** `package.json` with `"type": "module"`, a source file with a
    wrong function (for example a `slugify` that drops accented letters instead of turning them into ASCII), and
    one passing test under `test/` run by `node --test`. No dependencies, so no install step is due.
  - **R2, any small project whose verify always fails**: add `.do-it-all-claude-code/verify.json` with
    `{"coder": ["node -e \"process.exit(1)\""]}`.
- To make sure a request is delegated: `do-it-all-claude-code config set forceLevel L2` before parts C and D,
  and `config set forceLevel default` after them.

## Part A. Terminal only

**A1. What `claude plugin validate` returns** (team office, section 2). `doctor` is to gain a non-blocking
"team office: loads" line from it.

1. `claude plugin validate <home>/plugin`, then print the exit code.
2. Copy the plugin folder somewhere else, put a syntax error in the copy's `office/register.tsx`, and run
   validate on the copy.
3. See whether validate has a machine-readable output (`--help`), and what it holds in both cases.

Expected: exit 0 for the good folder, not 0 for the broken copy, and a report that names the first problem.
If the exit code does not tell the two apart, the `doctor` line has to read the report's text, or is left out.

**Not session checks**, listed here because the notes mark them:

- How the current vitest reporter words a failed import against a failed test (reproduce first, section 4).
  It needs a project that has vitest installed; run one failing test file of each kind and compare the output
  with what `classifyRun` expects. Until then a vitest failure the router cannot read is "kind unknown", which
  is accepted and labelled.
- `node --test` was checked on Node 24: a missing module and a syntax error are reported as one failed test
  with `ERR_MODULE_NOT_FOUND` or `SyntaxError` and are read as a load failure; a failed assertion and an error
  thrown in a test are read as a failure in the test body.
- The limit on consecutive stop blocks of one subagent (reproduce first, section 3) belongs to the two-stop
  form, which was not built. The built form blocks a stop once, as verify does today.

## Part B. A session, almost no model use

Start Claude Code in any folder. B1 to B3 send no prompt.

**B1. The office loads and draws.** `/office demo`.

Expected: the pane opens with four members at desks; a click or 1–9 picks one and its rows show below; `o`,
`h`, `c`, `r` switch tabs; `/office clear` empties it. If the pane is not drawn, the command's answer says why.

**B2. The helper reaches the daemon** (team office, decision 3; it replaces the two transport points of
section 3, which were about `$.http.fetch`). With the pane open:

1. The History and Cost tabs show the daemon's numbers (or say there are none yet), not the "not reachable"
   line.
2. `do-it-all-claude-code stop` in another terminal: within a few seconds the office's top line says
   "router daemon not reachable — run do-it-all-claude-code start". The demo keeps drawing.
3. `do-it-all-claude-code start`: the line goes away within about 30 s (the helper backs off while the
   daemon is down), without reopening the pane.

Expected as written. If the tabs never get data while `do-it-all-claude-code status` works, the helper could
not start: check that `node` is on the PATH of the process that started Claude Code.

**B3. The helper ends with the pane.** Close the pane, then look for a `node` process running
`office/bridge.mjs` (Task Manager's command line column, or `ps`). Open the pane again, end the session, look
again.

Expected: none left after about 5 s, both times (the helper also ends by itself when its parent is gone or
its output is closed). A leftover process is a defect to fix before release.

**B4. A module that fails to load leaves the command hooks working** (team office, section 1). This is the
assumption behind shipping the office in the same plugin.

1. Put a syntax error at the top of `<home>/plugin/office/register.tsx`.
2. Start a new session (or `/reload-plugins`) and send one short prompt, such as "say hi".
3. Look at the status line and at `do-it-all-claude-code status`.
4. Put the file back: `do-it-all-claude-code reload` writes the effective plugin again. Start a new session
   and see with `/office demo` that the office is back.

Expected: the prompt is answered, and the status line and `status` show the router's level for it, as in any
session: the relay's hooks ran. The office is absent in that session. If the hooks did not run, the office
becomes a plugin of its own (`do-it-all-office`), as the note says.

## Part C. One delegated request, reproduce first on

In R1: `do-it-all-claude-code config set reproduceFirst on`, `config set forceLevel L2`, then a session on a
wide terminal. Ask for the bug fix in words that name the wrong and the right result, and add: "Ask the coder
to begin its report by quoting the first line of any note the router gave it when it started."

One request answers C1 to C6. Keep the pane open and pick the coder.

**C1. The office opens by itself at the first worker** (team office, decision 9), on a terminal of 144 columns
or more. On a narrower one it does not, and `/office` opens it.

**C2. The office's agent id is the daemon's** (team office, section 3).

1. In the transcript, the Agent call's result names the agent's id (open the result if it is folded).
2. `<home>/agents/` holds one file per agent the daemon knows, named by the `agent_id` of the hooks.
3. In the office, pick the coder and press `v`: the main view shows that coder's transcript.

Expected: the same id in 1 and 2, and the right transcript in 3. The panel never prints the id it holds; `v`
opens the transcript of exactly that id, which makes 3 the most direct check. The office joins a member to its
subtask by id and, failing that, by the subtask tag, so the header looks right either way; this check says
which one it was. If the ids differ, the join stays on the tag and the note says so.

**C3. The header shows the plan against what ran** (team office, section 3). The picked coder's second line
reads like `s1 (Haiku low)`, and adds `ran at …` in the warning color only when the desk's model or effort
differs from the plan. Compare the desk's model and effort with what the Agent call asked for.

**C4. The start note reaches the coder** (reproduce first, "As built" and open point 3). The coder's report
begins with "[do-it-all-claude-code] This subtask needs a reproduction first." or says it was given no note.

If it was given none: the role text alone does not start the order (it says "if the router tells you when you
start"), so the note has to travel another way, for example in the lead's prompt for the subtask. Decide that
before the measurement with `on`.

**C5. A coder on the first step follows the order** (reproduce first, open point 3). In the coder's rows:

1. the first file written is a test;
2. the next rows are the change, not another run of the test by hand;
3. the test file is not written again after the change began.

In the daemon's log: one `reproduction run` line with `result: failed` before the change, and one
`reproduction at stop` line with `state: reproduced`.

**C6. The lead is told.** The picked coder's second line ends with `repro reproduced`, and the lead's summary
or the task result it was given says "Reproduction: <file> failed before the change and passes after it,
unchanged."

If C5 ends as `unconfirmed` instead, note the reason in the log line (`changed-first` means the coder changed
the source before a test was seen failing; `no-test` means it wrote none). That is a result about the wording
of the note and the role text, not about the mechanism.

Afterwards: `config set reproduceFirst default`.

## Part D. One delegated request whose verify always fails

In R2, with `reproduceFirst` off and `forceLevel L2`. This is the check of reproduce first, section 6: that
Claude Code hands the reason of a blocked `Stop` to the lead as something to act on.

1. Give a small change request and let the coder miss (two failed stops; the first is blocked for a fix
   round).
2. Watch the lead's turn after the task result.

Expected, in order: the lead's first attempt to end its turn is blocked; the reason text is the lead's next
input; the lead calls the Agent tool again with the raised model and effort, or asks the user. The daemon's log
has "lead stop blocked", once. In the office the new attempt takes a desk.

If the lead stops again without acting, the second stop passes by design and the request closes as before the
change. That means the wording of the reason needs work, not the mechanism.

Afterwards: `config set forceLevel default`.

## Part E. Optional

**E1. A reproduction run that reaches its limit** (reproduce first, "As built", item 3). In R1 with
`reproduceFirst on`, ask for a fix whose test must wait, for example "the test has to sleep 70 seconds before
it asserts". The run is cut at 60 s; the hook's own limit is 100 s.

Expected: about a minute after the test is saved the coder is told the router could not run it and goes on;
the result is unconfirmed (`not-checked`), and the coder's turn is not cut off.

**E2. A stream hook that fails in the middle** (team office, section 7). In a session whose answer may be
lost: in `<home>/plugin/office/register.tsx` (the effective copy, not the template in the repository),
replace the `turn.step` hook with one that passes three chunks on and then throws:

```tsx
on('turn.step', async function* ($, e, next) {
  const inner = next(e)
  let n = 0
  for (;;) {
    const r = await inner.next()
    if (r.done) return r.value
    yield r.value
    if (++n === 3) throw new Error('office check: turn.step fails mid-stream')
  }
})
```

Start a new session, send a prompt that gets a longer answer (a short one may end before the third chunk),
and see whether the answer completes. Put the file back with `do-it-all-claude-code reload`.

Expected by the interface's own description: the stream below is left where it stood, and the answer
completes. Whatever is seen, the hook's body stays one guarded write followed by passing the stream on; the
result only says how bad a mistake there would be.

**E3. Ten members.** The note's performance point: a request with many workers, or a preview extended to ten
members, with the pane open. If typing in the prompt lags, the scene's tick goes from 100 ms to 200 ms and
stops while no member works.

**E4. The desktop app.** A plugin installed at user scope also draws there: open a local session in the
desktop app and run `/office demo`.

## Part F. The tabs and the profile (decisions 193, 194)

The tabs are Office, Work, Savings, Team and Settings (`o`, `w`, `s`, `t`, `c`); `p` steps the period in Savings
and Team. The routes behind them are tested without the engine; what a session shows is that the panel draws
them and that a write from the panel lands.

**F1. The Settings tab shows values with their source.** No model needed. Open `/office`, press `c`.

Expected: the profile reads `balanced` (default); every item shows a value and where it comes from; a budget
reads its default; nothing shows a path of this machine. With `do-it-all-claude-code config set budgetsUsd.L2 7`
in another terminal, the L2 budget reads 7 with "own" after the panel's next refresh.

**F2. A write from the panel, and the profile.** No model needed.

1. Move to the profile, press Enter until it reads `quality`, then `a` and `y`.
2. In another terminal: `do-it-all-claude-code config get profile` and `do-it-all-claude-code config history`.
3. In the panel, look at the L2 team, "Step down after easy results" and the L1 and L3 budgets.
4. Change one more value, then press `x`.
5. Change a value in the panel but do not apply; change any setting with the CLI; then press `a` and `y`.
6. Put the profile back to `balanced` the same way, and `config set budgetsUsd.L2 default`.

Expected: (2) `quality`, and the newest history line has source `office` and names `profile`; (3) the L2
coders start on `s2 (haiku high)` with source "profile", step-down reads off with source "profile", the L1 and
L3 budgets read 3 and 22.5 with "profile x 1.5", and the L2 budget still reads 7, "own"; (4) nothing is
written and no history line appears; (5) the panel says the settings changed since it read them and writes
nothing, and after its refresh the apply works.

If (2) shows source `cli` instead of `office`, the helper's write is going through the CLI's route; if (5)
overwrites the CLI's change, the revision is not being sent.

**F3. Work, while a request runs and after.** During part C or D keep the Work tab open.

Expected while it runs: the request is the top line, marked as running, with its level and, once the coder
has stopped, the files it changed with `+`/`−` line counts. After it closed: it moves below, with passed or
failed; opening it shows the judged and final level, each subtask with role, model and effort, its scope and
changed files, each check with passed and failed counts and its time, the reproduction state (part C), the
step change with its reason (part D: `s1 → s2, miss`), and the time split into lead, workers, verify and
waiting. No prompt text anywhere, also with `recordPrompts` on.

**F4. Savings keeps measured and estimated apart.** After parts C and D, press `s`, and `p` for each period.

Expected: the first block is what was spent, labelled as an API-equivalent estimate on a subscription or as
billed in API-key mode, with the 5-hour and 7-day limits as the status line shows them. The estimate "at the
lead's price" stands apart with its four assumption lines and says how many requests it left out; the holdout
comparison says how many requests are still missing instead of a difference. No single "saved" number is
shown. The bars match the days (or hours) the requests of parts C and D ran in.

**F5. Team.** Press `t`.

Expected: each role with its model and effort per level and the source (after F2 step 6: "default"); the
coder's line counts the subtasks of parts C and D with a pass rate, and one step-up; the recent step changes
list part D's raise with its reason; the triage numbers and the auto-release table are at the bottom.

## Part G. The project question, and writers that share a checkout (decision 192)

Use a third scratch repository, **R3**, that no session has run in: a small Node project with two unrelated
source files (for example `src/a.js` and `src/b.js`, each with its own test file), committed. Set
`forceLevel L2`.

**G1. The first delegation asks once, and "no" is remembered.**

1. In R3, give a request that needs both files changed in unrelated ways, and say that the two parts are
   independent.
2. When the lead asks whether to turn on isolation for this project, answer no.
3. `do-it-all-claude-code project status` in R3.
4. After the request, give a second small request in the same repository.

Expected: (1) before it dispatches anyone, the lead asks one question about work trees for parallel writers
and waits for the answer; (2) the work goes on in the checkout; (3) the status
says it was asked and what was decided; (4) the lead does not ask again. The Office tab's top line reads
"Isolation off: overlapping edits take turns" for this project.

If the lead never asks, look at `<home>/projects/`: a file there with `askedAt` means the note was given and
the lead ignored it, which is a wording problem; no file means the note was not added.

**G2. Two writers in one checkout: the first to finish is not verified on its own.** In the request of G1,
with isolation off, the lead should send two coders at the same time, one per file.

Expected, in the Work tab's detail and the Office: the coder that stops first shows `scope ok` only and reads
as waiting for the tree's verify, not as failed and not as passed; when the second coder stops, the build
and tests run once, and both read passed. The daemon's log has "verify held: other writers still change the
same work tree" once and "held subtask passed with the last writer of its work tree" once. Neither coder's
slot is raised.

If the lead sends the coders one after the other instead, nothing is held (each is verified alone); repeat
with a request that names the two parts as parallel. If the first coder is failed for a test that the second
coder's half-made change broke, the hold did not apply: note whether the two ran in the checkout or in work
trees of their own (the Agent results name a branch for a work tree).

**G3. A failure of the last writer names the other.** Optional. As G2, with a verify that fails (R2's
`verify.json` in R3).

Expected: the first coder is held; the second coder's failure, after its one fix round, is reported to the
lead with "also saw the changes of subtask A (…), which were not verified on their own"; the step-up is the
second coder's.

**G4. "Yes" turns isolation on.** In a fourth repository the router has not seen: answer yes at the question
and run `do-it-all-claude-code project enable` as the lead says.

Expected: the Office tab's line no longer says isolation is off; the settings view's "Work trees for parallel
writers" line reads on; with two parallel coders each Agent result names a branch to merge, and each coder
is verified when it stops.

Afterwards: `config set forceLevel default`.

## What each result decides

| Check | If it fails |
|---|---|
| A1 | `doctor`'s office line reads the report's text, or is left out |
| B2, B3 | a defect in the helper; fix before release |
| B4 | the office moves to a plugin of its own |
| C2 | members join subtasks by tag only |
| C4 | the start note is delivered another way before the measurement |
| C5, C6 | the note's and the role's wording; `observe` shows how often |
| D | the wording of the stop reason |
| E1 | the limits of the hook and the relay |
| E2 | nothing changes; it sizes the risk |
| F1, F3, F4, F5 | a defect in what the panel draws; the routes themselves are tested |
| F2 | the helper's write (source, revision); fix before release |
| G1 | the wording of the project note, or where it is added |
| G2, G3 | the hold for writers that share a checkout; fix before release |
| G4 | the `project enable` path and Claude Code's own work tree setting |
