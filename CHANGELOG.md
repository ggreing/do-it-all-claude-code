# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Dates are in UTC.

## [Unreleased]

## [0.5.0] — 2026-11-18

### Added

- **The team office.** `/office` opens a panel inside the Claude Code terminal (it replaces the browser
  dashboard). The request's team sits at desks as small characters, and the member you pick has its session
  below. Click a member and it reacts in one of eleven ways (it nods, waves, hops, spins, hides behind the desk,
  peeks out from behind its monitor, and more); click again quickly for a bigger one. Five tabs: Office, Work,
  Savings, Team and Settings (keys `o w s t c`). When the pane is short the desks get smaller, then fall back to
  one row of characters and a line of names, and to a list only when there is no room at all. On Windows the
  classic console cannot draw the characters; `doctor` and the README point to Windows Terminal.
- **Profiles.** `do-it-all-claude-code config set profile save|balanced|quality` (or the team office's Settings
  tab) moves a set of values at once: where delegation starts, each level's team and its start steps, whether
  a slot steps down after easy results, and the per-request budgets (save 0.6 of the default, quality 1.5).
  `balanced` is the defaults as they were, so nothing changes until you pick another. A value you set yourself
  (`budgetsUsd`, `delegateFrom`, `stepDown`, a `teams.yaml`) stays above the profile. Only `balanced` has a
  measurement behind it; `save` and `quality` are not measured yet, and reproduce first is in no profile.
- **What the team office's tabs read.** The daemon now records what each subtask changed (the files, with
  added and removed lines) and every step change of a slot with its reason, and serves them, sealed like the
  rest of its API, for the Work, Savings, Team and Settings tabs. Savings keeps what was spent apart from two
  estimates: the workers' tokens at the lead model's list price (with its assumptions spelled out), and the
  comparison with requests the lead handled alone (with how many there are and how many are needed). A
  request's prompt is never in a panel answer; `data export` has it when `recordPrompts` is on. The ledger
  schema is now version 18.
- **Settings from the panel.** The Settings tab writes through the same validation and into the same settings
  history as the CLI (`config history` shows the source `office`). Keys that `init` and `mode` own are refused
  there too. New keys: `profile`, `officeAutoOpen`, `autoStart`; `reproduceFirst` can now be set with
  `config set`.
- **One-command install and auto-start.** `npx do-it-all-claude-code setup` (or `npm i -g do-it-all-claude-code`
  then `do-it-all-claude-code setup`) installs the plugin and a status line, copies the engine into your router
  home, and starts the daemon on your Claude subscription. Or, from inside Claude Code, add the marketplace,
  `/plugin install do-it-all-claude-code@do-it-all`, then run `/do-it-all-setup`. After setup the daemon starts
  itself when a Claude Code session starts (`autoStart`, on by default; `config set autoStart off` turns it
  off), launched detached with a minimal environment that does not inherit your credentials. `uninstall` undoes
  it, including the engine copy and auto-start. When the router is not reachable, a team worker is refused at the
  moment the lead tries to spawn it — rather than after it has started and spent tokens only to be blocked at its
  first write — with a message to make the change yourself or run `do-it-all-claude-code start`.
- **Project worktree isolation, asked when first used.** Whether a project runs subagents in parallel git
  worktrees is asked the first time the team is used there — the lead asks you once — instead of at install.
  `do-it-all-claude-code project enable|disable|status` sets or shows it; the choice is kept in the router home
  and nothing is written to the project until you enable. Declining keeps the team and coordinates edits on the
  shared checkout.

### Changed

- **License: Business Source License 1.1.** From this release the code is under BSL 1.1 (`BUSL-1.1`), not
  Apache-2.0. You can use it for free, including at work to build, test and run your own software. Offering it,
  or a product whose value comes mainly from it, to others for a fee (selling, licensing, hosting, a managed
  service) needs a commercial license. Each version turns into Apache-2.0 four years after its release. 0.4.0
  and earlier stay under Apache-2.0. See `LICENSE` and `NOTICE`.
- **Writers that share your checkout are verified together.** When two writers with separate scopes work in
  the same work tree and one finishes first, the router checks only its scope and holds the build and tests
  until the last of them stops: a test run in between would judge the other's half-made changes. A pass of
  that last verify covers the held writers; when it fails, the lead is told whose changes it also saw. A
  writer in a work tree of its own is verified as before.
- **A background worker's verify result reaches the lead.** In an interactive session Claude Code runs
  workers in the background: the worker's report arrives first, as a message of its own, and the notification
  that follows raises no hook while the lead's turn is running. The report was taken for a new request, and
  the verify result never arrived, so the lead ran the tests again. Now the report belongs to the request it
  came from, and the result line waits for the lead's next step, whichever it is: a prompt, an Agent or
  router tool call, its own Bash, Read or edit call, or the end of its turn (which then goes on once). It is
  told once. While the router is still checking, the lead is told to wait instead of running the checks. The
  waiting line is kept in `lead-notes/` in the router's home until it is read: the result line only, never a
  prompt or a report.

- **Small requests stay with the lead.** When the router cannot tell a request's size from its wording, it asks
  the lead to check first whether the change is in one file and about 15 changed lines or fewer. If so, the
  lead reports it (`router_report_triage` now takes a `lines` estimate) and makes the change itself; no worker
  starts. A level set with `/router level` is kept.
- **A Sonnet lead keeps what the wording shows to be a small fix.** A short bug-fix or option request, or a
  short one with a log, used to go to one Haiku coder. On 20 public tasks that cost more than the lead doing
  it and solved one task fewer: the lead works out the fix to brief the worker, so the hand-off saved nothing.
  Such a request is now the lead's, with a three-line brief, when the lead is a Sonnet model or its model is
  not known yet (a session's first prompt). An Opus lead delegates it as before, and so does a lead class you
  set `delegateFrom` for yourself. Requests of unclear size are not changed.
- **Tests that cannot start are not a miss.** When pytest ends before any test ran (an import that fails
  during collection, a plugin that does not load, a usage error) and the error is in no file the worker
  changed, the worker still gets its one fix attempt. If the tests then fail to start again, the slot is not
  raised: the subtask ends unverified, and the lead is told once to read the change and to say that the tests
  could not be run here. Before, each such end counted as a miss and moved the work up to a stronger model,
  step after step. An import the worker broke (the traceback names a file it changed) is a failure as before.
- **A shorter first brief.** What the lead reads for a delegated request says each rule once: about 28% fewer
  characters for a request of unclear size and 15% for a team request. The lead-orchestrator skill is no
  longer announced as mandatory for every request; its description asks for it only when a delegation needs
  what the brief leaves out (a verify block, a step change, parallel writers).
- **No second test run.** A worker's passed notification lists each check with its result and how many tests
  passed, and tells the lead not to run the test suite again. When verify ran no tests for the change (none
  configured, skipped, or 0 tests), the lead runs only the changed code's tests, once. Each kind of check is
  listed once, in the lead's line, the office and the Work tab: two commands of a kind (the install and the
  build script, `npm test` and pytest) are one entry. A package.json script that does not exist
  (`npm run build --if-present` in a project without a build script) is not run and reads "skipped", not "ok".
- **Independent parts run at the same time.** The lead and the architect split a larger change into writer
  subtasks with write scopes that share no file and send them together; the architect's report lists each
  subtask's scope and what must finish before it. The router refuses a second writer whose scope can name a
  file of a writer still running, and says how to send it instead (split the scopes, or after the other one
  finishes); writers sent one after another are never refused. A worker that ran in its own worktree is named
  with the branch to merge.

### Removed

- **The browser dashboard.** `do-it-all-claude-code dashboard` and the page the daemon served at `/dashboard`
  are gone, with the one-time code, the session cookie and the settings pages that belonged to them. What the
  page showed is in the team office inside Claude Code (`/office`: Office, Work, Savings, Team and Settings
  tabs).
  Settings are changed with the CLI (`config`, `preset`, `role`), as before.
  - For this release the command prints one line that names `/office`, and `/dashboard` on the daemon's port
    answers 410 with a line that says the same, so an old bookmark says what happened.
  - The numbers behind the page are still served, now as sealed routes like the rest of the daemon's API:
    `GET /router/v1/metrics/summary`, `/requests`, `/requests/<id>` and `/triage-report`, with the same
    parameters and answers. A `since` or `until` that is not a date is now refused (400).
  - From a checkout, the `npm run build:dashboard` step is gone and `npm ci` installs fewer packages (Vue and
    Vite are no longer dependencies).

## [0.4.0] — 2026-11-13

Fourth pre-release: an optional update check, and the end of two transitions from earlier releases.

### Update check (opt-in)

- The router can check for a newer release, off unless you turn it on. `do-it-all-claude-code init` asks
  (`[Y/n]`, Enter for yes; `--yes` turns it on, and with no terminal it is left unset); an existing install
  stays off until you turn it on, and `doctor` suggests it meanwhile. `do-it-all-claude-code update on|off|check`
  controls it later — `check` looks now whatever the setting and prints what you have against the newest
  release. When on, the daemon reads GitHub's public release list at most once a day (a failed try counts, so
  it does not retry in a loop), following your `HTTPS_PROXY`/`NO_PROXY` and skipping an unusable proxy rather
  than going around it. GitHub sees an ordinary web request (your IP address and a generic client name);
  nothing else is sent — no prompts, no usage, no identifiers. A newer version shows in the status line and
  as a one-line message at session start, to you only (never sent to the model) and at most once a day per
  version. There is no auto-update.

### Changed

- `bearerApi` is now **off by default**: the daemon's local API accepts only sealed messages. `bearerApi: on`
  still works this release for a client from before sealing, but it is **deprecated** — `doctor` warns and the
  daemon logs a line — and will be removed.
- The legacy `.agentic-router/` project folder is **no longer read**. `doctor` and `do-it-all-claude-code
  policy show` tell you to rename it to `.do-it-all-claude-code/`; once renamed, a policy you had already
  accepted counts again (acceptance is keyed by the repository and the file's content). Both names stay
  write-protected for workers.

### Upgrading

- If a project still has a `.agentic-router/` folder, rename it to `.do-it-all-claude-code/` — its contents
  are otherwise ignored now. An already-accepted policy is recognized again after the rename, with no need to
  accept it afresh.
- Upgrading straight from 0.2.0 or 0.3.0 to this release still migrates your home: run
  `do-it-all-claude-code init`, which moves an old install as described under 0.3.0.

## [0.3.0] — 2026-11-13

Third pre-release: the project is renamed. Nothing else changes in how it works.

### Renamed to Do It All Claude Code

- The project is now **Do It All Claude Code** (was Agentic Router Proxy). The CLI and the published
  package are `do-it-all-claude-code`, so the install name is the command; the internal packages are
  `@do-it-all-claude-code/{core,daemon,adapter-claude-code,proxy,dashboard}`, the proxy binary is
  `do-it-all-claude-code-proxy`, the router home is `~/.do-it-all-claude-code`, the per-project folder is
  `.do-it-all-claude-code/`, the environment variables start with `DO_IT_ALL_CLAUDE_CODE_`, and the agent
  types are `do-it-all-claude-code:coder` and the like. The repository is now
  `github.com/ggreing/do-it-all-claude-code` (GitHub redirects the old URL).
- A project that still has a `.agentic-router/` folder keeps working this release: each file in it
  (`policy.json`, `verify.json`, `teams.yaml`) is read when the new `.do-it-all-claude-code/` folder does
  not have that file, and the new folder wins where both do. `do-it-all-claude-code doctor` flags the old
  folder so you can rename it, and an accepted policy carries over the rename.

### Upgrading from 0.1.0 or 0.2.0

- Stop the old install with the **old** CLI first, from your current checkout:
  `node packages/cli/src/index.ts stop`.
- `git pull`, then `npm ci` and `npm run build:dashboard`. The remote is now `ggreing/do-it-all-claude-code`;
  GitHub redirects the old URL, and you can update your remote with
  `git remote set-url origin https://github.com/ggreing/do-it-all-claude-code`.
- Run `do-it-all-claude-code init`. When it finds an old install (the folder named by
  `AGENTIC_ROUTER_HOME`, or `~/.agentic-router`), it lists what it will change — including, by pid, the
  processes it will stop — and asks first. On yes it stops the old supervisor, daemon and proxy; moves the
  router home (ledger, tokens, the TLS certificate and bundle, config) to `~/.do-it-all-claude-code`; backs
  up Claude Code's settings (the backup is named in its report) and rewrites only its own entries there — its
  MCP tools, its agent types, rules for its own commands, the status line, the key helper, env values such as
  `NODE_EXTRA_CA_CERTS`, and paths under the old folder — leaving your other rules exactly as they are; and
  moves the API key in the OS keychain to the new name without showing it (on macOS you paste it once when
  asked). It prints what moved.
- `init` only migrates a source that is a real folder (not a link), holds the router's config or token, and
  on macOS and Linux is owned by you; otherwise it changes nothing and says why. It stops only processes it
  can confirm are the previous release's; if it cannot confirm one, it leaves everything and asks you to stop
  it. If both an old and a new install already exist, it changes nothing and says so.
- Then `do-it-all-claude-code start`, and restart any open Claude Code sessions. After migration
  `AGENTIC_ROUTER_HOME` is no longer read; `doctor` warns when it is still set ("previous home",
  "AGENTIC_ROUTER_HOME").

## [0.2.0] — 2026-11-13

Second pre-release: mostly security work for shared machines and API-key mode, plus better triage outside English.

### Upgrading from 0.1.0

- Run `agentic-router stop`, then `git pull`, `npm ci` and `npm run build:dashboard`, then
  `agentic-router start`: the daemon needs a restart for the sealed messages and, on macOS and Linux, the
  socket. Restart open Claude Code sessions too; the plugin is read from your checkout.
- In API-key mode, run `agentic-router mode api` once. It makes the local certificate and switches Claude
  Code's settings to `https://127.0.0.1:<port>`.
- The daemon still accepts the 0.1.0 way of calling it (the token sent as a header) for this release, so
  sessions that were open during the upgrade keep working. It is controlled by `bearerApi` and will be off
  by default in the next release.

### API-key mode

- The proxy now holds each request's worst case — its prompt size and `max_tokens` priced at the model's
  highest rates — against the daily caps until the request finishes, and refuses a request that would not
  fit. This tightens the budgets that 0.1.0 noted were not hard caps.
- **Corporate proxy support.** The proxy reaches the API through the proxy your environment names (the first
  of `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, with `NO_PROXY` honoured), using Node's
  built-in proxy support (Node 24.5+): HTTPS goes through a CONNECT tunnel with the API's certificate still
  verified end to end. A TLS-inspecting proxy needs its root certificate trusted by Node (e.g.
  `NODE_EXTRA_CA_CERTS`); SOCKS is not supported, and an unusable proxy setting stops the router from
  starting rather than going around it. So that Claude Code's own calls to the local proxy are not sent
  through the corporate proxy, `init --mode api` and `mode api` add `127.0.0.1` and `localhost` to
  `NO_PROXY` in Claude Code's settings (keeping your entries); `mode direct`, `mode subscription` and
  `uninstall` remove only what they added. `agentic-router doctor` checks both directions.
- Pricing knows Claude Fable 5.2, charges fast-mode requests at their real rate, and prices Fable 5.1 cache
  reads correctly (they were overestimated).

### Security

- Messages between the router's own programs (hooks, status line, MCP server, CLI) and the daemon are now
  encrypted and authenticated with a key derived from the token. A program that takes the daemon's port
  while it is down can read neither the token nor your prompts and cannot answer in the daemon's place.
- On macOS and Linux the router's programs reach the daemon through a Unix socket in the router home that
  only your user can enter, and never fall back to the port when the socket is gone; Windows keeps the
  local port with sealed messages.
- In API-key mode the proxy serves Claude Code over local TLS: a private certificate, held only by this
  router and valid for `127.0.0.1` and `localhost` only, that Claude Code trusts through
  `NODE_EXTRA_CA_CERTS` in its settings (bundled with any certificate you already trust there, and restored
  on a mode switch and `uninstall`). The local-token helper prints the token only after the proxy proves it
  holds the current one, and the proxy writes a fresh token at every start, so an old token is refused.
  Without `openssl` the proxy stays on plain HTTP and `doctor` says so.

### Delegation

- A reviewer's or tester's verdict can name the writer subtask it is about with a `Subtask:` line, so a
  reject that covers several writers is credited to the right one instead of to none.
- Triage handles more languages more accurately: Traditional Chinese task sets, Korean grammatical particles
  after file names, and length thresholds weighted per script for CJK.

### The guard

- Path comparisons are canonicalized on both sides, and a directory is checked under every spelling it can
  take on Linux, macOS and Windows, closing cross-platform ways around a scope.

### Project

- Continuous integration builds and tests on Linux, Windows and macOS.

## [0.1.0] — 2026-11-12

First public pre-release.

### Modes

- **Subscription mode** (default): the plugin and a local daemon do all the work. There is no proxy,
  and no subscription credential is ever read or stored. Traffic goes straight from Claude Code to
  Anthropic.
- **API-key mode** (opt-in): a local proxy aggregates real token cost and applies daily budgets ($100
  per local token, $300 total, both configurable) plus a per-request budget. These are not hard caps:
  new calls are refused with a 429 once a budget is reached, but responses already in flight can go over
  it. The API key lives only in the OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret).
- **Direct mode**: connect with the API key, bypassing the proxy, if the proxy has a problem. Switch
  between modes with `agentic-router mode subscription|api|direct|proxy`.

### Delegation and the ladder

- Each request is triaged (stage 1 is rules only — no embeddings, no extra model call) and either
  handled directly by the lead or delegated to a right-sized subagent team (architect, coder,
  reviewer, tester, ui-designer).
- Which levels are delegated depends on the lead model; roles move up or down a model × effort ladder
  to finish at the lowest cost that still passes verification.
- The daemon runs each subtask's build/typecheck/lint/tests, records cost, and keeps a work ledger.

### Dashboard

- A read-only local web dashboard (served by the daemon at `127.0.0.1`) shows the request timeline,
  each request's team, steps and verify result, cost (lead vs. workers), KPIs, the triage-vs-actual
  learning report, and the auto-release panel. Available in English, Korean, Japanese and Simplified
  Chinese. All data stays on the machine.

### Privacy (defaults)

- Everything is stored in one local SQLite file; nothing leaves the machine except Claude Code's own
  traffic — the router makes no outbound call of its own, in either mode.
- The learning store keeps rule-derived features, outcomes, costs and numbers — not embeddings, and
  not prompt text unless you turn on `recordPrompts`. Turning it back off deletes the stored prompt
  text at the next daemon start. Logs and the dashboard mask API keys and tokens.

### The guard (and its limits)

- A guard in front of router subagents' tools refuses writes outside a subtask's scope, writes to
  credential and repository-config files, reads of credential files, and off-allowlist or
  environment-dumping commands. A refusal cannot be overridden by an allow rule.
- For ordinary Bash the guard is silent: Claude Code's own permission rules decide, as they would
  without the router. To let workers build and test without prompts, allow those commands (e.g.
  `Bash(npm test)`, `Bash(npm run *)`). See docs/worker-permissions.md.
- The guard is a net, not a sandbox: it reads the text of a tool call and does not observe what a
  program does once it runs. Workers run as your OS user; code you allow a worker to run has your
  file access. See SECURITY.md "Limits".

### Known limits

- Verify runs the related build/typecheck/lint/tests, so a fix that is wrong in a way those checks do
  not exercise can still pass.
- "Accepted" means no objection was seen, so the success/acceptance rate is an upper bound, not a
  measured approval rate.
- Auto-release is a brake against gross losses, not a fine optimiser; its default is **observe** and
  nothing switches until you turn `autoRelease` on.
- On a shared machine the local binding does not separate users; use it on a machine you don't share,
  or keep the daemon running. See SECURITY.md.
- API-mode budgets are not hard caps: new calls are refused with a 429 once a budget is reached, but
  responses already in flight can push the total over it. Sizing the reservation from a request's
  `max_tokens` and reserving against the per-request budget are planned after release.

### Install note

- `npm ci` installs dependencies but does not build the dashboard SPA. Run `npm run build:dashboard`
  (or the dashboard shows a short page telling you to). `agentic-router doctor` reports the build
  state.

[Unreleased]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ggreing/do-it-all-claude-code/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ggreing/do-it-all-claude-code/releases/tag/v0.1.0
