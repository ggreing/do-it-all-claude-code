// Records of scripts/measure-session.ts written before a step's cost was taken as the difference from the step
// before (bench/src/kpi/session.ts, stepCost): there, a step's costUsd is the total its process reported, which in
// a resumed session covers every step so far, and the ledger added those totals up. This rewrites such an output
// folder in place:
// - sessions.jsonl: each old record's steps get their own cost, per-model usage and cost basis, from the step's
//   kept stream when it is there and its total is the one on record, else from the recorded totals alone; the
//   record's cost totals follow. Records already in the new form are left as they are.
// - ledger.jsonl: each old entry's cost becomes the step's own. Entries of one session are taken in order; a step
//   id that does not go up starts another attempt at that session (a session that was stopped and run again).
// The files as they were are kept beside them (<name>.before-recompute), once. Nothing is run and nothing outside
// the folder is read.
import fs from 'node:fs';
import path from 'node:path';
import type { StreamLine } from './phases.ts';
import { leadTurns, reported, sessionCost, stepCost, streamFileOf, type Reported, type StepCost } from './session.ts';

type Row = Record<string, unknown>;
const readJsonl = (f: string): Row[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Row) : []);
const totalOnly = (usd: number): Reported => ({ totalUsd: usd, modelUsage: null, sinceLastResultUsd: null });
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function readStream(file: string): StreamLine[] | null {
  if (!fs.existsSync(file)) return null;
  const lines: StreamLine[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try { const j = JSON.parse(l) as StreamLine; if (j && typeof j.m === 'object' && j.m) lines.push(j); } catch { /* a cut line */ }
  }
  return lines;
}

function keepOnce(file: string): void {
  const kept = `${file}.before-recompute`;
  if (!fs.existsSync(kept)) fs.copyFileSync(file, kept);
}

export interface Recomputed {
  /** Session records rewritten, and those already in the new form. */
  sessions: number;
  sessionsLeft: number;
  ledgerEntries: number;
  ledgerBeforeUsd: number;
  ledgerAfterUsd: number;
  /** One line per rewritten session, and anything that could not be read from a stream. */
  notes: string[];
}

export function recompute(out: string): Recomputed {
  const notes: string[] = [];
  const sessionsFile = path.join(out, 'sessions.jsonl');
  const ledgerFile = path.join(out, 'ledger.jsonl');
  let sessions = 0, sessionsLeft = 0;

  const records = readJsonl(sessionsFile).map(rec => {
    const steps = Array.isArray(rec.steps) ? rec.steps as Row[] : [];
    if (steps.every(s => typeof s.costBasis === 'string')) { sessionsLeft++; return rec; }
    const key = `${rec.scenario}|${rec.arrangement}|${rec.rep}`;
    let before: Reported | null = null;
    const redone = steps.map(step => {
      const onRecord = Number(step.reportedTotalUsd ?? step.costUsd) || 0;
      const lines = readStream(streamFileOf(out, `${key}|${step.id}`));
      const result = lines ? [...lines].reverse().find(l => l.m.type === 'result')?.m ?? null : null;
      const fromStream = lines && result && near(Number(result.total_cost_usd) || 0, onRecord);
      if (!fromStream) notes.push(`${key}|${step.id}: ${lines ? 'the kept stream is not the recorded step\'s (its total differs)' : 'no kept stream'}; the cost is taken from the recorded total, without per-model usage`);
      const now = fromStream ? reported(lines, result) : totalOnly(onRecord);
      const cost: StepCost = stepCost(fromStream ? lines : [], now, before);
      if (cost.costBasis !== 'none') before = now;
      // without the stream, the figures read from it stay as they are on record
      const { streamInputUsd, streamInputLeadUsd, streamInputWorkersUsd, unpricedMessages, ...fromTotals } = cost;
      return { ...step, ...(fromStream ? { ...cost, leadTurns: leadTurns(lines) } : fromTotals) };
    });
    const { costUsd: _c, costReading: _r, sumOfStepTotalsUsd: _s, lastStepTotalUsd: _l, ...rest } = (rec.totals ?? {}) as Row;
    const cost = sessionCost(redone as unknown as StepCost[]);
    sessions++;
    notes.push(`${key}: ${redone.map(s => `${s.id} $${Number(s.costUsd).toFixed(3)}`).join(', ')}; session $${cost.costUsd.toFixed(3)} (${cost.costReading})`);
    return { ...rec, costRecomputed: true, steps: redone, totals: { ...cost, ...rest } };
  });
  if (sessions) { keepOnce(sessionsFile); fs.writeFileSync(sessionsFile, records.map(r => JSON.stringify(r)).join('\n') + '\n'); }

  const attempts = new Map<string, { step: string; before: Reported }>();
  let ledgerEntries = 0, ledgerBeforeUsd = 0, ledgerAfterUsd = 0;
  const ledger = readJsonl(ledgerFile).map(entry => {
    const key = String(entry.key ?? '');
    const cut = key.lastIndexOf('|');
    const [session, step] = [key.slice(0, cut), key.slice(cut + 1)];
    ledgerBeforeUsd += Number(entry.costUsd) || 0;
    if (typeof entry.costBasis === 'string') { attempts.delete(session); ledgerAfterUsd += Number(entry.costUsd) || 0; return entry; }
    const last = attempts.get(session);
    const now = totalOnly(Number(entry.costUsd) || 0);
    const cost = stepCost([], now, last && step.localeCompare(last.step, undefined, { numeric: true }) > 0 ? last.before : null);
    if (cost.costBasis !== 'none') attempts.set(session, { step, before: now }); else if (last) attempts.set(session, { ...last, step });
    ledgerEntries++;
    ledgerAfterUsd += cost.costUsd;
    return { key, costUsd: cost.costUsd, costBasis: cost.costBasis, reportedTotalUsd: cost.reportedTotalUsd, at: entry.at, recomputed: true };
  });
  if (ledgerEntries) { keepOnce(ledgerFile); fs.writeFileSync(ledgerFile, ledger.map(r => JSON.stringify(r)).join('\n') + '\n'); }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { sessions, sessionsLeft, ledgerEntries, ledgerBeforeUsd: round(ledgerBeforeUsd), ledgerAfterUsd: round(ledgerAfterUsd), notes };
}
