const { runOllamaExtraction, listInstalledOllamaModels } = require('../../runner/ollamaRunner');

function normalizeCountryValue(rawCountry) {
  const value = `${rawCountry ?? ''}`.trim();
  if (!value) {
    return '';
  }
  const upper = value.toUpperCase();
  if (upper === 'USA' || upper === 'US' || upper === 'UNITED STATES OF AMERICA') {
    return 'United States';
  }
  if (upper === 'BR' || upper === 'BRAZIL') {
    return 'Brazil';
  }
  if (upper === 'DE' || upper === 'GERMANY') {
    return 'Germany';
  }
  if (upper === 'UAE' || upper === 'UNITED ARAB EMIRATES') {
    return 'United Arab Emirates';
  }
  // Keep as-is (trimmed) for other countries (Canada, Israel, etc.)
  return value;
}

function inferCountryFromInput(inputText) {
  const text = `${inputText ?? ''}`.toUpperCase();
  if (/\b(UNITED STATES|USA|US)\b/.test(text)) return 'United States';
  if (/\bCANADA\b/.test(text)) return 'Canada';
  if (/\b(BRAZIL|BR)\b/.test(text)) return 'Brazil';
  if (/\b(GERMANY|DE)\b/.test(text)) return 'Germany';
  if (/\bISRAEL\b/.test(text)) return 'Israel';
  if (/\bAUSTRALIA\b/.test(text)) return 'Australia';
  if (/\b(UNITED ARAB EMIRATES|UAE)\b/.test(text)) return 'United Arab Emirates';
  if (/\bGUATEMALA\b/.test(text)) return 'Guatemala';
  return '';
}

function sanitizeOutput(parsedJson, inputText) {
  if (!parsedJson || typeof parsedJson !== 'object') {
    return null;
  }

  const inferredCountry = inferCountryFromInput(inputText);
  const normalizedCountry = normalizeCountryValue(parsedJson.country);
  const country = inferredCountry || normalizedCountry;

  return {
    name: `${parsedJson.name ?? ''}`.trim(),
    address1: `${parsedJson.address1 ?? parsedJson.street ?? ''}`.trim(),
    address2: `${parsedJson.address2 ?? ''}`.trim(),
    city: `${parsedJson.city ?? ''}`.trim(),
    region: `${parsedJson.region ?? parsedJson.state ?? ''}`.trim(),
    postal: `${parsedJson.postal ?? parsedJson.postal_code ?? ''}`.trim(),
    country,
  };
}

async function runSingleCase({ model, input, expected = null }) {
  const result = await runOllamaExtraction({ model, input });
  return {
    input,
    expected,
    ...result,
    parsed_json: sanitizeOutput(result.parsed_json, input),
  };
}

async function runBatchCases({ model, cases }) {
  if (!model || typeof model !== 'string') {
    throw new Error('model is required.');
  }

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('cases must be a non-empty array.');
  }

  const results = [];
  for (const item of cases) {
    const caseInput = `${item.input ?? ''}`.trim();
    if (!caseInput) {
      results.push({
        input: item.input ?? '',
        expected: item.expected ?? null,
        raw_output: '',
        parsed_json: null,
        execution_time_ms: 0,
        json_valid: false,
        error: 'Empty input.',
      });
      continue;
    }

    try {
      const response = await runSingleCase({
        model,
        input: caseInput,
        expected: item.expected ?? null,
      });
      results.push(response);
    } catch (error) {
      results.push({
        input: caseInput,
        expected: item.expected ?? null,
        raw_output: '',
        parsed_json: null,
        execution_time_ms: 0,
        json_valid: false,
        error: error.message,
      });
    }
  }

  const processed = results.length;
  const validCount = results.filter((item) => item.json_valid).length;
  const latencyAvg =
    processed > 0
      ? Math.round(
          results.reduce((acc, item) => acc + (item.execution_time_ms || 0), 0) / processed,
        )
      : 0;

  return {
    model,
    summary: {
      processed,
      json_valid_count: validCount,
      json_valid_rate: processed ? validCount / processed : 0,
      avg_latency_ms: latencyAvg,
    },
    results,
  };
}

module.exports = {
  runSingleCase,
  runBatchCases,
  listInstalledOllamaModels,
};
