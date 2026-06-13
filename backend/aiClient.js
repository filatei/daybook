/**
 * Daybook AI Client (CommonJS port of the Torama etax aiClient)
 * ─────────────────────────────────────────────────────────────
 * Primary:  Anthropic (Claude) via HTTPS  — x-api-key + anthropic-version
 * Fallback: any OpenAI-compatible endpoint (Ollama, LM Studio) on 429/529
 *
 * Env vars (set on the server / in GitHub Secrets):
 *   AI_API_KEY         Anthropic key (sk-ant-…)   — REQUIRED to enable AI
 *   AI_API_URL         default https://api.anthropic.com/v1/messages
 *   AI_MODEL           default claude-haiku-4-5-20251001
 *   AI_FALLBACK_URL    optional, e.g. http://localhost:11434/v1/chat/completions
 *   AI_FALLBACK_MODEL  default qwen2.5:7b
 *
 * Same env-var names and behaviour as etax, so one key configures both apps.
 */
'use strict';

class AIError extends Error {
  constructor(userMessage, code, httpStatus) {
    super(userMessage);
    this.name = 'AIError';
    this.userMessage = userMessage;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const userMsg = (t) => ({
  authentication_error: 'AI: invalid API key — check AI_API_KEY',
  permission_error: 'AI: this key cannot access the configured model',
  rate_limit_error: 'AI rate limit reached. Please wait and try again.',
  overloaded_error: 'AI is busy right now. Please try again shortly.',
}[t] || 'AI service returned an error. Please try again.');

const retriable = (t) => t === 'overloaded_error' || t === 'rate_limit_error';
const flatten = (c) => (typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

async function callAnthropic(url, key, model, system, messages, maxTokens) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const t = data.error && data.error.type;
    const err = new AIError(userMsg(t), t || 'unknown', res.status);
    err.retriable = retriable(t);
    throw err;
  }
  return (data.content || []).find((b) => b.type === 'text')?.text || '';
}

async function callOpenAICompat(url, key, model, system, messages, maxTokens) {
  const oai = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: flatten(m.content) }))];
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, max_tokens: maxTokens, messages: oai }) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AIError('AI service returned an error. Please try again.', 'openai_error', res.status);
  }
  const data = await res.json().catch(() => ({}));
  return data.choices?.[0]?.message?.content || '';
}

/**
 * callAI({ system, messages, maxTokens, noFallback }) → string
 * Throws AIError on failure (httpStatus 503 + code 'no_api_key' if unconfigured).
 */
async function callAI({ system, messages, maxTokens = 1024, noFallback = false }) {
  const key = process.env.AI_API_KEY;
  const url = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';
  const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  const fbUrl = process.env.AI_FALLBACK_URL;
  const fbModel = process.env.AI_FALLBACK_MODEL || 'qwen2.5:7b';

  if (!key && !(url && !url.includes('anthropic.com'))) {
    throw new AIError('AI is not configured yet. Set AI_API_KEY on the server.', 'no_api_key', 503);
  }
  const isAnthropic = url.includes('anthropic.com');
  if (!isAnthropic) return callOpenAICompat(url, key, model, system, messages, maxTokens);

  try {
    return await callAnthropic(url, key, model, system, messages, maxTokens);
  } catch (err) {
    if (err instanceof AIError && err.retriable) {
      await new Promise((r) => setTimeout(r, 3000));
      try { return await callAnthropic(url, key, model, system, messages, maxTokens); }
      catch { /* fall through to fallback */ }
      if (fbUrl && !noFallback) {
        try { return await callOpenAICompat(fbUrl, undefined, fbModel, system, messages, maxTokens); }
        catch (e) { /* fall through to throw original */ }
      }
    }
    throw err;
  }
}

const aiConfigured = () => !!(process.env.AI_API_KEY || (process.env.AI_API_URL && !process.env.AI_API_URL.includes('anthropic.com')));

/**
 * Agentic call with tools (Anthropic only). The model may call your tools to
 * fetch data, then answer. `runTool(name, input)` executes a tool and returns
 * a JSON-serialisable result. Loops up to maxRounds.
 */
async function callAgent({ system, messages, tools, runTool, maxTokens = 900, maxRounds = 4 }) {
  const key = process.env.AI_API_KEY;
  const url = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';
  const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  if (!key) throw new AIError('AI is not configured yet. Set AI_API_KEY on the server.', 'no_api_key', 503);
  const msgs = messages.map((m) => ({ ...m }));
  for (let round = 0; round < maxRounds; round++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: msgs, tools }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const t = data.error && data.error.type;
      throw new AIError(userMsg(t), t || 'unknown', res.status);
    }
    const blocks = data.content || [];
    if (data.stop_reason === 'tool_use') {
      msgs.push({ role: 'assistant', content: blocks });
      const results = [];
      for (const blk of blocks) {
        if (blk.type !== 'tool_use') continue;
        let out;
        try { out = await runTool(blk.name, blk.input || {}); }
        catch (e) { out = { error: String(e.message || e) }; }
        results.push({ type: 'tool_result', tool_use_id: blk.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      msgs.push({ role: 'user', content: results });
      continue;
    }
    return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  return 'I gathered the data but ran out of steps before finishing — please narrow the question.';
}

module.exports = { callAI, callAgent, AIError, aiConfigured };
