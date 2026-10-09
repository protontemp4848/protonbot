import { preview } from './log.js';

/** Thin client for xAI's OpenAI-compatible chat completions API. */
export class GrokClient {
  constructor({ apiKey, model, baseUrl = 'https://api.x.ai/v1', fetchImpl = globalThis.fetch, timeoutMs = 30_000, now = Date.now, log = console }) {
    Object.assign(this, { apiKey, model, baseUrl, fetchImpl, timeoutMs, now, log });
    // Totals since start, for !stats. `unreported` counts calls whose response had no token usage.
    this.usage = { calls: 0, tokensIn: 0, tokensOut: 0, reasoning: 0, unreported: 0 };
  }

  async chat(messages) {
    return (await this.complete(messages)).content?.trim() ?? '';
  }

  /**
   * Returns the raw assistant message, which may contain `tool_calls` when `tools` are offered.
   * `tag` is prefixed to log lines so they can be matched to the chat message that caused them.
   */
  async complete(messages, { tools, tag = '' } = {}) {
    const body = { model: this.model, messages, temperature: 0.8 };
    if (tools?.length) body.tools = tools;
    const chars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    this.log.debug?.(`[llm]${tag} request: ${messages.length} messages, ${chars} chars, tools=${tools?.length ? 'yes' : 'no'}`);
    const started = this.now();
    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`xAI API ${res.status} after ${this.#secs(started)}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const message = data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
    const u = data.usage ?? {};
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    this.usage.calls++;
    if (u.prompt_tokens == null) this.usage.unreported++;
    this.usage.tokensIn += u.prompt_tokens ?? 0;
    this.usage.tokensOut += u.completion_tokens ?? 0;
    this.usage.reasoning += reasoning ?? 0;
    const tokens = u.prompt_tokens == null ? 'tokens n/a' : `tokens in=${u.prompt_tokens} out=${u.completion_tokens}${reasoning ? ` (reasoning ${reasoning})` : ''}`;
    const result = message.tool_calls?.length
      ? 'tool calls: ' + message.tool_calls.map((c) => `${c.function?.name}(${preview(c.function?.arguments, 80)})`).join(', ')
      : `answer (${message.content?.length ?? 0} chars)`;
    this.log.info(`[llm]${tag} ${data.model ?? this.model} ${this.#secs(started)} ${tokens} -> ${result}`);
    return message;
  }

  #secs(started) {
    return `${((this.now() - started) / 1000).toFixed(2)}s`;
  }
}
