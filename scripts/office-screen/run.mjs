#!/usr/bin/env node
// Development only: runs an interactive Claude Code with the router's plugin in a pseudo-terminal, feeds what it
// draws into a headless terminal of the same size, and dumps the screen as text at the steps you ask for, with
// checks for the faults the team office has shown: lines wider than the terminal, broken frames, leftovers of an
// earlier frame, mouse reports typed into the prompt and error lines.
//
// It never sends a prompt: it types slash commands (/office demo, /reload-plugins) and keys only, so no model
// request is made. Claude Code runs with your own login and settings, which it does not change; it leaves
// the session's usual records. It refuses ctrl+x followed by an arrow, which resizes a plugin pane and is kept in
// your settings, and left, which hands the session to Claude Code's background service; a click presses and lets go on one cell, so it drags no pane edge. The router home and the repository it works in are yours to give (a test home with a
// running daemon). Install its two packages once: npm install --prefix scripts/office-screen
//
//   node scripts/office-screen/run.mjs --home <router home> --cwd <repository> [options] <steps>
//
// Options:
//   --cols N --rows N          the terminal's size (default 120 x 40)
//   --term wt|conhost|plain    the environment of the terminal it poses as: wt sets WT_SESSION, conhost and plain
//                              set nothing of a terminal (default wt)
//   --backend conpty|conpty-dll|winpty
//                              Windows only: the system's ConPTY, the newer one node-pty ships (as Windows
//                              Terminal does), or winpty, which runs the program in a hidden classic console
//                              (default conpty-dll)
//   --tui default|fullscreen   Claude Code's renderer, passed with --settings (default: your own setting)
//   --plugin <dir>             the plugin directory (default <home>/plugin)
//   --claude <path>            the claude executable (default: claude on the PATH)
//   --out <dir>                where the screens go (default: a new folder in the OS temp directory)
//   --debug                    also write Claude Code's debug log there (--debug-file)
//   --env NAME=VALUE           one more variable for Claude Code's environment (again for more)
//   --script <file>            read the steps from a file, one a line (# starts a comment)
//
// Steps, separated by ";" or one a line:
//   wait <seconds>             until <regex> [<seconds>]  (waits for the screen to match; fails after 20 s)
//   type <text>                enter | esc | tab | space | backspace | up | down | right | ctrl+<k>
//                              (no left: on an empty prompt Claude Code moves the session to its background service)
//   key <char>                 send <text with \x1b-style escapes>
//   office [<args>]            types /office <args> and Enter          reload: types /reload-plugins and Enter
//   resize <cols> <rows>       resizes the terminal and then the pseudo-terminal, as a terminal window does
//   drag <cols> <rows> [<ms>]  the same through every size between, <ms> apart (default 16): a dragged window edge
//   move <x> <y>               click <x> <y>     wheel up|down <x> <y>   (SGR mouse reports; 1-based cells)
//   move|click "<text>" [<dx> <dy>]   at the first place the screen shows that text, moved by dx, dy
//   shot <name>                writes the screen (and the whole buffer) and the checks to <out>/NN-<name>.txt
//   repaint <name>             ctrl+L, then compares the settled screen with the one before it: leftovers
//   quit                       ends Claude Code (ctrl+c twice), then the run
//
// Example:
//   node scripts/office-screen/run.mjs --home <home> --cwd <repo> --cols 120 --rows 40 \
//     "office demo; wait 4; shot open; resize 90 30; wait 2; shot narrow; resize 140 45; wait 2; shot wide; quit"

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
let pty, Terminal;
try {
  pty = require('node-pty');
  ({ Terminal } = require('@xterm/headless'));
} catch {
  console.error('office-screen: its packages are not installed. Run: npm install --prefix scripts/office-screen');
  process.exit(2);
}

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const o = { cols: 120, rows: 40, term: 'wt', backend: 'conpty-dll', tui: '', home: '', cwd: '', plugin: '', claude: '', out: '', debug: false, env: {}, steps: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--cols') o.cols = Number(val());
    else if (a === '--rows') o.rows = Number(val());
    else if (a === '--term') o.term = val();
    else if (a === '--backend') o.backend = val();
    else if (a === '--tui') o.tui = val();
    else if (a === '--home') o.home = val();
    else if (a === '--cwd') o.cwd = val();
    else if (a === '--plugin') o.plugin = val();
    else if (a === '--claude') o.claude = val();
    else if (a === '--out') o.out = val();
    else if (a === '--debug') o.debug = true;
    else if (a === '--env') { const [k, ...v] = val().split('='); if (!k || !v.length) throw new Error('--env takes NAME=VALUE'); o.env[k] = v.join('='); }
    else if (a === '--script') rest.push(fs.readFileSync(val(), 'utf8'));
    else rest.push(a);
  }
  o.steps = rest.join('\n').split(/[;\n]/).map(s => s.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean);
  let ctrlX = false;
  for (const s of o.steps) {
    const cmd = s.split(/\s+/)[0];
    if (ctrlX && /^(up|down|left|right)$/.test(cmd)) throw new Error(`"ctrl+x" then "${cmd}" resizes a plugin pane, a size Claude Code keeps in your settings: not sent`);
    ctrlX = cmd === 'ctrl+x' || (ctrlX && /^(wait|shot|until)$/.test(cmd));
  }
  if (!o.home || !o.cwd) throw new Error('--home and --cwd are required');
  if (!['wt', 'conhost', 'plain'].includes(o.term)) throw new Error('--term is wt, conhost or plain');
  if (!['conpty', 'conpty-dll', 'winpty'].includes(o.backend)) throw new Error('--backend is conpty, conpty-dll or winpty');
  if (o.tui && !['default', 'fullscreen'].includes(o.tui)) throw new Error('--tui is default or fullscreen');
  if (!(o.cols >= 20 && o.rows >= 8)) throw new Error('--cols and --rows are at least 20 and 8');
  o.plugin ||= path.join(o.home, 'plugin');
  return o;
}

function findClaude() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, `claude${ext}`);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  throw new Error('claude is not on the PATH; give --claude <path>');
}

/** The caller's environment less anything of a surrounding Claude Code session, a credential or a terminal. */
function childEnv(o) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(CLAUDE|ANTHROPIC|AWS_BEARER|MCP_|ENABLE_TOOL_SEARCH|DO_IT_ALL_CLAUDE_CODE|AGENTIC_ROUTER|OTEL_)/i.test(k)) continue;
    if (/^(TERM|COLORTERM|VSCODE_|WT_|ConEmu|MSYSTEM|MINGW|TMUX|ZELLIJ|KITTY|ALACRITTY|WEZTERM|ITERM|LC_TERMINAL)/i.test(k)) continue;
    env[k] = v;
  }
  if (o.term === 'wt') { env.WT_SESSION = randomUUID(); env.WT_PROFILE_ID = `{${randomUUID()}}`; }
  if (process.platform !== 'win32' || o.term === 'plain') env.TERM = 'xterm-256color';
  env.DO_IT_ALL_CLAUDE_CODE_HOME = o.home;
  Object.assign(env, o.env);
  return env;
}

// ------------------------------------------------------------------ the screen

/** The rows of the screen as text, with what each row tells about wrapping and the right edge. */
function grab(term, whole = false) {
  const buf = term.buffer.active;
  const from = whole ? 0 : buf.viewportY;
  const to = whole ? buf.length : buf.viewportY + term.rows;
  const rows = [];
  for (let y = from; y < to; y++) {
    const line = buf.getLine(y);
    if (!line) { rows.push({ text: '', wrapped: false, edge: false, inverse: false }); continue; }
    const last = line.getCell(term.cols - 1);
    // a run of inverse cells with text in it: where a focus ring (or a selection) is drawn
    let inverse = false;
    for (let x = 0; x < term.cols && !inverse; x++) { const c = line.getCell(x); inverse = !!c && c.isInverse() !== 0 && c.getChars().trim() !== ''; }
    rows.push({ text: line.translateToString(true), wrapped: line.isWrapped, edge: !!last && last.getChars() !== '' && last.getChars() !== ' ', inverse });
  }
  return rows;
}

/** Cells of a row, one string per column (a wide character's second cell is ''). */
function cellsOf(term, y) {
  const line = term.buffer.active.getLine(term.buffer.active.viewportY + y);
  const out = [];
  for (let x = 0; x < term.cols; x++) { const c = line?.getCell(x); out.push(c ? (c.getWidth() === 0 ? '' : c.getChars() || ' ') : ' '); }
  return out;
}

const TITLE = 'DO IT ALL · team office';
const SCENE_GLYPHS = /[▀▄█▐▌▗▖▝▘▟▙▜▛]/;

/** The rounded frames on screen: [top, bottom, left, right] in cells. */
function framesOf(term) {
  const frames = [];
  const grid = Array.from({ length: term.rows }, (_, y) => cellsOf(term, y));
  for (let y = 0; y < term.rows; y++) {
    for (let x = 0; x < term.cols; x++) {
      if (grid[y][x] !== '╭') continue;
      let r = x + 1;
      while (r < term.cols && grid[y][r] === '─') r++;
      if (grid[y][r] !== '╮' && !(r < term.cols && grid[y][r] !== '─')) continue;
      // a frame's top may carry a label: look for its corner further along
      while (r < term.cols && grid[y][r] !== '╮') r++;
      if (grid[y][r] !== '╮') continue;
      let b = y + 1;
      while (b < term.rows && grid[b][x] !== '╰') b++;
      frames.push({ top: y, bottom: b < term.rows ? b : -1, left: x, right: r });
    }
  }
  return { frames, grid };
}

function check(term, whole, prevGrid) {
  const found = [];
  const view = grab(term);
  const all = whole;
  // 1. lines wider than the terminal: the terminal wrapped them onto the next row
  view.forEach((r, y) => { if (r.wrapped) found.push({ kind: 'wrapped', row: y + 1, text: `row ${y + 1} continues row ${y}: that line was wider than ${term.cols} columns` }); });
  const wrappedAll = all.filter(r => r.wrapped).length;
  if (wrappedAll > view.filter(r => r.wrapped).length) found.push({ kind: 'wrapped', text: `${wrappedAll - view.filter(r => r.wrapped).length} wrapped row(s) in the scrollback` });
  // rows that reach the last column: a narrower window wraps them first (Claude Code's own rules around the prompt
  // are left out: they are its, and every screen has them)
  const edgeRows = view.map((r, y) => (r.edge && !/^─+$/.test(r.text) ? y + 1 : 0)).filter(Boolean);
  if (edgeRows.length) found.push({ kind: 'edge', text: `rows reaching column ${term.cols}: ${edgeRows.join(', ')}` });
  // 2. the office's frames: whole, once, nothing of the scene outside them
  const titles = view.map((r, y) => (r.text.includes(TITLE) ? y + 1 : 0)).filter(Boolean);
  const titlesAll = all.filter(r => r.text.includes(TITLE)).length;
  if (titles.length > 1) found.push({ kind: 'leftover', text: `the office title shows ${titles.length} times on screen (rows ${titles.join(', ')})` });
  if (titlesAll > titles.length) found.push({ kind: 'leftover', text: `${titlesAll - titles.length} earlier office frame(s) in the scrollback` });
  const { frames, grid } = framesOf(term);
  for (const f of frames) {
    if (f.bottom < 0) { found.push({ kind: 'frame', row: f.top + 1, text: `the frame opened at row ${f.top + 1} col ${f.left + 1} has no bottom on screen` }); continue; }
    for (let y = f.top + 1; y < f.bottom; y++) {
      const l = grid[y][f.left], rr = grid[y][f.right];
      if (l !== '│' || rr !== '│') found.push({ kind: 'frame', row: y + 1, text: `frame ${f.top + 1}-${f.bottom + 1}: row ${y + 1} has ${JSON.stringify(l)} at col ${f.left + 1} and ${JSON.stringify(rr)} at col ${f.right + 1}, not │` });
    }
    if (grid[f.bottom][f.right] !== '╯') found.push({ kind: 'frame', row: f.bottom + 1, text: `frame ${f.top + 1}-${f.bottom + 1}: no ╯ at col ${f.right + 1} of its bottom row` });
  }
  const officeFrame = frames.find(f => f.bottom > 0 && titles.some(t => t - 1 > f.top && t - 1 < f.bottom));
  if (officeFrame) {
    const inside = (x, y) => frames.some(f => f.bottom > 0 && y >= f.top && y <= f.bottom && x >= f.left && x <= f.right);
    // the welcome banner's logo draws with the same blocks: its corner does not count
    const banner = view.map((r, y) => (/Claude Code v\d/.test(r.text) ? y : -9)).filter(y => y >= 0);
    const isLogo = (x, y) => x < 12 && banner.some(b => y >= b - 1 && y <= b + 2);
    const stray = [];
    for (let y = 0; y < term.rows; y++) {
      for (let x = 0; x < term.cols; x++) if (SCENE_GLYPHS.test(grid[y][x]) && !inside(x, y) && !isLogo(x, y)) stray.push(`${y + 1}:${x + 1}`);
    }
    if (stray.length) found.push({ kind: 'leftover', text: `scene glyphs outside every frame at row:col ${stray.slice(0, 12).join(' ')}${stray.length > 12 ? ` (+${stray.length - 12})` : ''}` });
  }
  // 3. mouse reports that reached the prompt as text
  view.forEach((r, y) => {
    const m = r.text.match(/\[?<?\d{1,3};\d{1,4};\d{1,4}[Mm]|\x1b\[<|(?:\d{1,3};){2}\d{1,3}/);
    if (m) found.push({ kind: 'mouse', row: y + 1, text: `row ${y + 1} shows ${JSON.stringify(m[0])}: a mouse report typed as text?` });
  });
  // 4. error lines
  all.forEach((r, y) => {
    if (/do-it-all-claude-code[^│]*\b(skipped|failed|error)\b|TypeError|ReferenceError|SyntaxError|RangeError|is not a function|Cannot read propert|is not defined|Unexpected token|\bError:/i.test(r.text)) {
      found.push({ kind: 'error', text: `buffer row ${y + 1}: ${r.text.trim()}` });
    }
  });
  // changes against the screen before (for repaint)
  let changed = null;
  if (prevGrid) {
    changed = [];
    for (let y = 0; y < term.rows; y++) for (let x = 0; x < term.cols; x++) if ((prevGrid[y]?.[x] ?? ' ') !== grid[y][x]) changed.push([y, x]);
  }
  return { found, frames, grid, changed };
}

// ------------------------------------------------------------------ the run

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** The Claude Code the run started: it ends with the run, also when a step stops it. */
let child = null;

const KEYS = {
  enter: '\r', esc: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
};

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const claude = o.claude || findClaude();
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'office-screen-'));
  fs.mkdirSync(out, { recursive: true });
  const args = ['--plugin-dir', o.plugin];
  if (o.tui) args.push('--settings', JSON.stringify({ tui: o.tui }));
  if (o.debug) args.push('--debug-file', path.join(out, 'claude-debug.txt'));

  const term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: 2000, allowProposedApi: true });
  const raw = fs.createWriteStream(path.join(out, 'raw.log'));
  const win = process.platform === 'win32';
  const p = pty.spawn(claude, args, {
    name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: childEnv(o),
    ...(win ? { useConpty: o.backend !== 'winpty', useConptyDll: o.backend === 'conpty-dll' } : {}),
  });
  child = p;
  let exited = null;
  let pending = 0;
  p.onData(d => { pending++; raw.write(JSON.stringify(d) + '\n'); term.write(d, () => { pending--; }); });
  p.onExit(e => { exited = e; });
  // the terminal's answers to Claude Code's queries go back to it, as a real terminal's do
  term.onData(d => { if (!exited) p.write(d); });

  const settle = async (ms = 150) => { await sleep(ms); while (pending > 0) await sleep(20); };
  const text = () => grab(term).map(r => r.text).join('\n');
  const write = s => { if (!exited) p.write(s); };
  const typeText = async s => { for (const ch of s) { write(ch); await sleep(12); } };
  const report = { args: { cols: o.cols, rows: o.rows, term: o.term, backend: o.backend, tui: o.tui || 'yours' }, shots: [] };
  let shotN = 0;
  let mouseNote = '';

  const dump = (name, extra = []) => {
    shotN++;
    const whole = grab(term, true);
    const res = check(term, whole);
    const view = grab(term);
    const rule = '     ' + Array.from({ length: term.cols }, (_, i) => ((i + 1) % 10 === 0 ? String(((i + 1) / 10) % 10) : '·')).join('');
    const modes = term.modes;
    const head = [
      `shot ${shotN} "${name}" at ${term.cols}x${term.rows} · ${o.term} · ${o.backend} · tui ${o.tui || 'yours'} · mouse ${modes.mouseTrackingMode} · ${term.buffer.active.type} screen`,
      rule,
      ...view.map((r, y) => `${String(y + 1).padStart(3)}${r.wrapped ? '↵' : ' '}${r.edge ? '|' : r.inverse ? '»' : ' '}${r.text}`),
      rule,
      '',
      res.found.length ? 'findings:' : 'findings: none',
      ...[...res.found, ...extra].map(f => `  [${f.kind}] ${f.text}`),
    ];
    const file = path.join(out, `${String(shotN).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '_')}.txt`);
    fs.writeFileSync(file, head.join('\n') + '\n');
    fs.writeFileSync(file.replace(/\.txt$/, '.buffer.txt'), whole.map((r, y) => `${String(y + 1).padStart(4)}${r.wrapped ? '↵' : ' '}${r.text}`).join('\n') + '\n');
    const kinds = {};
    for (const f of [...res.found, ...extra]) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    report.shots.push({ name, file, cols: term.cols, rows: term.rows, mouse: modes.mouseTrackingMode, screen: term.buffer.active.type, findings: [...res.found, ...extra] });
    console.log(`shot ${shotN} ${name}: ${Object.keys(kinds).length ? Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') : 'clean'}  (${file})`);
    return res;
  };

  /** Where the screen shows this text: 1-based x, y of its first cell. */
  const locate = needle => {
    const view = grab(term);
    for (let y = 0; y < view.length; y++) {
      const cells = cellsOf(term, y);
      const joined = cells.join('');
      const at = joined.indexOf(needle);
      if (at >= 0) {
        // map the string index back to a column (wide characters take a cell more than they count)
        let col = 0, len = 0;
        while (col < cells.length && len < at) { len += cells[col].length; col++; }
        return { x: col + 1, y: y + 1 };
      }
    }
    return null;
  };
  const point = argsOf => {
    const m = argsOf.match(/^"([^"]+)"\s*(-?\d+)?\s*(-?\d+)?$/);
    if (m) {
      const at = locate(m[1]);
      if (!at) throw new Error(`the screen does not show "${m[1]}"`);
      return { x: at.x + Number(m[2] ?? 0), y: at.y + Number(m[3] ?? 0) };
    }
    const [x, y] = argsOf.split(/\s+/).map(Number);
    return { x, y };
  };
  const sgr = (b, x, y, up = false) => `\x1b[<${b};${x};${y}${up ? 'm' : 'M'}`;

  // No Enter may send a prompt. What the prompt holds: the text after its mark on the row below one of Claude
  // Code's rules ('' for its placeholder), or null when no prompt shows (a dialog has the keys).
  const promptText = () => {
    const view = grab(term).map(r => r.text);
    for (let y = view.length - 1; y > 0; y--) {
      const m = view[y].match(/^\s*[❯>]\s?(.*)$/);
      if (m && /^─{10,}/.test(view[y - 1] ?? '')) { const t = m[1].trim(); return /^Try "/.test(t) ? '' : t; }
    }
    return null;
  };
  // the only commands the run sends: the office's and the plugin reload, neither of which asks the model
  const SAFE = /^\/(office( demo| clear)?|reload-plugins)$/;
  const enter = expected => {
    const t = promptText();
    const ok = t === null ? expected === undefined : expected !== undefined ? t === expected : t === '' || SAFE.test(t);
    const classic = /this launch is using the classic renderer/.test(text()) ? ' (Claude Code fell back to its classic renderer for this launch, where the prompt is not read: run again)' : '';
    if (!ok) throw new Error(`the prompt holds ${JSON.stringify(t ?? '(no prompt on screen)')}: Enter would send it on, so the run stops here${classic}`);
    write('\r');
  };
  // Left on an empty prompt hands the session to Claude Code's background service, where it outlives the run. The
  // run never sends left; should that view show anyway, it goes back (esc), ends the session there and stops.
  const BACKGROUND = /Your session moved to the background/;
  const leaveBackground = async () => {
    dump('background');
    write('\x1b'); await settle(800);
    write('\x03'); await sleep(300); write('\x03');
    const until = Date.now() + 5000;
    while (!exited && Date.now() < until) await sleep(100);
    throw new Error('Claude Code moved the session to its background view: the run went back, ended the session and stops here');
  };

  // the first screen: wait for the prompt, answering the trust question if it comes
  const started = Date.now();
  let trusted = false;
  for (;;) {
    await settle(300);
    if (exited) throw new Error(`Claude Code ended at the start (code ${exited.exitCode}); see ${path.join(out, 'raw.log')}`);
    const s = text();
    if (!trusted && /trust (the files in )?this folder|Yes, (I trust|proceed)|Quick safety check/i.test(s)) { write('\r'); trusted = true; continue; }
    if (/for shortcuts|\? for help|Try "|─{20,}\n.*>/.test(s) && Date.now() - started > 1500) break;
    if (Date.now() - started > 60000) { dump('start-timeout'); throw new Error('the prompt did not show within 60 s'); }
  }
  await settle(800);

  let afterCtrlX = false;
  for (const step of o.steps) {
    const [cmd, ...restWords] = step.split(/\s+/);
    const rest = step.slice(cmd.length).trim();
    if (exited && cmd !== 'quit') { console.log(`Claude Code ended (code ${exited.exitCode}) before "${step}"`); break; }
    if (!exited && BACKGROUND.test(text())) await leaveBackground();
    if (cmd === 'left') throw new Error('"left" is not sent: on an empty prompt Claude Code moves the session into its background service');
    // ctrl+x and an arrow resize a plugin pane, and Claude Code keeps that size in your own settings for every
    // plugin's pane: the run never sends it
    if (afterCtrlX && /^(up|down|left|right)$/.test(cmd)) throw new Error(`"ctrl+x" then "${cmd}" would change the pane size Claude Code keeps in your settings`);
    afterCtrlX = cmd === 'ctrl+x' || (afterCtrlX && /^(wait|shot|until)$/.test(cmd));
    if (cmd === 'wait') await settle(Number(rest) * 1000);
    else if (cmd === 'until') {
      const [re, secs] = rest.match(/^(.*?)(?:\s+(\d+(?:\.\d+)?))?$/).slice(1);
      const deadline = Date.now() + Number(secs ?? 20) * 1000;
      while (!new RegExp(re).test(text())) { if (Date.now() > deadline) { dump(`until-failed`); throw new Error(`the screen never matched /${re}/`); } await settle(200); }
    } else if (cmd === 'type') await typeText(rest);
    else if (cmd === 'send') {
      const raw = rest.replace(/\\x([0-9a-f]{2})|\\t/gi, (m, h) => (h ? String.fromCharCode(parseInt(h, 16)) : '\t'));
      if (/[\r\n]/.test(raw) || /\\[rn]/.test(raw)) throw new Error('send takes no Enter: use the enter step, which checks the prompt first');
      write(raw);
    } else if (cmd === 'key') {
      if (/[\r\n]/.test(rest)) throw new Error('key takes no Enter: use the enter step');
      write(rest);
    } else if (cmd === 'enter' || cmd === 'ctrl+m' || cmd === 'ctrl+j') enter();
    else if (KEYS[cmd] !== undefined) write(KEYS[cmd]);
    else if (/^ctrl\+[a-z]$/.test(cmd)) write(String.fromCharCode(cmd.charCodeAt(5) - 96));
    else if (cmd === 'office' || cmd === 'reload') {
      const command = cmd === 'office' ? `/office${rest ? ` ${rest}` : ''}` : '/reload-plugins';
      if (!SAFE.test(command)) throw new Error(`"${command}" is not one of the commands the run sends`);
      // typed into a prompt that already holds text, it would join that text
      const before = promptText();
      if (before !== '') throw new Error(`the prompt holds ${JSON.stringify(before ?? '(no prompt on screen)')}: "${command}" not typed`);
      await typeText(command);
      // Enter only once the prompt shows the command whole (a slow echo, the command menu drawing)
      const shown = Date.now() + 3000;
      do await settle(200); while (promptText() !== command && Date.now() < shown);
      enter(command);
      await settle(600);
    } else if (cmd === 'resize') {
      const [c, r] = restWords.map(Number);
      term.resize(c, r);
      if (!exited) p.resize(c, r);
      await settle(200);
    } else if (cmd === 'drag') {
      // a window edge dragged: one size after another, a few milliseconds apart, as a terminal reports them
      const [c, r, ms] = restWords.map(Number);
      const from = { c: term.cols, r: term.rows };
      const n = Math.max(Math.abs(c - from.c), Math.abs(r - from.r), 1);
      for (let k = 1; k <= n; k++) {
        const cc = Math.round(from.c + ((c - from.c) * k) / n), rr = Math.round(from.r + ((r - from.r) * k) / n);
        if (cc === term.cols && rr === term.rows) continue;
        term.resize(cc, rr);
        if (!exited) p.resize(cc, rr);
        await sleep(ms || 16);
      }
      await settle(100);
    } else if (cmd === 'move' || cmd === 'click') {
      const { x, y } = point(rest);
      if (cmd === 'move') write(sgr(35, x, y));
      else { write(sgr(35, x, y)); await sleep(40); write(sgr(0, x, y)); await sleep(60); write(sgr(0, x, y, true)); }
      if (term.modes.mouseTrackingMode === 'none' && !mouseNote) { mouseNote = 'mouse reports sent while the terminal had no mouse mode on'; }
      await settle(100);
    } else if (cmd === 'wheel') {
      const [dir, xs, ys] = restWords;
      write(sgr(dir === 'up' ? 64 : 65, Number(xs), Number(ys)));
      await settle(100);
    } else if (cmd === 'shot') dump(rest || `shot${shotN + 1}`, mouseNote ? [{ kind: 'note', text: mouseNote }] : []);
    else if (cmd === 'repaint') {
      const before = check(term, grab(term, true)).grid;
      write('\x0c');
      await settle(1200);
      const a = check(term, [], before);
      await settle(400);
      const b = check(term, [], a.grid);
      // cells that changed with the repaint and then held still: they were stale before it (a clock's digit turning
      // over is not)
      const moving = new Set(b.changed.map(([y, x]) => `${y},${x}`));
      const clock = (y, x) => /[0-9:]/.test(before[y]?.[x] ?? '') && /[0-9:]/.test(a.grid[y]?.[x] ?? '');
      const stale = a.changed.filter(([y, x]) => !moving.has(`${y},${x}`) && !clock(y, x));
      const rowsHit = [...new Set(stale.map(([y]) => y + 1))];
      dump(rest || 'repaint', stale.length ? [{ kind: 'leftover', text: `${stale.length} cell(s) changed with a full repaint and then held still, in rows ${rowsHit.slice(0, 20).join(', ')}` }] : []);
    } else if (cmd === 'quit') {
      write('\x03'); await sleep(300); write('\x03');
      const until = Date.now() + 5000;
      while (!exited && Date.now() < until) await sleep(100);
      break;
    } else throw new Error(`unknown step "${step}"`);
  }

  if (!exited && BACKGROUND.test(text())) await leaveBackground();
  if (!exited) { try { p.kill(); } catch { /* gone */ } }
  await sleep(200);
  raw.end();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`screens in ${out}`);
}

main().then(() => process.exit(0), async err => {
  console.error(`office-screen: ${err.message}`);
  // ended as a person ends it (ctrl+c twice), so its next start does not take this one for a failed start
  try { child?.write(''); await sleep(300); child?.write(''); await sleep(1500); } catch { /* gone */ }
  try { child?.kill(); } catch { /* gone */ }
  setTimeout(() => process.exit(1), 300);
});
