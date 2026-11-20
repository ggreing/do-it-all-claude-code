# Do It All Claude Code 0.6.0

This release makes the team cheaper and faster. The router now sizes each request and starts each worker on
the model and effort its part needs, instead of a fixed ladder, and the workers stay on the tests of their own
change while the router runs the full checks once.

**Each worker starts where its work needs it.** The lead reads a request, grades how hard it is and splits it
into subtasks; the router starts each subtask on a grid of model × effort chosen from that difficulty and from
whether it can run the change's tests in your repository at all. A routine fix in a repo whose tests run starts
on Haiku; a hard one, or one the router cannot check here, starts higher. A miss moves a worker up a measured
path; a result it still cannot verify goes back to the lead rather than spend a stronger model blind. The team
office and `router_get_plan` show each worker's model, effort and difficulty, and where the difficulty came
from.

**The lead coordinates; it does not do the work.** Every lead now delegates from L1 — only a one-line L0 change
stays with it. It says where to look and what behaviour to check, never how to fix, and it no longer runs the
tests the router has already run. The profiles still move this: `quality` keeps L1 with the lead and starts a
notch higher, `save` starts a notch cheaper.

**Coders run less.** A coder runs only the tests of what it changed, once or twice, never the whole suite,
nothing in the background and nothing over about two minutes; it runs lint, format and type tools only when the
project or the task names them. The router runs the build, typecheck, lint and tests when the coder finishes.
The guard enforces this: a worker may not start a background command or set a timeout over 180 s, and it may
install packages only inside the project — an active virtualenv under the repo, or `--target`/`--prefix` inside
it, never a global or user-site install. It now allows the things a worker legitimately needs along the way: an
interpreter one-liner, a repo script run without an extension, a pytest node id, and a tool version check.

**A worker is no longer lost when a session ends.** If a Claude Code session ends — quit, `/clear`, logout, or
a killed or crashed `claude -p` run — while a worker it dispatched is still running, the next session to start
closes the cut-off subtask (as unverified) and counts the worker's cost from its transcript, rather than
leaving the subtask open and the cost uncounted. If you run the router headless under `claude -p`, raise
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` so the run waits for its workers to finish and report before it exits.

**Measured on a subscription.** These changes were measured in subscription mode, against plain Claude Code and
a single subagent on the same tasks; the run is written up in
[docs/measurements/decision230-234-subscription.md](measurements/decision230-234-subscription.md).

Upgrading from 0.5.x: run `npx do-it-all-claude-code@latest setup` (or `/do-it-all-setup` inside Claude Code) to
refresh the engine in your router home. Nothing in your settings has to change.

The full list of changes is in [CHANGELOG.md](../CHANGELOG.md).
