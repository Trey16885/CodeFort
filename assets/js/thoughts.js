/**
 * thoughts.js — the shared mind of the fort.
 *
 * Every reasoning line, tool call, tool result and verdict from every agent
 * lands here. The orchestrator renders a slice of this log into each agent's
 * prompt, which is the mechanism by which the models read one another's
 * thinking instead of each working blind.
 */

export const KIND = {
  SYSTEM: 'system',
  TASK: 'task',
  THOUGHT: 'thought',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  VERDICT: 'verdict',
  ERROR: 'error'
};

export class ThoughtBus extends EventTarget {
  constructor() {
    super();
    /** @type {Array<object>} */
    this.entries = [];
    this.seq = 0;
  }

  post(entry) {
    const record = {
      id: ++this.seq,
      at: Date.now(),
      round: entry.round ?? null,
      agent: entry.agent ?? null,   // agent id, e.g. 'architect'
      who: entry.who ?? 'CodeFort', // display name
      model: entry.model ?? null,
      kind: entry.kind ?? KIND.SYSTEM,
      text: entry.text ?? '',
      tool: entry.tool ?? null,
      args: entry.args ?? null,
      result: entry.result ?? null,
      ok: entry.ok ?? true
    };
    this.entries.push(record);
    this.dispatchEvent(new CustomEvent('post', { detail: record }));
    return record;
  }

  clear() {
    this.entries = [];
    this.dispatchEvent(new CustomEvent('clear'));
  }

  /**
   * Render the recent shared log as prompt text for `viewerId`.
   * The agent's own lines are marked so it can tell self from other.
   */
  transcriptFor(viewerId, { limit = 45, maxChars = 9000 } = {}) {
    const slice = this.entries.slice(-limit);
    const lines = [];

    for (const e of slice) {
      const mine = e.agent && e.agent === viewerId;
      const tag = e.agent ? `${e.who}${mine ? ' (you)' : ''}` : e.who;

      switch (e.kind) {
        case KIND.TASK:
          lines.push(`[TASK] ${e.text}`);
          break;
        case KIND.THOUGHT:
          lines.push(`[${tag} thinking] ${e.text}`);
          break;
        case KIND.TOOL_CALL:
          lines.push(`[${tag} calls ${e.tool}] ${compactArgs(e.args)}`);
          break;
        case KIND.TOOL_RESULT:
          lines.push(`[${e.tool} -> ${e.ok ? 'ok' : 'FAILED'}] ${clip(e.result, 320)}`);
          break;
        case KIND.VERDICT:
          lines.push(`[${tag} verdict] ${e.text}`);
          break;
        case KIND.ERROR:
          lines.push(`[${tag} error] ${e.text}`);
          break;
        default:
          lines.push(`[${e.who}] ${e.text}`);
      }
    }

    // Trim from the front so the newest context always survives.
    let out = lines.join('\n');
    if (out.length > maxChars) out = '…(earlier discussion trimmed)…\n' + out.slice(-maxChars);
    return out || '(nothing yet — you are opening the discussion)';
  }

  /** Latest verdict per agent, used for the done-consensus check. */
  latestVerdicts() {
    const map = new Map();
    for (const e of this.entries) {
      if (e.kind === KIND.VERDICT && e.agent) map.set(e.agent, e);
    }
    return map;
  }
}

function clip(value, n) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

function compactArgs(args) {
  if (!args) return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    parts.push(`${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 140)}`);
  }
  return parts.join(' ');
}

export const bus = new ThoughtBus();
