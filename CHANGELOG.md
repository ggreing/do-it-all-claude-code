# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Dates are in UTC.

## [Unreleased]

### Fixed

- **A worker left running when a session ends.** When a Claude Code session ended — quit, `/clear`, logout, or a
  killed or crashed `claude -p` run — while a worker it had dispatched was still running, Claude Code sent no
  SubagentStop, so the subtask stayed `running`, its request stayed open, and the worker's cost was never counted.
  The next session to start now reconciles the sessions that are gone: a subtask still running far longer than any
  worker and its checks could take is closed as cut off (verdict unverified), its request is closed, and the
  worker's cost is read from its transcript. Running `claude -p` headless? Raise
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` so the run waits for background workers to finish and report before it
  exits, rather than leaving them to be reconciled by a later session. See
  [docs/design/session-end-cleanup.md](docs/design/session-end-cleanup.md).
- **The lead's model on a session's first request.** Claude Code names the model to hooks only when an
  interactive session starts, and the router planned a first request without one as if the lead were unknown:
  an Opus lead then kept a small fix it should have delegated. Now a non-interactive run (`claude -p`) is read
  from `ANTHROPIC_MODEL` when that is set, and a session that started while the router was down gets its model
  when the router comes up. When two sources name different models, the one seen later counts, so the request
  right after `/model` is planned for the new model. A `claude -p --model …` run without the variable still
  starts as an unknown lead: Claude Code gives a hook nothing to read the flag from.
- **Tests that cannot start, when pytest stops at the first error.** Run with `-x`, pytest ends a collection
  error with exit 1, the code of a failed test, and the router counted it as a miss and moved the work up to a
  stronger model. It is now read as "the tests did not start" like the same error with exit 2: by its
  "ERROR collecting" header and a summary that counts errors and no test. A test that ran and failed, a test
  whose setup raised, and an import the worker broke are failures as before.
- **The bench and the end-to-end scripts no longer write your Claude Code settings.** `init --yes` installs the
  generated plugin with `claude plugin marketplace add`, and these scripts ran it for a temporary router home:
  since 0.5.0 each run left a `do-it-all-local` marketplace in your settings that pointed at a folder which was
  then deleted (Claude Code warns that it cannot load it). `init` now takes `--no-plugin`, which registers
  nothing, and the scripts pass it and give the router's CLI a config folder of the run. If you ran a bench or
  end-to-end script from a 0.5.0 or 0.5.1 checkout, look at `claude plugin marketplace list`: when
  `do-it-all-local` points at a temporary folder, remove both with
  `claude plugin uninstall do-it-all-claude-code@do-it-all-local` and
  `claude plugin marketplace remove do-it-all-local`.

### Changed

- **A coder runs only the tests of its change; the full checks stay the router's.** (decision 234.) Opus coders
  cost well over twice a plain Opus subagent on the same bugs, mostly in extra Bash turns: lint runs, whole-suite
  runs and repairs of a test setup that would not start. The coder now runs only the tests related to what it
  changed, once or twice, never the whole suite, a command over about two minutes or one in the background, and
  lint, format or type tools only when the project or the task names them. When the test runner does not start,
  it says so and finishes instead of installing packages or setting `PYTHONPATH`. The router still runs the
  build, typecheck, lint and tests when the coder finishes. A tester follows the same rules: the tests it wrote
  and those of the code its spec names. The lead's acceptance check names the behaviour the request asks for, not
  a test run; to point at a test it names one test file. The lead sends a tester only for tests the request asks
  for, no longer to run the checks. The guard now enforces these limits: a worker may not start a Bash command in
  the background or with a timeout over 180 s, and `timeout N …` (N ≤ 180 s) is allowed so a worker can bound its
  own run; interpreter runtime options and a repo script named without an extension (`python -W ignore -c …`,
  `python bin/test`) are allowed, and a pytest node id (`tests/x.py::test_y`) is no longer mistaken for a Windows
  stream; `pip install` is allowed only inside the project — an active virtualenv under the repo, or
  `--target`/`--prefix` inside it — never a global or user-site install. When a worker's turn ends without coming
  back to fix its one verify failure, the router finalizes the subtask with the result it already has instead of
  telling the lead "no verification result yet", so the lead does not re-run the long checks. And tests that did
  not start, by an error in no file the worker changed, are finalized and handed to the lead on the first stop —
  the worker is no longer bounced to attempt a fix that cannot make them start.
- **Support roles cost less, testers start cheap, and the lead takes fewer turns.** (decision 232, from the
  subscription validation.) Architect and reviewer now start at sonnet·medium at both routine and moderate (only
  hard goes to opus·xhigh); a tester starts at haiku·low whatever the request's difficulty, unless its own subtask
  is tagged hard (then sonnet·medium). The custom L1 lead had been doing 6–9 turns — Grep, router_report_triage,
  Agent, a `git diff`, router_report_result — each re-reading its whole context, which is where its cost is. So:
  when the checkability probe has settled by the time the brief is built, the brief now lists each role's
  subagent type and per-difficulty model and effort, and the lead dispatches without a router_report_triage round
  trip (a wrong call is still refused with the right values; router_report_triage stays for an L3 raise, a
  hard-direct report, or one the lead chooses to make). The router's result line for a finished subtask now names
  the files it changed (a short diff stat), so the lead need not run `git diff` to summarise; and on a pass with no
  reviewer or tester still to judge it, the line says no router_report_result is needed — the lead just answers. The
  one-time project-setup note is shorter. A request the router floors to hard now gets the Opus-worker budget
  headroom at open, so it survives the lead skipping the report.
- **Where a worker starts follows whether the router can CHECK its result, not the lead's difficulty.** The lead's
  up-front difficulty turned out to be almost always "moderate" and no signal, so the router now probes, once per
  repository and commit at the request's open and in the background (bounded, the repo's own test command run in a
  collect-only / list form), whether the verify tests actually start in this environment, and shows the result
  (`checkable`, `unchecked`, `no test command`, or still `checking`) in the office and `router_get_plan`. A
  source-changing coder then starts at Haiku·low on a checkable repo (Sonnet·medium when the task is hard) and goes
  straight to Opus·high on a repo whose tests do not run here (Sonnet·medium when routine); misses move it up the
  measured path as before. A tester, or any untagged subtask that changes no source (docs, changelog, config), now
  starts at the routine cell rather than the coder's; reviewer and architect keep the difficulty table. The
  unverified → one-stronger-attempt retry now fires only when the subtask started below Opus·high: a strong start
  that still cannot be verified goes back to the lead instead of spending a costlier model blind. Workers may now
  run reproduction commands the sandbox used to refuse — a `python -c` / `node -e` one-liner, a script inside the
  repository, and environment-variable prefixes before an otherwise allowed command (`PYTHONPATH=src python -m
  pytest`) — while network tools, writes outside the repository, destructive git and loader/`PATH` prefixes stay
  blocked. A worker report that names a real cause in a file outside its scope now counts as a scope request (even
  when it says "none needed"), and a retry re-dispatches the same subtask with the same scope, never a narrower one,
  the earlier attempt's changes left in the tree as a starting point rather than a diff to review.
- **The lead is a coordinator: it delegates at L1 and above, and tags each subtask's own difficulty.** Every lead
  model now delegates from L1 — only an L0 change (a typo, a one-line default) stays with the lead, and a user's
  `delegateFrom` (or a teams.yaml `lead_direct`) still keeps lower levels direct. On a level that is lead-direct, a
  change the lead reports (or the router floors) as **hard** is still handed to a one-coder team at the hard cell
  rather than kept, since that is where a stronger model pays. The old per-lead-model rules that
  let a Sonnet or Haiku lead keep small changes, and the "small change stays with the lead / a small hard change
  is delegated" bounds, are gone. The lead splits a request into subtasks and tags each Agent call with
  `[difficulty: routine|moderate|hard]` on a third header line (after `[subtask:…]` and `[scope:…]`): the router
  starts that subtask at the role × difficulty cell, so hard parts go to Opus/Fable, moderate to Sonnet and easy
  to Haiku, and independent coder subtasks of different difficulty run at the same time at different cells. A call
  with no tag uses the request's difficulty. A coder subtask whose scope can change source files (paths outside the
  test, doc, changelog and config patterns) may not be tagged below the request's difficulty, once that is set; a
  lower tag is corrected up to the floor, the same way a wrong model is. The request's difficulty is the higher of
  the lead's report and a router rule floor: the floor reads "hard" when the request shows a strong sign of a hard
  bug — a traceback, an unexpected error or crash, a regression, "sometimes", a race, or an order- or
  chunk-dependent symptom — and names no reproducing test (never for a typo-level L0 request). A moderate or hard
  subtask that comes back unverified (the checks could not run or did not start) now gets one more attempt on the
  next model up — s3/s4 → s5, or at s5 with Fable off the effort rises to s6 — once per slot and within budget,
  before it is handed back; a routine one is handed back as before. While that retry is pending the lead cannot
  close the subtask with `router_report_result` accept: the router answers with the retry's Agent-call values
  instead, so the stronger attempt runs first. The office and `router_get_plan` show each subtask's difficulty and
  where it came from (its tag, the request, or the coder floor), and the request's difficulty source (lead, router
  or default).
- **Difficulty, and a model × effort grid, decide where a worker starts.** The lead now reports a difficulty
  (routine, moderate or hard) with its size, and the router sets each role's start from a difficulty table, not
  from the level: a coder starts at Haiku·low when routine, Sonnet·medium when moderate (the default when the
  lead gives none) and Opus·high when hard, at any level; architect and reviewer one effort step richer (floor
  Sonnet·medium, Opus·xhigh when hard); the tester at the coder's cell; the ui-designer at Sonnet. So a big but
  routine change does not get Opus coders and a small hard one does. The fixed seven-step ladder became a grid of
  four models × five efforts (`s1`…`s7` stay as aliases of the seven measured/Phase-0 cells); the thirteen new
  cells carry **estimated** cost coefficients (list price × an effort multiplier read from Claude Code 2.1.326),
  marked estimated in the config, the office and `doctor`, to be measured in subscription mode. A slot steps UP in
  big, measured steps along the legacy cells (`s1`→`s2`→`s3`→`s4`→`s5`→`s6`, or `s5`→`s7` with Fable), so three
  raises carry a routine coder to `s4` and a moderate one to `s6`; it steps DOWN in fine grid steps, effort first
  within a model. A hard task that comes back unverified jumps the model once within budget before it returns to
  the lead. Decision 220's keep-it-with-the-lead bound now applies
  to routine and moderate only — a small *hard* change goes to a stronger worker (an Opus lead keeps it). The
  profiles shift the whole table one notch; a `teams.yaml` start or a role override still wins. Provisional, and
  the estimated cells especially: see [docs/design/difficulty-steps.md](docs/design/difficulty-steps.md).
- **The lead coordinates, and each subtask carries its own difficulty.** The brief and the lead-orchestrator skill
  keep the lead's first look to sizing and grading the request: it reads the request, makes at most a couple of
  quick searches, and does not trace the cause, read source in depth or draft the fix. Its prompt adds its
  first-look notes to the request the router already hands each worker. A bug report in code the lead has not
  traced counts as hard, and a floor the router sets wins when it is higher. The lead splits the request by
  difficulty as well as by file, and tags each Agent call with `[difficulty: routine|moderate|hard]` on the
  prompt's third line, so a hard fix runs on a strong model while the changelog and the checks run on a small
  one at the same time. A coder that changes source code is not tagged below the request's difficulty. An
  unverified result whose line names a retry is not accepted: the lead sends the subtask once more at that cell. The team office shows a difficulty the router raised, and each
  worker's own.
- **The router picks each worker's model, and the lead says where to look, not how to fix.** The brief no longer
  lists model and effort per role: the router sets them from the subtask's difficulty and from whether it can
  check the result in this repository, and the lead uses the values in its answer. The lead tags the hard parts;
  an untagged coder that changes source runs at the request's difficulty, other untagged work (tests, the
  changelog, the checks) as routine. The lead's notes name where to look and the behaviour to check, never the
  fix, and the lead no longer runs or writes checks of its own. A coder given a bug reproduces it, traces the
  cause and fixes it there, and names a cause outside its scope in a scope request instead of working around it.
  A retry is the same subtask, with the earlier attempt as a candidate. The team office shows whether the
  router can check the result ("checkable", "not checkable (no test command)").
- **Bench.** `scripts/measure107.ts` takes `--profile save|balanced|quality` for the router runs, and passes the
  lead's model to the router as a session's environment would. Every run may now use `echo`, `pwd` and `wc`
  without a prompt, as a user at the terminal allows; earlier runs refused them. New:
  `scripts/measure-session.ts` puts the six requests of a scenario (`bench/tasks/sessions/taskboard-01`) to one
  session, router on and off, and records each step's result and cost and how the lead's context grows. A
  resumed process reports the session's running total, so a step's cost is the difference from the step before.
- **Bench on a subscription.** `scripts/measure107.ts --subscription` runs on the login of the machine's Claude
  Code instead of an API key: no key helper, no credential variable and no config folder of the run reach the
  session, and the script reads no credential. A run that shows a key, or that reached a limit, leaves no record
  and stops the measurement; `/usage` is read before each run and none starts with a meter at 80% or more. Costs
  are then Claude Code's API-priced estimates, and each record says `subscription: true`. A router run keeps its
  transcript, which the router reads for the request and the costs, and one that left none stops the measurement
  the same way. Three tasks were added
  for it, `c-hs-01` to `c-hs-03` on a new fixture: a small change each that takes reasoning to get right, with
  wrong fixes kept beside them that the hidden tests must fail. They are loaded only when named.
- **Bench: a waiting lead no longer loses its worker after ten minutes.** In print mode (`claude -p`) Claude Code
  stops background tasks that are still running ten minutes after the last turn, ends the session as a success,
  and runs no SubagentStop hook for them. A measured run whose lead ended its turn to wait for a worker lost that
  worker in the middle of its work. `scripts/measure107.ts` and `scripts/measure-session.ts` now start every run
  with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`; the task's timeout and the cost cap end a run that hangs. A record
  lists the workers Claude Code stopped (`killedWorkers`) and keeps the end of the process's stderr
  (`stderrTail`). If you run the router under `claude -p` yourself, set that variable for work that takes longer.
- **Bench: a `subagent` arrangement.** `scripts/measure107.ts --arrangements subagent` runs plain Claude Code, no
  plugin and no router, with a fixed instruction before the task: hand the whole task, word for word, to one
  general-purpose subagent (`--subagent-model`, default opus, at `--subagent-effort`, default high) and do nothing
  else; `--lead` is the main session. It shows what a model does as a subagent of Claude Code with no router around
  it, next to the same model alone (`direct`) and under the router (`auto`). A record carries `subagent`: what the
  Agent call asked for, the models the subagent's messages ran on, what the main session did itself, and where the
  run was not that hand-off. The stream does not show the effort a subagent ran at, so the record has the value
  the call carried. Works with a key and with `--subscription`.
- **Parallel writers share the checkout.** When a change has independent parts, the lead now sends one coder
  for each part in one message, in the working tree, and the router runs the build and tests once, when the last
  of them stops. A subtask the architect's plan marks `after: none` is such a part. Before, the brief asked for a
  git worktree per writer and a merge, and in the fair re-measure the leads ran every planned pair one after
  another: a worktree starts from the last commit, so it lacks the architect's uncommitted plan. A worktree per
  writer is now only for a project with worktree isolation on, and only when no part needs an uncommitted file.
  This narrows decision 83: turning isolation on no longer means that every parallel writer gets a worktree.
  Details: [docs/design/team-speed.md](docs/design/team-speed.md).
- **A reviewer may have an empty `[scope: ]` line.** It writes nothing, so the router takes the empty line as
  that instead of refusing the call; a writer's empty line is still refused. In the re-measure a reviewer was
  refused for it in three of five delegated runs, and the lead wrote the whole brief again.
- **A reviewer's pass line no longer asks the lead to run tests.** It changed no file, so there is nothing to
  test; the lead had spent a turn running the coder's tests, which the router had already run.
- **Each worker gets the user's request from the router.** When a worker starts, the router reads the request
  from the lead's session transcript (the prompt that opened it and the user's answers to the lead's questions)
  and gives it to the worker, masked, so the lead writes only the subtask instead of copying the request into
  every prompt. In the re-measure that copying was most of the lead's first look on the larger tasks. The text is
  not stored: it reaches the worker and nothing else, not the ledger, the daemon's log, the team office or its
  tabs. When there is no transcript to read (`claude -p --no-session-persistence`), the first worker call of a
  request is refused once with a note to put the request in the prompt.
- **Workers may check a tool's version before their tests.** `node --version`, `node -v`, `npm --version`,
  `npm -v`, `python --version` and `python3 --version` are allowed exactly as written, with nothing after them;
  in the re-measure two workers' test runs were refused for a version check in front of them. The coder and
  tester roles also ask for one command per call from the folder they start in, without a `cd` in front, which
  avoids most of Claude Code's own approval questions.
- **A Sonnet lead keeps a change of up to two files.** After its first look, when the lead estimates the whole
  change at two files or fewer and about 60 changed lines or fewer, the router keeps it with the lead rather than
  a team; before, the bound was one file and about 15 lines (decision 178). An Opus lead keeps the one-file bound
  (its workers are cheap against its own calls), and a `delegateFrom` the user set for the lead's class still
  delegates these requests. The uncertain-team brief now tells the lead to take one quick look at the file it
  suspects before deciding, rather than not to explore. The bound was fitted on one run of the 20 public
  SWE-bench tasks — the four requests the lead delegated or took back there were all two files, and two cost far
  more than the lead alone — so treat the exact numbers as provisional.
- **The team office names each slot by its model and effort.** A worker's step now reads `Sonnet · medium (s3)`
  where it was `s3`, with the old name in parentheses for the seven cells that have one, and `est.` on a cell whose
  cost has not been measured yet (`Sonnet · xhigh est.`); a step change reads `Haiku low→high`. The difficulty the
  lead reported stands beside the level in the Office line, on each Work row and in a request's detail, which
  also says whether the lead gave it or the default applied. The Team tab gives each level's start cells from
  routine to hard. Narrow docks and small desks drop the parenthesis first and keep within their width; requests
  from before show no difficulty. A Work row in a dock 47 columns wide or narrower no longer runs past the frame:
  the kind of work, then the state's padding give way first, and the state is cut last.
- **The lead asks for the L3 team in its report.** With start cells set by difficulty, a first Agent call no
  longer shows whether the lead chose the L2 or the L3 team, so the brief no longer asks for an architect (or any
  role) as the first call. The lead reports level L3 in the `router_report_triage` call it makes before its first
  Agent call, and the answer gives the L3 team's call values; a first call the router can still read as L3 counts
  as before.

## [0.5.1] — 2026-11-18

### Fixed

- **The installed copy reports its version.** `setup` copied the engine into the router home without its
  `package.json`, so the daemon and the CLI that run from that copy reported version 0.0.0: in the status
  line and `doctor`, and, with the update check on, a note offering 0.5.0 to a machine already running it.
  The copy now includes `package.json`; run `npx do-it-all-claude-code@latest setup` again to refresh it.
- **Installing from the marketplace needs no SSH key.** The marketplace pointed the plugin at the repository
  in its short form, which Claude Code fetched over SSH; without a GitHub SSH key the plugin install failed.
  It is now fetched over HTTPS.

## [0.5.0] — 2026-11-18

### Added

- **The team office.** `/office` opens a panel inside the Claude Code terminal (it replaces the browser
  dashboard). The request's team sits at desks as small characters, and the member you pick has its session
  below. Click a member and it reacts in one of eleven ways (it nods, waves, hops, spins, hides behind the desk,
  peeks out from behind its monitor, and more); click again quickly for a bigger one. Five tabs: Office, Work,
  Savings, Team and Settings (keys `o w s t c`). When the pane is short the desks get smaller, then fall back to
  one row of characters and a line of names, and to a list only when there is no room at all. On Windows the
  classic console cannot draw the characters; `doctor` and the README point to Windows Terminal.
- **Profiles.** `do-it-all-claude-code config set profile save|balanced|quality` (or the team office's Settings
  tab) moves a set of values at once: where delegation starts, each level's team and its start steps, whether
  a slot steps down after easy results, and the per-request budgets (save 0.6 of the default, quality 1.5).
  `balanced` is the defaults as they were, so nothing changes until you pick another. A value you set yourself
  (`budgetsUsd`, `delegateFrom`, `stepDown`, a `teams.yaml`) stays above the profile. Only `balanced` has a
  measurement behind it; `save` and `quality` are not measured yet, and reproduce first is in no profile.
- **What the team office's tabs read.** The daemon now records what each subtask changed (the files, with
  added and removed lines) and every step change of a slot with its reason, and serves them, sealed like the
  rest of its API, for the Work, Savings, Team and Settings tabs. Savings keeps what was spent apart from two
  estimates: the workers' tokens at the lead model's list price (with its assumptions spelled out), and the
  comparison with requests the lead handled alone (with how many there are and how many are needed). A
  request's prompt is never in a panel answer; `data export` has it when `recordPrompts` is on. The ledger
  schema is now version 18.
- **Settings from the panel.** The Settings tab writes through the same validation and into the same settings
  history as the CLI (`config history` shows the source `office`). Keys that `init` and `mode` own are refused
  there too. New keys: `profile`, `officeAutoOpen`, `autoStart`; `reproduceFirst` can now be set with
  `config set`.
- **One-command install and auto-start.** `npx do-it-all-claude-code setup` (or `npm i -g do-it-all-claude-code`
  then `do-it-all-claude-code setup`) installs the plugin and a status line, copies the engine into your router
  home, and starts the daemon on your Claude subscription. Or, from inside Claude Code, add the marketplace,
  `/plugin install do-it-all-claude-code@do-it-all`, then run `/do-it-all-setup`. After setup the daemon starts
  itself when a Claude Code session starts (`autoStart`, on by default; `config set autoStart off` turns it
  off), launched detached with a minimal environment that does not inherit your credentials. `uninstall` undoes
  it, including the engine copy and auto-start. When the router is not reachable, a team worker is refused at the
  moment the lead tries to spawn it — rather than after it has started and spent tokens only to be blocked at its
  first write — with a message to make the change yourself or run `do-it-all-claude-code start`.
- **Project worktree isolation, asked when first used.** Whether a project runs subagents in parallel git
  worktrees is asked the first time the team is used there — the lead asks you once — instead of at install.
  `do-it-all-claude-code project enable|disable|status` sets or shows it; the choice is kept in the router home
  and nothing is written to the project until you enable. Declining keeps the team and coordinates edits on the
  shared checkout.

### Changed

- **License: Business Source License 1.1.** From this release the code is under BSL 1.1 (`BUSL-1.1`), not
  Apache-2.0. You can use it for free, including at work to build, test and run your own software. Offering it,
  or a product whose value comes mainly from it, to others for a fee (selling, licensing, hosting, a managed
  service) needs a commercial license. Each version turns into Apache-2.0 four years after its release. 0.4.0
  and earlier stay under Apache-2.0. See `LICENSE` and `NOTICE`.
- **Writers that share your checkout are verified together.** When two writers with separate scopes work in
  the same work tree and one finishes first, the router checks only its scope and holds the build and tests
  until the last of them stops: a test run in between would judge the other's half-made changes. A pass of
  that last verify covers the held writers; when it fails, the lead is told whose changes it also saw. A
  writer in a work tree of its own is verified as before.
- **A background worker's verify result reaches the lead.** In an interactive session Claude Code runs
  workers in the background: the worker's report arrives first, as a message of its own, and the notification
  that follows raises no hook while the lead's turn is running. The report was taken for a new request, and
  the verify result never arrived, so the lead ran the tests again. Now the report belongs to the request it
  came from, and the result line waits for the lead's next step, whichever it is: a prompt, an Agent or
  router tool call, its own Bash, Read or edit call, or the end of its turn (which then goes on once). It is
  told once. While the router is still checking, the lead is told to wait instead of running the checks. The
  waiting line is kept in `lead-notes/` in the router's home until it is read: the result line only, never a
  prompt or a report.

- **Small requests stay with the lead.** When the router cannot tell a request's size from its wording, it asks
  the lead to check first whether the change is in one file and about 15 changed lines or fewer. If so, the
  lead reports it (`router_report_triage` now takes a `lines` estimate) and makes the change itself; no worker
  starts. A level set with `/router level` is kept.
- **A Sonnet lead keeps what the wording shows to be a small fix.** A short bug-fix or option request, or a
  short one with a log, used to go to one Haiku coder. On 20 public tasks that cost more than the lead doing
  it and solved one task fewer: the lead works out the fix to brief the worker, so the hand-off saved nothing.
  Such a request is now the lead's, with a three-line brief, when the lead is a Sonnet model or its model is
  not known yet (a session's first prompt). An Opus lead delegates it as before, and so does a lead class you
  set `delegateFrom` for yourself. Requests of unclear size are not changed.
- **Tests that cannot start are not a miss.** When pytest ends before any test ran (an import that fails
  during collection, a plugin that does not load, a usage error) and the error is in no file the worker
  changed, the worker still gets its one fix attempt. If the tests then fail to start again, the slot is not
  raised: the subtask ends unverified, and the lead is told once to read the change and to say that the tests
  could not be run here. Before, each such end counted as a miss and moved the work up to a stronger model,
  step after step. An import the worker broke (the traceback names a file it changed) is a failure as before.
- **A shorter first brief.** What the lead reads for a delegated request says each rule once: about 28% fewer
  characters for a request of unclear size and 15% for a team request. The lead-orchestrator skill is no
  longer announced as mandatory for every request; its description asks for it only when a delegation needs
  what the brief leaves out (a verify block, a step change, parallel writers).
- **No second test run.** A worker's passed notification lists each check with its result and how many tests
  passed, and tells the lead not to run the test suite again. When verify ran no tests for the change (none
  configured, skipped, or 0 tests), the lead runs only the changed code's tests, once. Each kind of check is
  listed once, in the lead's line, the office and the Work tab: two commands of a kind (the install and the
  build script, `npm test` and pytest) are one entry. A package.json script that does not exist
  (`npm run build --if-present` in a project without a build script) is not run and reads "skipped", not "ok".
- **Independent parts run at the same time.** The lead and the architect split a larger change into writer
  subtasks with write scopes that share no file and send them together; the architect's report lists each
  subtask's scope and what must finish before it. The router refuses a second writer whose scope can name a
  file of a writer still running, and says how to send it instead (split the scopes, or after the other one
  finishes); writers sent one after another are never refused. A worker that ran in its own worktree is named
  with the branch to merge.

### Removed

- **The browser dashboard.** `do-it-all-claude-code dashboard` and the page the daemon served at `/dashboard`
  are gone, with the one-time code, the session cookie and the settings pages that belonged to them. What the
  page showed is in the team office inside Claude Code (`/office`: Office, Work, Savings, Team and Settings
  tabs).
  Settings are changed with the CLI (`config`, `preset`, `role`), as before.
  - For this release the command prints one line that names `/office`, and `/dashboard` on the daemon's port
    answers 410 with a line that says the same, so an old bookmark says what happened.
  - The numbers behind the page are still served, now as sealed routes like the rest of the daemon's API:
    `GET /router/v1/metrics/summary`, `/requests`, `/requests/<id>` and `/triage-report`, with the same
    parameters and answers. A `since` or `until` that is not a date is now refused (400).
  - From a checkout, the `npm run build:dashboard` step is gone and `npm ci` installs fewer packages (Vue and
    Vite are no longer dependencies).

## [0.4.0] — 2026-11-13

Fourth pre-release: an optional update check, and the end of two transitions from earlier releases.

### Update check (opt-in)

- The router can check for a newer release, off unless you turn it on. `do-it-all-claude-code init` asks
  (`[Y/n]`, Enter for yes; `--yes` turns it on, and with no terminal it is left unset); an existing install
  stays off until you turn it on, and `doctor` suggests it meanwhile. `do-it-all-claude-code update on|off|check`
  controls it later — `check` looks now whatever the setting and prints what you have against the newest
  release. When on, the daemon reads GitHub's public release list at most once a day (a failed try counts, so
  it does not retry in a loop), following your `HTTPS_PROXY`/`NO_PROXY` and skipping an unusable proxy rather
  than going around it. GitHub sees an ordinary web request (your IP address and a generic client name);
  nothing else is sent — no prompts, no usage, no identifiers. A newer version shows in the status line and
  as a one-line message at session start, to you only (never sent to the model) and at most once a day per
  version. There is no auto-update.

### Changed

- `bearerApi` is now **off by default**: the daemon's local API accepts only sealed messages. `bearerApi: on`
  still works this release for a client from before sealing, but it is **deprecated** — `doctor` warns and the
  daemon logs a line — and will be removed.
- The legacy `.agentic-router/` project folder is **no longer read**. `doctor` and `do-it-all-claude-code
  policy show` tell you to rename it to `.do-it-all-claude-code/`; once renamed, a policy you had already
  accepted counts again (acceptance is keyed by the repository and the file's content). Both names stay
  write-protected for workers.

### Upgrading

- If a project still has a `.agentic-router/` folder, rename it to `.do-it-all-claude-code/` — its contents
  are otherwise ignored now. An already-accepted policy is recognized again after the rename, with no need to
  accept it afresh.
- Upgrading straight from 0.2.0 or 0.3.0 to this release still migrates your home: run
  `do-it-all-claude-code init`, which moves an old install as described under 0.3.0.

## [0.3.0] — 2026-11-13

Third pre-release: the project is renamed. Nothing else changes in how it works.

### Renamed to Do It All Claude Code

- The project is now **Do It All Claude Code** (was Agentic Router Proxy). The CLI and the published
  package are `do-it-all-claude-code`, so the install name is the command; the internal packages are
  `@do-it-all-claude-code/{core,daemon,adapter-claude-code,proxy,dashboard}`, the proxy binary is
  `do-it-all-claude-code-proxy`, the router home is `~/.do-it-all-claude-code`, the per-project folder is
  `.do-it-all-claude-code/`, the environment variables start with `DO_IT_ALL_CLAUDE_CODE_`, and the agent
  types are `do-it-all-claude-code:coder` and the like. The repository is now
  `github.com/ggreing/do-it-all-claude-code` (GitHub redirects the old URL).
- A project that still has a `.agentic-router/` folder keeps working this release: each file in it
  (`policy.json`, `verify.json`, `teams.yaml`) is read when the new `.do-it-all-claude-code/` folder does
  not have that file, and the new folder wins where both do. `do-it-all-claude-code doctor` flags the old
  folder so you can rename it, and an accepted policy carries over the rename.

### Upgrading from 0.1.0 or 0.2.0

- Stop the old install with the **old** CLI first, from your current checkout:
  `node packages/cli/src/index.ts stop`.
- `git pull`, then `npm ci` and `npm run build:dashboard`. The remote is now `ggreing/do-it-all-claude-code`;
  GitHub redirects the old URL, and you can update your remote with
  `git remote set-url origin https://github.com/ggreing/do-it-all-claude-code`.
- Run `do-it-all-claude-code init`. When it finds an old install (the folder named by
  `AGENTIC_ROUTER_HOME`, or `~/.agentic-router`), it lists what it will change — including, by pid, the
  processes it will stop — and asks first. On yes it stops the old supervisor, daemon and proxy; moves the
  router home (ledger, tokens, the TLS certificate and bundle, config) to `~/.do-it-all-claude-code`; backs
  up Claude Code's settings (the backup is named in its report) and rewrites only its own entries there — its
  MCP tools, its agent types, rules for its own commands, the status line, the key helper, env values such as
  `NODE_EXTRA_CA_CERTS`, and paths under the old folder — leaving your other rules exactly as they are; and
  moves the API key in the OS keychain to the new name without showing it (on macOS you paste it once when
  asked). It prints what moved.
- `init` only migrates a source that is a real folder (not a link), holds the router's config or token, and
  on macOS and Linux is owned by you; otherwise it changes nothing and says why. It stops only processes it
  can confirm are the previous release's; if it cannot confirm one, it leaves everything and asks you to stop
  it. If both an old and a new install already exist, it changes nothing and says so.
- Then `do-it-all-claude-code start`, and restart any open Claude Code sessions. After migration
  `AGENTIC_ROUTER_HOME` is no longer read; `doctor` warns when it is still set ("previous home",
  "AGENTIC_ROUTER_HOME").

## [0.2.0] — 2026-11-13

Second pre-release: mostly security work for shared machines and API-key mode, plus better triage outside English.

### Upgrading from 0.1.0

- Run `agentic-router stop`, then `git pull`, `npm ci` and `npm run build:dashboard`, then
  `agentic-router start`: the daemon needs a restart for the sealed messages and, on macOS and Linux, the
  socket. Restart open Claude Code sessions too; the plugin is read from your checkout.
- In API-key mode, run `agentic-router mode api` once. It makes the local certificate and switches Claude
  Code's settings to `https://127.0.0.1:<port>`.
- The daemon still accepts the 0.1.0 way of calling it (the token sent as a header) for this release, so
  sessions that were open during the upgrade keep working. It is controlled by `bearerApi` and will be off
  by default in the next release.

### API-key mode

- The proxy now holds each request's worst case — its prompt size and `max_tokens` priced at the model's
  highest rates — against the daily caps until the request finishes, and refuses a request that would not
  fit. This tightens the budgets that 0.1.0 noted were not hard caps.
- **Corporate proxy support.** The proxy reaches the API through the proxy your environment names (the first
  of `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, with `NO_PROXY` honoured), using Node's
  built-in proxy support (Node 24.5+): HTTPS goes through a CONNECT tunnel with the API's certificate still
  verified end to end. A TLS-inspecting proxy needs its root certificate trusted by Node (e.g.
  `NODE_EXTRA_CA_CERTS`); SOCKS is not supported, and an unusable proxy setting stops the router from
  starting rather than going around it. So that Claude Code's own calls to the local proxy are not sent
  through the corporate proxy, `init --mode api` and `mode api` add `127.0.0.1` and `localhost` to
  `NO_PROXY` in Claude Code's settings (keeping your entries); `mode direct`, `mode subscription` and
  `uninstall` remove only what they added. `agentic-router doctor` checks both directions.
- Pricing knows Claude Fable 5.2, charges fast-mode requests at their real rate, and prices Fable 5.1 cache
  reads correctly (they were overestimated).

### Security

- Messages between the router's own programs (hooks, status line, MCP server, CLI) and the daemon are now
  encrypted and authenticated with a key derived from the token. A program that takes the daemon's port
  while it is down can read neither the token nor your prompts and cannot answer in the daemon's place.
- On macOS and Linux the router's programs reach the daemon through a Unix socket in the router home that
  only your user can enter, and never fall back to the port when the socket is gone; Windows keeps the
  local port with sealed messages.
- In API-key mode the proxy serves Claude Code over local TLS: a private certificate, held only by this
  router and valid for `127.0.0.1` and `localhost` only, that Claude Code trusts through
  `NODE_EXTRA_CA_CERTS` in its settings (bundled with any certificate you already trust there, and restored
  on a mode switch and `uninstall`). The local-token helper prints the token only after the proxy proves it
  holds the current one, and the proxy writes a fresh token at every start, so an old token is refused.
  Without `openssl` the proxy stays on plain HTTP and `doctor` says so.

### Delegation

- A reviewer's or tester's verdict can name the writer subtask it is about with a `Subtask:` line, so a
  reject that covers several writers is credited to the right one instead of to none.
- Triage handles more languages more accurately: Traditional Chinese task sets, Korean grammatical particles
  after file names, and length thresholds weighted per script for CJK.

### The guard

- Path comparisons are canonicalized on both sides, and a directory is checked under every spelling it can
  take on Linux, macOS and Windows, closing cross-platform ways around a scope.

### Project

- Continuous integration builds and tests on Linux, Windows and macOS.

## [0.1.0] — 2026-11-12

First public pre-release.

### Modes

- **Subscription mode** (default): the plugin and a local daemon do all the work. There is no proxy,
  and no subscription credential is ever read or stored. Traffic goes straight from Claude Code to
  Anthropic.
- **API-key mode** (opt-in): a local proxy aggregates real token cost and applies daily budgets ($100
  per local token, $300 total, both configurable) plus a per-request budget. These are not hard caps:
  new calls are refused with a 429 once a budget is reached, but responses already in flight can go over
  it. The API key lives only in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret).
- **Direct mode**: connect with the API key, bypassing the proxy, if the proxy has a problem. Switch
  between modes with `agentic-router mode subscription|api|direct|proxy`.

### Delegation and the ladder

- Each request is triaged (stage 1 is rules only — no embeddings, no extra model call) and either
  handled directly by the lead or delegated to a right-sized subagent team (architect, coder,
  reviewer, tester, ui-designer).
- Which levels are delegated depends on the lead model; roles move up or down a model × effort ladder
  to finish at the lowest cost that still passes verification.
- The daemon runs each subtask's build/typecheck/lint/tests, records cost, and keeps a work ledger.

### Dashboard

- A read-only local web dashboard (served by the daemon at `127.0.0.1`) shows the request timeline,
  each request's team, steps and verify result, cost (lead vs. workers), KPIs, the triage-vs-actual
  learning report, and the auto-release panel. Available in English, Korean, Japanese and Simplified
  Chinese. All data stays on the machine.

### Privacy (defaults)

- Everything is stored in one local SQLite file; nothing leaves the machine except Claude Code's own
  traffic — the router makes no outbound call of its own, in either mode.
- The learning store keeps rule-derived features, outcomes, costs and numbers — not embeddings, and
  not prompt text unless you turn on `recordPrompts`. Turning it back off deletes the stored prompt
  text at the next daemon start. Logs and the dashboard mask API keys and tokens.

### The guard (and its limits)

- A guard in front of router subagents' tools refuses writes outside a subtask's scope, writes to
  credential and repository-config files, reads of credential files, and off-allowlist or
  environment-dumping commands. A refusal cannot be overridden by an allow rule.
- For ordinary Bash the guard is silent: Claude Code's own permission rules decide, as they would
  without the router. To let workers build and test without prompts, allow those commands (e.g.
  `Bash(npm test)`, `Bash(npm run *)`). See docs/worker-permissions.md.
- The guard is a net, not a sandbox: it reads the text of a tool call and does not observe what a
  program does once it runs. Workers run as your OS user; code you allow a worker to run has your
  file access. See SECURITY.md "Limits".

### Known limits

- Verify runs the related build/typecheck/lint/tests, so a fix that is wrong in a way those checks do
  not exercise can still pass.
- "Accepted" means no objection was seen, so the success/acceptance rate is an upper bound, not a
  measured approval rate.
- Auto-release is a brake against gross losses, not a fine optimiser; its default is **observe** and
  nothing switches until you turn `autoRelease` on.
- On a shared machine the local binding does not separate users; use it on a machine you don't share,
  or keep the daemon running. See SECURITY.md.
- API-mode budgets are not hard caps: new calls are refused with a 429 once a budget is reached, but
  responses already in flight can push the total over it. Sizing the reservation from a request's
  `max_tokens` and reserving against the per-request budget are planned after release.

### Install note

- `npm ci` installs dependencies but does not build the dashboard SPA. Run `npm run build:dashboard`
  (or the dashboard shows a short page telling you to). `agentic-router doctor` reports the build
  state.

[Unreleased]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.1.0
