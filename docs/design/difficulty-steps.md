# Difficulty- and effort-driven start cells (decision 225 — design note)

Status: design note, not implemented. Written for decision 225 and its extension.

## Why

The router's job is to match **model and effort** to each task — up as well as down. It is not
"use something cheaper than the lead". Changes are judged by **pass rate first, cost second**.

Two gaps, from the Opus-lead re-measure ([decision 225 measurements](../measurements/decision225-opus-quality-session.md)):

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

## 1. Start cell from role × difficulty (as built, decision 226)

The start cell comes from a **difficulty table**, not from "preset start + shift". **Difficulty
alone sets the coder's model**; the level preset keeps only the team shape (which roles, how many)
and the user's overrides. The same table applies at every level:

| role | routine | moderate (default) | hard |
|------|---------|--------------------|------|
| coder | haiku · low (s1) | sonnet · medium (s3) | opus · high (s5) |
| architect, reviewer | sonnet · medium (s3) | sonnet · high (s4) | opus · xhigh (s6) |
| tester | the coder's cell | the coder's cell | the coder's cell |
| ui-designer | sonnet · medium (s3) | sonnet · medium (s3) | sonnet · high (s4) |

The judging roles (architect, reviewer) are the coder's model one effort step richer, with a floor
of sonnet · medium; **hard** is the one case they go to opus · xhigh. It is symmetric — routine can
sit **below** the lead's tier (a Haiku coder under a Sonnet/Opus lead: cheaper), and **hard starts
above it** (a Sonnet lead gets an Opus coder). "Up as well as down." A big but routine change does
not get Opus coders, and a small hard one does. Because the table is level-independent, L3 at the
default is **cheaper** for coders than before (sonnet · medium, not opus · high) and close to before
for the judging roles.

- The **profiles** (save, quality) move the whole table one notch (save down, quality up), capped at
  the grid's reachable top.
- A **teams.yaml start step or a role override** the user set still wins over the table.

Reaching xhigh / max: `hard` starts at opus · high (coder) / opus · xhigh (judging); higher cells are
reached by the slot's own movement (a miss, or the hard-unverified model jump) or an explicit
`router_request_escalation`, not by a fourth difficulty value — difficulty stays three levels and
the grid movement does the rest.

## 2. How a slot moves on the grid (decision 229)

Step-UP and step-DOWN are **asymmetric**: up goes in big, measured steps so a miss buys a real
improvement; down eases back gently. `MAX_STEP_UPS = 3`, the floor-lock, and the two-easy-passes
rule are unchanged. A **model change is a new subagent** (`crossesTier`); an **effort change within
a model is a new call to the same subagent**.

- **On a miss (two failures, or a reject), a lead-requested raise, or a verify-gap raise:**
  `stepUp` moves along the **legacy cells only** — `s1 → s2 → s3 → s4 → s5 → s6`. So three raises
  carry a routine coder (`s1`) to `s4` and a moderate coder (`s3`) to `s6`. With Fable opted in,
  `s5 → s7` instead of `s6` (decision 226 drops `s6` when Fable is on). From an off-path cell (a
  teams.yaml / role-override / save-notch start, or a slot that stepped down onto an in-between
  cell), `stepUp` goes to the cheapest up-path cell that costs more than it.
- **A hard task that comes back unverified / hitl:** `modelJump` — the next up-path cell whose
  model differs (from `s3`/`s4` that is `s5`; from `s5` it is `s7` with Fable, else none) — within
  the request budget, once per slot per request, before handing back to the lead. routine/moderate
  unverified ends hand back to the lead as before (no jump), so a routine task with legitimately no
  test doesn't burn Opus.
- **Step-down (two easy passes, and the `save` −1 notch):** `stepDown` stays **fine-grained** —
  lower effort first within the model, then drop a model tier: `s3 → sonnet·low → haiku·xhigh → s2 →
  haiku·medium → s1`; `s5 → opus·medium → opus·low → s4`. So a slot that over-shot on a miss can
  ease back onto an in-between cell, and a later miss then takes it up the legacy path again. The
  `quality` profile keeps `stepDown: off`.

## 3. Per-subtask difficulty and the small-direct bound (superseded by decision 230)

Decisions 225/226 set a start cell from the **request's** difficulty. Decision 220 kept a
≤2-file/≤60-line change with a non-Opus lead, and decision 225 then delegated the *hard* ones.

**Decision 230 replaces all of this.** The lead is a coordinator: it delegates at L1 and above (only
L0 stays lead-direct; a user `delegateFrom`/`lead_direct` still wins), so the decision-220 bound, the
decision-211 "small stays with the lead" path, the Opus small-hard-direct exception and the
per-lead-model L1 lead-direct defaults (117/118/124) are **gone** (`smallChangeDirect`,
`smallDirectBound`, `SMALL_DIRECT`, `smallStaysWithLead`, `SMALL_STAYS_WITH_LEAD` removed;
`DEFAULT_DELEGATE_FROM` is L1 for every class). Instead difficulty is now **per subtask**:

- The lead tags each Agent call with `[difficulty: routine|moderate|hard]` on a third header line
  (after `[subtask:…]` and `[scope:…]`). The router starts that subtask at the role × difficulty cell
  and checks the call's model/effort against it (the same `checkAgentCall` deny-with-right-values path).
  No tag → the request's difficulty. So hard parts go to Opus/Fable and easy parts to Haiku, and two
  coder subtasks of different difficulty run at once at different cells (a slot's start is its first
  subtask's cell; `resolveCallDifficulty` + the per-call `difficulty` into `checkAgentCall`).
- **Coder source floor**: a coder subtask whose scope can change source files (paths outside the
  test/doc/changelog/config patterns, `scopeChangesSource`) may not be tagged below the request's
  difficulty, once that is set (lead report or router floor); a lower tag is raised to it (source
  `floor`). tester, docs/changelog-only and scope-less scouting subtasks may go lower.
- **Router difficulty floor** (`difficultyFloor`): the request's difficulty is the higher of the
  lead's report and a rule floor. The floor reads `hard` on a **strong** hard-bug cue only — a
  traceback, an unexpected error/crash, a regression, "sometimes", a race, or an order-/chunk-dependent
  symptom — and only when no reproducing test is named and the request is not a stage-1 L0. A bare
  expected/actual example or the word "bug" sets no floor. Over the 38 bench prompts this floors 9.
- **Unverified retry** (item 3): a moderate or hard subtask that ends unverified (the checks could not
  run or did not start) gets one more attempt on the next model up (s3/s4 → s5; at s5 with Fable off
  the effort rises to s6), once per slot and within budget, before it goes back to the lead; routine is
  handed back as before. This supersedes decision 212's "keep the step" for moderate/hard. While the
  retry is pending the lead cannot close the subtask with `router_report_result` accept — the router
  answers with the retry's Agent-call values (item 4).

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
