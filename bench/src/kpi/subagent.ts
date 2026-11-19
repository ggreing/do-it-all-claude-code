// Decision 233: the `subagent` arrangement of scripts/measure107.ts. Plain Claude Code, no plugin and no router, as
// `direct` is; the task's prompt comes after a fixed instruction that tells the main session to hand the whole task,
// word for word, to one subagent (Agent tool: general-purpose, a named model and effort) and to do nothing itself.
// It separates two things a router run mixes: a model working as a subagent of Claude Code, and what the router
// adds to that (the lead's brief, the write scope, the guard, the verify step).
// The Agent tool of Claude Code 2.1.328 takes `model` (sonnet, opus, haiku, fable) and `effort` (low, medium, high,
// xhigh, max). It drops `effort` from its input when CLAUDE_CODE_EFFORT_LEVEL is set and `model` when
// CLAUDE_CODE_SUBAGENT_MODEL_FORCE is; neither variable reaches a measured run (its environment is allow-listed).
// The stream shows the model of each of the subagent's messages. It does not show the effort a subagent ran at:
// what a record has of it is the value the Agent call carried and whether the tool took the call.
import type { StreamLine } from './phases.ts';

export const SUBAGENT_TYPE = 'general-purpose';
export const SUBAGENT_MODELS: readonly string[] = ['sonnet', 'opus', 'haiku', 'fable'];
export const SUBAGENT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The line that separates the instruction from the task: everything after it is the task as it was written. */
export const TASK_MARK = '--- task ---';

export interface SubagentAsk { model: string; effort: string }

/** The prompt of a `subagent` run: the instruction, the mark, the task unchanged. */
export function handOffPrompt(task: string, ask: SubagentAsk): string {
  return [
    'Do not work on the task below yourself. Your only job in this session is to hand it to one subagent and to report what that subagent did.',
    '',
    `Make exactly one Agent tool call: subagent_type "${SUBAGENT_TYPE}", model "${ask.model}", effort "${ask.effort}", and as its prompt the whole task, which is everything below the line "${TASK_MARK}", word for word, with nothing added, left out, summarised or rephrased. The subagent works in this folder and makes the changes itself.`,
    '',
    'Do not read, search or edit files and do not run commands yourself, before the call or after it: this run is to show what the subagent does on its own with the task as it was written. When the subagent has finished, report what it did, from its result.',
    '',
    TASK_MARK,
    task,
  ].join('\n');
}

export interface SubagentCall {
  subagentType: string | null;
  model: string | null;
  effort: string | null;
  /** run_in_background of the call; null when the call did not say. */
  background: boolean | null;
  /** The call's prompt holds the task word for word (runs of white space count as one). */
  taskVerbatim: boolean;
  /** Characters of the call's prompt beyond the task's (0 for the task alone; negative when it was cut). */
  addedChars: number;
  /** The start of the tool's answer when it refused the call (an input it does not take, a model it cannot run). */
  error: string | null;
}

export interface SubagentSeen {
  asked: { subagentType: string; model: string; effort: string };
  /** The main session's Agent calls, in order. */
  calls: SubagentCall[];
  /** The models of the subagents' own messages, as the stream names them, most messages first. */
  ranModels: Array<{ model: string; messages: number }>;
  /** The models of the main session's messages. */
  leadModels: string[];
  /** What the main session did itself besides the Agent call: tool name -> calls. */
  leadOwnTools: Record<string, number>;
  /** Where the run was not the hand-off asked for; empty when it was. */
  problems: string[];
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const squeeze = (s: string): string => s.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join(' ');
}

/** What a `subagent` run's stream shows of the hand-off: the Agent calls, the models that ran, what the main session did itself. */
export function subagentSeen(lines: readonly StreamLine[], task: string, ask: SubagentAsk): SubagentSeen {
  const want = squeeze(task);
  const calls: Array<SubagentCall & { id: string }> = [];
  const ran = new Map<string, number>();
  const leadModels = new Set<string>();
  const leadOwnTools: Record<string, number> = {};
  for (const { m } of lines) {
    const msg = m.message as { model?: unknown; content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg.content as Array<Record<string, unknown>> : [];
    const sub = typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id !== '';
    if (m.type === 'assistant') {
      const model = str(msg?.model);
      if (sub) { if (model) ran.set(model, (ran.get(model) ?? 0) + 1); continue; }
      if (model) leadModels.add(model);
      for (const c of content) {
        if (c.type !== 'tool_use' || typeof c.name !== 'string') continue;
        if (!AGENT_TOOLS.has(c.name)) { leadOwnTools[c.name] = (leadOwnTools[c.name] ?? 0) + 1; continue; }
        const input = (c.input ?? {}) as Record<string, unknown>;
        const prompt = squeeze(typeof input.prompt === 'string' ? input.prompt : '');
        calls.push({ id: String(c.id ?? ''), subagentType: str(input.subagent_type), model: str(input.model), effort: str(input.effort),
          background: typeof input.run_in_background === 'boolean' ? input.run_in_background : null,
          taskVerbatim: want !== '' && prompt.includes(want), addedChars: prompt.length - want.length, error: null });
      }
    } else if (m.type === 'user' && !sub) {
      for (const c of content) {
        if (c.type !== 'tool_result' || c.is_error !== true) continue;
        const call = calls.find(x => x.id === c.tool_use_id);
        if (call) call.error = squeeze(resultText(c.content)).slice(0, 200) || 'refused';
      }
    }
  }
  const asked = { subagentType: SUBAGENT_TYPE, model: ask.model, effort: ask.effort };
  const ranModels = [...ran.entries()].map(([model, messages]) => ({ model, messages })).sort((a, b) => b.messages - a.messages);
  const problems: string[] = [];
  const started = calls.filter(c => !c.error);
  if (!calls.length) problems.push('the main session made no Agent call: the task was not handed to a subagent');
  for (const c of calls) if (c.error) problems.push(`the Agent tool refused a call (${c.error})`);
  if (started.length > 1) problems.push(`the main session started ${started.length} subagents, not one`);
  for (const c of started) {
    const got = `${c.subagentType ?? 'no type'} ${c.model ?? 'no model'}/${c.effort ?? 'no effort'}`;
    if (c.subagentType !== asked.subagentType || c.model !== asked.model || c.effort !== asked.effort) problems.push(`an Agent call asked for ${got}, not ${asked.subagentType} ${asked.model}/${asked.effort}`);
    if (!c.taskVerbatim) problems.push('an Agent call did not carry the task word for word');
    else if (c.addedChars > 0) problems.push(`an Agent call added ${c.addedChars} characters to the task`);
  }
  // the alias the call names (opus) is part of the model's full name in the stream (claude-opus-...)
  const other = ranModels.filter(r => !r.model.includes(ask.model));
  if (started.length && !ranModels.length) problems.push('the stream has no message of a subagent: the model it ran on is not known');
  if (other.length) problems.push(`a subagent ran on ${other.map(r => r.model).join(', ')}, not on ${ask.model}`);
  const own = Object.entries(leadOwnTools);
  if (own.length) problems.push(`the main session worked itself (${own.map(([n, k]) => `${n} x${k}`).join(', ')})`);
  return { asked, calls: calls.map(({ id: _id, ...c }) => c), ranModels, leadModels: [...leadModels], leadOwnTools, problems };
}

/**
 * The run's cost split between the main session and its subagent, from the result's cost per model. It can be told
 * only when the two ran on different models: per model is all Claude Code reports. Null otherwise. A model that
 * neither named in a message (a helper call of Claude Code itself) counts with the main session.
 */
export function subagentCostSplit(seen: SubagentSeen, modelUsage: unknown, totalUsd: number): { leadUsd: number; subagentUsd: number } | null {
  const sub = seen.ranModels.map(r => r.model);
  if (!sub.length || sub.some(m => seen.leadModels.includes(m))) return null;
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  let subagentUsd = 0;
  for (const [model, u] of Object.entries(modelUsage as Record<string, { costUSD?: unknown }>)) {
    if (sub.some(m => model === m || model.startsWith(m))) subagentUsd += Number(u?.costUSD ?? 0) || 0;
  }
  return { leadUsd: Math.max(0, totalUsd - subagentUsd), subagentUsd };
}

/** One line for the console: what was asked, what ran. */
export function subagentLine(seen: SubagentSeen): string {
  const ran = seen.ranModels.length ? seen.ranModels.map(r => `${r.model} (${r.messages} messages)`).join(', ') : 'nothing seen';
  const call = seen.calls.find(c => !c.error);
  const handed = !call ? 'no hand-off' : call.taskVerbatim ? (call.addedChars > 0 ? `the task handed over with ${call.addedChars} characters added` : 'the task handed over word for word') : 'the task NOT handed over word for word';
  return `subagent: asked ${seen.asked.subagentType} ${seen.asked.model}/${seen.asked.effort}; the call carried ${call ? `${call.model ?? 'no model'}/${call.effort ?? 'no effort'}` : 'nothing'}; ran on ${ran}; ${handed}`;
}
