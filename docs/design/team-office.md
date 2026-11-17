# Design note: the team office (decisions 180–184)

The team office is a panel inside the Claude Code terminal. Across the top, the request's team sits at desks as
characters. Below them is the session of the member you pick. It replaces the browser dashboard (decision 183)
and ships in 0.5.0 (decision 184).

**Status: decided (decisions 185 and 186, listed at the end), being built.** The look is the approved prototype
(decision 182). Points marked *to verify* are assumptions about Claude Code that a run in a real session must
confirm; [session-checks.md](session-checks.md) puts them in the order to check them in.

The office uses Claude Code's plugin interface extension: a hooks module named under `modules` in
`hooks/hooks.json`, a `Pane` it draws, and a `Client` surface module that draws the scene with its own frame
clock and the pointer. That interface is early access ("this surface may change between releases without
notice", says its declaration file). Every choice below follows from that: a change in Claude Code may cost the
panel, never the router.

## The look (fixed, decision 182)

- Each member is drawn in one fixed shape. Only three things move: the eyes, the sign above the head (z while
  waiting, sparkles when done, a drop when failed) and the monitor.
- A click presses the member down for a moment and picks it. There are no speech bubbles and no jumping.
- The office is at the top; the picked member's session is in the space below, drawn the way Claude Code draws
  its own rows (a dot for a tool call, `⎿` for its result).
- Under each desk are three lines: the name, the model and effort (`Haiku · low`), and the status with the
  elapsed time. The session header shows the effort too.
- The model and effort come from the `turn.step` hook (a streaming hook, `async function*`), which reads
  `e.model` and `e.effort` of every model request, per agent.

## The room and the terminal (as built)

- The office lays itself out in the room the pane has (`bodyColumns`, `scroll.bodyRows`; `officeLayout` in
  `model.ts`):
  - the desks when they fit with at least three session rows under them, and the back wall when that fits too;
  - else small desks: the same member in the same shape, without the monitor and with one row over its head
    (15 columns and 9 rows a desk against 22 and 11). The dock of a 120- or 160-column terminal is 54 to 69
    columns across, two full desks a row, and five members then need 36 rows of full desks; small desks take 20;
  - only when even those do not fit, one line a member: the name, the model and effort, the status and its time,
    what it is doing. A press or 1–9 picks a member, as on the desks;
  - in a room too low for frames, lines only, and a line on making the office taller (`ctrl+x tab`, then
    `ctrl+x up`). This is an inline pane the person made short: Claude Code keeps that height in their settings
    for every plugin pane, and it wins over the office's request. In fullscreen an inline pane gets at most a
    third of the room in any case.
- Every frame stops two columns short of the body's right edge, and the scene is only as wide as its desks. A line
  that reaches the terminal's last column is the first one a narrower window wraps; the classic console and the
  system ConPTY mark such rows as wrapped.
- When it opens, the pane asks for `columns` (docked: up to 45% of the terminal) and `rows` (inline).
- **The classic Windows console** is any Windows terminal that does not say which it is, decided as Claude Code
  decides it for its own figures (`unicodeTerminal`). There the office is always the list:
  - its marks are ones that console draws one cell wide (`*`, `v`, `-`, `x`, `>`, `->`), with single-line
    frames. Measured in that console, `●`, `○` and `→` take two cells where Claude Code counts one, so a row
    holding one is shifted and its later updates land beside it;
  - the scene and the pointer are left out.
  - The numbers seen in the prompt there come from Claude Code's own mouse tracking. Fullscreen turns it on with
    or without the office, and `CLAUDE_CODE_DISABLE_MOUSE=1` turns it off.
- `scripts/office-screen` (development only) runs Claude Code in a virtual terminal and checks these screens.

## 1. Where it lives in the product plugin

**Measured** with `claude plugin validate` on a copy of `plugin/` with the prototype's module added (Claude Code
2.1.325):

- One `hooks/hooks.json` may hold both the existing command hooks (`"hooks"`) and a hooks module
  (`"modules": ["../office/register.tsx"]`). Validation passes and lists the module's hooks, calls and state next
  to the command hooks.
- The module may live outside `hooks/`; the path is relative to `hooks.json`.
- The one error was the owner of the state values. A `$.state` value belongs to the plugin by name, so the
  prototype's `do-it-all-office` keys become `do-it-all-claude-code` keys. After that rename it passes.
- An unknown top-level key in `hooks.json` is ignored on this build, with no warning.

**Recommendation: one plugin.** The layout:

```
plugin/
  hooks/hooks.json         "hooks": {...} as today, plus "modules": ["../office/register.tsx"]
  office/register.tsx      events, state, the pane and its tabs
  office/scene.tsx         the Client module: the office scene (the prototype's office-scene.tsx)
  office/daemon.ts         the daemon client: sealed calls over $.http.fetch
  office/seal.ts           WebCrypto port of the client half of hooks/seal.mjs
  office/model.ts          pure functions: members and rows from events, daemon answers to view data
  office/test/*.test.tsx   claude plugin test
  types/office.d.ts        the PluginState contract ("types" in plugin.json)
```

Why not a second plugin in the same marketplace:

- It costs a second install and uninstall step in `init`, and a second entry in both marketplaces.
- It breaks decision 168's layout. The home marketplace's root is the effective plugin folder itself (source
  `"./"`), so a second plugin needs a new root holding two folders, and existing installs need a migration.
- The isolation it would buy, the engine already gives. A module that does not load, or a hook that throws, is
  skipped alone, and the command hooks keep running (*to verify* in a session: a module that fails to load
  leaves the plugin's command hooks working). If that check fails, the office becomes a second plugin,
  `do-it-all-office`.

**The effective plugin (decision 168).** `generateEffectivePlugin` copies every file of the template folder and
merges only `agents/*.md`. So `office/`, `types/` and the `modules` key reach `<home>/plugin` with no change to
the generator. The home marketplace is read in place, so after a regenerate `/reload-plugins` (or a new session)
loads the new module with no version bump. The role floor does not apply to the office files: like
`hooks/*.mjs`, they are template files and not role files.

**Packaging and install.**

- `scripts/build-npm.mjs` keeps copying `plugin/` whole. It leaves out `plugin/office/test/` and any
  `.claude-plugin/types/` (the engine writes that folder only into a plugin folder it hot-reloads; git ignores
  it). It stops building and copying `dashboard/dist` (section 6).
- `init`: no new install step; the office comes with the same marketplace install. Init's closing text gains one
  line: running Claude Code sessions pick the office up after `/reload-plugins` or a restart.
- The GitHub marketplace entry (`.claude-plugin/marketplace.json`, git-subdir `plugin`) is unchanged.
- `validate` also warns that the name "do-it-all-claude-code" "reads as one of Anthropic's own". That concerns the
  plugin directory's listing, not loading, and it predates the office.

## 2. The Claude Code version

- The router's minimum today is `MIN_CLAUDE` = 2.1.295 (`doctor`, blocking).
- The office needs the function-hook interface with `Pane`, `Client`, `turn.step` with `model` and `effort`,
  `$.http.fetch` with `socketPath`, and `$.state` with `atom` and `update`. The declaration file it was built
  against was written by 2.1.322; validation ran on 2.1.325.
- **Not known:** whether a build between 2.1.295 and 2.1.322 reads `"modules"`, and how a build without it
  treats the key. 2.1.325 ignores an unknown key silently, which suggests a lenient reader, but older builds were
  not tested. Testing one means installing an older Claude Code in a separate prefix.

**Recommendation:**

- Raise `MIN_CLAUDE` to the build the release's office tests pass on (2.1.322 or later; the exact number is set
  at release). `doctor` then blocks older builds for the whole router, so an old build never meets `"modules"`.
  The cost is that users on 2.1.295 to 2.1.321 update Claude Code first.
- The module reads `$.session.version()` at `session.start` and stays quiet below its own minimum. It sets no
  upper bound: a newer build is tried, and if its interface changed, the engine skips what fails.
- `doctor` adds a non-blocking line: it runs `claude plugin validate <home>/plugin`, which only reads the folder,
  and reports "team office: loads", or the first problem with "the router itself is not affected". So a Claude
  Code update that breaks the module is seen (*to verify*: validate's exit code and its JSON report).
- When the office cannot load, a session says nothing beyond what the engine logs. The status line keeps working:
  it is a command, not a module.

## 3. Daemon data

Claude Code's own events give who was spawned, the tool calls, the text, and the model and effort of each request.
The daemon adds:

- the request: level and its source (rule, stage 2, the lead's report, manual), preset, lead-direct, budget and
  spent;
- each subtask: id, role, slot, step, the step's planned model and effort, status, verdict, scope and agent id;
- verify: per check kind, ok, failed or skipped, tests passed and failed, and the reproduction outcome
  (decision 175);
- cost: the request's cost with its estimated and unknown flags, the session's cost, and the 5-hour and 7-day
  limits.

**Endpoints.** `GET /router/v1/status?session_id=` (sealed) has the request, the roles and the cost, but no
verify signals, no reproduction outcome and no limits. `router_get_plan` has subtasks and reproduction but no
signals, and it is a tool call bound to an instance. So:

- Add one sealed read endpoint, `GET /router/v1/office?session_id=<id>`. It returns the status view, plus per
  subtask the fields above with `checks: [{ kind, result, testsPassed, testsFailed }]` and `repro`, plus the
  latest limits. It carries no prompt text, tool arguments or output tails.
- The History and Cost tabs use the read functions the dashboard uses today (`daemon/src/metrics.ts`), moved from
  the cookie routes to sealed `GET /router/v1/metrics/{summary,requests,requests/:id}` (section 6).
- These routes live in `daemon/src/server.ts`.

**Transport.** Every call is sealed (decision 156), as the relay's, the status line's and the CLI's are.

- **A (recommended): `$.http.fetch`, sealed.**
  - Where the daemon has no private socket (Windows, or a socket it could not make), the module POSTs the envelope
    to `http://127.0.0.1:<port>/router/v1/sealed`.
  - Where `<home>/endpoint.json` names a socket (macOS and Linux), the module uses `socketPath`. The relay's
    rule holds: a named socket is used and only it.
  - The seal is AES-256-GCM with an HKDF-SHA256 key. The module environment has both in `crypto.subtle`, and
    WebCrypto appends the tag after the ciphertext as Node does. `office/seal.ts` ports the client half, and a
    test pins it byte for byte to `core/seal.ts`, as one does for `hooks/seal.mjs` today.
- **B (fallback): `$.process.run`** of a small Node bridge that reuses `hooks/seal.mjs`. It needs no port, but it
  starts a Node process on every poll (roughly 100–300 ms on Windows) and needs `node` on the PATH of the Claude
  Code process.
- **C (refused): an unsealed bearer call.** `bearerApi` is deprecated (0.4.0), and the token would travel in a
  header that other plugins' `http.fetch` hooks can read.

B is used only if A is refused in practice. *To verify:*

- An organization's web-fetch policy or a proxy setting could refuse or reroute a loopback URL.
- The `socketPath` doc says "one per session, in a private directory", which may limit the sockets allowed.

**The token.** The module reads `<home>/token` with `$.fs.read`, the same file the relay reads. It finds
`<home>` in this order:

1. `$.plugin.root` + `/..`, when the plugin runs from the home marketplace (`<home>/plugin`) and
   `<home>/config.json` exists beside it;
2. else `$.env.get("DO_IT_ALL_CLAUDE_CODE_HOME")`;
3. else `$.env.get("USERPROFILE")` or `$.env.get("HOME")`, plus `/.do-it-all-claude-code`.

`validate` lists the environment names a module reads, so these three show in its report.

**What reading the token means for security:**

- **Trust does not widen.** It is the secret the command hooks already read, read as the same user by the same
  Claude Code process.
- **It stays in a module variable only.** It never goes in `$.state` (any plugin can read any state value), never
  in `$.store` (a JSON file in the Claude Code configuration folder), and is never logged or drawn.
- **Requests and answers are sealed.** Another plugin that hooks `http.fetch` sees ciphertext. It cannot answer
  either, because an answer must be sealed with the token and bound to the request's nonce. A program holding the
  port while the daemon is down learns nothing (decision 156's property, kept).
- **Another installed plugin can hook `fs.read` and see the token as it is read.** That plugin could read the file
  itself just as well (`$.fs.read`, or a command hook), so this exposure is not new. The rule stays as it is today:
  an installed plugin is trusted with the user's files. SECURITY.md says so.
- **The office only reads.** Settings edits stay in the CLI (section 6), so a fault in the module cannot change a
  setting.
- **The token is re-read after an authentication failure** (`token rotate` and a re-init change it), at most once
  a minute.

**Polling.**

- The module polls only while the pane is open: `$.clock.every(1000)` starts at `ui.open` and stops at `ui.close`
  and `session.end`.
- It also calls once at `agent.spawn`, at a task notification and at `turn.complete`.
- Each call has the relay's 1.5 s timeout.
- `$.state` is written only when the answer changed (a hash compare), so a quiet team redraws nothing.

**When the daemon is off**, the office still draws from Claude Code's own events: members, rows, model and effort.

- Fields only the daemon knows stay blank.
- The office's top line shows one dim line, in the status line's words: "router daemon not reachable — run
  do-it-all-claude-code start".
- Polling backs off from 1 s to 5 s to 30 s, and returns to 1 s after a success.
- The History and Cost tabs say they need the router daemon.
- There are no toasts and nothing is spooled: the relay spools hook events, but the office has nothing to replay.

**Matching members to subtasks.** The office keys members by Claude Code's agent id: the `agentId` that
`agent.spawn` resolves, and `e.agentId` on `tool.call` and `turn.step`. The daemon keys agents by the
`agent_id` of `SubagentStart`. *To verify:* the two are the same id. If they are, a member joins its subtask by
agent id, and its label comes from the subtask tag (`[subtask:A]` gives "coder A") instead of the order of
spawning.

**The step against the effort it ran at.** The daemon plans each subtask at a step (s1 to s7, each a model and an
effort), and its PreToolUse check makes the Agent call carry those. A request can still run at less: Claude Code
lowers effort to the organization's cap, the `maxEffortLevel` setting or the model's own levels, and
`CLAUDE_CODE_EFFORT_LEVEL` caps it. Decision:

- The desk shows what `turn.step` reports, the model and effort of the member's last request, as the prototype
  does.
- The session header shows the step and its plan, for example `coder A · s2 (Haiku high)`.
- When the real values differ from the plan, the header adds `ran at Haiku medium` in the warning color.
- The desk itself gets no extra mark, because the desk stays fixed.
- The lead has no step. Its header shows the request's level, the level's source and the budget.

## 4. Tabs, and what moves from the dashboard

The pane has three tabs: Office, History (recent requests) and Cost. The terminal has no tab element, so they are a
row of `Button`s at the top. Their hotkeys are letters, because the scene uses the digits 1 to 9 to pick members.

| Dashboard tab | What happens to it |
|---|---|
| Now (live request, roles, cost against budget, limits) | **Office tab**, already covered: the top line has level, cost against budget and limits; each desk is a role |
| Requests (recent list, detail) | **History tab.** Rows: when, level (and the final level when it changed), outcome, accepted, cost, duration, verify failures. Enter opens a request in the space below: its subtasks with role, step and verdict, each check with tests passed and failed, the reproduction outcome, and the prompt only when `recordPrompts` is on. Dropped: the raw record JSON (`data export` has it) |
| Overview (summary, cost by level, flags, limits) | **Cost tab**: today / 7 days / 30 days; total, lead and workers, cost by level, cost per accepted request, accepted out of all; estimated, unknown and over-budget flags; the 5-hour and 7-day limits. Dropped from the panel: team fit, start-step fit, up rate, cache hit rate |
| Learning (triage report) | **Out of the panel.** A CLI command prints it as text (open point 7) |
| Routing (arms per class and level) | **Out of the panel.** The same CLI command prints it |
| Settings (config, presets, roles, history) | **CLI only**: `config`, `preset`, `role` and `reload` exist. Added: settings history and resetting a role to its template (section 6) |

**Keys:**

- `/office` opens the pane. It also opens itself at a request's first worker; the engine places an unasked pane
  only from 144 columns, so a narrow terminal is not covered.
- To focus the pane, click it or press ctrl+x then tab (the engine's keys). Esc returns to the prompt, and Tab and
  shift+Tab walk the buttons.
- `o`, `h` and `c` switch to Office, History and Cost.
- In Office: 1 to 9 pick a member, ← and → move the highlight, Enter picks, and `v` shows the picked agent's
  transcript in the main view (`$.ui.view`, which the engine allows only on the person's own key or click). The
  same member again clears the space below.
- In History: ↑ and ↓ move, Enter opens a request below, and Esc or Backspace goes back to the list. `l` cycles a
  level filter.
- In Cost: ← and → change the period.

## 5. Privacy

**What the panel holds.** Each member's rows:

- its text, cut to 160 characters;
- its tool calls: the tool's name and one argument, cut to 80;
- its results: a count, or the first line cut to 120.

The person's transcript already shows all of these.

**Where.** In `$.state` only: memory the host keeps for the Claude Code session. It survives a hot reload and is
gone when the session ends. Rows never go to `$.store`, which is a JSON file of the plugin's in the user's Claude
Code configuration folder, kept across sessions; it holds only view preferences (the last tab, the cost period).

**Who can read it.** Any plugin can read any `$.state` value. That adds no exposure: a plugin that wants the rows
can hook `session.append` and `tool.call` itself. Still:

- Before a row is written, the router's secret patterns (`plugin/hooks/secret-patterns.json`, the guard's list)
  mask it, so a key typed into a command is not repeated in the panel or in another plugin's read.
- At most 200 rows per member and 40 members are kept.
- Everything is cleared at `session.end`, which `/clear` also raises.

**`recordPrompts`.** It governs what the daemon stores. The panel sends nothing to the daemon (its calls only
read), so the rows never reach the ledger, whatever `recordPrompts` says. The History tab shows a request's
prompt only when `recordPrompts` is on: the daemon returns it only then, as it did for the dashboard.

**The scene module.** The `Client` receives the scene's props (names, roles, model and effort, status, the last
tool call) and nothing more.

## 6. Removing the browser dashboard

**Status: done** (decision 183) as listed below, with these differences:

- The metrics reads are the sealed `GET /router/v1/metrics/{summary,requests,requests/<id>,triage-report}`
  (`daemon/src/metrics-routes.ts`), with the same parameters and JSON. A `since` or `until` that is not a date is a
  400. The dashboard's `now` view is gone; `/router/v1/office` covers it.
- `/dashboard` and `/dashboard/*` answer 410 with one line naming `/office`.
- `config history` and `role reset` are still to come.

The list as it was planned:

**Code to delete:**

- `packages/dashboard/` (Vue, Vite, the views and the mock data), its `build:dashboard` script, its test glob in
  the root `test` script, and its CI step.
- Its devDependencies: `vue`, `vite`, `@vitejs/plugin-vue`, `vue-tsc` and its nested `typescript`.
  `package-lock.json` shrinks with them.
- In `daemon/src/`:
  - `dashboard.ts` as a whole: every `/dashboard` route, the one-time code (`register-code`, `auth`), the
    `ar_dash` cookie, the CSRF token with its Origin and Sec-Fetch checks, the CSP, and the static serving;
  - its wiring in `server.ts`;
  - `DEFAULT_DASHBOARD_DIST`;
  - the launch-page purge in `data.ts`, which `init` keeps doing once more (see "Upgrading").
- `metrics.ts` and `limits.ts`'s `latestLimits` **stay**. They become the sealed `/router/v1/metrics/*` and
  `/router/v1/office` routes.
- In `core/src/`:
  - `layout.ts`'s `dashboardDist`;
  - `settings.ts`'s `'dashboard'` source and the `CLI_ONLY_CONFIG_KEYS` refusal: the audit reader still reads
    old `'dashboard'` lines;
  - `role-overrides.ts`'s `textWithFields`, the per-field edit only the web form used.
- In `cli/src/`: `dashboard.ts`, the `dashboard` command and its usage text, and doctor's "dashboard assets" line.
- `scripts/build-npm.mjs`: the dashboard build and copy, and `dashboard/` in the package's `files`.
- `scripts/e2e.ts`: the dashboard check (R7). In its place goes a sealed check of `/router/v1/office`.

**Tests:**

- Remove:
  - `daemon/test/dashboard.test.ts`, `cli/test/dashboard.test.ts` and `dashboard/test/`;
  - the dashboard test in `daemon/test/server-dashboard.test.ts`; that file's other tests stay;
  - in `daemon/test/settings.test.ts`, the "front door" test and its helper;
  - the dashboard case in `daemon/test/canonical.test.ts`;
  - the dashboard-refusal case in `core/test/settings-review.test.ts`.
- Move: `daemon/test/metrics.test.ts` to the sealed routes.
- Change, where the dashboard is only mentioned:
  - `daemon/test/sealed.test.ts`, `delta-hardening.test.ts` (the launch page), `limits.test.ts`,
    `acceptance.test.ts`, `takeover.test.ts` (a test name);
  - `core/test/layout.test.ts`;
  - the `'dashboard'` source fixtures in `core/test/settings.test.ts`, `core/test/settings-review.test.ts`,
    `core/test/role-overrides.test.ts` and `cli/test/settings.test.ts`.

**Documents:**

- **The four READMEs** (en, ko, ja, zh-CN), at the same four places in each: the `npm run build:dashboard` install
  step, the `dashboard` row of the commands table, the dashboard section, and the "accepted in the dashboard"
  line under what does not work well yet. The section becomes "The team office", with `/office`, the three tabs and
  the keys.
- **Other repository files:**
  - CHANGELOG (an Unreleased entry and the upgrade steps);
  - SECURITY.md (its scope line about the dashboard; the token paragraph of section 3);
  - THIRD_PARTY_NOTICES.md (Vue's notice goes; the npm bundle still inlines zod and yaml, which it lists);
  - CONTRIBUTING.md;
  - the pull request and bug report templates;
  - `docs/release-checklist.md`.
- **Design notes and diagrams:**
  - `docs/design/settings-editing.md`: its section 2 ("Dashboard: an edit page, or stay read-only?") is marked
    superseded by decision 183;
  - `docs/design/reproduce-first.md` and `docs/design/distribution.md`, where they name the dashboard;
  - the architecture, module and roadmap figures in `docs/diagrams/src`.
- **Released notes stay as they were** (0.1.0 to 0.4.0).

**Settings after the web part.** The CLI already has:

- `config list|get|set|edit` (`set <key> default` resets a key);
- `preset show|edit [L0-L3]`;
- `role show|edit <role>` (the whole file in `$EDITOR`);
- `reload`.

The web had two edits the CLI lacks, and both are added:

- `config history`: it reads the sealed `/router/v1/settings/history`, which exists.
- `role reset <role>`: it sends the existing `{ reset: true }`.

The per-field role form is dropped; a whole-file edit covers it.

**Upgrading (0.4.0 to 0.5.0):**

- `do-it-all-claude-code dashboard` is gone. In its place:
  - in Claude Code, `/office` with its History and Cost tabs;
  - for settings, `config`, `preset` and `role`;
  - for the learning and routing views, the CLI command of open point 7.
- `/dashboard` on the daemon's port answers 410 with one line naming `/office`, for one release, so a bookmark
  says what happened.
- `init` regenerates the effective plugin, which now holds the office. Start a new Claude Code session or run
  `/reload-plugins`. `init` also deletes a leftover `<home>/dashboard-open.html`.
- Claude Code must be at least the new `MIN_CLAUDE`; `doctor` says so.
- From a checkout, the `build:dashboard` step disappears and `npm ci` installs fewer packages.

## 7. Tests and remaining risks

**`npm test`** (node:test; no Claude Code needed):

- The office's logic sits in plain `.ts` files whose `claude-code` imports are type-only, so they are empty at run
  time and node:test runs the files as they are:
  - `model.ts`: members from events and daemon answers, labels from subtask tags, the step-against-effort header;
  - `seal.ts`: for a fixed nonce and time, the same bytes as `core/seal.ts`, and each opens the other's messages;
  - finding the home and the token;
  - the backoff, the masking and the row caps.
- Daemon tests for `/router/v1/office` and `/router/v1/metrics/*`: the shape, sealed only, and a prompt only with
  `recordPrompts`.
- The CLI's `config history` and `role reset`.

**`claude plugin test plugin/`** (the engine's kit):

- It starts from the prototype's tests (the demo seats the team, a press shows that member below, an empty office
  says how to fill it) and adds:
  - the tabs and their keys, each tab drawn once (History once threw on a local that hid the JSX factory `h`;
    `office-model.test.ts` now refuses such a local in the office's `.tsx`);
  - the room's layouts (desks, small desks in a narrow dock, the list, lines only) and the classic console's list;
  - the daemon-off line;
  - a mocked `http.fetch` answering sealed responses;
  - the step-against-effort header;
  - `turn.step` forwarding the stream unchanged.
- Each test runs on both the terminal and the desktop surface.
- It needs the `claude` binary, so it is not part of `npm test`: CI has no Claude Code, and tests must not touch
  a real Claude Code configuration. It runs in the release checklist (open point 8).

**`claude plugin validate plugin/`** runs in the release checklist, and in `doctor` (section 2).

**Type-checking.** The root `tsc -b` does not see the engine's `claude-code` declarations: the engine writes them
only into a plugin folder it hot-reloads, and git ignores that folder. So `tsc -b` checks the office against a
declaration file of our own, `typecheck/office/claude-code.d.ts` (open point 4).

**Risks:**

- **The early-access interface changes.** A new build may rename an event or a prop. Then the hook is skipped or
  the pane is not drawn, and the router is unaffected. Against it:
  - `doctor`'s validate line;
  - tests run against the build named as the minimum;
  - `office: off` in `config.json`, which the module reads at `session.start` and which turns the panel off
    without uninstalling anything.
- **`turn.step` sits in the stream of every model request.** A bug there can harm the session itself, not only the
  drawing, which makes it the riskiest hook. Its body is one guarded state write followed by `yield* next(e)`, and
  a kit test checks that the chunks pass unchanged. *To verify:* what a stream hook that fails mid-stream does to
  the stream beneath it ("left where it stood").
- **Narrow terminals.** The engine places an unasked pane only from 144 columns, 110 once it was asked for, and
  `/office` opens it at any width. A desk takes 22 columns. Below 44 columns the scene falls back to a one-line
  roster, as the prototype does where there is no `Client`. Session rows are cut at their end.
- **Performance.**
  - The scene's frame clock ticks every 100 ms. With ten members that redraws about ten 10-row desks each tick.
    It is measured with a ten-member demo; if it is heavy, the tick goes to 200 ms, and the clock stops while no
    member works (the eyes then blink only while working).
  - The hooks write `$.state` on every tool call and every text block. If measurement shows lag, the writes are
    batched every 100 ms.
  - The daemon is polled only while the pane is open.
- **Gating hooks.** `validate` lists `tool.call`, `session.append` and `agent.spawn` as gating hooks. The office's
  hooks never refuse: each one calls `next(e)`, and its `.catch` calls `next(e)`. That pattern is required for
  every new hook.
- **The desktop surface.** A plugin installed at user scope also draws in the desktop app's local sessions, which
  is why the tests run on both surfaces.

## Decisions (185, 186)

The open points of this note were decided as follows. Where a decision differs from the text above, the decision
holds.

1. **Layout:** one plugin, with the module in `plugin/office/`.
2. **Minimum Claude Code:** `MIN_CLAUDE` rises, for the whole router, to the build the office tests pass on.
   `init` and `doctor` tell the user to update.
3. **Transport, as changed:** a long-lived Node helper, not `$.http.fetch`. The plugin environment's
   `crypto.subtle` has only `digest` (no AES-GCM, no HKDF; a probe under `claude plugin test` on 2.1.325), so the
   module cannot seal, and the cipher is not written by hand. While the pane is open the module starts one helper,
   `office/bridge.mjs`, with `$.process.spawn` (`node` from the PATH, as the plugin's command hooks use it). The
   helper:
   - reads the router home itself (config, endpoint file, token) and makes sealed calls with `hooks/seal.mjs`
     (node:crypto), so the module never handles the token and decision 156 holds: no unsealed route;
   - writes one JSON object per line on stdout, only when it changed: the office view every 1.2 s, and the open
     tab's data (History, a request's detail, Cost for a period, Routing) every 10 s;
   - writes no token and no prompt text (a request detail's prompt is dropped; the line says only that one exists);
   - backs off 1 s, 5 s, 30 s while the daemon does not answer;
   - ends when its parent process is gone (checked every 2 s), when stdout is closed (a short `alive` line every
     5 s makes that visible) or on a signal. The module ends it when the pane closes, at `session.end`, and with
     the module (the engine kills a spawned child then).

   `$.process.spawn` closes the child's stdin at the start, so the module cannot send it anything later: a change
   of tab, period or opened request starts a new helper with new arguments.
4. **Type-checking:** a declaration file of our own for the parts of `claude-code` the office uses, with
   `validate` and the kit as the real check. As built: `typecheck/office/claude-code.d.ts` holds what the
   module, the scene and the state contract use, under the engine's names, and `typecheck/office/tsconfig.json`
   puts `plugin/office/*.ts(x)` and `plugin/types/` under the root `tsc -b` with the options the engine gives a
   hooks module (no Node, no DOM, classic JSX on `h`). It lives outside `plugin/`, so it is not packaged and the
   engine never reads it. An office change that calls something new fails `tsc -b` until the declaration names
   it. The kit's tests are not checked there. `validate` type-checks the module against the engine's own
   declarations and reports no errors; the module imports `./model` without an extension, which the engine
   resolves and both checks accept. The pure parts (`model.ts`, `bridge.mjs`) run under `npm test`.
5. **Language:** English only. The prototype's Korean labels are translated.
6. **Default:** on. `office: off` in `config.json` turns it off.
7. **Learning and routing:** a fourth tab, not a CLI command (this replaces section 4's "out of the panel"). The
   tabs are Office, History, Cost and Routing.
8. **`claude plugin test`:** in the release checklist only.
9. **Opening by itself:** at a request's first worker, on wide terminals only.
10. **`/dashboard` after removal:** during 0.5.0 it answers with a line naming `/office`.
11. **No input line in the office** (decision 185). The panel only shows; the prompt stays the one place to type.
