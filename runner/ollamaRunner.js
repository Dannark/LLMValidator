const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags';

function buildPrompt(inputText) {
  return [
    'You are a strict JSON extractor.',
    'Extract the address fields from the input text and return ONLY valid JSON.',
    'Do not include markdown, explanations, or extra keys.',
    'Required keys: name, street, city, postal_code, country.',
    'Use empty string when a field is unknown.',
    'Output format:',
    '{"name":"","street":"","city":"","postal_code":"","country":""}',
    '',
    `Input: ${inputText}`,
  ].join('\n');
}

function tryParseJson(rawOutput) {
  try {
    return JSON.parse(rawOutput);
  } catch (_error) {
    return null;
  }
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
