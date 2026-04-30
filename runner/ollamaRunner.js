const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(
  /\/$/,
  '',
);
const OLLAMA_URL = `${OLLAMA_BASE}/api/generate`;
const OLLAMA_TAGS_URL = `${OLLAMA_BASE}/api/tags`;

/**
 * Max context tokens per /api/generate request (KV RAM scales with this).
 * Keep low for ~24–30 GiB hosts; extraction prompts here are short.
 * Override: OLLAMA_NUM_CTX. Also set OLLAMA_CONTEXT_LENGTH on `ollama serve` so CLI/other clients match.
 */
const DEFAULT_NUM_CTX = 4096;

function resolveNumCtx() {
  const raw = process.env.OLLAMA_NUM_CTX;
  if (raw == null || `${raw}`.trim() === '') {
    return DEFAULT_NUM_CTX;
  }
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 256) {
    return DEFAULT_NUM_CTX;
  }
  return Math.min(n, 262144);
}

function buildPrompt(inputText) {
  return [
    'You are a strict JSON extractor.',
    'Extract the address fields from the input text and return ONLY valid JSON.',
    'Do not include markdown, explanations, or extra keys.',
    'Required keys: name, address1, address2, city, region, postal, country.',
    'Use empty string when a field is unknown.',
    'Name rules:',
    '- The name field acts as an identifier / primary key (e.g. "Company X, person name").',
    '- Copy the name from the input EXACTLY as given: same wording, punctuation, commas, and order. Do not rephrase, normalize, fix spelling, or merge with address lines.',
    'Region and country rules:',
    '- Never abbreviate region or country. Use full region names (e.g. full state or province name, not a 2-letter code) and full English country names.',
    '- If the input explicitly mentions a country (e.g. "UNITED STATES", "CANADA", "BRAZIL", "ISRAEL"), use that country in full form.',
    '- Do NOT output 2-letter country codes (e.g. "US", "BR").',
    '- If the input does NOT explicitly mention a country, leave country as an empty string.',
    'Address rules:',
    '- Put the main street/number (and PO Box) in address1.',
    '- Put unit/suite/apartment/building/floor and other complements in address2.',
    '- Do NOT duplicate address text inside name.',
    'Output format:',
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
      prompt: buildPrompt(input),
      stream: false,
      options: {
        num_ctx: resolveNumCtx(),
      },
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
