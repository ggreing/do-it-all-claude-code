# Difficulty- and effort-driven start cells (decision 225 — design note)

Status: design note, not implemented. Written for decision 225 and its extension.

## Why

The router's job is to match **model and effort** to each task — up as well as down. It is not
"use something cheaper than the lead". Changes are judged by **pass rate first, cost second**.

Two gaps, from the Opus-lead re-measure (`C:/ar-m3-tree/bench/results/op1`):

1. **Start cell encodes size, not difficulty.** A slot's start is fixed per level by the preset
   (`packages/core/src/presets.ts`; `startStep()` at `policy.ts:36` just reads `role.start`).
   Triage sizes most SWE-bench fixes as L1/L2, whose coders start at **s1 (Haiku-low)** — so even
   the subtle sympy and pytest bugs were worked by Haiku. Router on **13/20**, Opus alone
   **18/20**; four of the five losses were delegated and lost because a hard bug started on a weak
   cell. The `ql1` (quality-profile) run is the mirror: all six hard-but-small tasks stayed with
   the Sonnet lead under decision 220's 2-file/60-line bound, so a stronger worker was never
   reached. **Small did not mean easy.**

2. **The ladder is one fixed line of seven cells.** `core/ladder.ts` uses Haiku low/high, Sonnet
   medium/high, Opus high/xhigh, Fable high — it never uses Haiku medium, Sonnet low/xhigh/max, or
   Opus low/medium/max, although Claude Code accepts them and role overrides (`ROLE_EFFORTS`)
   already do. Effort should be chosen as flexibly as model.

Root fix: size decides team shape and budget; **difficulty decides where on a model × effort grid
each role starts**, and the slot then moves on that grid.

## What Claude Code 2.1.326 actually accepts (read from the installed binary, no runs)

The installed CLI (`~/.local/share/claude/versions/2.1.326`, a Bun single-file binary) embeds its
model registry. Read out of it:

- **Accepted effort tokens are exactly `low, medium, high, xhigh, max`.** Anything else is refused
  at config/schema parse (`"$.model.complete: effort must be one of low, medium, high, xhigh, max"`).
- **Per-model support is capability-gated.** A model's `capabilities` list carries `max_effort`
  and/or `xhigh_effort`; the functions `oSe`/`j7e` check them. A model missing a capability (e.g.
  a `tier_3_15` model lists `max_effort` but **not** `xhigh_effort`) has that level **silently
  downgraded** to the nearest supported one — documented on the `CLAUDE_EFFORT` hook field:
  "Active effort level … after any silent downgrade for the selected model." **It clamps; it does
  not refuse or pass an unsupported level through.**
- **All four models the router uses carry both `xhigh_effort` and `max_effort`** and an
  `effort_cost_index` with all five entries — so **every cell low…max is genuinely accepted for
  Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1**, and no downgrade happens for them. The 20-cell
  grid is real.

`effort_cost_index` per model (verbatim from the binary; cost relative to that model's `high` = 1):

| model (pricing tier) | low | medium | high | xhigh | max | default_effort |
|----------------------|-----|--------|------|-------|-----|----------------|
| Haiku 5.5 (`haiku_55`) | 0.38 | 0.52 | 1 | 2.03 | 4.34 | medium |
| Sonnet 5.5 (`tier_2_10`) | 0.49 | 0.54 | 1 | 1.87 | 5.5 | medium |
| Opus 5.5 (`tier_4_20`) | 0.48 | 0.66 | 1 | 1.66 | 3.44 | medium |
| Fable 5.1 (`tier_10_50`) | 0.75 | 0.86 | 1 | 1.38 | 1.74 | high |

(The tier code is dollars per Mtok in/out: Sonnet $2/$10, Opus $4/$20, Fable $10/$50; Haiku has a
named tier only. These are the 5.x prices baked into the CLI, not today's 4.x prices.)

## The grid, and the measured anchors

Phase 0 (spec Appendix E) measured only the seven legacy cells: s1 1.0, s2 3.1, s3 9.1, s4 15.3,
s5 44.9, s6 96.2 (s7 unmeasured). The other 13 cells are **estimated**: anchor each model's
measured `high` cell (Haiku s2 = 3.1, Sonnet s4 = 15.3, Opus s5 = 44.9; Fable has no measured cell,
price-anchored at ≈2.5× Opus-high) and scale by `effort_cost_index`. Cross-check: the estimate
lands within ~15% of every measured cell **except Opus-xhigh (est 74 vs measured 96)** — i.e. the
index under-states high-effort cost, so estimates are **conservative (lower bounds) at xhigh/max.**

Cost-ordered grid (coefficient; **E** = estimated, else Phase-0 measured):

| coef | cell | alias | |
|------|------|-------|--|
| 1.2 | haiku·low | s1 | measured 1.0 |
| 1.6 | haiku·medium | — | **E** |
| 3.1 | haiku·high | s2 | measured |
| 6.3 | haiku·xhigh | — | **E** |
| 7.5 | sonnet·low | — | **E** |
| 8.3 | sonnet·medium | s3 | measured 9.1 |
| 13.5 | haiku·max | — | **E** (dominated) |
| 15.3 | sonnet·high | s4 | measured |
| 21.6 | opus·low | — | **E** |
| 28.6 | sonnet·xhigh | — | **E** |
| 29.6 | opus·medium | — | **E** |
| 44.9 | opus·high | s5 | measured |
| 74→96 | opus·xhigh | s6 | measured 96.2 |
| 84 | sonnet·max | — | **E** (dominated) |
| 84 | fable·low | — | **E** |
| 96 | fable·medium | — | **E** |
| 112 | fable·high | s7 | **E** |
| 155 | opus·max | — | **E** |
| 155 | fable·xhigh | — | **E** |
| 195 | fable·max | — | **E** |

Note the interleave: **haiku·max (13.5) costs more than sonnet·medium (8.3)**, and sonnet·xhigh
(28.6) more than opus·low/medium — so climbing a small model to its top effort is dominated by
switching models. That is what makes the movement rules below cost-sensible.

## Difficulty (the request dimension the lead reports)

After its first look the lead reports **difficulty** alongside size in `router_report_triage`:
`routine | moderate | hard`. Signals (for the brief rubric and the tool description):

- **hard** if **any**: no reproducing test and one isn't obvious; the bug is in code the first
  look didn't fully explain; the fix needs choosing between plausible behaviours (spec ambiguity);
  the work is reasoning-heavy (algorithm, numerics, concurrency, parser); a first attempt is likely
  subtly wrong.
- **routine** if **all**: fix location and shape clear from the first look; a test exists or is a
  one-liner; familiar idiomatic code.
- **moderate** otherwise — and the default when the lead gives none (see open questions).

Difficulty is independent of size: "2 files, 30 lines, hard" is a normal report.

## 1. Start cell from role × difficulty (× profile)

Difficulty picks the **model tier**; the start cell is that tier's **low-effort cell**, leaving the
higher-effort cells of the tier as step-up headroom. Coder (the cell that matters most), balanced:

| difficulty | coder start cell | vs today |
|------------|------------------|----------|
| routine | **haiku · low** (haiku · medium if lightly reasoning) | same floor, now deliberate |
| moderate | **sonnet · medium** (s3) | was haiku · low |
| hard | **opus · high** (s5) | was haiku · low |

Other roles track the coder's tier, one effort step richer for the judging roles, as the presets
already do (architect/reviewer start a tier above the coder; tester with it). The mapping is a
**capped offset on the cost-ordered grid**: `start = preset_cell shifted up by one model-tier per
difficulty rank`, capped at the top (s6, or s7 with Fable opted in). It is symmetric — routine can
sit **below** the lead's tier (a Haiku worker under a Sonnet/Opus lead: cheaper), and **hard starts
above it** (a Sonnet lead gets an Opus worker). "Up as well as down."

Reaching xhigh/max: `hard` starts at opus·high; opus·xhigh/·max are reached by the slot's own
step-up (a miss or an unverified jump) or an explicit `router_request_escalation`, not by a fourth
difficulty value — keeps difficulty at three levels and uses grid movement for the rest. (Whether
to add a "very hard" that starts at opus·xhigh is an open question.)

## 2. How a slot moves on the grid

The grid's **cost order is the new 1-D projection**, so the existing triggers (`ladder.ts`) map
straight onto it: `stepUp` = advance to the next cell in the step-up path; `stepDown` = retreat one;
`MAX_STEP_UPS = 3`, the floor-lock, and the two-easy-passes step-down are unchanged. A **model
change is a new subagent** (today's `crossesTier`); an **effort change within a model is a new call
to the same subagent**. The path refines the raw cost order with control's rules:

- **On a miss (two failures, or a reject):** step **effort up within the model while the next
  effort cell is still cheaper than the cheapest cell of the next model**, then change model. So
  from haiku: low → medium → high → xhigh, then **jump to sonnet** (haiku·max is skipped — it costs
  more than sonnet·low/medium). This prunes the dominated cells (haiku·max, sonnet·max, opus·max,
  fable mid-cells) from the automatic path; they stay addressable by config only.
- **A hard task that comes back unverified / hitl:** **jump model** immediately (skip the
  within-model effort climb), within the request budget, before handing back to the lead — once per
  slot per request. This is decision 225 point 2, sharpened: on the grid an unverified hard result
  means the model, not the effort, was the shortfall. Guards: below top, budget has room for the
  next model's cell, once only; else hand back to the lead. routine/moderate unverified ends hand
  back to the lead as today (no jump), so a routine task with legitimately no test doesn't burn
  Opus.
- **Step-down (two easy passes):** **lower effort first within the model**, then drop a model tier
  — the retreat mirrors the climb. `quality` profile keeps `stepDown: off`.

## 3. Interaction with decision 220's small-direct bound

Decision 220 keeps a ≤2-file/≤60-line change with a non-Opus lead because the fixed 15–25 s
hand-off overhead exceeds a *trivial* fix. That assumed the fix is easy. `ql1` is the
counter-example. So:

- The bound applies to **routine and moderate** only. For **hard**, the bound does **not** hold: a
  non-Opus lead delegates the small hard task to a worker at the hard start cell (opus·high),
  re-planned as a delegated L1 (one coder, not lead-direct). Small + hard is exactly where a
  **stronger model** pays — the value is reasoning, not parallelism.
- For an **Opus lead**, a small hard task **stays with the lead** (`ONE_FILE_DIRECT`): the lead is
  already top tier; delegating to another Opus worker is overhead for no tier gain.
- routine/moderate small work is unchanged (moderate's tier is Sonnet = the Sonnet lead's own tier;
  no gain in delegating). Concretely `smallChangeDirect` takes a difficulty arg and returns `false`
  only for `hard` + non-Opus lead.

**Decision 211** (`SMALL_STAYS_WITH_LEAD`) fires at stage 1 from wording, before the first look, so
it can't know difficulty. Keep it a *starting* plan: the lead still takes its look, and a
`direct + hard` report then delegates to an Opus worker. This needs the lead on such a request to
still be invited to report triage/difficulty (today it may be settled silently). Flag.

## 4. Compatibility

- **`teams.yaml` start steps `s1…s7` keep working** as aliases of the seven legacy cells
  (s1 = haiku·low, s2 = haiku·high, s3 = sonnet·medium, s4 = sonnet·high, s5 = opus·high,
  s6 = opus·xhigh, s7 = fable·high). New cells are addressed as `model·effort` pairs (e.g.
  `sonnet-xhigh`) rather than inventing s8…sN — recommended, since the grid isn't a line.
- **Role overrides** (`ROLE_EFFORTS`, already all five efforts) now act on the automatic path too.
- **Profiles** (decision 194) layer as before: they set the routine baseline cell and difficulty
  moves up from it. `save` reaches Opus from a lower floor; `quality` caps sooner and already lifts
  `delegateFrom` to L2. One offset for all profiles initially (open question whether to vary it).
- **Ledger step column**: widen from the 7-value enum to a cell id; keep writing the `s`-alias when
  the cell is one of the seven, store `model·effort` otherwise, so old ledgers still read.
- **Panel / office display** (`docs/design/team-office.md`, `router.ts:2747`): show each slot as
  `model · effort` with the legacy `s`-alias in parens; add a small **difficulty** badge beside the
  level on the Team tab; mark **estimated** cells (and the request if it runs on one) with an
  "est." badge. `doctor` lists any configured cell that is estimated.

## 5. Budgets

`PROVISIONAL_BUDGET_USD`: L1 $2, L2 $5, L3 $15. A hard L1/L2 now starts opus·high (coef 45) and may
jump to opus·xhigh (coef 96); $2 at L1 is too tight. Proposal: a **hard task uses at least the L2
budget floor** plus a difficulty factor (routine ×1, moderate ×1, hard ×1.5), under any
user-set budget — matching how `quality` lifts budgets ×1.5. Still provisional. (Open question.)

## 6. Tests (all pure/unit — no API, no `claude -p`)

- Grid: accepted cells per model from capabilities; cost-ordered sequence; estimated-cell marking;
  `s1…s7` alias round-trip.
- Start cell: role × difficulty × profile → expected cell; cap at top; Fable opt-in raises the cap.
- Movement: miss climbs effort within model then jumps (haiku·max pruned); hard + unverified jumps
  model once then hands back; routine unverified no jump; step-down lowers effort before tier;
  model change = new subagent, effort change = same subagent.
- `smallChangeDirect` with difficulty: hard breaks the bound for non-Opus, Opus small-hard stays,
  routine/moderate unchanged.
- `router_report_triage` schema accepts `difficulty`; absent → default; `normalizeLeadTriage`
  unaffected. Decision-211 path still lets the lead report hard and delegate.

## 7. Validating with almost no API credit

~$10 of API credit left, likely the last; the bench's **subscription mode** is the route for the
bulk. Minimal set: the **5 lost Opus public tasks** (sympy + pytest hard bugs + three more) plus
**2–3 custom hard-but-small tasks** (exercise §3's bound break). Opus lead, router on, balanced,
with the difficulty/grid mapping; compare against op1 (13/20 on those tasks) and Opus-alone
(18/20); target is recovering the four delegated losses by starting hard coders at opus·high. Reuse
op1/ql1 router-off runs as the counterfactual — don't re-run off; one router-on run per task. Put
the bulk on subscription mode and spend API only on 2–3 confirmatory tasks (open question).

**Measuring the estimated cells later**: Phase 0 covered only s1–s6. Run representative subtasks at
the unmeasured cells in **subscription mode**, record realized cost, replace the estimate in config,
and drop the "estimated" badge. Until then the estimates are conservative at xhigh/max (the Opus
cross-check), which is the safe direction for a budget guard.

## Open questions (as options)

1. **Default difficulty when the lead reports none** — (a) moderate [recommended: safe middle],
   (b) routine [cheapest, risks the s1 failure], (c) derive from level (L3→hard, L2→moderate,
   L1→routine).
2. **Routine coder start cell** — (a) haiku·low [cheapest, recommended], (b) haiku·medium (a little
   reasoning headroom at ~1.4× the cost).
3. **How `hard` reaches xhigh/max** — (a) start at opus·high, reach xhigh/max by step-up/escalation
   [recommended], (b) add a 4th "very hard" = opus·xhigh, (c) let the lead name the start effort in
   the triage report.
4. **Dominated cells** (haiku·max, sonnet·max, opus·max, fable mid) — (a) keep addressable by config
   but exclude from the automatic step-up path [recommended], (b) include them.
5. **New-cell addressing in config** — (a) `model·effort` pairs [recommended], (b) invent s8…sN.
6. **Offset shape** — (a) one model-tier per difficulty level [recommended], (b) a free
   role × difficulty cell table.
7. **Unverified jump scope** — (a) hard only [recommended, per control], (b) hard + moderate; and
   whether it consumes the one lead-only raise or a dedicated one-shot counter.
8. **Hard-task budget** — (a) L2 floor + ×1.5 factor [recommended], (b) difficulty factor on the
   level budget, (c) no change, rely on the step-up budget guard.
9. **Per-profile offset** — (a) one offset for all profiles [recommended], (b) per-profile.
10. **Per-subtask `[difficulty:]` brief marker** — (a) defer past v1 [recommended], (b) now.
11. **Validation split** — (a) 2–3 on API + the rest on subscription mode [recommended], (b) all on
    API, (c) all on subscription, API only to spot-check.

---
*Appendix — Fable pin.* `core/ladder.ts` s7 pins `claude-fable-5-1`; the CLI's `fable` alias now
resolves to `claude-fable-5-2` (and the registry maps Fable 5.2 → 5.5 internally). Whether to move
the pin is out of scope here but worth a separate check.
