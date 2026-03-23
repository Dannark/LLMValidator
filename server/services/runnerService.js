const { runOllamaExtraction, listInstalledOllamaModels } = require('../../runner/ollamaRunner');

function sanitizeOutput(parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object') {
    return null;
  }

  return {
    street: `${parsedJson.street ?? ''}`.trim(),
    city: `${parsedJson.city ?? ''}`.trim(),
    state: `${parsedJson.state ?? ''}`.trim(),
    postal_code: `${parsedJson.postal_code ?? ''}`.trim(),
    country: `${parsedJson.country ?? ''}`.trim(),
  };
}

async function runSingleCase({ model, input, expected = null }) {
  const result = await runOllamaExtraction({ model, input });
  return {
    input,
    expected,
    ...result,
    parsed_json: sanitizeOutput(result.parsed_json),
  };
}

async function runBatchCases({ model, cases }) {
  if (!model || typeof model !== 'string') {
    throw new Error('model é obrigatório.');
  }

  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('cases deve ser um array não vazio.');
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
        error: 'Input vazio.',
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
