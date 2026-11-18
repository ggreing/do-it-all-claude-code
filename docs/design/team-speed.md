# A faster team: parallel writers and shorter hand-offs (decisions 216, 219)

On the ten custom tasks of the [fair re-measure](../measurements/decision213-fair-remeasure.md) the router was 12%
cheaper but 65% slower than plain Claude Code (1335 s against 809 s). This note says where the time of the five
delegated L2 and L3 runs went, what decision 219 changed, and what is proposed next.

## Where the time went

Seconds, router on (router off in brackets). "Lead" is time when no worker ran.

| run | wall | lead before the first worker | workers, in order: active time | lead between workers | verify | wrap-up |
|---|---|---|---|---|---|---|
| c-l2-01 | 134.5 (72.0) | 12.8 | coder 73.5, then tester 23.3 and reviewer 12.5 together | 9.9 | 1.5 | 9.9 |
| c-l2-02 | 102.9 (67.4) | 12.8 | coder 46.3, reviewer 19.3 | 8.4 | 0.7 | 11.4 |
| c-l2-03 | 82.2 (54.6) | 10.4 | coder 61.2 | 0 | 1.5 | 7.6 |
| c-l3-01 | 326.9 (199.3) | 19.5 | architect 67.2, coder 61.5, coder 67.6, then tester 70.0 and reviewer 24.8 together | 24.4 | 2.1 | 7.2 |
| c-l3-02 | 470.6 (239.3) | 23.1 | architect 117.9, coder 99.3, coder 84.4, reviewer 49.2 (reject), coder 25.2 | 51.7 | 2.4 | 9.8 |

- **The L3 coders ran one after another although they could have run together.** Both architects planned two
  coder subtasks with scopes that share no file and marked each `after: none`, one of them with "it runs in
  parallel … against the frozen signatures". No writer was refused. The leads chose the order when they sent the
  first coder. The brief's only way to run writers together was a git worktree each and a merge afterwards, and a
  worktree starts from the last commit: it would not have held the architect's plan, which was not committed.
  The router could already run disjoint writers in one checkout and verify them once, at the last stop
  (decision 192), but the brief did not offer it.
- **The lead's time is mostly writing briefs.** Both L3 architect briefs copied the user's request into the
  prompt (5,340 of 6,415 and 5,004 of 5,764 characters), about 13 to 17 s of the first look.
- **A reviewer's empty `[scope: ]` line was refused** in three of the five runs, and the lead wrote the whole
  brief again.
- **Small here:** verify (2.4 s or less a run), a worker's start (1.6 to 2.8 s), a hook call (about 0.1 s).
- **L2 cannot be faster than router off with one coder:** the coder alone was active about as long as the whole
  router-off run. What the router brings at L2 is cost ($0.39 against $0.55 on these three tasks).

## Decision 219, as built

1. **Writers sent together share the working tree.** The brief for a team with two or more writer slots says:
   independent parts go to one coder subtask each, sent in one message, each with a scope no other subtask
   writes; subtasks an architect's plan marks `after: none` are such parts; no `isolation`. The router checks each
   writer's scope when it stops and runs the build and tests once, when the last one stops (decision 192). The
   lead-orchestrator skill and the coder role say the same; the coder is told that other writers may be changing
   other files of the tree at the same time and to leave them alone.

   **This narrows decision 83**, which gave each concurrent writer a worktree. A worktree each is now the
   exception: only when the user turned on worktree isolation for the project and no part needs a file that is
   not committed (an architect's plan, the user's own uncommitted changes). Turning isolation on no longer means
   that every parallel writer gets a worktree; the project question and the router tool say so.
2. **An empty `[scope: ]` line on a role that cannot write** (a role file without an edit tool: the reviewer)
   means the subtask writes nothing, and the call goes through. A writer's empty line is still refused.
3. **The pass line of a subtask that changed no file** (a reviewer) no longer asks the lead to run the changed
   code's tests; a writer whose change ran no tests is still asked.

Expected, from the runs above: about −69 s on c-l3-01 and −89 s on c-l3-02 from the parallel coders, −6 s on
c-l3-02 from the scope line, about −3 s on c-l2-02 from the pass line. That is custom L3 from 798 s to about
640 s. L2 does not change.

4. **The router hands the user's request to each worker**, so the lead writes only the subtask (below).

## The request handed to each worker

The lead copied the user's request into every brief because a worker sees nothing else. Now the router gives
each worker the user's request as written, and the brief tells the lead not to copy it: the lead writes the
subtask (which part, the files and symbols it names, the acceptance check).

**How.** When a router worker starts (`SubagentStart` of a subtask the router dispatched), the daemon reads the
lead's transcript and returns the request as the worker's start context, between `----- the user's request -----`
lines, ahead of the reproduce-first note when that applies. The request is the prompts the user typed in it: the
one that opened it and the answers to the lead's questions (after a `[router:awaiting-user]` question). The
ledger counts those prompts by their stored kind (it keeps the kind, not the text), and that many are read back
from the end of the transcript, within its last 8 MB. Task notifications, tool results, slash command records,
`!` shell lines, meta lines and the subagents' own lines are not prompts. The text is masked with the router's
secret patterns and cut at 16,384 characters, the limit `recordPrompts` uses. Every role says that the request
is context and the lead's prompt is the task. `SubagentStart` context reaches the worker: check C4 of
[session-checks.md](session-checks.md) passed.

**Nothing is stored.** The text is read from the transcript Claude Code already keeps, held only while the hook
answers, and goes nowhere but the hook's answer:

- not into the ledger: the `SubagentStart` event is recorded in its minimal form as before, and a hook's answer is
  not recorded;
- not into the daemon's log: the line for the start names the request, the subtask and the number of characters;
- not into the team office or the tabs: they are built from the ledger, and they read no transcript;
- with `recordPrompts` on, the opening prompt is kept as before, and nothing more.

A test puts a marker in the user's prompt. The worker's start answer carries it; no ledger table, no file of the
daemon's home and no office, status or tab answer holds it.

**When the transcript cannot be read** (no transcript, as with `claude -p --no-session-persistence`, or fewer
prompts found than the request has), the first Agent call of the request is refused with "the router could not
read the user's request … Put the request in the prompt and send the call again." The lead is told this once per
request; the call it sends again, and any later call of the request, goes through.

**Expected:** the first look from 19.5 and 23.1 s to about 6 and 7 s on L3, from 10 to 13 s to about 5 s on
L2, and 2 to 5 s off each later brief: about −74 s over the five runs, and less lead output.

## Waiting for a measurement

- **The tester beside the coders**, when there is a written spec: it writes tests from the spec and does not
  run them, and its verify waits for the last writer. About −40 s on c-l3-01, about −15 s on c-l2-01. A failure
  at the last stop can land on the tester, which cannot change the source.
- **An architect's plan that does not restate the request**: the split, the signatures and the defaults it
  chose. −15 to −30 s per L3 run.
