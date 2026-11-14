const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(
  /\/$/,
  '',
);
const OLLAMA_URL = `${OLLAMA_BASE}/api/generate`;
const OLLAMA_TAGS_URL = `${OLLAMA_BASE}/api/tags`;

// Optional: cap context per request (can interact badly with some models/hosts).
// const DEFAULT_NUM_CTX = 4096;
// function resolveNumCtx() {
//   const raw = process.env.OLLAMA_NUM_CTX;
//   if (raw == null || `${raw}`.trim() === '') {
//     return DEFAULT_NUM_CTX;
//   }
//   const n = Number.parseInt(String(raw), 10);
//   if (!Number.isFinite(n) || n < 256) {
//     return DEFAULT_NUM_CTX;
//   }
//   return Math.min(n, 262144);
// }

/** Instructions for the model role and normalization rules (Ollama `system` field). */
const OLLAMA_SYSTEM_PROMPT =
  'You are an address normalization service. Extract and return a structured JSON with: person name or company (call it as name), address1 (including number), address2, city, region, postal_code, country. Consider details like unit, apartment, postal box and similar as address2. Return everything uppercase. Region/state should have its full name, if possible. Keep country with 3 letters. If the zip code is set, use it to help on detect the country. Try to do not keep the country empty. But, if you are not able to extract the data, keep it blank.';

/** User turn: schema alignment for this app + raw input (minimal). */
function buildPrompt(inputText) {
  return [
    'Return ONLY valid JSON. No markdown, no prose.',
    'Use exactly these keys (postal is the zip/postal code):',
    '{"name":"","address1":"","address2":"","city":"","region":"","postal":"","country":""}',
    '',
    `Input: ${inputText}`,
  ].join('\n');
}

function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parses model output that may be raw JSON or wrapped in markdown fences (```json ... ```),
 * optionally with extra prose before/after the fence.
 */
function tryParseJson(rawOutput) {
  const cleaned = `${rawOutput ?? ''}`.trim();
  if (!cleaned) {
    return null;
  }

  const direct = parseJsonLenient(cleaned);
  if (direct !== null) {
    return direct;
  }

  // Entire string is one fenced block (common case)
  const fullFence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/im.exec(cleaned);
  if (fullFence) {
    const inner = fullFence[1].trim();
    const parsed = parseJsonLenient(inner);
    if (parsed !== null) {
      return parsed;
    }
  }

  // First fenced block anywhere (e.g. "Here is the result:\n```json\n{...}\n```")
  const embedded = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;
  let match;
  while ((match = embedded.exec(cleaned)) !== null) {
    const inner = match[1].trim();
    const parsed = parseJsonLenient(inner);
    if (parsed !== null) {
      return parsed;
    }
  }

  // Last resort: object between first "{" and last "}"
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = cleaned.slice(start, end + 1);
    return parseJsonLenient(sliced);
  }

  return null;
}

async function runOllamaExtraction({ model, input }) {
  const start = Date.now();

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system: OLLAMA_SYSTEM_PROMPT,
      prompt: buildPrompt(input),
      stream: false,
      // Let Ollama use server / Modelfile defaults (omit num_ctx for benchmarking).
      // options: { num_ctx: resolveNumCtx() },
    }),
  });

  const elapsedMs = Date.now() - start;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const rawOutput = (data.response || '').trim();
  const parsedJson = tryParseJson(rawOutput);

  return {
    raw_output: rawOutput,
    parsed_json: parsedJson,
    execution_time_ms: elapsedMs,
    json_valid: parsedJson !== null,
  };
}

async function listInstalledOllamaModels() {
  const response = await fetch(OLLAMA_TAGS_URL);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list Ollama models (${response.status}): ${text}`);
  }

  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models : [];
  return models
    .map((item) => item?.name)
    .filter((name) => typeof name === 'string' && name.trim().length > 0);
}

module.exports = {
  runOllamaExtraction,
  listInstalledOllamaModels,
};
