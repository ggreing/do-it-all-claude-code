// Terminal capability (decision 206). The team office draws block and circle glyphs (▀▄█ ●○); on Windows the
// classic console window (conhost) renders those two cells wide on some systems (e.g. Korean Windows), so the
// office characters overlap or fall apart into a list. Windows Terminal draws them one cell wide. `setup` and
// `doctor` detect the classic console and point the user at Windows Terminal.
//
// The detection must match the office's own, which decides whether to draw the characters at all. A
// dependency-free copy of `unicodeTerminal` lives in plugin/office/model.ts (the office UI cannot import this
// package); packages/core/test/terminal.test.ts keeps the two in exact agreement.

/**
 * Whether the terminal draws Unicode marks one cell wide, decided as Claude Code decides it for its own figures:
 * anywhere but Windows unless TERM is linux; on Windows only in a terminal that says which it is. The names are
 * the environment variables of Claude Code's process.
 */
export function unicodeTerminal(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.OS !== 'Windows_NT') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION) || Boolean(env.TERMINUS_SUBLIME) || env.ConEmuTask === '{cmd::Cmder}'
    || env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode'
    || env.TERM === 'xterm-256color' || env.TERM === 'alacritty' || env.TERM === 'rxvt-unicode' || env.TERM === 'rxvt-unicode-256color'
    || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}

/** The classic Windows console (conhost), where the office characters do not draw: Windows, and not a known
 *  Unicode-width terminal. Elsewhere (macOS, Linux, Windows Terminal, VS Code, …) this is false. */
export function classicWindowsConsole(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.OS === 'Windows_NT' && !unicodeTerminal(env);
}

/** The one-paragraph guidance shown by `setup` and `doctor` on the classic Windows console. */
export const WINDOWS_TERMINAL_HINT =
  'On Windows, run Claude Code in Windows Terminal — the classic console window cannot draw the team office '
  + 'characters (they show as a list). Make Windows Terminal the default: its Settings -> Startup -> Default '
  + 'terminal application -> Windows Terminal, or Windows Settings -> System -> Advanced (For developers on older versions) -> Terminal. Then '
  + 'opening PowerShell opens it inside Windows Terminal.';
