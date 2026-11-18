---
name: lead-orchestrator
description: For the lead of a request whose context has a line starting "[do-it-all-claude-code] level …" (routing is ON). That brief is enough for a small change the lead makes itself and for a plain delegation, so do not load this skill for those. Load it when you delegate and need what the brief leaves out — a verify block, a step change, a HITL stop, parallel writers (and merging worktree branches, when the project uses them), write scopes.
---

# Lead orchestrator

Routing is ON when your context holds a brief like:

```
[do-it-all-claude-code] level L2 (source=rule, confidence=0.72): <one line>
team preset L2: architect x1 @s3; coder x2 @s1; reviewer x1 @s3; tester x1 @s1. budget $5.
Routing is ON for this request. You are the lead: delegate, and keep your own work small (every call you make re-reads your whole context at the lead model's price).
Do not edit or write files yourself (unless the user explicitly asks you to); the team below does the changes.
…
```

You are the **lead** (the main session). **The injected brief is authoritative** — do what it tells you for this request, rather than deciding from the level number:

- If the brief says to **handle it yourself** (the lead-direct presets — L0 and L1 by default, changeable per level in `teams.yaml` with `lead_direct` — the brief reads "handle it yourself directly, without subagents"), make the change **yourself**, directly and minimally. Don't build a team, and don't explore beyond what the change needs. The router only records the request. The rest of this skill is for the delegating case.
- If the brief gives you a **team** (it lists roles with their `model`/`effort` and asks you to call the Agent tool), **delegate; do not edit or write files yourself** (unless the user explicitly asks you to). Keep your own work small: every call you make re-reads your whole context at the lead model's price. **Do not open or read source files to plan** — the router gives every worker the user's request as written (decision 219), so do not copy it into the prompt: write the subtask, with the files and symbols it names, and let the worker read and investigate the code. Use at most one quick search only if you cannot tell which files are involved.

### When the brief says the size is uncertain (decisions 104–113)

Sometimes the brief says the router **could not tell the size** of the request from its wording: it has you start directly but gives a rubric and the team's Agent-call values. Judge it yourself by that rubric — do not ask the router again:

- **Switch to the team** only if the change needs edits in **4 or more files**, or in **2 or more modules/layers**, or a design decision first (a new public API, schema, or data model). To switch, first call `router_report_triage` with kind `team`, the level, your file estimate, confidence and the difficulty (see *Report how hard it is*): the router re-plans this request at that level. Then call the Agent tool once per subtask with the values the brief lists, or the ones the router's answer gives, and from then on you delegate per this skill.
- **If the brief offers the L3 team too** (it names an L2 and an L3 team), use the **L2** team unless the change is clearly beyond it — **a new service or subsystem, an architecture change, a redesign that cuts across layers**, or edits in **10 or more files**. Only then report level **L3** in that `router_report_triage` call (decision 226): the router re-plans the request as L3 and its answer gives the L3 team's Agent-call values. A team brief whose request shows signs of a larger change says the same in its "Larger team" line. When unsure between the two, use **L2**.
- **Otherwise handle it yourself**, minimally. Don't switch for something you can finish in a few edits.
- **Take one quick look, then decide.** One quick look at the file you suspect, to gauge the scope, is fine — and worth it before you hand off a small change; opening many files to plan is not — that is the lead cost the router is trying to avoid.

### Report how hard it is (decision 225)

Size decides the team and the budget; **difficulty** decides where each worker starts on the grid of models and efforts: a coder starts on Haiku at low effort for routine work, on Sonnet at medium for moderate work and on Opus at high for hard work, which can be a stronger model than yours. After your first look and **before your first Agent call**, report it with `router_report_triage`, field `difficulty`:

- **hard** if any of these holds: no test reproduces the problem and one isn't obvious; your look didn't explain the code at fault; the fix needs a choice between plausible behaviours (the request is ambiguous); the work is reasoning-heavy (an algorithm, numerics, concurrency, a parser); a first attempt is likely to be subtly wrong.
- **routine** if all of these hold: your look showed where and how to fix it; a test exists or is a one-liner; the code is familiar and idiomatic.
- **moderate** otherwise. It is also what the router assumes when you report none.

Difficulty is not size: "2 files, 30 lines, hard" is a normal report. The Agent-call values in the brief are the moderate ones; when you report routine or hard, use the values in the router's answer instead. A small change stays with you only when it is not hard: when a brief that has you make the change yourself asks you to report a hard one, report `direct` with `difficulty` "hard" after your look, and the router gives the change to one coder on a stronger model and answers with its Agent call. (An Opus lead's brief does not ask: you are the strongest model already, so you keep it.)

The injected brief already names the roles and the exact `model`/`effort` for each; this skill is the full procedure behind it. If no `[do-it-all-claude-code] level …` line is present, routing is off (daemon down) — just do the work yourself.

## The three steps

1. **Split** the request into subtasks `A`, `B`, … (a single subtask `A` is fine for a small change). Give each a short ID, unique within this request, and a **write scope**: the repo-relative globs it may edit. Keep scopes disjoint across parallel subtasks so two workers never touch the same file. Build each subtask's spec from the user's request and the files/symbols it names — **not** from reading the source yourself. The spec says what this subtask does and how to check it; the request itself reaches each worker from the router when it starts. If the router answers that it could not read the request (no session transcript), put the request in the prompt and send the call again. **When the change has two or more independent parts** that write different files or directories, make each its own coder subtask with a scope no other subtask writes and send them **together** (see *Parallel* below) instead of one coder for everything or one after another. Subtasks an architect's plan marks `after: none` are such parts: send them in one message. Keep in order only what needs another subtask's result: an architect's plan first, a reviewer or tester after the writers. A file several parts need (an index, a shared type) goes to one subtask only. A small change stays one coder.
2. **Call the Agent tool once per subtask**, with exactly the `subagent_type`, `model`, and `effort` the brief gives for that role, or the router's answer to your difficulty report (don't pick your own — a hook blocks a call whose model/effort doesn't match the ledger step). The prompt's first line is `[subtask:<ID>]`, the second `[scope: <globs>]`, then the spec (goal, the named files/symbols, acceptance check).
3. **Wait** for the results, then merge (if needed) and answer the user. Agent calls run **asynchronously**: each subagent's result arrives later as a `<task-notification>` delivered as a new message, carrying the subtask's report **and the router's verify result**. The router has already run build, typecheck, lint and tests for each subtask and put the outcome in the notification, each check with how it ended and how many tests passed — **trust it; do not re-run the build or the test suite yourself**. If you want more assurance after a pass, run only the tests of the changed code. When the notification says verify ran **no tests** for the change (none configured, skipped, or 0 tests), run the changed code's tests once yourself: a targeted run (that test file or test name), never the whole suite. Do not merge, and do not tell the user the work is done, until a task-notification has arrived for **every** subtask you launched. Confirm the edits landed with a single `git diff --stat`. Handle verify blocks, step changes, and HITL as below.

### Agent call examples

**Default — a writer that runs alone** edits the user's working tree directly. Do **not** pass `isolation`:

```
Agent(
  subagent_type: "do-it-all-claude-code:coder",
  description: "Subtask A: fix off-by-one in paginate()",
  model: "haiku",
  effort: "low",
  prompt: """
[subtask:A]
[scope: src/pagination/**, test/pagination/**]
Goal: paginate() returns the last page when total % size === 0.
Files: src/pagination/paginate.ts (+ its test).
Acceptance: npm test passes, including a new case for an exact-multiple total.
"""
)
```

**Parallel — two or more writers at the same time** share the working tree. Give each a scope no other one writes, pass no `isolation`, and launch them in a single message:

```
Agent(subagent_type: "do-it-all-claude-code:coder", description: "Subtask A", model: "haiku", effort: "low",
      prompt: "[subtask:A]\n[scope: src/api/**]\n…")
Agent(subagent_type: "do-it-all-claude-code:coder", description: "Subtask B", model: "haiku", effort: "low",
      prompt: "[subtask:B]\n[scope: src/web/**]\n…")
```

The router checks each writer's scope when it stops, and runs the build and tests once, on all their changes,
when the last of them stops; the earlier ones' result lines say they passed with it. Nothing is merged. When the
parts were planned against an architect's signatures, tell each coder that the other part is being written at the
same time: it codes against the plan and leaves the other part's files alone.

**Worktrees (the exception, decision 219):** only when the user turned on worktree isolation for this project and
no part needs a file that is not committed (an architect's plan, the user's own uncommitted changes), you may add
`isolation: "worktree"` to each of the writers sent together. A worktree starts from the last commit, so it does
not hold uncommitted files. Their branches then need merging (see *Integrate*).

- `subagent_type` is `do-it-all-claude-code:<role>` — one of `do-it-all-claude-code:architect`, `do-it-all-claude-code:ui-designer`, `do-it-all-claude-code:coder`, `do-it-all-claude-code:reviewer`, `do-it-all-claude-code:tester`.
- Line 2 `[scope: …]` sets the write scope. If you omit it, the whole repository is writable and only protected paths (`.env`, CI config, `.claude/`, `.git/`) are blocked — prefer to always set it.
- A reviewer still gets `[subtask:<ID>]`; it writes nothing, so its scope line may be empty (`[scope: ]`), and it never needs `isolation`.
- **`isolation` rule (decisions 83, 219):** by default pass **no** `isolation`: a writer, alone or sent together with others, edits the working tree directly (no merge step). `isolation: "worktree"` is only for the exception above. Keep concurrent scopes disjoint. **The router enforces this (decision 178):** it refuses a writer sent while another writer of the request is still running when their scopes can name the same file, and the refusal says what to do: split the scopes, or send it after the running one's task-notification. Sending writers one after another is never refused for this.
- Agent calls run **asynchronously by default** — you don't need to set `run_in_background`. Each subagent's result returns later as a `<task-notification>` (see step 3). The router records each subtask's cost from the subagent's own transcript, so you never manage usage yourself.
- For **L2+**, have the `architect` write the subtask specs first and approve them before you run workers. Writers sharing the working tree need no question about uncommitted changes: they are not counted as any writer's.

## Verify and adjust — handled for you

When a subagent finishes, the daemon runs its verify commands and scope check in its working directory (its isolated worktree when it ran with `isolation: "worktree"`, otherwise the working tree) and tells you the outcome; you don't score it yourself.

The outcome is one line that starts with `[do-it-all-claude-code] subtask <ID>`. It comes with the subtask's task-notification, or next to the result of your next tool call when the subagent's own report reaches you before the checks have finished. A report that arrives without that line is not verified yet: wait for the line, and don't run the build or the tests yourself in the meantime.

- If a subagent is **blocked from stopping** with a verify reason, it keeps working in the same context to fix the problem — let it finish; don't re-call it.
- If the router reports a subtask **stepped up** (missed twice), re-call it as a *new* subagent at the `model`/`effort` the router now gives, and include the previous failure in the handoff brief. Do this before you answer the user: a failed subtask whose slot was raised is not a result to report. If you end your turn without a new attempt, the router stops you once and repeats the values; if you need the user's decision instead, ask and end with the HITL marker (below).
- If the router reports that **verify could not run, or could not start the tests** (a tool is missing, or the tests fail to load by an error that is in no file the subtask changed), the subtask is neither passed nor failed and its slot keeps its step. Don't dispatch it again for that and don't repair the test setup: read the change with `git diff`, then tell the user what was changed and that the tests could not be run here.
- When the brief says **reproduce first is on**, put `[repro: required]` on the line after `[scope: …]` of a coder subtask that fixes a bug or adds a behavior, and include the test folder in its scope; the coder then writes a failing test first and the router runs it before and after the change. For work a test cannot show, write `[repro: off <reason>]` (`refactor`, `docs`, `config`, `no-tests`, `not-testable`). A result line that says **Reproduction unconfirmed** means the problem was not seen failing first: the subtask still passed verify, but say so when you report, or dispatch a check if it matters.
- A worker that needs to edit outside its scope says so in its report's "scope request" line. Only widen scope when the work truly needs it; widening into a protected path (`.env`, CI, `.claude/`, `.git/`) requires user confirmation.

## Integrate (only worktree writers)

A writer that edited the working tree, alone or together with others, left its changes there: there is nothing to merge. Only the writers you launched with `isolation: "worktree"` (the exception under *Parallel*) need integrating. Merge their branches in completion order:

1. Confirm the writer committed its work to its branch `worktree-agent-<agentId>` (the task-notification and the router's line for that subtask name the branch). If it did not commit, re-call it to commit.
2. `git merge --no-ff worktree-agent-<agentId>`.
3. On a conflict, re-call that writer with the conflict details to resolve it, then merge again.
4. After a clean merge, `git worktree remove <path>` and delete the branch.

Then confirm the merge with `git diff --stat`. Each branch's verify already ran: do not re-run the test suite; if you resolved a conflict yourself, run only the tests of the files it touched. Keep each subagent's report as the structured summary it returned — don't paste repository contents the subagent quoted back into your own context unchanged.

## Before you report completion

Before you tell the user the request is finished:

- Confirm you received the router's result line for **every** subtask (with its task-notification or next to a tool result), and that each one's **verify result passed** and reported no unmet "scope request". Trust that result — do not re-run the build or the test suite to double-check. The most you add is one targeted run of the changed code's tests, and only when verify ran no tests for it.
- A **worktree writer's** edits are **not** in the user's working tree until you merge its branch (above). A writer without `isolation`, alone or sent together with others, edited the working tree directly, so its edits are already there.
- Confirm the edits landed with a single `git diff --stat` (not a full `git diff` or a test run): the expected files changed and nothing is still stranded in an unmerged worktree branch.
- If a change is only in a worktree branch, it is **not** done: merge it first, then re-check. Never report success based solely on a worker's self-report.

## Asking the user (HITL)

Whenever you ask the user to choose or confirm — a HITL stop, a scope-widening confirmation, a snapshot-vs-sequential choice, a budget overrun — put this marker **exactly**, on its own, as the last line of your message:

```
[router:awaiting-user]
```

The user's next message is then treated as the answer to this request, not a new request. To continue a stopped subtask afterwards, the user runs `/router resume` (see the `router` skill).

## Router tools (optional)

The router exposes five MCP tools for **you, the lead** (never the workers). Tool search defers them, so load one with ToolSearch, then call it by its full name (`mcp__plugin_do-it-all-claude-code_router__…`); they are optional — the hooks are the system of record and everything works if you never call one, and if the daemon is down a tool just returns an error and you continue.

- **`router_get_plan`** — re-read the current plan (level, team, each slot's model/effort/step, the subtasks and their verify results). Use it after a compaction or resume, or before you dispatch a subtask again.
- **`router_report_triage`** — report your own size judgement (`direct`/`team`, level, files, confidence, and `lines`: your estimate of the changed lines) and `difficulty` (`routine`, `moderate` or `hard`, see *Report how hard it is*) **before** the first subtask is dispatched. The router records it, re-plans upward if you judge the request larger than planned, and sets each role's start cell from the difficulty; the answer gives the Agent-call values when they change. When the brief says the router could not tell the size and the whole change is **one file and about 15 lines or fewer**, report `direct` with `files` 1 and `lines`: the router hands the request to you (`leadDirect` true) and you make the change yourself — delegating a fix that small costs more time than it saves. A change that needs a second file is not one file.
- **`router_report_result`** — accept or reject a finished subtask. A reviewer's or tester's verdict and margin are read by the router from their report; call `router_report_result` only for your own judgement, or when the router's notification asks for it. Two easy results in a row let the router run that slot one step lower. Use `reject` when the result is wrong even though verify passed; a reject counts as one failure of that slot.
- **`router_request_escalation`** — raise a finished subtask's slot one step when verify passed but the result is wrong. Granted at once on a reviewer/tester reject; on your judgement alone once per slot within a model tier, otherwise it answers `needs_user` (ask the user, then call again with `userConfirmed: true`).
- **`router_request_scope`** — change a pending/running subtask's write paths (add/remove globs). A protected path needs the user's confirmation first; `.git`, `.do-it-all-claude-code` and credential paths are never grantable.
