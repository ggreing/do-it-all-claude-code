// Terminal detection (decision 206): core's unicodeTerminal must agree exactly with the office's dependency-free
// copy, and classicWindowsConsole flags the Windows console where the office characters do not draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classicWindowsConsole, unicodeTerminal } from '../src/terminal.ts';
import { unicodeTerminal as officeUnicodeTerminal } from '../../../plugin/office/model.ts';

const ENVS: Array<Record<string, string | undefined>> = [
  {},
  { TERM: 'linux' },
  { TERM: 'xterm' },
  { TERM: 'xterm-256color' },
  { OS: 'Windows_NT' },                               // classic console
  { OS: 'Windows_NT', WT_SESSION: '1' },              // Windows Terminal
  { OS: 'Windows_NT', TERM_PROGRAM: 'vscode' },       // VS Code integrated terminal
  { OS: 'Windows_NT', TERM: 'xterm-256color' },
  { OS: 'Windows_NT', ConEmuTask: '{cmd::Cmder}' },
  { OS: 'Windows_NT', TERMINAL_EMULATOR: 'JetBrains-JediTerm' },
  { OS: 'Windows_NT', TERM_PROGRAM: 'Terminus-Sublime' },
  { OS: 'Windows_NT', WT_SESSION: '' },               // empty var: still the classic console
];

test('core unicodeTerminal agrees with the office copy on every env (no drift)', () => {
  for (const e of ENVS) assert.equal(unicodeTerminal(e), officeUnicodeTerminal(e), JSON.stringify(e));
});

test('classicWindowsConsole: only the Windows console, never elsewhere', () => {
  assert.equal(classicWindowsConsole({ OS: 'Windows_NT' }), true);
  assert.equal(classicWindowsConsole({ OS: 'Windows_NT', WT_SESSION: '1' }), false, 'Windows Terminal');
  assert.equal(classicWindowsConsole({ OS: 'Windows_NT', TERM_PROGRAM: 'vscode' }), false, 'VS Code');
  assert.equal(classicWindowsConsole({}), false, 'not Windows');
  assert.equal(classicWindowsConsole({ TERM: 'linux' }), false, 'Linux console');
  assert.equal(classicWindowsConsole({ TERM_PROGRAM: 'Apple_Terminal' }), false, 'macOS');
});
