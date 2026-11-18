# Opus lead, the quality profile, and a long session (decisions 216, 221, 225)

Date: 2026-11-18. API key, one run per cell, $20.42 in all, on commit bac239c, which carries decisions 218–222:

- the lead's model on a session's first prompt;
- disjoint writers sharing the checkout;
- the request handed to each worker;
- the 2-file/60-line bound for a Sonnet or unknown lead;
- version queries for workers.

Both arrangements run as a user's session would, as in the [fair re-measure](decision213-fair-remeasure.md):

- router off has the Agent tool;
- router on has the router's MCP tools;
- from decision 222 on, every run may also use `echo`, `pwd` and `wc` in Bash without a prompt.

Per-run caps were scaled down (`--cap-scale`) to fit the budget; no run came near its cap.

## 1. Opus lead, 30 tasks

The same 30 tasks as the fair re-measure: 10 custom, and 20 SWE-bench Verified graded by the official harness. The lead is Opus 5.5 at effort high; $17.02. The router recorded the lead as `opus` on every run.

| group | router off | router on |
|---|---|---|
| custom L1 (5) | 295 s · $1.14 · 5/5 | 276 s · $0.72 · 5/5 |
| custom L2 (3) | 323 s · $1.25 · 3/3 | 293 s · $0.89 · 3/3 |
| custom L3 (2) | 572 s · $2.21 · 2/2 | 557 s · $1.18 · 2/2 |
| public L2 (12) | 550 s · $1.95 · 12/12 | 650 s · $1.89 · 10/12 |
| public L3 (8) | 2340 s · $3.78 · 6/8 | 814 s · $2.01 · 3/8 |
| **custom (10)** | **1190 s · $4.60 · 10/10** | **1126 s · $2.78 · 10/10** |
| **public (20)** | **2890 s · $5.73 · 18/20** | **1464 s · $3.90 · 13/20** |

On the custom tasks, router on cost 40% less for the same passes and was slightly faster (−5%). That is the first time the team was faster than one session working alone.

On the public tasks, router on passed **five fewer**. Four of the five were tasks the router delegated: sympy-16597, sympy-17630, pytest-5787 and pytest-5840. The fifth, sphinx-9602, the lead did itself.

| public tasks, by what the lead did | tasks | router off | router on |
|---|---|---|---|
| the lead did it alone | 7 | $1.15 · 7/7 | $1.21 · 6/7 |
| the lead delegated (or took the work back) | 13 | $4.58 · 11/13 | $2.69 · 7/13 |

In every delegated public task the coder started at s1 (Haiku, effort low). The rule triage sized these fixes L1 or L2 because they are small, and the start steps were fixed per level. The workers ended unverified (no test they could run reproduced the bug), so no slot stepped up. Opus alone solves these bugs; Haiku at low effort does not.

## 2. The quality profile on six hard public tasks

These are the six public L3 tasks that both arrangements failed in the fair re-measure. The lead is Sonnet 5.5, router on, profile `quality`; $1.01.

All six failed again. All six were handled by the lead itself: the 2-file/60-line bound kept each small fix with the lead, so the profile's stronger workers were never used. Run on the same tasks with the balanced profile, router on cost $0.64.

## 3. A long session: six requests in one session

One run per arrangement, Sonnet 5.5 lead, the `taskboard-01` scenario. Six requests build on one another: due dates, a status fix, filtering and paging, sorting, an audit trail, and a refactor. Each step is graded on a copy against its own hidden tests and every earlier step's. $2.39.

| | router off | router on |
|---|---|---|
| steps passed | 6/6 | 6/6 |
| cost | $1.06 | **$0.66** (−38%) |
| time | 360 s | 443 s (+23%) |
| the lead's context after the last step | 100,851 tokens | **77,354 tokens** (−23%) |

Per step, router on cost $0.117, 0.091, 0.133, 0.077, 0.167, 0.071, and router off $0.206, 0.059, 0.184, 0.100, 0.244, 0.265. The lead's context grows with every request in both arrangements. It grows more slowly when the workers' file reads and edits stay out of it.

A resumed `claude -p` reports the session's running total, not the step's. The step costs above are the differences between consecutive totals, so the bench's first pilot double-counted until this was found.

## What it shows

1. **On the bench's own tasks the router does what it is for**: the same passes, at 40% less with an Opus lead and 12% less with a Sonnet lead. Over a long session, it costs 38% less and keeps the lead's context smaller.
2. **On hard bugs in unfamiliar code it gave up quality for cost.** The router sent such work to the cheapest worker, because it sized requests by how much changes rather than by how hard the change is. It had no signal to move up when it could not check the result. The quality profile could not help, because those requests never reached a team.
3. That is the opposite of the product's aim, which is to match the model and effort to the task, upward as well as downward. Decision 225 changes this:
   - the lead reports difficulty after its first look;
   - each role's start cell comes from a model × effort grid by difficulty, and a hard task may start above the lead's model;
   - a hard task that ends unverified moves up a model before it goes back to the lead.

   The design is in [difficulty-steps](../design/difficulty-steps.md). The router is judged by pass rate first, then cost.

## Limits

- One run per cell, and one session per arrangement.
- Eight Opus runs overlapped full test runs on the same machine (11:28–12:10 KST): astropy-7671, xarray-4966, django-16263 and sympy-16597, both arrangements. Their times may be inflated; their costs and grades are not affected.
- Five Opus runs were cut by the budget and run afterwards with the same settings: django-15957 direct, and xarray-3993 and sympy-17630 in both arrangements.
- These are API-key runs. Subscription limits were not measured.
- Raw results (not committed): `bench/results/op1`, `ql1` and `sess1` in the measurement copies.
