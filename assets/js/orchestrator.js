/**
 * orchestrator.js — the fort's loop.
 *
 * Rounds; inside a round each agent takes a turn; inside a turn the agent
 * gets up to N tool steps and must finish with end_turn. Everything any
 * agent says or does is written to the shared thought bus, and each agent's
 * next prompt is rebuilt from that bus — so the three models are reading one
 * another rather than working in parallel silos.
 *
 * The run stops when all three vote done in the same round *and* nobody has
 * touched the workspace since the first of those votes. A vote cast before
 * someone else changed a file is stale and does not count.
 */

import { AGENTS, modelFor, systemPromptFor, turnPromptFor } from './agents.js';
import { bus, KIND } from './thoughts.js';
import { chat, usage } from './mistral.js';
import { TOOL_DEFS, Toolbox } from './tools.js';
import { vfs } from './vfs.js';

const MUTATIONS = new Set(['create', 'write', 'mkdir', 'delete', 'move', 'restore', 'clear']);

export class Orchestrator extends EventTarget {
  constructor({ getSettings, log, onPublish }) {
    super();
    this.getSettings = getSettings;
    this.toolbox = new Toolbox({ getSettings, log, onPublish });
    this.running = false;
    this.controller = null;
    this.round = 0;
    this.mutations = 0;

    vfs.addEventListener('change', (e) => {
      if (MUTATIONS.has(e.detail?.action)) this.mutations++;
    });
  }

  stop() {
    this.controller?.abort();
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #say(entry) {
    return bus.post(entry);
  }

  /** Run the whole task to consensus (or to the round limit / an abort). */
  async run(task) {
    if (this.running) throw new Error('a run is already in progress');

    const settings = this.getSettings();
    if (!settings.mistralKey) throw new Error('No Mistral API key. Open Settings and add one.');

    this.running = true;
    this.controller = new AbortController();
    this.round = 0;

    const signal = this.controller.signal;
    const systems = new Map(AGENTS.map((a) => [a.id, systemPromptFor(a, { task, settings })]));
    /** @type {Map<string, {round:number, done:boolean, reason:string, mutations:number}>} */
    const verdicts = new Map();

    this.#say({ kind: KIND.TASK, who: 'You', text: task });
    this.#emit('start', { task });

    let outcome = 'stopped';

    try {
      for (let round = 1; round <= settings.maxRounds; round++) {
        this.round = round;
        this.#emit('round', { round, maxRounds: settings.maxRounds });
        this.#say({ kind: KIND.SYSTEM, who: 'CodeFort', text: `— round ${round} —`, round });

        for (const agent of AGENTS) {
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');

          this.#emit('turn', { agent, round });
          const verdict = await this.#takeTurn({ agent, round, task, settings, systems, verdicts, signal });
          verdicts.set(agent.id, verdict);
          this.#emit('verdict', { agent, ...verdict });
        }

        if (this.#consensus(verdicts, round)) {
          outcome = 'done';
          this.#say({
            kind: KIND.SYSTEM,
            who: 'CodeFort',
            round,
            text: `All three agents voted done in round ${round}. Standing down.`
          });
          break;
        }

        if (round === settings.maxRounds) {
          outcome = 'exhausted';
          const holdouts = AGENTS.filter((a) => !verdicts.get(a.id)?.done).map((a) => a.name);
          this.#say({
            kind: KIND.SYSTEM,
            who: 'CodeFort',
            round,
            text: `Round limit reached without consensus.${holdouts.length ? ` Still not satisfied: ${holdouts.join(', ')}.` : ''}`
          });
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        outcome = 'stopped';
        this.#say({ kind: KIND.SYSTEM, who: 'CodeFort', text: 'Run stopped.' });
      } else {
        outcome = 'error';
        this.#say({ kind: KIND.ERROR, who: 'CodeFort', text: err.message });
        this.#emit('error', { error: err });
      }
    } finally {
      this.running = false;
      this.controller = null;
      this.#emit('end', { outcome, rounds: this.round, usage: { ...usage }, published: this.toolbox.published });
    }

    return { outcome, rounds: this.round, published: this.toolbox.published };
  }

  /** All agents voted done this round, and nothing changed after the first vote. */
  #consensus(verdicts, round) {
    if (verdicts.size < AGENTS.length) return false;
    const all = [...verdicts.values()];
    if (!all.every((v) => v.round === round && v.done)) return false;
    const earliest = Math.min(...all.map((v) => v.mutations));
    return earliest === this.mutations;
  }

  /** One agent's turn: up to maxSteps tool calls, ending in end_turn. */
  async #takeTurn({ agent, round, task, settings, systems, verdicts, signal }) {
    const model = modelFor(agent, settings);

    const messages = [
      { role: 'system', content: systems.get(agent.id) },
      {
        role: 'user',
        content: turnPromptFor(agent, {
          round,
          maxRounds: settings.maxRounds,
          tree: vfs.tree(),
          transcript: bus.transcriptFor(agent.id),
          nudge: this.#nudgeFor(agent, verdicts, round)
        })
      }
    ];

    let verdict = {
      round,
      done: false,
      reason: 'turn ended without a verdict',
      summary: '',
      mutations: this.mutations
    };
    let sawEndTurn = false;

    for (let step = 1; step <= settings.maxStepsPerTurn && !sawEndTurn; step++) {
      const { message } = await chat({
        apiKey: settings.mistralKey,
        model,
        messages,
        tools: TOOL_DEFS,
        temperature: settings.temperature,
        signal
      });

      messages.push(message);
      this.#emit('usage', { ...usage });

      const text = (message.content || '').trim();
      const calls = message.tool_calls || [];

      if (text) {
        this.#say({ kind: KIND.THOUGHT, agent: agent.id, who: agent.name, model, round, text });
      }

      if (!calls.length) {
        // Talked without acting. One reminder, then the step budget takes over.
        messages.push({
          role: 'user',
          content: 'You produced no tool call. Take a concrete action now, then call end_turn exactly once.'
        });
        continue;
      }

      for (const call of calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }

        this.#say({ kind: KIND.TOOL_CALL, agent: agent.id, who: agent.name, model, round, tool: name, args });

        const result = await this.toolbox.call(name, args, agent);

        if (result.control?.thought) {
          this.#say({
            kind: KIND.THOUGHT, agent: agent.id, who: agent.name, model, round,
            text: result.control.thought
          });
        } else {
          this.#say({
            kind: KIND.TOOL_RESULT, agent: agent.id, who: agent.name, model, round,
            tool: name, result: result.text, ok: result.ok
          });
        }

        messages.push({
          role: 'tool',
          name,
          tool_call_id: call.id,
          content: result.text || (result.ok ? 'ok' : 'failed')
        });

        if (result.control?.endTurn) {
          sawEndTurn = true;
          verdict = {
            round,
            done: result.control.done,
            reason: result.control.reason,
            summary: result.control.summary,
            mutations: this.mutations
          };
          this.#say({
            kind: KIND.VERDICT, agent: agent.id, who: agent.name, model, round,
            text: `${result.control.done ? 'DONE' : 'NOT DONE'} — ${result.control.reason || result.control.summary || 'no reason given'}`
          });
          break;
        }
      }
    }

    if (!sawEndTurn) {
      verdict.mutations = this.mutations;
      this.#say({
        kind: KIND.VERDICT, agent: agent.id, who: agent.name, model, round,
        text: 'NOT DONE — ran out of tool steps before calling end_turn'
      });
    }
    return verdict;
  }

  /** Per-turn steering so agents don't stall or all vote done reflexively. */
  #nudgeFor(agent, verdicts, round) {
    const notes = [];

    const holdouts = AGENTS.filter((a) => a.id !== agent.id && verdicts.get(a.id) && !verdicts.get(a.id).done);
    for (const h of holdouts) {
      notes.push(`${h.name} is not satisfied yet: "${verdicts.get(h.id).reason}". Resolve that before voting done.`);
    }

    const mine = verdicts.get(agent.id);
    if (mine?.done && this.mutations > mine.mutations) {
      notes.push('The workspace changed after your last done vote — re-check it before voting done again.');
    }

    if (round === 1 && agent.id === 'architect') {
      notes.push('Nothing exists yet. Write /PLAN.md first, then start the scaffold.');
    }

    if (!vfs.exists('/index.html') && round >= 2 && agent.id === 'builder') {
      notes.push('There is still no /index.html. If this task produces a site, that file is the entry point.');
    }

    return notes.join(' ');
  }
}
