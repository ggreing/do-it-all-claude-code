// Subtask results the lead has not been told yet (decision 205).
//
// A background subagent's result used to reach the lead in one place only: the UserPromptSubmit of its
// <task-notification>. An interactive Claude Code does not always raise that hook: when the lead's turn is
// already running, the notification is attached in the middle of the turn and no hook fires. So each result is
// also left here, one small file per result, and whichever of the lead's hooks comes next hands it over once:
// a hook the daemon answers (a prompt, an Agent call, a router tool, the lead's Stop), or the guard hook, which
// runs before the lead's Bash, Read and edit calls and reads these files without asking the daemon.
//
// <home>/lead-notes/<session>/<time>-<n>-<agent>.json holds { agentId, subtaskId, text, at }: the result line
// the lead would have read, masked like every other stored text. No prompt, no report, no file content. The
// folder is 0700 and the files 0600, like the rest of the home. A note is taken by renaming it first, so two
// readers never deliver the same one; a note older than a day is dropped unread.
//
// plugin/hooks/guard.mjs carries its own copy of `takeLeadNotes` (the hook has no dependencies); a test runs
// both on the same folder.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './home.ts';

export const LEAD_NOTES_DIR = 'lead-notes';
/** One note's text is cut to this; a result line is a few hundred characters. */
export const MAX_NOTE_CHARS = 2000;
/** At most this many notes are handed over at once (the newest). */
export const MAX_NOTES = 20;
export const NOTE_MAX_AGE_MS = 24 * 3600_000;

export interface LeadNote {
  agentId: string;
  subtaskId: string;
  text: string;
  at: string;
}

const safe = (id: string): string => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);

export function leadNotesDir(home: string, sessionId: string): string {
  return path.join(home, LEAD_NOTES_DIR, safe(sessionId));
}

/** Takes every waiting note of the session, oldest first. Never throws; a note another reader took is skipped. */
export function takeLeadNotes(home: string, sessionId: string, now: number = Date.now()): LeadNote[] {
  const dir = leadNotesDir(home, sessionId);
  let names: string[];
  try { names = fs.readdirSync(dir).sort(); } catch { return []; }
  const out: LeadNote[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.json')) {
      // what a reader or writer left behind when it was killed halfway
      try { if (now - fs.statSync(file).mtimeMs > 60_000) fs.unlinkSync(file); } catch { /* gone */ }
      continue;
    }
    const mine = `${file}.${process.pid}.taken`;
    try { fs.renameSync(file, mine); } catch { continue; }
    try {
      const j = JSON.parse(fs.readFileSync(mine, 'utf8')) as Partial<LeadNote>;
      const at = Date.parse(String(j.at));
      if (typeof j.text === 'string' && j.text && Number.isFinite(at) && now - at <= NOTE_MAX_AGE_MS) {
        out.push({ agentId: String(j.agentId ?? ''), subtaskId: String(j.subtaskId ?? ''), text: j.text.slice(0, MAX_NOTE_CHARS), at: String(j.at) });
      }
    } catch { /* unreadable: dropped */ }
    try { fs.unlinkSync(mine); } catch { /* gone */ }
  }
  try { fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
  // one line per agent, its latest: "held" followed by "passed" is told as "passed"
  const latest = out.filter((n, i) => !n.agentId || !out.some((m, j) => j > i && m.agentId === n.agentId));
  return latest.slice(-MAX_NOTES);
}

export class LeadNotes {
  readonly #home: string;
  readonly #now: () => Date;
  #seq = 0;
  /** agent -> the file of its latest note, to tell "handed over already" from "never left" (memory only). */
  readonly #files = new Map<string, string>();

  constructor(home: string, now: () => Date = () => new Date()) {
    this.#home = home;
    this.#now = now;
  }

  /** Leaves one result for the lead. Returns false when it could not be written (the caller logs it). */
  add(sessionId: string, note: { agentId: string; subtaskId: string; text: string }): boolean {
    const at = this.#now();
    const name = `${String(at.getTime()).padStart(13, '0')}-${String(this.#seq++ % 10000).padStart(4, '0')}-${safe(note.agentId)}.json`;
    const file = path.join(leadNotesDir(this.#home, sessionId), name);
    try {
      writeJsonAtomic(file, { agentId: note.agentId, subtaskId: note.subtaskId, text: note.text.slice(0, MAX_NOTE_CHARS), at: at.toISOString() });
    } catch {
      return false;
    }
    if (this.#files.size >= 500 && !this.#files.has(note.agentId)) this.#files.clear();
    this.#files.set(note.agentId, file);
    return true;
  }

  take(sessionId: string): LeadNote[] {
    return takeLeadNotes(this.#home, sessionId, this.#now().getTime());
  }

  /** True when a note of this agent was left here and is no longer waiting: the lead has read it. */
  delivered(agentId: string): boolean {
    const file = this.#files.get(agentId);
    return file !== undefined && !fs.existsSync(file);
  }
}
