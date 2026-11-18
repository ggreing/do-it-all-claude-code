# Do It All Claude Code 0.5.0

This release makes Do It All Claude Code easy to install, moves everything you look at into Claude Code
itself, and cuts the router's own overhead.

**Install with one command.** It is on npm now:

```
npx do-it-all-claude-code setup
```

That installs the plugin and a status line, copies the engine into your router home and starts the daemon on
your Claude subscription. Or, from inside Claude Code:

```
/plugin marketplace add ggreing/do-it-all-claude-code
/plugin install do-it-all-claude-code@do-it-all
/do-it-all-setup
```

After setup the daemon starts itself when a Claude Code session starts (`config set autoStart off` turns that
off). `do-it-all-claude-code uninstall` undoes all of it.

**The team office.** `/office` opens a panel inside the terminal, in place of the old browser dashboard. The
request's team sits at desks as small characters, with the session of the member you pick below them. Click a
member and it reacts. Five tabs show the work, the savings, the team and the settings. On Windows, use Windows
Terminal: the classic console cannot draw the characters.

**Profiles and settings.** `save`, `balanced` and `quality` move a set of values at once (where delegation
starts, the teams, their start steps and the budgets). `balanced` is the default and is what we measured. You
can change settings from the office's Settings tab or with `config set`.

**Less overhead.** Small requests stay with a Sonnet lead, the first brief is shorter, the lead no longer runs
the tests the router just ran, and tests that cannot start in your environment no longer move a worker up to
a stronger model. On 30 tasks (20 from SWE-bench Verified) with a Sonnet 5.5 main session, a passed task cost
12% less than with plain Claude Code, and about as many tasks passed. It is slower on the bench's own tasks,
since each hand-off starts a worker and runs the checks. One run per task; the details are in
[docs/measurements](measurements/decision213-fair-remeasure.md).

**License.** From this release the code is under the Business Source License 1.1. You can use it for free,
including at work for your own software. Offering it to others for a fee, or a product whose value comes
mainly from it, needs a commercial license. Each version becomes Apache-2.0 four years after its release; 0.4.0
and earlier stay Apache-2.0.

Upgrading from a 0.4.0 checkout: stop its daemon (`node packages/cli/src/index.ts stop`), then run
`npx do-it-all-claude-code setup`. The browser dashboard is gone; `/office` has what it showed.

The full list of changes is in [CHANGELOG.md](../CHANGELOG.md).
