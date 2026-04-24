const path = require('path');
const fs = require('fs/promises');
const { runSingleCase } = require('./runnerService');

const RUNNER_DATA_DIR = path.join(__dirname, '..', '..', 'data', 'runner-benchmark');
const CSV_FILE_NAME = 'benchmark-current.csv';
const CSV_PATH = path.join(RUNNER_DATA_DIR, CSV_FILE_NAME);

function csvEscape(value) {
  const text = `${value ?? ''}`;
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function normalizedCsvCellsFromRow(row) {
  const parsed = row.parsed_json || {};
  const original = row.source_original || {};
  return [
    parsed.name || original.name || '',
    parsed.address1 || parsed.street || original.address1 || '',
    parsed.address2 || original.address2 || '',
    parsed.city || original.city || '',
    parsed.region || parsed.state || original.region || '',
    parsed.country || original.country || '',
    parsed.postal || parsed.postal_code || original.postal || '',
  ];
}

/**
 * @typedef {object} BenchmarkSession
 * @property {'idle'|'running'|'completed'|'canceled'|'error'} status
 * @property {string|null} runId
 * @property {string|null} model
 * @property {number|null} startedAt
 * @property {number|null} completedAt
 * @property {number} total
 * @property {number} concurrency
 * @property {boolean} cancelRequested
 * @property {string|null} lastError
 * @property {Array<{input:string, expected?:*, source_original?:*}>|null} cases
 * @property {Array<*>} resultSlots
 * @property {number} completedCount
 * @property {number} inFlight
 * @property {number[]} latenciesMs
 * @property {number} nextCsvIndex
 * @property {{processed:number,json_valid_count:number,json_valid_rate:number,avg_latency_ms:number,total_elapsed_ms:number,concurrency:number}|null} summary
 */

/** @type {BenchmarkSession} */
let session = {
  status: 'idle',
  runId: null,
  model: null,
  startedAt: null,
  completedAt: null,
  total: 0,
  concurrency: 1,
  cancelRequested: false,
  lastError: null,
  cases: null,
  resultSlots: [],
  completedCount: 0,
  inFlight: 0,
  latenciesMs: [],
  nextCsvIndex: 0,
  summary: null,
};

async function ensureRunnerDataDir() {
  await fs.mkdir(RUNNER_DATA_DIR, { recursive: true });
}

async function resetCsvFile() {
  await ensureRunnerDataDir();
  const header = [
    'case_index',
    'name',
    'address1',
    'address2',
    'city',
    'region',
    'country',
    'postal',
    'json_valid',
    'execution_time_ms',
    'error',
  ].join(',');
  await fs.writeFile(CSV_PATH, `${header}\n`, 'utf8');
}

async function appendCsvRowsInOrder() {
  const lines = [];
  while (session.nextCsvIndex < session.total && session.resultSlots[session.nextCsvIndex] != null) {
    const row = session.resultSlots[session.nextCsvIndex];
    const cells = [String(session.nextCsvIndex), ...normalizedCsvCellsFromRow(row)];
    cells.push(row.json_valid ? 'true' : 'false');
    cells.push(String(row.execution_time_ms ?? 0));
    cells.push(row.error != null ? `${row.error}` : '');
    lines.push(`${cells.map(csvEscape).join(',')}\n`);
    session.nextCsvIndex += 1;
  }
  if (lines.length > 0) {
    await fs.appendFile(CSV_PATH, lines.join(''), 'utf8');
  }
}

function buildPlaceholderRow(item, message) {
  return {
    input: item.input ?? '',
    expected: item.expected ?? null,
    source_original: item.source_original ?? null,
    raw_output: '',
    parsed_json: null,
    execution_time_ms: 0,
    json_valid: false,
    error: message,
  };
}

function finalizeSummary(processed, concurrency) {
  const validCount = session.resultSlots.filter((item) => item && item.json_valid).length;
  const latencyAvg =
    processed > 0
      ? Math.round(
          session.resultSlots.reduce((acc, item) => acc + (item?.execution_time_ms || 0), 0) / processed,
        )
      : 0;
  const totalElapsedMs = session.startedAt ? Date.now() - session.startedAt : 0;
  return {
    processed,
    json_valid_count: validCount,
    json_valid_rate: processed ? validCount / processed : 0,
    avg_latency_ms: latencyAvg,
    total_elapsed_ms: totalElapsedMs,
    concurrency,
  };
}

async function runBenchmarkWorkers() {
  const { model, cases, concurrency: rawConc } = session;
  const total = cases.length;
  const concurrency = Math.min(64, Math.max(1, Math.floor(rawConc) || 1));

  let nextIdx = 0;
  let inFlight = 0;
  let completed = 0;

  function takeNext() {
    if (session.cancelRequested) {
      return -1;
    }
    if (nextIdx >= total) {
      return -2;
    }
    const idx = nextIdx;
    nextIdx += 1;
    return idx;
  }

  async function worker() {
    while (true) {
      const index = takeNext();
      if (index === -1 || index === -2) {
        return;
      }
      inFlight += 1;
      session.inFlight = inFlight;
      const item = cases[index];
      const caseInput = `${item.input ?? ''}`.trim();

      try {
        if (!caseInput) {
          session.resultSlots[index] = buildPlaceholderRow(item, 'Empty input.');
        } else {
          const response = await runSingleCase({
            model,
            input: caseInput,
            expected: item.expected ?? null,
          });
          session.resultSlots[index] = {
            input: item.input,
            expected: item.expected ?? null,
            source_original: item.source_original ?? null,
            raw_output: response.raw_output,
            parsed_json: response.parsed_json,
            execution_time_ms: response.execution_time_ms,
            json_valid: response.json_valid,
            error: response.error ?? null,
          };
          session.latenciesMs.push(response.execution_time_ms || 0);
        }
      } catch (error) {
        session.resultSlots[index] = {
          input: item.input,
          expected: item.expected ?? null,
          source_original: item.source_original ?? null,
          raw_output: '',
          parsed_json: null,
          execution_time_ms: 0,
          json_valid: false,
          error: error.message || 'Execution failed.',
        };
        session.latenciesMs.push(0);
      } finally {
        inFlight -= 1;
        session.inFlight = inFlight;
        completed += 1;
        session.completedCount = completed;
        await appendCsvRowsInOrder();
      }
    }
  }

  const workers = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  for (let i = 0; i < total; i += 1) {
    if (session.resultSlots[i] == null) {
      const item = cases[i];
      session.resultSlots[i] = buildPlaceholderRow(
        item,
        session.cancelRequested ? 'Canceled.' : 'Skipped.',
      );
    }
  }

  await appendCsvRowsInOrder();

  session.inFlight = 0;
  session.completedCount = total;
  session.completedAt = Date.now();
  session.summary = finalizeSummary(total, concurrency);
  session.status = session.cancelRequested ? 'canceled' : 'completed';
}

async function runBenchmarkJob() {
  try {
    await runBenchmarkWorkers();
  } catch (error) {
    session.lastError = error.message || 'Benchmark failed.';
    session.inFlight = 0;
    if (Array.isArray(session.cases) && session.resultSlots.length > 0) {
      for (let i = 0; i < session.total; i += 1) {
        if (session.resultSlots[i] == null) {
          session.resultSlots[i] = buildPlaceholderRow(session.cases[i], session.lastError);
        }
      }
      try {
        await appendCsvRowsInOrder();
      } catch {
        // ignore CSV write failures after a crash
      }
    }
    session.completedAt = Date.now();
    session.status = 'error';
  }
}

function assertNotRunning() {
  if (session.status === 'running') {
    const err = new Error('A benchmark is already running on the server.');
    err.code = 'BUSY';
    throw err;
  }
}

async function startBenchmark({ model, cases, concurrency }) {
  assertNotRunning();

  if (!model || typeof model !== 'string') {
    throw new Error('model is required.');
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('cases must be a non-empty array.');
  }

  const rawConc = Number(concurrency);
  const conc = Math.min(64, Math.max(1, Number.isFinite(rawConc) && rawConc > 0 ? Math.floor(rawConc) : 1));

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const total = cases.length;
  const startedAt = Date.now();

  session = {
    status: 'running',
    runId,
    model,
    startedAt,
    completedAt: null,
    total,
    concurrency: conc,
    cancelRequested: false,
    lastError: null,
    cases: cases.map((c) => ({
      input: c.input,
      expected: c.expected ?? null,
      source_original: c.source_original ?? null,
    })),
    resultSlots: new Array(total).fill(null),
    completedCount: 0,
    inFlight: 0,
    latenciesMs: [],
    nextCsvIndex: 0,
    summary: null,
  };

  await resetCsvFile();
  setImmediate(() => {
    runBenchmarkJob();
  });

  return { runId, total, concurrency: conc };
}

function requestCancel() {
  if (session.status !== 'running') {
    return { ok: false, message: 'No benchmark is running.' };
  }
  session.cancelRequested = true;
  return { ok: true };
}

function getCsvAbsolutePath() {
  return CSV_PATH;
}

function getPublicStatus() {
  if (session.status === 'idle') {
    return {
      ok: true,
      status: 'idle',
      csvUrl: '/api/runner/benchmark/csv',
      hasCsv: false,
    };
  }

  const base = {
    ok: true,
    status: session.status,
    runId: session.runId,
    model: session.model,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    total: session.total,
    concurrency: session.concurrency,
    completedCount: session.completedCount,
    inFlight: session.inFlight,
    cancelRequested: session.cancelRequested,
    latenciesMs: session.latenciesMs,
    csvUrl: '/api/runner/benchmark/csv',
    lastError: session.lastError,
    summary: session.summary,
  };

  if (session.status === 'running') {
    return {
      ...base,
      hasCsv: true,
      cases: session.cases,
      results: session.resultSlots,
    };
  }

  const hasSparse =
    Array.isArray(session.cases) &&
    session.resultSlots.length > 0 &&
    session.resultSlots.some((r) => r == null);
  const results = hasSparse
    ? session.cases.map((item, i) => session.resultSlots[i] ?? buildPlaceholderRow(item, 'Pending.'))
    : session.resultSlots;

  return {
    ...base,
    hasCsv: true,
    results,
  };
}

module.exports = {
  startBenchmark,
  requestCancel,
  getPublicStatus,
  getCsvAbsolutePath,
  RUNNER_DATA_DIR,
  CSV_FILE_NAME,
};
