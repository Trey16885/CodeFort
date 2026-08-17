/**
 * mistral.js — thin client for the Mistral chat-completions API.
 *
 * `api.mistral.ai` sends `access-control-allow-origin: *`, so the browser
 * talks to it directly and CodeFort stays a pure static site.
 */

const ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const MAX_RETRIES = 4;

export class MistralError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'MistralError';
    this.status = status;
    this.retryable = retryable;
  }
}

export const usage = { prompt: 0, completion: 0, total: 0, calls: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One chat completion.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages
 * @param {Array}  [opts.tools]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{message: object, finishReason: string}>}
 */
export async function chat({
  apiKey,
  model,
  messages,
  tools,
  temperature = 0.35,
  maxTokens = 2600,
  signal
}) {
  if (!apiKey) throw new MistralError('No Mistral API key configured. Open Settings and add one.');

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = false; // one step at a time keeps the log readable
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        throw new MistralError(
          `${model}: HTTP ${res.status} ${res.statusText}${detail ? ` — ${trim(detail, 300)}` : ''}`,
          { status: res.status, retryable }
        );
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) throw new MistralError(`${model}: response contained no choices`);

      if (data.usage) {
        usage.prompt += data.usage.prompt_tokens || 0;
        usage.completion += data.usage.completion_tokens || 0;
        usage.total += data.usage.total_tokens || 0;
      }
      usage.calls++;

      return { message: choice.message, finishReason: choice.finish_reason };
    } catch (err) {
      if (err.name === 'AbortError') throw err;

      const retryable = err instanceof MistralError ? err.retryable : true; // network blips
      lastError = err;
      if (!retryable || attempt === MAX_RETRIES) break;

      await sleep(2 ** attempt * 800 + Math.random() * 400);
    }
  }
  throw lastError;
}

function trim(s, n) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

/** Cheap sanity check for the Settings dialog. */
export async function verifyKey(apiKey, model = 'mistral-small-latest') {
  await chat({
    apiKey,
    model,
    messages: [{ role: 'user', content: 'reply with the single word: ok' }],
    maxTokens: 5
  });
  return true;
}
