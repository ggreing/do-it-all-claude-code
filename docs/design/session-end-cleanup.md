# Session-end cleanup: workers orphaned when a session ends

A Claude Code session can end while a worker it dispatched is still running. The lead launches a
background worker (an Agent call runs async by default), the worker is still thinking, and the session
ends underneath it — the user quits, runs `/clear` or logs out, or a `claude -p` run is killed or
crashes. Claude Code then raises no `SubagentStop` for that worker, so the router never sees the
subtask finish.

Left alone, that costs three things:

- the subtask stays `running` forever, so the office keeps showing work in progress that will never
  finish;
- its request stays open, which keeps the whole session "live", so retention and `purge` never collect
  any of it;
- the worker's tokens are never read from its transcript, so the request's cost is understated.

## Why not a SessionEnd hook, and why not clean up at daemon stop

Claude Code *does* have a `SessionEnd` hook, but it is not a reliable signal for this. It fires on the
clean paths (`/clear`, interactive `/resume`, logout, exiting at the prompt) and on a `SIGTERM` of a
`claude -p` run, but it is undocumented for `SIGKILL`, a crash, or a closed terminal; it is unstated for
a normal `-p` completion; a plugin-provided hook's timeout is capped at 1.5 s (it does not raise the
budget); and it does not run under `--bare`. So the headless and crash cases — exactly the ones that
orphan a worker — are the ones it would miss.

Cleaning up at the daemon's own shutdown is also wrong: a running subtask must survive a daemon restart.
The relay spools hook events while the daemon is down and replays them when it comes back, so a worker
that stopped during the outage gets its real `SubagentStop` after the restart. The daemon's shutdown
deliberately leaves a running subtask untouched (see `shutdown.test.ts`).

## What the router does instead: reconcile at the next session start

Every live `SessionStart` reconciles the *other* sessions (the session starting now is excluded — on a
`resume`/`compact` it is legitimately continuing its own work). A subtask that is still `running` (or
`pending` once an agent is bound to it) under a request that is still open or awaiting the user, and has
not been touched for longer than `ORPHAN_RUNNING_MS` (one hour), belongs to a session that has gone: no
worker and its checks run anywhere near an hour, so a live session's worker is never reaped early. The
threshold trades immediacy for safety — the cost is captured whenever the sweep next runs, which for a
headless batch is the next `-p` task's start.

Each such subtask is closed as **cut off**: status `cancelled`, verdict `unverified`. Once its request
has nothing else pending or running, the request is closed (outcome `delegated`, or `lead_takeover` if
the lead had also edited), and closing it reads the worker's cost from its transcript along the normal
path (`#recordClose` → `#rereadAgents`); because the per-agent cost write is a replace, a later read of
the same transcript cannot double-count it.

To read a worker's cost without the ended session's main transcript in hand, the router stores each
worker's own transcript path when the worker starts (`SubagentStart` already carries it) and recovers
the main transcript from it with `mainTranscriptFromSubagent`, the inverse of `subagentTranscriptPath`.

## Headless runs: let `-p` wait for background workers

If you drive the team with `claude -p`, raise `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` so the run waits for
its background workers to finish and report (their `SubagentStop`) before it exits. That keeps the
workers from being orphaned in the first place; the reconciliation above is the backstop for the runs
that still end early, not a substitute for letting the work finish.
