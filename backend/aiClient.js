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
// (was `flatten` — replaced by toOpenAIContent() below, which preserves images
//  instead of discarding them. Kept out to avoid two ways of shaping content.)

// Never let a provider stall a request forever — a hung upstream would otherwise
// hold the HTTP handler (and the user's spinner) open indefinitely. Vision calls
// on large models are slow, so the default is generous but finite.
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '25000', 10);
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ac = new AbortController(); setTimeout(() => ac.abort(), ms); return ac.signal;   // older Node
}
const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'TimeoutError');

async function callAnthropic(url, key, model, system, messages, maxTokens) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
      signal: timeoutSignal(AI_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbort(e)) throw new AIError(`AI timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s`, 'timeout', 504);
    throw new AIError('Could not reach the AI service.', 'network', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const t = data.error && data.error.type;
    const err = new AIError(userMsg(t), t || 'unknown', res.status);
    err.retriable = retriable(t);
    throw err;
  }
  return {
    text: (data.content || []).find((b) => b.type === 'text')?.text || '',
    usage: {
      input_tokens: data.usage?.input_tokens || 0,
      output_tokens: data.usage?.output_tokens || 0,
      model,
    },
  };
}

// Anthropic content blocks → OpenAI-compatible ones (NVIDIA NIM, Ollama, LM Studio).
// Images MUST be translated, not flattened away: Anthropic uses
//   { type:'image', source:{ type:'base64', media_type, data } }
// OpenAI-compatible APIs use
//   { type:'image_url', image_url:{ url:'data:<mime>;base64,<data>' } }
// `flatten()` drops non-text blocks, so a vision call (e.g. reading a POS EOD slip)
// would silently lose its photo and the model would answer from the prompt alone.
function toOpenAIContent(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = c.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image' && b.source && b.source.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    }
    if (b.type === 'image_url') return b;   // already OpenAI-shaped
    return null;
  }).filter(Boolean);
  // Plain-text-only messages stay strings — widest compatibility with older servers.
  return parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts;
}

async function callOpenAICompat(url, key, model, system, messages, maxTokens) {
  const oai = [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: toOpenAIContent(m.content) }))];
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: oai }),
      signal: timeoutSignal(AI_TIMEOUT_MS),
    });
  } catch (e) {
    if (isAbort(e)) throw new AIError(`AI timed out after ${Math.round(AI_TIMEOUT_MS / 1000)}s`, 'timeout', 504);
    throw new AIError('Could not reach the AI service.', 'network', 502);
  }
  if (!res.ok) {
    await res.text().catch(() => '');   // drain body
    throw new AIError('AI service returned an error. Please try again.', 'openai_error', res.status);
  }
  const data = await res.json().catch(() => ({}));
  return {
    text: data.choices?.[0]?.message?.content || '',
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      model,
    },
  };
}

/**
 * callAI({ system, messages, maxTokens, noFallback, withUsage }) → string
 * With `withUsage: true` → { text, usage:{ input_tokens, output_tokens, model } }
 * so a caller can bill/track spend. Default stays a plain string, so existing
 * callers are unaffected.
 * Throws AIError on failure (httpStatus 503 + code 'no_api_key' if unconfigured).
 */
async function callAI({ system, messages, maxTokens = 1024, noFallback = false, withUsage = false }) {
  const key = process.env.AI_API_KEY;
  const url = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';
  const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  const fbUrl = process.env.AI_FALLBACK_URL;
  const fbModel = process.env.AI_FALLBACK_MODEL || 'qwen2.5:7b';
  const out = (r) => (withUsage ? r : r.text);

  if (!key && !(url && !url.includes('anthropic.com'))) {
    throw new AIError('AI is not configured yet. Set AI_API_KEY on the server.', 'no_api_key', 503);
  }
  const isAnthropic = url.includes('anthropic.com');
  if (!isAnthropic) return out(await callOpenAICompat(url, key, model, system, messages, maxTokens));

  try {
    return out(await callAnthropic(url, key, model, system, messages, maxTokens));
  } catch (err) {
    if (err instanceof AIError && err.retriable) {
      await new Promise((r) => setTimeout(r, 3000));
      try { return out(await callAnthropic(url, key, model, system, messages, maxTokens)); }
      catch { /* fall through to fallback */ }
      if (fbUrl && !noFallback) {
        try { return out(await callOpenAICompat(fbUrl, undefined, fbModel, system, messages, maxTokens)); }
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
