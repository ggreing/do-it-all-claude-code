# Fair re-measure: 30 tasks, router on and off as a user runs them (decisions 210–214)

Date: 2026-11-18. Lead: Sonnet 5.5, effort high, API key, one run per cell, 60 runs, $7.30 in all, on commit
b269ca7, which carries the cuts of decisions 211 and 212:

- a request the rules size as a small change stays with a Sonnet lead, or a lead whose model is not known, and
  the lead gets a short note instead of the full briefing;
- shorter session and plugin instructions;
- a check that cannot start for a reason outside the worker's files (a test collection error, for example) ends
  as unverified after one more try, instead of moving the worker up.

The tasks are the 20 public tasks of the [quality baseline](quality-baseline-swebench20.md) (SWE-bench Verified,
12 L2 and 8 L3 by the bench's own sizing) and the 10 custom tasks of the [phase 3 check](kpi-phase3.md). The
public tasks are graded by the official SWE-bench harness (5.0.2), the custom ones by their own tests.

Unlike the earlier measurements, both arrangements run as a user's session would:

- `router off`: plain Claude Code, no plugin, with the Agent tool.
- `router on`: plugin and daemon as a user runs them, with the router's MCP tools (checked before the first
  run: 6 tools, the daemon answered), the default budgets, `reproduceFirst` off (its default), holdoutRate 0.

## Result

| group | router off | router on |
|---|---|---|
| custom L1 (5) | 177 s · $0.51 · 5/5 | 218 s · $0.33 · 5/5 |
| custom L2 (3) | 194 s · $0.55 · 3/3 | 319 s · $0.39 · 3/3 |
| custom L3 (2) | 438 s · $1.08 · 2/2 | 798 s · $1.17 · 2/2 |
| public L2 (12) | 331 s · $0.72 · 10/12 | 499 s · $0.89 · 12/12 |
| public L3 (8) | 1564 s · $0.86 · 2/8 | 559 s · $0.80 · 2/8 |
| **all 30** | **2704 s · $3.72 · 22/30** | **2393 s · $3.58 · 24/30** |

Cost per passed task: router off $0.169, router on $0.149 (**-12%**). On the custom tasks alone $0.214 against
$0.189 (-12%), on the public tasks alone $0.132 against $0.121 (-8%).

Against the quality baseline, on the same 20 public tasks:

| | quality baseline | this run |
|---|---|---|
| router on, all 20 | 12/20 · $2.35 | 14/20 · $1.69 |
| router on against router off, total cost | +35% | +7% |
| tasks the lead did alone, against router off | +14% (13 tasks) | -1% (16 tasks) |
| tasks the lead delegated, against router off | +72% (7 tasks) | +34% (4 tasks) |

The baseline's router-off runs had no Agent tool, which made the router's cost look about 5 points higher than a
user would see; part of the change from +35% to +7% is that.

## What it shows

1. **Where the lead works alone, the router no longer costs extra.** That was 16 of the 20 public tasks: $1.20
   with the router, $1.22 without.
2. **Delegating still costs more on the public tasks**: four tasks, $0.49 against $0.37, passing the same (3 and
   3). Sonnet alone solves most of them for a few cents, so a hand-off has little to save.
3. **On the custom tasks the router is cheaper but slower**: -12% per passed task, mostly from L1 and L2, but
   1335 s against 809 s (+65%). Each hand-off adds the lead's look before it delegates, the worker's start and the
   router's checks.
4. **The pass counts are the same within run-to-run variance.** The two extra passes (pytest-5840 and
   sphinx-9602, both public L2) were tasks the router-on lead did alone, and in the quality baseline it was
   router off that solved pytest-5840. We do not read them as the router's doing.
5. **Public time leans on one task.** sympy-16597 took 1252 s with router off, where the lead ran the slow test
   suite, and 222 s with router on. Without it, router on took 836 s against 643 s.

## Limits

One run per cell, so differences on a single task can be noise. These are API-key runs; what the router saves
against a Pro or Max plan's 5-hour and weekly limits was not measured. Raw results: `bench/results/qb2` in the
measurement copy (not committed).
