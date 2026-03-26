const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';

function buildPrompt(inputText) {
  return [
    "You're a name and address parser. You should extract it from a string that has name and address together.",
    'Extract the address fields from the input text and return ONLY valid JSON.',
    'Do not include markdown, explanations, or extra keys.',
    'Required keys: name, address1, address2, city, region, postal, country.',
    'Use empty string when a field is unknown.',
    'Country rules:',
    '- If the input explicitly mentions a country (e.g. "UNITED STATES", "CANADA", "BRAZIL", "ISRAEL"), use that country.',
    '- Do NOT output 2-letter country codes (e.g. "US", "BR"). Prefer full English country names.',
    '- If the input does NOT explicitly mention a country, leave country as an empty string.',
    'Address rules:',
    '- Put the main street/number (and PO Box) in address1.',
    '- Put unit/suite/apartment/building/floor and other complements in address2.',
    '- Put ONLY the customer/entity name in name. Do NOT repeat the address inside name.',
    '- If uncertain, preserve tokens from input instead of inventing or normalizing.',
    '- Do NOT drop meaningful address fragments; keep overflow/complements in address2.',
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
    }),
  });

  const elapsedMs = Date.now() - start;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Falha no Ollama (${response.status}): ${text}`);
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
    throw new Error(`Falha ao listar modelos do Ollama (${response.status}): ${text}`);
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
