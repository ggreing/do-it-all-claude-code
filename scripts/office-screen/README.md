# office-screen

Development only. Runs an interactive Claude Code with the router's plugin in a pseudo-terminal
([node-pty](https://www.npmjs.com/package/node-pty)), feeds what it draws into a headless terminal of the same size
([@xterm/headless](https://www.npmjs.com/package/@xterm/headless)), and writes the screen out as text at the steps you
give, with checks for the faults the team office has had. It is not part of the npm package or of CI, and its two
packages are not installed by the root `npm ci`.

```sh
npm install --prefix scripts/office-screen
node scripts/office-screen/run.mjs --home <router home> --cwd <repository> --cols 120 --rows 40 \
  "office demo; wait 3; shot open; click \"History\"; wait 2; shot history; drag 100 30; wait 2; shot narrow; quit"
```

- **No model request.** It never sends a prompt: it types slash commands (`/office demo`, `/reload-plugins`) and keys.
  Claude Code runs with your own login and settings, and the session leaves its usual records.
- **Your settings stay as they are.** Claude Code keeps the size a person gives a plugin pane (`ctrl+x` and an arrow,
  or a drag on its edge) in your settings, for every plugin's pane. The tool refuses `ctrl+x` followed by an arrow,
  and a click presses and lets go on one cell.
- **The router home and repository** are yours to give: a test home with its daemon running (`DO_IT_ALL_CLAUDE_CODE_HOME`
  is set to it) and a repository Claude Code may open. `--plugin` defaults to `<home>/plugin`, the copy the home runs.

The steps and options are listed at the top of `run.mjs`.

## What it checks

Each `shot` writes `NN-<name>.txt` (the screen, numbered rows, `↵` on a row the terminal wrapped onto, `|` on a row
that reaches the last column) and `NN-<name>.buffer.txt` (the scrollback too), and prints what it found:

| kind | meaning |
|---|---|
| `wrapped` | a line was wider than the terminal and went on to the next row |
| `edge` | rows that reach the last column, other than Claude Code's own rules: a narrower window wraps them first |
| `frame` | a rounded frame without its bottom on screen (taller than its room) or with a broken side |
| `leftover` | the office title more than once, scene glyphs outside every frame, or cells a full repaint (`repaint`) changed |
| `mouse` | a mouse report that reached the screen as text |
| `error` | a `do-it-all-claude-code: … skipped` line, a `TypeError` and the like |

`raw.log` holds what Claude Code wrote, one chunk a line; `--debug` adds Claude Code's own debug log.

## Terminals

- `--term wt` (default) sets `WT_SESSION` as Windows Terminal does; `--term conhost` sets nothing of a terminal, as the
  classic Windows console. Claude Code and the office decide on that which marks to draw.
- `--backend conpty-dll` (default) is the ConPTY node-pty ships, as recent Windows Terminal builds bring their own;
  `conpty` is the system's. After a resize the system's ConPTY repaints every row to the last column, so most rows
  then show as `wrapped` although nothing moved.
- `--backend winpty` runs Claude Code in a hidden classic console and reads that console's screen: its marks come out
  as wide as the classic console draws them. Its resize does not follow a real console window, and it passes no mouse
  mode on.
- `--tui default|fullscreen` picks Claude Code's renderer for the run (`--settings`); left out, yours.
