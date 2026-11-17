# After the speed fixes: router on vs off again (decisions 181, 189)

Date: 2026-11-17. Lead: Sonnet 5.5, effort high, API key. The same 15 bench tasks as the
[phase 3 check](kpi-phase3.md) (10 custom, 5 SWE-bench Verified), router on (`auto`: plugin and daemon as a
user runs them, holdoutRate 0), one run each, $1.88 in all, on commit 5138fea, which carries the speed fixes
of decision 181:

- the lead's own triage can replan a one-file request as lead-direct;
- the pass notice carries the verify results, and the lead no longer re-runs the suite the router just ran;
- concurrent writers with overlapping scopes are refused.

The five public tasks were graded afterwards by the SWE-bench harness on the same workspaces. Router off is the
phase 3 `direct` run of the same tasks; "before" is the phase 3 `auto` run.

## Result

| group | router off | router on, before | router on, after |
|---|---|---|---|
| custom L1 (5) | 202 s · $0.52 · 5/5 | 247 s · $0.26 · 5/5 | 238 s · $0.32 · 5/5 |
| custom L2 (3) | 226 s · $0.61 · 3/3 | 252 s · $0.22 · 3/3 | 324 s · $0.24 · 3/3 |
| custom L3 (2) | 499 s · $1.20 · 2/2 | 789 s · $0.79 · 2/2 | 696 s · $0.85 · 2/2 |
| public L2 (2) | 32 s · $0.06 · 2/2 | 87 s · $0.10 · 2/2 | 29 s · $0.08 · 2/2 |
| public L3 (3) | 1371 s · $0.43 · 0/3 | 1576 s · $0.38 · 0/3 | 293 s · $0.40 · 0/3 |
| **all 15** | **2330 s · $2.81 · 12/15** | **2951 s · $1.76 · 12/15** | **1580 s · $1.89 · 12/15** |

Cost per passed task: router off $0.235, before $0.146, after $0.157 (**-33%** against router off).

## What it shows

1. **Total time is 32% shorter than router off, but most of that is the public L3 tasks**, whose tests are slow.
   On sympy the lead no longer re-ran the tests the router had verified (1340 s became 142 s); django and pylint
   the lead judged one-file changes and did itself.
2. **The two public L2 tasks went lead-direct** and run as fast as router off (29 s against 32 s).
3. **The ten custom tasks are still slower than router off**: 1258 s against 927 s, about 36% longer. What is left
   is the fixed price of a hand-off on small and medium tasks: the lead's look before it delegates, the worker's
   start, and splitting work between coders.
4. **Pass rate is the same** in all three columns (12/15); the same three public L3 tasks fail everywhere.

## Limits

One run per cell, so differences on a single task (for example 41 s against 61 s) can be noise. Total time leans
on one task (sympy). Subscription limits were not measured: these are API-key runs, and what the router saves
against a Pro or Max plan's 5-hour and weekly limits is still open. Raw results: `bench/results/kpi-phase5` and
`kpi-phase5-public` (not committed).

The router-off runs here had no Agent tool, and the router-on runs had no router MCP tools (the bench ran with
`--strict-mcp-config`). A user's session has both: without the Agent tool, router off saves about 5 points on
small requests that a real session would not; without the MCP tools, router on skips about 2,400 tokens of tool
definitions a real session carries, and its lead cannot report a one-file request and keep it. The re-measure
(decision 213) runs both arrangements as a user's session would.
