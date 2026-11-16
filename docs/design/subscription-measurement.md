# Design note: does delegation stretch subscription limits?

Most Claude Code users are on Pro or Max. For them the question is not dollars but **how much work fits
before the 5-hour and weekly limits**. This note is a plan to measure that honestly: the same tasks, done
directly and done through the router, with the plan's own usage meters read before and after.

**Status: plan only. Nothing here has been run.** Facts marked *to verify* come from the documentation and
have not been checked against a live session.

## The claim under test, and why it may fail

- **Hypothesis.** With the router on, work that a strong lead would do itself is done by subagents on
  cheaper models or lower effort, so the same tasks use less of the limit.
- **Counter-hypothesis.** Orchestration costs more than it saves: the lead re-reads subagent results, every
  subagent starts with its own context, and cache writes multiply. A user on Max 20x reported exactly this
  with an Opus lead and Haiku subagents: the 5-hour window at 22% after about 40 minutes, and a weekly
  meter that pooled Haiku with everything else ([anthropics/claude-code#52502][issue]; closed without an
  answer from Anthropic).
- **We do not know how the meters weigh models, cache reads or effort.** Anthropic does not publish it. So
  the plan measures the meters themselves and models nothing.

Either result is useful. A negative one changes what the product says and possibly its defaults.

## What Claude Code exposes

| Source | What it gives | When | Notes |
|---|---|---|---|
| Status line input, `rate_limits` | `five_hour.used_percentage`, `seven_day.used_percentage` (0 to 100), each with `resets_at` (epoch seconds) | Only for Pro, Max and Ultra; only after the session's first API response; the script re-runs after each assistant message, debounced 300 ms | A window is dropped once its `resets_at` passes. The documented example shows one decimal (23.5) ([status line][statusline]) |
| `/usage` sent as a prompt | A `usage_report` with `rate_limits.limits[]`: one row per meter with `kind` (`session`, `weekly_all`, `weekly_scoped`, …), `percent`, `resets_at`, and for scoped rows the model | On request, also in a non-interactive run | Attached only for a claude.ai login with a known plan and no usage-based billing; marked experimental ([Agent SDK reference][sdk]) |
| Non-interactive result (`--output-format json`) | `total_cost_usd`, `usage`, `modelUsage` per model | End of each run | A client-side estimate from token counts, not what the plan charges ([headless][headless]) |

Consequences:

- **The status line is the wrong instrument for an automated run.** It belongs to the interactive
  interface; a `claude -p` run does not draw it (*to verify*). The router already forwards `rate_limits`
  from the status line to its daemon, but keeps only the latest value per session.
- **`/usage` as a prompt is the instrument.** It can be read between runs without the interface, and it
  separates the all-models weekly meter from model-scoped weekly meters, which is the heart of the user
  report above. *To verify:* that reading it sends no model request and so does not move the meter.
- **The cost estimate is a second, independent measure.** It lets us say whether the meter moves in step
  with API-priced tokens or not.

Not used: the account usage endpoint that Claude Code itself calls. Reading it would mean handling the
subscription credential, which this project never does.

## Design

### Arms

- **Direct.** Claude Code without the plugin, one lead model at one effort, doing each task itself.
- **Router.** The same lead model and effort, the plugin loaded, the daemon running, default presets.

Run with the lead a real user has: Opus for a Max user, Sonnet for a Pro user. Start with one lead (the
account's own default) and add the other only if the first result is worth extending.

### Tasks and what counts

- The 13 custom bench tasks (levels L0 to L3), each with hidden tests. A task counts only when its hidden
  tests pass: the unit is **completed tasks**, not attempts.
- Report by level. The router does not delegate at the low levels, so a single mixed number would hide
  where the effect is.

### The unit of measurement

For one block of tasks: **meter points used per completed task**, for each meter (`session`, `weekly_all`,
and each `weekly_scoped` row). The headline is the ratio router ÷ direct. Below 1, delegation stretches
the limit; above 1, it shortens it.

### One block

1. Read the meters (`/usage`).
2. Run the block's tasks in one arm, one after another, each in a fresh session.
3. Read the meters again.
4. Record: both readings with `resets_at`, tasks completed, `modelUsage` per run, Claude Code version,
   plan, lead model, wall time.

A block is discarded when a window reset between its two readings (`resets_at` changed), or when the meter
moved more than the block's own token counts can explain (someone else used the account: see Noise).

### Order

Pair the arms inside the same 5-hour window and alternate which goes first (direct, router, router,
direct). Limits can depend on the time of day and on what is cached; pairing cancels most of that.

## Noise, and what it costs

| Source | Effect | Handling |
|---|---|---|
| Other use of the account (claude.ai chat, other sessions, other devices) | Moves the same meters | The account must be quiet during a block. Cross-check each block's meter movement against its own token counts and drop outliers |
| Window resets | A reading before and one after a reset cannot be compared | Start a block only when the window has comfortably longer left than the block needs; discard on a changed `resets_at` |
| Meter resolution | A block that moves the meter by 1 point is mostly rounding | Size blocks so the 5-hour meter moves at least 5 points per arm; the pilot sets the size |
| The weekly meter moves slowly | Per-block weekly readings are too coarse | Compare weekly movement over each arm's blocks summed |
| Task variance | The same task costs different amounts on different runs | Repeat blocks; report an interval, not a point |
| Meter lag | The meter may trail the work | Wait a fixed minute before the second reading; the pilot checks whether a later reading differs |

### Pilot (first, small)

One block of four mixed tasks in the direct arm. It answers: does `/usage` work non-interactively on this
account; does reading it move the meter; how many decimals the meter has; how many points a task costs on
this plan; whether the meter lags. **Cost: a few points of one 5-hour window.** Nothing else is planned
until the pilot is read.

### Full run

- How many blocks: with block-to-block variation of about 15%, detecting a 20% difference needs roughly 10
  to 11 blocks per arm; at 10% variation, about 5. The pilot and the first pairs give the real variation.
- **Cost to the user: about 100 to 220 points of the 5-hour meter in total**, which is one to a little over
  two full windows, spread over at least three days so no single window is exhausted. What that is on the
  weekly meter is unknown until the pilot; it will be stated before the full run starts.
- Stop early when the interval for the ratio clearly excludes 1, or lies entirely within ±10% of it.

## What we would publish

**If the router uses clearly less:** "On *plan*, with *lead model*, the same *N* tasks used *X*% (interval)
less of the 5-hour limit with the router than without, measured on *date* with Claude Code *version*." With
the method, the per-level table, and three caveats: the meters are Anthropic's and can change; the task mix
is ours; one account, one plan.

**If there is no clear difference:** say that. "On subscription plans the router did not change how much
work fits in the limits (ratio, interval)." The case for the router then rests on what else it does, and
the README must not imply limit savings.

**If the router uses clearly more:** publish it the same way, and decide what the product does on a
subscription: delegate only at the highest level, delegate nowhere by default, or tell subscription users
at `init` what was measured. That is a product decision, not a measurement one.

In every case the per-model table goes out with the result, because it answers the open question in the
user report: whether cheaper-model tokens count for less on each meter.

## What has to be built

- A subscription mode for the bench harness: runs each task with the user's own Claude Code login, with and
  without the plugin, and never reads or copies a credential. Today the harness deliberately refuses to run
  on a subscription login.
- A meter reader: sends `/usage`, keeps the `usage_report` rows as received.
- Block bookkeeping and the discard rules above; a report with the ratio and its interval per meter and
  per level.
- Optional: a history of the status line's `rate_limits` in the daemon (it keeps only the latest), as a
  cross-check for people who work interactively.

## Open points

Needed before the pilot:

1. **The account.** Which plan (Pro, Max 5x, Max 20x) and which default lead model.
2. **Permission to spend limit.** The pilot's few points now; the full run's one to two windows later.
3. **A quiet account** during blocks: no other Claude use on that login for about an hour at a time.
4. **Whether driving the user's own Claude Code non-interactively on a subscription login is acceptable**
   for this measurement. It is the user's own account running Claude Code on the user's own machine, but it
   is automated use, and the answer should be explicit. The alternative is interactive sessions by hand,
   which is slower and noisier.
5. **Three facts to check in the pilot**, all cheap: the status line does not run under `-p`; `/usage`
   under `-p` returns `usage_report` on this account; reading it does not move the meter.

## Sources

- [Customize your status line][statusline]: `rate_limits` fields, who gets them, update triggers.
- [Agent SDK reference, TypeScript][sdk]: `SDKUsageReport`, `SDKResultMessage`.
- [Run Claude Code programmatically][headless]: output formats, cost fields, what loads under `-p`.
- [anthropics/claude-code#52502][issue]: the user report.

[statusline]: https://code.claude.com/docs/en/statusline
[sdk]: https://code.claude.com/docs/en/agent-sdk/typescript
[headless]: https://code.claude.com/docs/en/headless
[issue]: https://github.com/anthropics/claude-code/issues/52502
