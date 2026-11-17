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
