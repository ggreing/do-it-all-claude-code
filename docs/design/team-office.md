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

## The look (decision 182; the click as decisions 200 and 202 changed it)

- At rest each member is drawn in one fixed shape. Only three things move: the eyes, the sign above the head (z
  while waiting, sparkles when done, a drop when failed) and the monitor.
- A click picks the member, and the member reacts (decisions 200 and 202, `reactions.ts`): one of eleven everyday
  reactions chosen at random (nod, wave, hop, wiggle, stretch, squish, startle, shake, spin, hiding behind the desk
  and popping up, peeking out from behind the monitor); the status shows in its eyes and marks. Clicks less than
  1.6 s apart bring a bigger one (dizzy, huff). While it lasts the body stretches, squashes, jumps, shakes or turns,
  each reaction at its own pace, and it always ends in the shape the member had. A jump stays inside the desk: the
  small desk has one row over the head, so it jumps lower there, and a desk without a monitor peeks from behind the
  desk instead. The monitor is drawn in front of the member, so the member can go behind it. There are no speech
  bubbles.
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
  - else narrow desks (11 columns, the name and model lines only, four a row in a 120 x 30 terminal's dock);
  - then the session shrinks to its last line, then goes, the narrow desks kept;
  - then, cramped, the rows of narrow desks that fit without the title line, and the members left over on one line
    under them (`+1: reviewer · Sonnet medium · ○ waiting`, or `+3: reviewer, tester, designer`), each name a
    press that picks it, and 1–9 past the desks too. A 120 x 30 terminal's dock with a dialog open under the chat is
    53 x 12: four at desks and that line;
  - only when not even one row of desks fits, one line a member: the name, the model and effort, the status and its
    time, what it is doing, its session shrinking the same way. A press or 1–9 picks a member, as on the desks;
  - the layout moves down a step as soon as its step no longer fits, and back up only with two rows to spare. A
    dialog under the chat (a permission question, `/help`) takes 12 to 17 rows from the dock while it is open, and a
    spinner or a task list a row or two: the office does not flip between the desks and the list as they come and go;
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
  - the scene and the pointer are left out;
  - a dim line over the list says where the desks show ("Open in Windows Terminal to see the desks: this console
    draws them too wide"; decision 206: the person is pointed to Windows Terminal, and there is no ASCII drawing of
    the members for that console). A list for want of room has no such line. Only the terminal surface counts as
    that console: the desktop app draws the scene on the same machine.
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
- The tabs beside the Office read section 8's sealed routes (`/router/v1/metrics/{work,savings,team}` and
  `/router/v1/office/settings`). The dashboard's reads, moved from the cookie routes to sealed
  `GET /router/v1/metrics/{summary,requests,requests/:id,triage-report}` (section 6), stay for one release.
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
- Each tab beside the Office says in one line that it needs the router daemon.
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

## 4. Tabs (0.5.0, decision 193; as built)

Five tabs, a row of `Button`s at the top (the terminal has no tab element): Office, Work, Savings, Team and Settings.
Each one's first line answers one question; the detail follows. The data is section 8's; `tabs.tsx` draws the four
beside the Office, from what `register.tsx` reads, and every tab keeps within the frames' width (the body's less two
columns).

| Tab | Its first line | Below it |
|---|---|---|
| Office | the team's level, cost against budget and limits | the desks, or the list (section "The room and the terminal") |
| Work | what runs now, how today went (`1 running · today 4 done, 1 failed · $3.01`) | running requests first, then the recent ones: a line each with its mark, time, the level it ran at (`L1→L2`), the kind of work, the file it changed most and how many more, its time and cost. Enter opens one: the level and how it was judged, a timeline of plan, workers, verify and review on one time axis, each worker's step against what ran, its tries, step changes and checks, the files with git's stat bar, the tests, the time per phase, the cost |
| Savings | what was spent, measured, and the limits used | the 5-hour and 7-day limits as bars; spend per hour or day as columns; then, under "Estimated (not measured)", the lead-priced comparison with its assumptions shown as the daemon words them, and the holdout rows with their counts. A holdout row with too few requests says how many more it needs and shows no difference. No figure says "saved" |
| Team | the profile, the roles, the share of subtasks passed, step changes | each role's pass rate as a bar, its average cost and time, and its model and effort per level with where each comes from; the latest step changes; the triage's hit rate and the rules it flags at the bottom |
| Settings | the profile, how many settings are the person's own, how many problems | the problems, a line each; the change bar; every setting the daemon offers, grouped (profile, team, budget, quality, office, privacy, advanced), with the value in effect and where it comes from (`default`, `profile`, `own`, `project`, or the daemon's own note such as `profile x 0.6`); the profile's summary and whether a measurement backs it ("not measured yet" for save and quality); what needs typing, with the command that changes it; the keys init and mode own |

**Keys.** A Button's hotkey is one digit or one lowercase letter, and the tabs' must not meet the tabs' own:

- `o`, `w`, `s`, `t`, `c` switch to Office, Work, Savings, Team, Settings (`c` as the CLI's `config`). In a dock
  narrower than the five full labels the row says `Save` and `Config`.
- Office: 1 to 9 pick a member, `v` shows the picked agent's transcript in the main view. Work: `b` back. Savings
  and Team: `p` steps the period, 24 hours, 7 days, 30 days, all three shown with the current one marked.
  Settings: `a` asks, then `y` writes or `n` waits; `x` drops what waits.
- The engine's focus ring walks the buttons with ↑/↓ and Tab, and Enter presses the one under it. It starts on
  nothing, so a tab switch puts it on the tab's first request, period or setting (`$.ui.focus`, once that element
  is drawn), and a press on a tab takes the keys (granted only while the prompt holds no text).
- The ring is held at a position among the buttons, not on a key: buttons that appear above it would carry it to
  another row. The settings' change bar therefore always holds two buttons, and after a refresh the ring is put
  back on the key it was on (recorded from `ui.focus`).
- Not used: ←/→ in the pane (they never reach its buttons, and ← on an empty prompt hands the session to Claude
  Code's background sessions), the engine's `Select` (a drop-down whose ↑/↓ stay inside its list) and text input
  (decision 185).

**Settings writes.** Enter on a row puts its next value in the pending changes (an enum's options, off/on, a
number's `choices` or min to max by step); a value back at the one in effect is no change, and one back at what the
profile or the default gives is sent as `null`, taking the own value away. The rows show old → new until written.
`a` shows what will change and when it takes effect (now, next request, next session, next start), and `y` sends it:
one run of the helper with `--apply` and the change on stdin, which makes the one sealed POST (section 8.5) and
writes one line back. A refused change keeps waiting, with each problem on its own line; a 409 reads the settings
again. The module never sees the token; the helper checks the change's shape before sending it.

**Every tab, one line for a fault.** While the daemon is down, refuses the call or is not set up, each tab says so
in one line at its top, and the Office still draws from Claude Code's own events. A tab that throws while drawing is
replaced by a line of its own under the tab row, which stays.

**Classic console.** The tabs use the same one-cell marks as the list (`*`, `v`, `-`, `x`, `->`), bars of `#` and
`.`, and the words "2 up, 1 down" for step counts. The marks and characters the tabs add were measured in that
console: the block elements, `·` and `…` are one cell, `●` two.

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

**`recordPrompts`.** It governs what the daemon stores. The panel's calls read, but for the one settings write
(section 8.5), which holds settings and nothing of a session, so the rows never reach the ledger, whatever
`recordPrompts` says. The panel never shows a prompt (the user's choice for 0.5.0): the request detail carries
none, only whether one is kept, and the helper drops one should it come.

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
  - in Claude Code, `/office` with its Work, Savings, Team and Settings tabs (section 4);
  - for settings, the Settings tab, and `config`, `preset` and `role` for what needs typing;
  - the learning and routing views are in the Team and Savings tabs.
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
- The helper's tests against a test daemon: a line for each tab, a request's detail without its prompt, the one
  settings write (`--apply`) and the changes it refuses to send.
- `office-model.test.ts`: the tab keys and labels, the bars and columns in both sets of marks, git's stat bar, the
  Work line's parts and the timeline's cells, Savings' measured line and the holdout row, Settings' stepping,
  the `null` for an inherited value, the question and the answers' lines.
- The CLI's `config history` and `role reset`.

**`claude plugin test plugin/`** (the engine's kit):

- It starts from the prototype's tests (the demo seats the team, a press shows that member below, an empty office
  says how to fill it) and adds:
  - the five tabs and their keys, each drawn with the daemon down (a tab once threw on a local that hid the JSX
    factory `h`; `office-model.test.ts` refuses such a local in the office's `.tsx`);
  - each new tab from data in section 8's shapes: Work's list and a request's timeline, files and tests; Savings'
    measured first line, the estimates apart with their assumptions, a holdout row short of requests; Team's
    bars, levels and triage; Settings' rows, a change shown old → new, the question, one write through the
    helper with the change and the revision, a refused write with each problem, a dropped change;
  - the short labels in a narrow dock and the classic console's marks in the tabs;
  - a click's reaction (decision 200): it changes that member's drawing alone and ends in the shape it had, also
    after clicks in a row;
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

## 8. 0.5.0 tab data (decisions 193, 194)

The tabs become Office, Work, Savings, Team and Settings (decision 193), and Settings carries a profile
(decision 194). This section is the contract between the daemon and the panel: the routes, their JSON, and
what the panel may write. **Status: built** (`daemon/src/tabs.ts`, `daemon/src/office-settings.ts`,
`core/src/profiles.ts`; tests in `daemon/test/office-tabs.test.ts`). Where it differs from sections 3 and 4,
this section holds.

Common rules:

- Every route is sealed (decision 156) and reached through the helper, as today. Reads are `GET`; the one
  write is `POST`.
- Money is USD as a number, times are ISO strings, durations are milliseconds. A value the daemon does not
  know is `null`, never 0.
- A period is `24h`, `7d` or `30d`. The daemon computes `since` itself and returns it.
- No route returns the token, a machine path outside the repository, tool output or prompt text. File paths
  are relative to the repository. A stored prompt (`recordPrompts`) leaves the daemon through `data export`
  only; a request's detail says whether one is kept.
- `/router/v1/office` (the Office tab) stays as it is, with one field more: `project: { name, worktree:
  'on' | 'off' | null } | null`, the session's repository and whether parallel writers get a work tree each
  there (decision 192; the same field is in the settings view). The reads of section 6
  (`/router/v1/metrics/{summary,requests,requests/<id>,triage-report}`) stay for one release; the new tabs do
  not use them.

### 8.1 Work: `GET /router/v1/metrics/work`

Query: `session_id` (optional: marks this session's requests), `limit` (1–50, default 12), `before` (the
cursor a previous answer gave).

```ts
{
  open: WorkRow[],            // requests not closed yet, newest first; at most 10, none older than a day
  rows: WorkRow[],            // closed requests, newest first
  nextCursor: string | null,
  today: { done: number, failed: number, usd: number },   // closed since the daemon's local midnight
}
WorkRow = {
  requestId: string,
  state: 'open' | 'awaiting_user' | 'closed',
  mine: boolean,                               // of the session in the query
  createdAt: string, closedAt: string | null,
  kind: string | null,                         // the triage's kind of work
  level: Level, finalLevel: Level,             // judged, and what it ran at
  outcome: 'direct' | 'delegated' | 'no_delegation' | 'lead_takeover' | null,
  passed: boolean | null,                      // null while open
  acceptance: 'accepted' | 'not_accepted' | 'unobserved' | 'n/a' | null,
  subtasks: number, verifyFailures: number, stepUps: number,
  changedFiles: number | null, linesAdded: number | null, linesRemoved: number | null,
  files: Array<{ path: string, added: number, removed: number }>,   // the three with most changed lines
  durationMs: number | null, activeMs: number | null,
  totalUsd: number, estimated: boolean, unknown: boolean, budgetExceeded: boolean,
}
```

### 8.2 One request: `GET /router/v1/metrics/work/<requestId>`

It answers for an open request too (from the live tables) and 404 for an unknown id.

```ts
{
  requestId: string, state: WorkRow['state'], createdAt: string, closedAt: string | null,
  kind: string | null, taskType: string | null,
  level: {
    judged: Level,
    source: 'rule' | 'judge' | 'lead' | 'manual' | 'forced',
    rule: string | null, confidence: number | null,
    final: Level,
    changes: Array<{ from: Level, to: Level, why: 'manual' | 'forced' | 'replanned' }>,
  },
  plan: { preset: string, leadDirect: boolean, leadModel: string | null, leadClass: string | null,
          budgetUsd: number, holdout: 'direct' | 'probe' | 'released' | null },
  outcome: WorkRow['outcome'], passed: boolean | null, acceptance: WorkRow['acceptance'],
  subtasks: Array<{
    id: string, role: Role, slot: number, attempts: number,
    step: Step, model: string, effort: string,          // as planned for the last dispatch
    ranModel: string | null,                            // the model Claude Code resolved, when it said
    status: string, verdict: string | null,
    stepChanges: StepChange[],                          // the ones this subtask caused, oldest first
    scope: string[], unscoped: boolean,
    files: {                                            // what the subtask changed, recorded at its stop
      list: Array<{ path: string, added: number, removed: number,
                    state: 'new' | 'changed' | 'deleted', binary?: true }>,
      total: number, truncated: boolean,                // list holds at most 200
      approximate: boolean,                             // a file already differed from the start commit
    } | null,                                           // null: not recorded (older rows, no git, still running)
    checks: Array<{ kind: string, attempt: number, result: 'ok' | 'failed' | 'skipped',
                    testsPassed?: number, testsFailed?: number, durationMs?: number }>,
    repro: { required: boolean, state: string, reason?: string, files?: string[] } | null,
    review: { verdict: 'accept' | 'reject', by: 'lead' | 'reviewer' | 'tester', bySubtaskId?: string,
              margin?: 'easy' | 'normal' } | null,
    time: { startedAt: string | null, stoppedAt: string | null, runMs: number | null, verifyMs: number | null },
    cost: { usd: number | null, state: 'actual' | 'estimate' | 'unknown' | 'none',
            inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number },
  }>,
  changes: { changedFiles: number, linesAdded: number, linesRemoved: number, newFiles: number,
             deletedFiles: number, approximate: boolean } | null,          // the whole request; null while open
  files: Array<{ path: string, added: number, removed: number, state: 'new' | 'changed' | 'deleted' }>,
  tests: { passed: number, failed: number } | null,      // the test checks of each subtask's last attempt
  stepChanges: StepChange[],                             // every slot's, oldest first
  time: { durationMs: number | null, activeMs: number | null, awaitingMs: number,
          phases: Array<{ phase: 'lead' | 'workers' | 'verify' | 'awaiting_user', ms: number }> },
  timeline: Array<{ kind: 'plan' | 'worker' | 'verify' | 'awaiting_user', role: Role | null,
                    subtaskId: string | null, startedAt: string, endedAt: string | null, ok: boolean | null }>,
  cost: { totalUsd: number, leadUsd: number | null, workerUsd: number, budgetUsd: number,
          estimated: boolean, unknown: boolean, budgetExceeded: boolean, basis: 'proxy' | 'transcript' },
  hasPrompt: boolean,          // a prompt is kept for it (recordPrompts); its text is not in this answer
}
StepChange = { at: string, requestId: string, subtaskId: string | null, role: Role, slot: number,
               from: Step, to: Step, direction: 'up' | 'down',
               reason: 'miss' | 'rejected' | 'escalation' | 'easy',
               detail: string | null }   // the escalation's reason word (wrong_result, review_reject, …)
```

- `checks` are verify's own runs (build, typecheck, lint, test, scope, and whatever a project's list names),
  every attempt, with the time each took.
- `phases` are computed from stored times: `workers` is the union of the subtasks' run spans, `verify` the sum
  of the checks' durations, `awaiting_user` the time the request waited for the user, `lead` the rest. They
  add up to `durationMs`.
- Two things are not stored today and are added (ledger schema v18): a subtask's changed files with their
  line counts, taken from the work tree when verify runs at its stop, and a row per step change with its
  reason. Requests from before the change have `files: null` and no `stepChanges`.

### 8.3 Savings: `GET /router/v1/metrics/savings?period=`

Measured and estimated values are separate objects, and every estimate carries its assumptions as text.

```ts
{
  period: '24h' | '7d' | '30d', since: string, until: string,
  measured: {
    cost: {
      label: 'billed' | 'api-equivalent' | 'mixed',   // billed: counted by the API-mode proxy; api-equivalent:
                                              // tokens from transcripts at list prices (a subscription is not
                                              // billed so); mixed: the period holds requests of both kinds
      totalUsd: number, leadUsd: number, workerUsd: number,
      requests: number, passed: number, costPerPassedUsd: number | null,
      bySource: { proxy: number, transcript: number },      // requests by where their cost came from
      flags: { estimated: number, unknown: number, budgetExceeded: number },
    },
    limits: SessionLimits | null,             // as the status line last reported them; the object
                                              // /router/v1/office gives (fiveHour, sevenDay: usedPercentage and
                                              // resetsAt in epoch seconds; updatedAt)
  },
  estimated: {
    leadPriced: {                             // "the workers' tokens at the lead model's list price"
      workerUsd: number, atLeadPriceUsd: number, differenceUsd: number,   // both sides at standard list prices
      requests: number,                       // delegated requests it covers
      leftOut: { noLeadModel: number, noPrice: number, noTokens: number },
      assumptions: string[],
    },
    holdout: Array<{                          // real requests the lead handled alone, against the teams
      leadClass: string, level: Level,
      team: { n: number, accepted: number, costPerAcceptedUsd: number | null },
      direct: { n: number, accepted: number, costPerAcceptedUsd: number | null },
      need: { team: number, direct: number },
      enough: boolean,                        // false: say "not enough requests yet", show no difference
      differencePct: number | null,           // team against direct, per accepted request; null unless enough
    }>,
    holdoutRate: number, holdoutMode: 'on' | 'observe' | 'off',
  },
  series: {
    unit: 'hour' | 'day',                     // hour for 24h, day otherwise; in the daemon's local time
    utcOffsetMinutes: number,
    points: Array<{ start: string, requests: number, passed: number,
                    totalUsd: number, leadUsd: number, workerUsd: number,
                    leadPricedDifferenceUsd: number | null }>,   // the estimate's share of this bar; null: none
  },
}
```

- `leadPriced` is a counterfactual, not a measurement. Its `assumptions` say so in words the panel shows as
  they are: the lead would have used the same tokens as the workers did; list prices; the lead's own cost is
  the same in both cases; briefing and coordination cost is not taken out. A request whose lead model or
  price is not known is left out and counted.
- `holdout` is the only comparison made of real requests. It is small by design (the holdout share is 10%),
  so `enough` is usually false for a new install; the panel then says how many are still needed.
- The panel shows no percentage "saved" without one of the two labels.

### 8.4 Team: `GET /router/v1/metrics/team?period=&session_id=`

```ts
{
  period, since, until,
  profile: { value: 'save' | 'balanced' | 'quality', source: 'default' | 'own' },
  leadClass: string | null,                   // of the session, when known: it decides where delegation starts
  delegateFrom: { value: Level, source: Source } | null,
  roles: Array<{
    role: Role,
    levels: Array<{ level: Level, count: number, step: Step, model: string, effort: string, source: Source }>,
    stats: { subtasks: number, passed: number, failed: number, passRate: number | null,
             avgCostUsd: number | null, avgRunMs: number | null, stepUps: number, stepDowns: number },
  }>,
  stepChanges: StepChange[],                  // the latest 20 of the period, newest first
  triage: TriageReport,                       // as /router/v1/metrics/triage-report gives it today
  routing: RoutingView,                       // the auto-release view the Routing tab showed
}
Source = 'default' | 'profile' | 'own' | 'project'
```

`own` is the user's `config.json` or `teams.yaml`; `project` is the repository's
`.do-it-all-claude-code/teams.yaml`, known only when the session's folder is.

### 8.5 Settings: `GET` and `POST /router/v1/office/settings`

`GET ?session_id=`:

```ts
{
  revision: { config: string, presets: string },
  profile: {
    value: 'save' | 'balanced' | 'quality', source: 'default' | 'own',
    options: Array<{ id: string, title: string, summary: string,
                     sets: Array<{ path: string, value: unknown }>,      // what the profile gives
                     measured: string | null }>,                         // the measurement it rests on, or null
  },
  items: Array<{
    path: string,                              // what POST takes: a config key, or team.<level>.<role>.<field>
    group: 'profile' | 'team' | 'budget' | 'quality' | 'office' | 'privacy' | 'advanced',
    title: string, description: string,
    type: 'enum' | 'boolean' | 'number' | 'integer',
    options?: string[], min?: number, max?: number, step?: number,       // enough to draw buttons: no text input
    optionLabels?: Record<string, string>,                               // a step's model and effort ("haiku low")
    choices?: number[],                                                  // the values a number is stepped through
    value: unknown, source: Source,
    sourceNote?: string,                                                 // how, when not plain: "profile x 0.6"
    default: unknown, profileValue?: unknown,                            // what it would be without the own value
    appliesAt: 'now' | 'next request' | 'next start' | 'next session',
    editable: boolean, why?: string,                                     // why not, when it is not
  }>,
  team: Array<{ level: Level, leadDirect: boolean, budgetUsd: number,
                roles: Array<{ role: Role, count: number, step: Step, model: string, effort: string,
                               source: Source }> }>,
  text: Array<{ key: string, title: string, value: string, command: string }>,   // no buttons for these: the
                             // verify commands in effect, each role file, the whole teams.yaml, with the CLI
                             // line that edits each
  project: { name: string, worktree: 'on' | 'off' | null } | null,       // the session's repository: whether
                             // parallel writers get a work tree each (decision 192); null: not asked yet
  problems: Array<{ path: string, message: string }>,                    // a file or value that is being ignored
  managed: Array<{ key: string, reason: string }>,                       // init's and mode's keys: never editable
}
```

`POST` body: `{ revision: { config?: string, presets?: string }, set: Record<string, unknown> }`. A value of
`null` removes the own value, so the profile's or the default applies again. Paths:

- a config key as the CLI takes it: `profile`, `reproduceFirst`, `office`, `officeAutoOpen`, `autoStart`,
  `updateCheck`, `recordPrompts`, `eventRetentionDays`, `stepDown`, `budgetsUsd.L2`, `delegateFrom.sonnet`, and
  the advanced `holdoutRate`, `autoRelease`, `forceLevel`, `fableOptIn`;
- `team.<L1|L2|L3>.<role>.start` (a step) and `team.<level>.<role>.count` (0–4), written to the user's
  `teams.yaml`.

Answers, in the shape the CLI's routes use:

- 200 `{ ok: true, changed: string[], nextStart: string[], notes: string[], revision: { config, presets } }`
- 400 `{ ok: false, errors: [{ path, message }] }`: every problem, nothing written
- 409 `{ ok: false, errors: [{ path: 'revision', message }] }`: the file changed since it was read

A key that `init` or `mode` owns is refused with its reason, as in the CLI. The write goes through the same
core as the CLI's, so it is validated the same way and lands in the same settings history, with source
`office`. (The history's old `dashboard` source stays readable; nothing writes it.)

**The profile.** `profile` is one config key (`do-it-all-claude-code config set profile quality` does the
same as the panel). It gives a set of values that sit between the defaults and the user's own settings: a
value the user set stays, and its `source` says `own`.

| | save | balanced | quality |
|---|---|---|---|
| Delegation starts at | as balanced | L1 for Opus, Sonnet and unknown leads, L2 for a Haiku lead | L2 for every lead: the lead does L1 itself |
| L1 team | coder ×1 s1 | coder ×1 s1 | none |
| L2 team | coder ×2 s1, tester s1 (the lead reviews) | architect s3, coder ×2 s1, reviewer s3, tester s1 | architect s4, coder ×2 s2, reviewer s4, tester s2 |
| L3 team | architect s4, ui-designer s3, coder ×2 s3, reviewer s3, tester s1 | architect s5, ui-designer s3, coder ×2 s5, reviewer s5, tester s1 | architect s6, ui-designer s4, coder ×2 s5, reviewer s6, tester s3 |
| Step down after easy results | on | on | off |
| Budget of one request | default × 0.6 | default | default × 1.5 |

- `balanced` is the defaults as they were, so an install without the key behaves as before.
- Only `balanced` has a measurement behind it; its text points to `docs/measurements` and gives no number,
  because the figures change with each run of the bench. `save` and `quality` say "not measured yet".
- Reproduce first is in no profile until its own measurement is in: it stays off unless the user turns it on.
- A budget the user set (`budgetsUsd`, or `budget_usd` in a teams.yaml) wins over the profile's; the view
  shows the value in effect and how it came about (`profile x 0.6`).
- The lowest budgets (`save`: $0.30, $1.20, $3, $9 for L0 to L3) stay well above what the measured requests
  cost: the dearest L1, L2 and L3 requests of the decision 107 run cost $0.47, $1.29 and $3.07 in total, lead
  included, and the budget bounds the workers' part only.

**Verify commands.** The project's `.do-it-all-claude-code/verify.json` is read from the start commit, so an
edit takes effect only once it is committed, and its lines run as the user. The panel shows the commands in
effect and where they come from (an entry of `text`); editing stays in the repository.

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
     tab's data (Work and a request's detail every 3 s; Savings and Team for a period, and Settings, every 10 s);
     with `--apply`, the one settings write, and then it ends;
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
   tabs are Office, History, Cost and Routing. (0.5.0: decision 193 replaced them with Work, Savings, Team and
   Settings; section 4.)
8. **`claude plugin test`:** in the release checklist only.
9. **Opening by itself:** at a request's first worker, on wide terminals only.
10. **`/dashboard` after removal:** during 0.5.0 it answers with a line naming `/office`.
11. **No input line in the office** (decision 185). The panel only shows; the prompt stays the one place to type.
