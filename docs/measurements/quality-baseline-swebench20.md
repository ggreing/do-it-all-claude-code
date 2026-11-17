# Quality baseline: 20 SWE-bench Verified tasks (decisions 175, 177)

Date: 2026-11-17. Lead: Sonnet 5.5, effort high, API key, one run per cell, 60 runs, $6.53 in all, on commit
da5a671. The 20 public tasks of `bench/tasks/public/manifest.json` (12 L2, 8 L3 by the bench's own sizing), each
graded by the official SWE-bench harness (5.0.2) on the workspace's diff from the task's base commit.

- `router off`: plain Claude Code, no plugin.
- `router on`: plugin and daemon as a user runs them (automatic triage, the lead picks the roles, default budgets),
  holdoutRate 0, with `reproduceFirst` on in one arm and off in the other.

## Result

| | passed | cost | cost per passed task | wall time |
|---|---|---|---|---|
| router off | **13 / 20** | $1.74 | **$0.134** | 1247 s |
| router on, reproduce first on | 12 / 20 | $2.35 | $0.196 (+46%) | 1581 s |
| router on, reproduce first off | 12 / 20 | $2.44 | $0.203 (+51%) | 2633 s |

Split by what the lead did in the reproduce-first-on arm:

| | tasks | router off | router on |
|---|---|---|---|
| the lead did it alone | 13 | $1.10 | $1.26 (+14%) |
| the lead delegated (or took the work back) | 7 | $0.64 | $1.10 (+72%) |

## What it shows

1. **On these tasks the router costs more and passes no more.** Sonnet alone solves most of them cheaply (a few
   cents each), so the router's fixed cost and the price of a hand-off weigh more than on the bench's own tasks,
   where the same comparison gave -33% per passed task ([after the speed fixes](decision189-after-speed-fixes.md)).
2. **Even when the lead does the work itself, a request costs about 14% more**: the lead reads the router's
   instructions and briefing before it starts. That is the first thing to cut.
3. **Delegating paid off on none of these tasks.** The seven delegated tasks passed or failed the same way in
   both arms, except one (pytest-5840) that the lead alone solved and the team did not.
4. **Reproduce first did not change the pass rate** (12 and 12). With it on, the runs were cheaper and faster,
   but the difference comes from two tasks whose time varies a lot from run to run, so it is not shown to be the
   reason.

## Limits

One run per cell. The three L3 tasks of the reproduce-first-off arm were run a second time on their own after the
first pass stopped on its budget; they are counted once. Raw results: `bench/results/qb-on`, `qb-off`,
`qb-off-l3` in the measurement copy (not committed).
