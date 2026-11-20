# A Sonnet lead with workers chosen by difficulty, next to Opus alone and a plain subagent (decisions 230–234)

Date: 2026-11-19, one day on one machine. 105 runs on a subscription login; no API key was used.

## Setup

- **Subscription mode.** Every run is `scripts/measure107.ts --subscription`: Claude Code 2.1.328 (2.1.327 for the first six runs) on the subscription login.
- **Cost is an estimate at API prices.** The dollar figures are what Claude Code reports for a run (`total_cost_usd`). On a subscription nothing is charged per run, so they measure token use, priced as the API would price it. Over the day they add up to $42.74.
- **Tasks.**
  - The bench's 10 custom tasks (five L1, three L2, two L3), graded by hidden tests.
  - Five SWE-bench Verified bugs, graded by the official harness in Docker: sympy-16597, sympy-17630, pytest-5787, pytest-5840 and sphinx-9602. These are the five the router lost with an Opus lead in the [previous measurement](decision225-opus-quality-session.md), where Opus alone passed all five.
- **Arrangements.**
  - *Opus alone*: one Opus 5.5 session at effort high, no plugin, with the Agent tool.
  - *Plain subagent*: no plugin. A Sonnet 5.5 main session gets a fixed instruction before the task: hand the whole task, word for word, to one general-purpose subagent on Opus at effort high, and do nothing else. In all ten runs the main session made exactly that call and did no work of its own, and the subagent ran on Opus. The stream does not show the effort a subagent ran at.
  - *Router*: the plugin with the router's MCP tools, the balanced profile, the lead at effort high. The lead is Opus up to decision 231 and Sonnet 5.5 from decision 232 on.
- **Same machine, same day.** Every comparison below is between runs of this one day. One earlier run is used, only in the run-to-run counts of points 5 and 6, and is named there.
- **A harness bug, found before these runs.** The subscription environment set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, which also turns off Claude Code's session transcript. The router reads the user's request and the costs from that transcript, so router runs made that way were not valid. Since e0b2979 a router run keeps its transcript, and a run whose transcript is not on disk stops the measurement without a record. Every router run here has its transcript.

## 1. The sequence

Each row is one run of the task set on the named commit. The router changed between rows; the tasks did not.

The five public bugs:

| commit | router | lead | passed | cost | time |
|---|---|---|---|---|---|
| e0b2979 | before decision 230 | Opus | 0/5 | $1.25 | 368 s |
| 0283b98 | decision 230 | Opus | 3/5 | $4.45 | 1871 s |
| 73da2be | decision 231 | Opus | 3/5 | $2.60 | 945 s |
| faf213b | decision 232 | Sonnet | 2/5 | $3.71 | 3310 s |
| faf213b | decision 232, again | Sonnet | 3/5 | $2.54 | 2143 s |
| c857549 | decision 234 | Sonnet | 3/5 | $1.66 | 619 s |
| c857549 | decision 234, again | Sonnet | 2/5 | $1.56 | 645 s |

The ten custom tasks:

| commit | router | lead | passed | cost | time |
|---|---|---|---|---|---|
| 0283b98 | decision 230 | Opus | 10/10 | $5.61 | 1423 s |
| 73da2be | decision 231 | Opus | 10/10 | $4.66 | 1454 s |
| faf213b | decision 232 | Sonnet | 10/10 | $2.19 | 1189 s |
| c857549 | decision 234 | Sonnet | 10/10 | $1.73 | 973 s |
| (no router) | Opus alone | | 10/10 | $5.27 | 1297 s |

What each step changed:

- **Before decision 230** the coders on the public bugs ran on Sonnet at effort medium (four tasks) or Haiku (one), and none of the five fixes passed.
- **Decision 230** (0283b98): the lead only judges size and difficulty and delegates from L1 on. Each subtask gets its own difficulty, and the router picks the cell from it. A subtask that ends unverified gets one more attempt a model up. The public coders moved to Opus at effort high, and three of five passed. The retry was costly where nothing could be checked: sympy-17630 went on to Opus at effort xhigh and cost $1.94 alone.
- **Decision 231** (73da2be): the start cell follows whether the router can check the result here. Where the project's tests start, a coder begins on Haiku at effort low and moves up on misses. Where they do not, it starts once on Opus at effort high, and an unverified result goes back to the lead instead of a blind retry. The public cost fell from $4.45 to $2.60 for the same three passes. On the custom tasks the lead's own share was now $2.20 of the $4.66.
- **Decision 232** (faf213b): fewer lead turns, architect and reviewer at Sonnet medium, testers at Haiku low. The measurement also moved to a Sonnet lead in this step, so the two effects are not separated. The custom tasks fell to $2.19. The public runs became slow and costly: 3310 s and 2143 s.
- **Decision 233** added no router change. It added the plain-subagent arrangement to the bench (ed4e196), to see how much of the cost and time came from the router's workers. The router rows "before decision 234" below are the two decision 232 runs.
- **Decision 234** (c857549): workers do less. A worker runs only the tests related to its change, no lint unless the project names it, no command over about two minutes, nothing in the background and no environment repair. The guard allows more forms of test and reproduction commands and refuses installs outside the project. Tests that never start no longer send the worker round again.

## 2. The final comparison

### Custom tasks, one run each

| group | Opus alone | router, decision 234, Sonnet lead |
|---|---|---|
| L1 (5) | 318 s · $1.35 · 5/5 | 250 s · $0.35 · 5/5 |
| L2 (3) | 355 s · $1.50 · 3/3 | 252 s · $0.26 · 3/3 |
| L3 (2) | 624 s · $2.43 · 2/2 | 471 s · $1.12 · 2/2 |
| **all (10)** | **1297 s · $5.27 · 10/10** | **973 s · $1.73 · 10/10** |

Every task passed in both. The router cost 67% less and took 25% less time.

### Public bugs, two runs each

| | Opus alone | plain subagent | router before decision 234 | router, decision 234 |
|---|---|---|---|---|
| passed | 6/10 | 5/10 | 5/10 | 5/10 |
| cost | $3.17 | $2.32 | $6.25 | $3.22 |
| time | 2968 s | 1242 s | 5453 s | 1264 s |

Per task, first run then second (✓ resolved, ✗ not):

| task | Opus alone | plain subagent | router before 234 | router, 234 |
|---|---|---|---|---|
| sympy-16597 | ✓ ✗ | ✗ ✗ | ✓ ✗ | ✓ ✗ |
| pytest-5787 | ✓ ✓ | ✓ ✗ | ✗ ✓ | ✗ ✗ |
| pytest-5840 | ✓ ✗ | ✓ ✗ | ✗ ✓ | ✓ ✓ |
| sphinx-9602 | ✗ ✓ | ✓ ✗ | ✓ ✓ | ✓ ✓ |
| sympy-17630 | ✓ ✗ | ✓ ✓ | ✗ ✗ | ✗ ✗ |
| **per run** | **4/5, 2/5** | **4/5, 1/5** | **2/5, 3/5** | **3/5, 2/5** |

In every router run here the fix was made by one coder on Opus at effort high, the same model and effort as the plain subagent. No worker was killed and no run timed out.

## What it shows

1. **On the bench's own tasks, a Sonnet lead with workers chosen by difficulty does the same work for a third of what Opus alone costs.** In the decision 234 run the L1 and L2 coders ran on Haiku at effort low, and most L3 coders and the reviewers on Sonnet at effort medium. All ten tasks passed in each of the four router runs of the day.

2. **Before decision 234 the router's workers cost 2.7 times the plain subagent and took 4.4 times as long, for the same model doing the same fix.** The difference was not overhead per turn. A worker and a plain subagent started with the same context (about 8,400 tokens) and took the same time per turn (about 7 s); the router's hooks added 7 to 23 s a run. The workers took more turns:
   - Of the $3.93 of extra cost, $3.72 was the workers' and $0.21 the lead's.
   - One task, sympy-16597, held 67% of the extra cost and 88% of the extra time. A refused test command led the worker to run two whole test folders, which hit the 10-minute command limit. Each wait of over five minutes re-wrote the worker's cached context. In the costlier of the two runs the worker reached its turn limit, the lead then ran the same long test itself, and background commands woke the worker again.
   - On the other four tasks a worker took 17.1 turns a run against the subagent's 9.5. It read as many files, but ran three times as many commands (10.8 against 3.5): tests more than twice as often, linters, and environment checks.
   - Three things drove this. The coder's instructions said to run the build, typecheck, lint and tests and make them pass. The guard refused 36 commands in ten runs, most of them harmless (a linter, a test or a reproduction written in a form the guard did not know), and each refusal cost a turn or more. In six of ten runs the stop check sent the worker round again because the tests had not started, which the worker could not fix.

3. **Decision 234 removed most of that.** Over the ten public runs, before and after, with the plain subagent for comparison:

   | router workers | before 234 | decision 234 | plain subagent |
   |---|---|---|---|
   | turns | 233 | 136 | 98 |
   | commands | 135 | 67 | 39 |
   | of them tests | 81 | 38 | 30 |
   | of them lint | 11 | 2 | 0 |
   | commands the guard refused | 36 | 14 | – |
   | turns after a stop check sent the worker back | 9 | 0 | – |
   | cost of the Opus work | $5.68 | $2.74 | $1.96 |
   | time on sympy-16597, two runs | 4248 s | 476 s | 561 s |

   The router now takes the same time as the plain subagent. It costs $0.90 more over ten runs: $0.78 in the workers, $0.12 in the lead.

4. **On these five bugs the router does not save money against Opus alone.** It costs the same ($3.22 against $3.17). Opus alone's time holds one 2008 s run of sympy-16597; on the other four tasks the three arrangements take about the same time (Opus alone 704 s, plain subagent 681 s, router 788 s over eight runs each). The router could check its worker's result in only two of the ten runs, because the projects' tests do not start on this machine (see Limits), so here it adds a lead's cost without adding a check.

5. **The pass counts are within noise.** The same arrangement on the same five tasks gave very different counts from run to run:
   - Opus alone passed 5/5 in the previous measurement (2026-11-18, with an API key), then 4/5 and 2/5 on this day: 11/15.
   - The plain subagent passed 4/5 and then 1/5, in two runs made one straight after the other with nothing changed.
   - The router passed 2/5, 3/5, 3/5 and 2/5.

   A single run of five tasks moves by up to three passes. With ten runs, a count of 5 is compatible with a true pass rate anywhere from about 20% to 80%, so 6/10 against 5/10 says nothing about which arrangement is better.

6. **One task is not noise: sympy-17630.** With an Opus coder under the router it failed six times out of six on this day (the four runs above and the decision 230 and 231 runs). Without the router it passed four times out of five (Opus alone 2/3 including the previous measurement, plain subagent 2/2). Every passing fix was made in `matexpr.py`; every failing one in `blockmatrix.py`, the file the issue names, or once in `dense.py`. In the last four router runs the lead's call limited the worker to `blockmatrix.py`. So on this task the lead's first look, and the scope it sets from it, kept the worker at the symptom. Decision 234 does not address this. In the other direction, sphinx-9602 passed six times out of six under the router and three out of five without it, which is within what chance gives.

## Limits

- **Two runs per cell on the public bugs, one on the custom tasks.** The percentages are for these runs; see point 5 for how far the pass counts move.
- **No Sonnet-alone run on this day.** The custom comparison is against Opus alone only.
- **Decision 232 and the Sonnet lead arrived together.** The fall from $4.66 to $2.19 on the custom tasks is the sum of both.
- **Runs overlapped, so times are not clean.** The Opus-alone custom run and its first public run ran next to no other measurement. The decision 232 and 234 custom runs each ran next to a public run. The second Opus-alone public run, the second "before 234" router run and the two plain-subagent runs overlapped one another. Costs and grades are not affected.
- **The public projects' tests do not start on this machine.** The repositories are old releases and the machine has a current Python (3.14) on Windows; the hidden tests run only in the Docker grading. The router marked these requests as not checkable, and in eight of the ten decision 234 runs the worker's result ended unverified. A machine where the tests start would let the router check the result, and would let the coder start on a cheaper model. That was not measured.
- **Workers changed the machine's Python twice.** Both installs went into the user's site-packages, not the project, and later local runs on this machine could see them. The Docker grading could not.
  - `standard-imghdr`, at about 13:03 KST, in the decision 231 run of sphinx-9602. It has since been removed.
  - `more-itertools`, at 16:27 KST, in the second "before 234" router run of pytest-5787. It has since been removed.

  Since decision 234 the guard refuses an install outside the project, and no decision 234 run made one.
- **Subscription limits were not measured.** The account was in other use on the same day, so the movement of its weekly meter cannot be attributed to these runs.
- **One run in the decision 230 row has no verdict from the router**: on sympy-16597 the worker was still running when the session ended. Its grade and cost are counted.
- Raw results (not committed): `dc2-opus`, `dc3-custom`, `dc3-public`, `dc4-custom`, `dc4-public`, `dc4-alone`, `dc5-custom`, `dc5-public`, `dc6-alone`, `dc6-router`, `dc7-sub1`, `dc7-sub2`, `dc8-custom`, `dc8-pub1` and `dc8-pub2` in the measurement copies, and `op1` from the previous measurement.
