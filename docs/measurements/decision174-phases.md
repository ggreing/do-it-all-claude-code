# Where a router-on run spends its time (decision 174)

Date: 2026-11-16. Lead: Sonnet 5.5 (effort high), API key, budget $4, spent $1.76. The 15 tasks of
[kpi-phase3.md](kpi-phase3.md), arrangement `auto` only (plugin and daemon as a user runs them, holdoutRate 0),
one run each; 12 of 15 passed (the three public L3 tasks failed, as in phase 3). The router-off times are phase 3's
`direct` runs of the same tasks (2026-11-12, same lead and effort).

Each run's phases come from its own stream (`claude -p --output-format stream-json --verbose
--include-hook-events --forward-subagent-text`, every line stamped by the harness on arrival) and the daemon
ledger (verify commands, workers, step ups). `scripts/kpi-phases.ts` builds the tables; the raw report is
`bench/results/kpi-phase4/phases.md`. Seconds throughout.

- lead before 1st worker: init to the lead's first Agent call (reading, the triage hook, planning)
- workers active: time at least one worker ran; lead between: the lead alone between workers
- lead wrap-up: the last worker's end to the final answer
- start delay: the lead's Agent call to the worker's first tool call
- hooks: hook_started to hook_response, all calls. **The SubagentStop hook contains the daemon's verify**, so the
  hook and verify columns overlap; without SubagentStop a hook call costs about 0.13 s (661 calls, 84 s)

## Results

| task | level | router off | router on | lead before 1st worker | workers active | lead between | lead wrap-up | start delays | verify | hooks (calls) |
|---|---|---|---|---|---|---|---|---|---|---|
| c-l1-01 | L1 | 46 | 41 | 6.8 | 24.6 | 0 | 8.4 | 2.0 | 2.6 | 7.0 (26) |
| c-l1-02 | L1 | 35 | 39 | 7.7 | 22.2 | 0 | 8.1 | 2.1 | 2.3 | 6.7 (27) |
| c-l1-03 | L1 | 28 | 40 | 6.6 | 24.2 | 0 | 8.0 | 2.0 | 2.4 | 6.7 (27) |
| c-l1-04 | L1 | 66 | 78 | 10.0 | 58.8 | 0 | 8.4 | 2.1 | 2.7 | 8.9 (48) |
| c-l1-05 | L1 | 27 | 50 | 9.2 | 32.7 | 0 | 7.8 | 2.1 | 4.7 | 9.4 (24) |
| c-l2-01 | L2 | 86 | 83 | 8.7 | 64.4 | 0 | 8.6 | 2.0 | 2.8 | 9.2 (44) |
| c-l2-02 | L2 | 65 | 88 | 10.6 | 59.1 | 0 | 16.3 | 2.0 | 4.9 | 11.7 (47) |
| c-l2-03 | L2 | 75 | 82 | 10.9 | 61.4 | 0 | 8.4 | 2.1 | 2.3 | 7.3 (34) |
| p-l2-astropy__astropy-7671 | L2 | 20 | 49 | 7.2 | 28.7 | 0 | 12.6 | 2.0 | 7.4 | 12.6 (19) |
| p-l2-pydata__xarray-4966 | L2 | 12 | 38 | 8.7 | 20.2 | 0 | 8.5 | 2.2 | 0 | 3.8 (20) |
| c-l3-01 | L3 | 209 | 316 | 22.3 | 258.1 | 19.6 | 14.8 | 6.5 | 2.3 | 17.2 (111) |
| c-l3-02 | L3 | 290 | 473 | 22.4 | 421.5 | 16.5 | 11.4 | 6.4 | 5.7 | 25.6 (155) |
| p-l3-django__django-16263 | L3 | 56 | 179 | 10.7 | 117.0 | 0 | 49.7 | 7.8 | 11.7 | 23.4 (30) |
| p-l3-sympy__sympy-16597 | L3 | 1241 | 1341 | 10.5 | 299.8 | 0 | 417.5 | 2.5 | 10.5 | 22.0 (43) |
| p-l3-pylint-dev__pylint-4551 | L3 | 74 | 57 | 11.7 | 37.0 | 0 | 7.4 | 2.7 | 0 | 5.6 (31) |

No run used a worktree, retried a worker or stepped a slot up; no worker re-read a file the lead had read.

## Totals per level

| level | runs | router off | router on | added | lead before 1st worker | workers active | lead between | lead wrap-up | start delays | verify | hooks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| L1 | 5 | 202 | 247 | 45 | 40.3 | 162.5 | 0 | 40.7 | 10.3 | 14.7 | 38.7 |
| L2 | 5 | 258 | 339 | 81 | 46.1 | 233.8 | 0 | 54.4 | 10.3 | 17.4 | 44.6 |
| L3 | 5 | 1870 | 2365 | 495 | 77.6 | 1133.4 | 36.1 | 500.8 | 25.9 | 30.2 | 93.8 |
| all | 15 | 2330 | 2951 | 621 | 164.0 | 1529.7 | 36.1 | 595.9 | 46.5 | 62.3 | 177.1 |

## Share of the added time

Each overhead's seconds over the seconds delegation added (router on minus router off). The overheads overlap
(hooks run inside workers; SubagentStop holds the verify), and part of a delegated run is the work itself done by
a worker instead of the lead, so the shares do not add up to 100%.

| level | added | lead before 1st worker | start delays | lead between | verify | hooks | lead wrap-up |
|---|---|---|---|---|---|---|---|
| L1 | 45 | 40.3 (89%) | 10.3 (23%) | 0 (0%) | 14.7 (33%) | 38.7 (86%) | 40.7 (90%) |
| L2 | 81 | 46.1 (57%) | 10.3 (13%) | 0 (0%) | 17.4 (21%) | 44.6 (55%) | 54.4 (67%) |
| L3 | 495 | 77.6 (16%) | 25.9 (5%) | 36.1 (7%) | 30.2 (6%) | 93.8 (19%) | 500.8 (101%) |
| all | 621 | 164.0 (26%) | 46.5 (7%) | 36.1 (6%) | 62.3 (10%) | 177.1 (29%) | 595.9 (96%) |

## Findings

1. **The lead re-ran the tests after the daemon had verified them.** In sympy the coder's verify passed (10.5 s
   on the related tests); the lead then ran the test suite again: 407 s of its 418 s wrap-up, 82% of the 495 s L3
   added. Without that re-run the sympy run takes about 934 s, against 1241 s router off.
2. **Small tasks pay a fixed price around the worker.** Every L1/L2 run had 7 to 11 s of lead time before its one
   worker and 8 to 16 s after it (brief, triage, then reading the worker's result and answering): 15 to 25 s per
   request, which is about all of L1's 45 s added. The worker's own time was shorter than the router-off run in 4
   of the 5 L1 tasks.
3. **L3 workers ran one after another.** c-l3-01 went architect (76 s), coder (154 s), reviewer (28 s); c-l3-02
   coder, reviewer, coder. The five L3 runs had at most one worker running at any time and no worktree, so the
   parallel path of Phase 2 was not used; the lead was alone 16 to 20 s between them.
4. **One-file public L2 fixes are slower delegated.** astropy and xarray took 20 s and 12 s router off and 49 s and
   38 s router on: the fixed price of finding 2 is larger than the fix.
5. **What was small:** a worker starts about 2 s after the Agent call (django 7.8 s); a hook call costs about
   0.13 s without SubagentStop (686 calls in all, 177 s, of which 93 s is SubagentStop with the verify inside);
   the daemon's verify took 0 to 12 s a run (62 s in all); no retries, step ups or worktree merges.

## What changed after these findings (decision 178)

Not measured yet: the same tasks are to be run again with these changes.

| finding | change |
|---|---|
| 1. the lead re-ran the tests | A worker's passed notification lists each check with how it ended and how many tests passed (`test ok (12 passed)`). When tests ran, it tells the lead not to run the test suite again (at most the changed code's tests). When verify ran no tests for the change (none configured, skipped, or 0 tests), it asks for one targeted run of the changed code's tests, never the whole suite. The lead-orchestrator skill says the same, in its merge step too. |
| 2 and 4. small requests pay a fixed price | When the router cannot tell a request's size from its wording, the brief asks the lead to check first whether the change is in one file and about 15 changed lines or fewer. If it is, the lead reports that (`router_report_triage` with `files` 1 and the new `lines` field) and the router re-plans the request as lead-direct L1: no worker starts. Before, the lead's report could only raise the level. A level set with `/router level` is kept. |
| 3. L3 workers ran one after another | The brief (for teams with two or more writer slots), the skill and the architect role ask for independent parts as separate writer subtasks with scopes that share no file, sent in one message. The architect's report lists each subtask's scope and what must finish before it. The router refuses a writer whose scope can name a file of a writer still running in the same request, and says what to do instead (split the scopes, or send it after the other one finishes); the same call goes through on its third try, and writers sent one after another are never refused. A worker that ran in its own worktree is named in its passed line with the branch to merge. |

An offline estimate for the one-file rule. `scripts/task-sizes.ts` measures each task's change (the oracle diff for
custom tasks, the gold patch for public ones: source files only, no tests), and `triage-eval-cli regret` applies
the rule to the `measure107-sonnet` runs (15 tasks, each run direct and as team-L2). It assumes the lead reports
the size the diff has. The rule changes 3 of the 15 answers from team-L2 to direct, and all three were faster
direct in those runs:

| task | files | lines | direct | team-L2 |
|---|---|---|---|---|
| c-l1-02 | 1 | 4 | $0.056, 24 s | $0.053, 43 s |
| p-l2-astropy__astropy-7671 | 1 | 9 | $0.036, 17 s | $0.045, 48 s |
| p-l2-pydata__xarray-4966 | 1 | 8 | $0.029, 11 s | $0.062, 42 s |

Mean regret per request against the best arrangement of each task (decision 108):

| policy | time at $0 a minute | time at $0.10 a minute |
|---|---|---|
| always team-L2 | 0.003 (worst 0.033) | 0.035 (worst 0.126) |
| one file, 15 lines or fewer, direct | 0.000 (worst 0.003) | 0.023 (worst 0.126) |
| one file, 25 lines or fewer, direct | 0.002 (worst 0.025) | 0.023 (worst 0.126) |

A 25-line limit adds c-l1-05 (1 file, 23 lines), which was cheaper delegated ($0.050 against $0.076), so 15 lines
was kept.

## Limits

- One run per task, on one Windows machine; router-off times are from phase 3, four days earlier.
- The start delay ends at the worker's first tool call, so it includes the worker's first model turn.
- Re-reads compare the paths of Read calls only; a worker reading a file through Grep or Bash is not counted.
- Every worker ran in the background: its end is the task notification, not an Agent result.
- Worktree creation is not timed on its own (no run used one).
- Grading time is outside these runs.
