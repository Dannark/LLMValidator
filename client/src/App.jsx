import { useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelRunnerBenchmark,
  deleteDatasetByFileName,
  generateDataset,
  getDatasetByFileName,
  getDatasetHistory,
  getLatestDataset,
  getInstalledModels,
  getRunnerBenchmarkStatus,
  getSystemMetrics,
  startRunnerBenchmark,
  uploadCsvDataset,
} from './api';
import './App.css';

const STAGES = ['Dataset', 'Runner', 'Evaluator', 'Review & Report'];
const PAGE_SIZE = 12;
const PREFERRED_MODEL = 'gemma3:4b';
const RUNNER_TABLE_PREVIEW = 100;
const EXPECTED_FIELDS = ['street', 'city', 'state', 'postal_code', 'country'];
const DATASET_LOCALE_OPTIONS = [
  { value: 'mixed', label: 'Mixed (US + BR + DE)' },
  { value: 'en_US', label: 'English (US)' },
  { value: 'pt_BR', label: 'Portuguese (Brazil)' },
  { value: 'de_DE', label: 'German (Germany)' },
];

/** Human-readable duration: Xh Ym Zs, or Ym Zs, or Zs (same rules as ETA). */
function formatDurationMs(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatElapsedTime(ms) {
  return formatDurationMs(ms);
}

function formatEta(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return formatDurationMs(ms);
}

/** ETA from observed completion latencies (completion order). */
function computeRunnerEtaFromLatencies(latenciesMs, total, completedCount) {
  if (completedCount < 3 || total <= completedCount || !latenciesMs?.length) {
    return null;
  }
  const avgMs = latenciesMs.reduce((a, b) => a + b, 0) / latenciesMs.length;
  return (total - completedCount) * avgMs;
}

function mergeRunnerRowsFromStatus(statusPayload) {
  if (!statusPayload || statusPayload.status === 'idle') {
    return [];
  }
  if (statusPayload.status === 'running') {
    const { cases, results } = statusPayload;
    if (!Array.isArray(cases) || !Array.isArray(results)) {
      return [];
    }
    return cases.map((item, i) => {
      const r = results[i];
      if (r) {
        return r;
      }
      return {
        input: item.input ?? '',
        expected: item.expected ?? null,
        source_original: item.source_original ?? null,
        raw_output: '',
        parsed_json: null,
        execution_time_ms: 0,
        json_valid: false,
        error: null,
        pending: true,
      };
    });
  }
  return Array.isArray(statusPayload.results) ? statusPayload.results : [];
}

function normalizeValue(value) {
  return `${value ?? ''}`.trim().toLowerCase();
}

function isExactRowMatch(expected, parsed) {
  if (!expected || !parsed) {
    return false;
  }
  const mapped = {
    street: parsed.address1 ?? parsed.street ?? '',
    city: parsed.city ?? '',
    state: parsed.region ?? parsed.state ?? '',
    postal_code: parsed.postal ?? parsed.postal_code ?? '',
    country: parsed.country ?? '',
  };
  return EXPECTED_FIELDS.every((field) => normalizeValue(expected[field]) === normalizeValue(mapped[field]));
}

function getGeneratedParsedDisplay(field, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }
  if (field === 'street') {
    return parsed.address1 ?? parsed.street ?? '';
  }
  if (field === 'state') {
    return parsed.region ?? parsed.state ?? '';
  }
  if (field === 'postal_code') {
    return parsed.postal ?? parsed.postal_code ?? '';
  }
  return parsed[field] ?? '';
}

/** Ground-truth CSV columns (expected) vs model output keys (parsed_json uses postal for zip). */
const GROUND_TRUTH_COLUMNS = [
  'name',
  'address1',
  'address2',
  'city',
  'region',
  'country',
  'zip',
];

/** True when dataset items include embedded expected columns (new CSV format), even without metadata.embedded_expected. */
function datasetHasEmbeddedGroundTruth(dataset) {
  if (!Array.isArray(dataset) || dataset.length === 0) {
    return false;
  }
  return dataset.some((item) => {
    const e = item?.expected;
    if (!e || typeof e !== 'object') {
      return false;
    }
    return (
      String(e.name ?? '').trim() !== '' ||
      String(e.address1 ?? '').trim() !== '' ||
      String(e.city ?? '').trim() !== ''
    );
  });
}

function normalizeCountryToken(value) {
  const x = normalizeValue(value);
  if (!x) {
    return '';
  }
  if (
    x === 'usa' ||
    x === 'us' ||
    x === 'united states' ||
    x === 'united states of america'
  ) {
    return 'us';
  }
  if (x === 'gbr' || x === 'gb' || x === 'uk' || x === 'united kingdom' || x === 'great britain') {
    return 'gb';
  }
  return x;
}

function fieldValuesMatchGroundTruth(fieldKey, expectedVal, parsedVal) {
  if (fieldKey === 'zip') {
    const ev = normalizeValue(expectedVal);
    if (!ev) {
      return true;
    }
    return ev === normalizeValue(parsedVal);
  }
  if (fieldKey === 'country') {
    const ev = normalizeValue(expectedVal);
    if (!ev) {
      return true;
    }
    return normalizeCountryToken(expectedVal) === normalizeCountryToken(parsedVal);
  }
  return normalizeValue(expectedVal) === normalizeValue(parsedVal);
}

function isGroundTruthRowMatch(expected, parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  const pairs = [
    ['name', 'name'],
    ['address1', 'address1'],
    ['address2', 'address2'],
    ['city', 'city'],
    ['region', 'region'],
    ['country', 'country'],
    ['zip', 'postal'],
  ];
  return pairs.every(([expKey, parsedKey]) =>
    fieldValuesMatchGroundTruth(expKey, expected[expKey], parsed[parsedKey]),
  );
}

function parseCsvLine(line, delimiter) {
  const out = [];
  let cur = '';
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
    } else if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === delimiter) {
      out.push(cur.trim());
      cur = '';
      i += 1;
    } else {
      cur += c;
      i += 1;
    }
  }
  out.push(cur.trim());
  return out;
}

function detectCsvDelimiter(line) {
  const semi = (line.match(/;/g) || []).length;
  const comma = (line.match(/,/g) || []).length;
  return semi > comma ? ';' : ',';
}

function normalizeCsvHeader(cell) {
  return `${cell ?? ''}`
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** Map header label -> canonical key (name, address1, … zip). */
function mapGroundTruthHeader(headerCells) {
  const aliases = {
    name: ['name', 'customer_name', 'full_name', 'issuer_name'],
    address1: ['address1', 'address_1', 'addr1', 'street', 'line1'],
    address2: ['address2', 'address_2', 'addr2', 'line2'],
    city: ['city'],
    region: ['region', 'state', 'province'],
    country: ['country'],
    zip: ['zip', 'postal', 'postal_code', 'postcode', 'zipcode'],
  };
  const colIndex = {};
  const normalized = headerCells.map(normalizeCsvHeader);
  for (const canonical of GROUND_TRUTH_COLUMNS) {
    const idx = normalized.findIndex((h) => aliases[canonical].includes(h));
    if (idx >= 0) {
      colIndex[canonical] = idx;
    }
  }
  return colIndex;
}

function parseGroundTruthCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { rows: [], error: 'CSV must include a header row and at least one data row.' };
  }
  const delim = detectCsvDelimiter(lines[0]);
  const headerCells = parseCsvLine(lines[0], delim);
  const colIndex = mapGroundTruthHeader(headerCells);
  const missing = GROUND_TRUTH_COLUMNS.filter((k) => colIndex[k] === undefined);
  if (missing.length > 0) {
    return {
      rows: [],
      error: `Missing column(s): ${missing.join(', ')}. Found headers: ${headerCells.join(', ')}`,
    };
  }
  const rows = [];
  for (let li = 1; li < lines.length; li += 1) {
    const cells = parseCsvLine(lines[li], delim);
    const row = {};
    for (const k of GROUND_TRUTH_COLUMNS) {
      const idx = colIndex[k];
      row[k] = cells[idx] != null ? `${cells[idx]}`.trim() : '';
    }
    rows.push(row);
  }
  return { rows, error: null };
}

function buildEvaluationRows(results = [], groundTruthRows = null) {
  return results.map((row, index) => {
    const expected =
      groundTruthRows != null ? groundTruthRows[index] || {} : row.expected || {};
    const exactMatch =
      row.json_valid &&
      (groundTruthRows != null
        ? isGroundTruthRowMatch(expected, row.parsed_json)
        : isExactRowMatch(expected, row.parsed_json));
    return {
      id: `${index}-${row.input}`,
      index: index + 1,
      input: row.input,
      expected,
      parsed_json: row.parsed_json,
      raw_output: row.raw_output,
      json_valid: row.json_valid,
      auto_exact_match: exactMatch,
      needs_manual_review: row.json_valid && !exactMatch,
      manual_decision: null,
    };
  });
}

function csvEscape(value) {
  const text = `${value ?? ''}`;
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function App() {
  const [activeStage, setActiveStage] = useState(0);
  const [datasetInputMode, setDatasetInputMode] = useState('generated');
  const [size, setSize] = useState(50);
  const [datasetLocale, setDatasetLocale] = useState('mixed');
  const [uploadedFile, setUploadedFile] = useState(null);
  const [dataset, setDataset] = useState([]);
  const [metadata, setMetadata] = useState(null);
  const [history, setHistory] = useState([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [historyActionLoading, setHistoryActionLoading] = useState({});
  const [runnerModel, setRunnerModel] = useState('qwen2.5:3b');
  const [availableModels, setAvailableModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [runnerLimit, setRunnerLimit] = useState(20);
  const [runnerConcurrency, setRunnerConcurrency] = useState(2);
  const [runnerLoading, setRunnerLoading] = useState(false);
  const [runnerServerMetrics, setRunnerServerMetrics] = useState(null);
  /** idle | loading | ok | empty — host metrics poll status while benchmark runs */
  const [runnerHostMetricsStatus, setRunnerHostMetricsStatus] = useState('idle');
  const [runnerCancelRequested, setRunnerCancelRequested] = useState(false);
  const [runnerResult, setRunnerResult] = useState(null);
  const [evaluationRows, setEvaluationRows] = useState([]);
  const [evaluationIndex, setEvaluationIndex] = useState(0);
  const [runnerProgress, setRunnerProgress] = useState({
    processed: 0,
    total: 0,
    currentItem: 0,
    etaMs: null,
    notice: '',
    startedAt: null,
    inFlight: 0,
    concurrency: 1,
  });
  const [runnerElapsedTick, setRunnerElapsedTick] = useState(0);
  const [runnerShowFullTable, setRunnerShowFullTable] = useState(false);
  const [runnerHasCsv, setRunnerHasCsv] = useState(false);
  const [evaluatorGroundTruthRows, setEvaluatorGroundTruthRows] = useState(null);
  const [evaluatorGroundTruthFileName, setEvaluatorGroundTruthFileName] = useState('');
  const [evaluatorGroundTruthError, setEvaluatorGroundTruthError] = useState('');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const groundTruthFileInputRef = useRef(null);
  const runnerMetricsPollRef = useRef(null);
  const runnerStartInFlightRef = useRef(false);

  useEffect(() => {
    if (!runnerLoading) {
      return undefined;
    }
    const id = setInterval(() => {
      setRunnerElapsedTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [runnerLoading]);

  useEffect(() => {
    if (!runnerLoading) {
      if (runnerMetricsPollRef.current) {
        clearInterval(runnerMetricsPollRef.current);
        runnerMetricsPollRef.current = null;
      }
      setRunnerServerMetrics(null);
      setRunnerHostMetricsStatus('idle');
      return undefined;
    }

    setRunnerHostMetricsStatus('loading');
    async function poll() {
      const data = await getSystemMetrics();
      setRunnerServerMetrics(data);
      setRunnerHostMetricsStatus(data?.memory ? 'ok' : 'empty');
    }
    poll();
    runnerMetricsPollRef.current = setInterval(poll, 1500);
    return () => {
      if (runnerMetricsPollRef.current) {
        clearInterval(runnerMetricsPollRef.current);
        runnerMetricsPollRef.current = null;
      }
    };
  }, [runnerLoading]);

  useEffect(() => {
    if (activeStage !== 1) {
      return undefined;
    }
    let stopped = false;

    async function pollRunnerSession() {
      try {
        if (runnerStartInFlightRef.current) {
          return;
        }
        const s = await getRunnerBenchmarkStatus();
        if (stopped) {
          return;
        }
        if (runnerStartInFlightRef.current) {
          return;
        }
        setRunnerHasCsv(s.hasCsv === true);

        if (s.status === 'idle') {
          setRunnerResult(null);
          setRunnerLoading(false);
          setRunnerCancelRequested(false);
          setRunnerProgress({
            processed: 0,
            total: 0,
            currentItem: 0,
            etaMs: null,
            notice: '',
            startedAt: null,
            inFlight: 0,
            concurrency: 1,
          });
          return;
        }

        const rows = mergeRunnerRowsFromStatus(s);
        const isTerminal = s.status === 'completed' || s.status === 'canceled' || s.status === 'error';
        setRunnerLoading(s.status === 'running');
        // Only mirror the server model while a run is active; after complete/canceled/error the user
        // must be able to pick the next model without the poll reverting the dropdown.
        if (s.status === 'running' && s.model) {
          setRunnerModel(s.model);
        }

        let notice = '';
        if (s.status === 'running') {
          notice = s.cancelRequested ? 'Cancel requested. Finishing current requests…' : '';
        } else if (s.status === 'canceled') {
          notice = 'Execution canceled.';
        } else if (s.status === 'error') {
          notice = s.lastError || 'Benchmark failed.';
        } else if (s.status === 'completed') {
          notice = 'Execution completed.';
        }

        setRunnerProgress({
          processed: s.completedCount ?? 0,
          total: s.total ?? 0,
          currentItem: Math.min((s.completedCount ?? 0) + (s.inFlight ?? 0), s.total ?? 0),
          etaMs: computeRunnerEtaFromLatencies(s.latenciesMs || [], s.total ?? 0, s.completedCount ?? 0),
          notice,
          startedAt: s.startedAt ?? null,
          inFlight: s.inFlight ?? 0,
          concurrency: s.concurrency ?? 1,
        });

        setRunnerResult({
          model: s.model,
          summary: isTerminal ? s.summary : null,
          results: rows,
          runStatus: s.status,
          lastError: s.lastError ?? null,
        });

        if (isTerminal) {
          setRunnerCancelRequested(false);
        }
      } catch {
        // Keep current UI if the status endpoint is unreachable.
      }
    }

    pollRunnerSession();
    const intervalId = setInterval(pollRunnerSession, 800);
    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [activeStage]);

  useEffect(() => {
    async function bootstrap() {
      try {
        const [latest, historyResponse] = await Promise.allSettled([
          getLatestDataset(),
          getDatasetHistory(),
        ]);

        if (latest.status === 'fulfilled') {
          setDataset(latest.value.items || []);
          setMetadata(latest.value.metadata || null);
        }
        if (historyResponse.status === 'fulfilled') {
          setHistory(historyResponse.value.items || []);
        }
      } catch {
        // Ignore bootstrap failures.
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    const results = runnerResult?.results || [];
    const useSeparateGroundTruthFile =
      metadata?.source_type === 'uploaded_csv' &&
      Array.isArray(evaluatorGroundTruthRows) &&
      evaluatorGroundTruthRows.length > 0;
    const gt = useSeparateGroundTruthFile ? evaluatorGroundTruthRows : null;
    setEvaluationRows(buildEvaluationRows(results, gt));
    setEvaluationIndex(0);
  }, [runnerResult, evaluatorGroundTruthRows, metadata?.source_type]);

  useEffect(() => {
    if (metadata?.source_type !== 'uploaded_csv') {
      setEvaluatorGroundTruthRows(null);
      setEvaluatorGroundTruthFileName('');
      setEvaluatorGroundTruthError('');
    }
  }, [metadata?.source_type]);

  useEffect(() => {
    async function loadModels() {
      setModelsLoading(true);
      try {
        const response = await getInstalledModels();
        const models = response.models || [];
        setAvailableModels(models);
        if (models.length > 0) {
          setRunnerModel((current) => {
            if (models.includes(PREFERRED_MODEL)) {
              return PREFERRED_MODEL;
            }
            return models.includes(current) ? current : models[0];
          });
        }
      } catch {
        // On failure, keep current model field for manual entry.
      } finally {
        setModelsLoading(false);
      }
    }

    loadModels();
  }, []);

  const totalPages = Math.max(1, Math.ceil(dataset.length / PAGE_SIZE));
  const paginatedRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return dataset.slice(start, start + PAGE_SIZE);
  }, [dataset, page]);

  async function handleGenerate() {
    setLoading(true);
    setError('');
    setSuccessMessage('');
    try {
      const response = await generateDataset(Number(size), datasetLocale);
      setDataset(response.items || []);
      setMetadata(response.metadata || null);
      setPage(1);
      const historyResponse = await getDatasetHistory();
      setHistory(historyResponse.items || []);
      setSuccessMessage('Dataset generated successfully.');
    } catch (err) {
      setError(err.message || 'Failed to generate dataset.');
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadCsv() {
    if (!uploadedFile) {
      setError('Select a CSV file first.');
      return;
    }

    setLoading(true);
    setError('');
    setSuccessMessage('');
    try {
      const response = await uploadCsvDataset(uploadedFile);
      setDataset(response.items || []);
      setMetadata(response.metadata || null);
      setPage(1);
      const historyResponse = await getDatasetHistory();
      setHistory(historyResponse.items || []);
      setSuccessMessage('CSV uploaded and normalized successfully.');
    } catch (err) {
      setError(err.message || 'Failed to upload CSV.');
    } finally {
      setLoading(false);
    }
  }

  async function handleLoadHistoryDataset(fileName) {
    setHistoryActionLoading((current) => ({ ...current, [fileName]: 'loading' }));
    setError('');
    setSuccessMessage('');

    try {
      const response = await getDatasetByFileName(fileName);
      setDataset(response.items || []);
      setMetadata(response.metadata || null);
      setPage(1);
      setSuccessMessage(`Dataset ${fileName} loaded successfully.`);
    } catch (err) {
      setError(err.message || 'Failed to load dataset.');
    } finally {
      setHistoryActionLoading((current) => {
        const next = { ...current };
        delete next[fileName];
        return next;
      });
    }
  }

  async function handleDeleteHistoryDataset(fileName) {
    const shouldDelete = window.confirm(
      `Are you sure you want to permanently delete ${fileName}?`,
    );
    if (!shouldDelete) {
      return;
    }

    setHistoryActionLoading((current) => ({ ...current, [fileName]: 'deleting' }));
    setError('');
    setSuccessMessage('');

    try {
      await deleteDatasetByFileName(fileName);
      const [historyResponse, latestResult] = await Promise.allSettled([
        getDatasetHistory(),
        getLatestDataset(),
      ]);

      if (historyResponse.status === 'fulfilled') {
        setHistory(historyResponse.value.items || []);
      }

      if (latestResult.status === 'fulfilled') {
        setDataset(latestResult.value.items || []);
        setMetadata(latestResult.value.metadata || null);
      } else {
        setDataset([]);
        setMetadata(null);
      }

      setPage(1);
      setSuccessMessage(`Dataset ${fileName} deleted successfully.`);
    } catch (err) {
      setError(err.message || 'Failed to delete dataset.');
    } finally {
      setHistoryActionLoading((current) => {
        const next = { ...current };
        delete next[fileName];
        return next;
      });
    }
  }

  async function handleRunBenchmark() {
    setRunnerLoading(true);
    setRunnerCancelRequested(false);
    setError('');
    setSuccessMessage('');
    setRunnerResult(null);
    setRunnerShowFullTable(false);

    try {
      const limitedCases = dataset.slice(0, Number(runnerLimit));
      if (limitedCases.length === 0) {
        throw new Error('Load or generate a dataset before running the benchmark.');
      }

      const rawConc = Number(runnerConcurrency);
      const concurrency = Math.min(
        64,
        Math.max(1, Number.isFinite(rawConc) && rawConc > 0 ? Math.floor(rawConc) : 1),
      );

      runnerStartInFlightRef.current = true;
      try {
        await startRunnerBenchmark(runnerModel, limitedCases, concurrency);
      } finally {
        runnerStartInFlightRef.current = false;
      }
      setSuccessMessage(`Benchmark running on server for ${runnerModel}. You can refresh the page; progress is restored from the server.`);
    } catch (err) {
      setError(err.message || 'Failed to run benchmark.');
      setRunnerLoading(false);
    }
  }

  async function handleCancelRun() {
    if (!runnerLoading) {
      return;
    }
    setRunnerCancelRequested(true);
    setRunnerProgress((current) => ({
      ...current,
      notice: 'Cancel requested. Finishing current requests…',
    }));
    try {
      await cancelRunnerBenchmark();
    } catch (err) {
      setError(err.message || 'Failed to cancel benchmark.');
    }
  }

  function handleGroundTruthFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const { rows, error: parseError } = parseGroundTruthCsv(text);
      if (parseError) {
        setEvaluatorGroundTruthError(parseError);
        setEvaluatorGroundTruthRows(null);
        setEvaluatorGroundTruthFileName('');
        return;
      }
      setEvaluatorGroundTruthRows(rows);
      setEvaluatorGroundTruthFileName(file.name);
      setEvaluatorGroundTruthError('');
    };
    reader.onerror = () => {
      setEvaluatorGroundTruthError('Failed to read file.');
      setEvaluatorGroundTruthRows(null);
      setEvaluatorGroundTruthFileName('');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function handleClearGroundTruthFile() {
    setEvaluatorGroundTruthRows(null);
    setEvaluatorGroundTruthFileName('');
    setEvaluatorGroundTruthError('');
    if (groundTruthFileInputRef.current) {
      groundTruthFileInputRef.current.value = '';
    }
  }

  function handleExportRunnerCsv() {
    if (!runnerResult?.results?.length) {
      return;
    }

    const header = ['name', 'address1', 'address2', 'city', 'region', 'country', 'postal'];
    const lines = [header.join(',')];

    for (const row of runnerResult.results) {
      const original = row.source_original || {};
      const parsed = row.parsed_json || {};

      const line = [
        parsed.name || original.name || '',
        parsed.address1 || parsed.street || original.address1 || '',
        parsed.address2 || original.address2 || '',
        parsed.city || original.city || '',
        parsed.region || parsed.state || original.region || '',
        parsed.country || original.country || '',
        parsed.postal || parsed.postal_code || original.postal || '',
      ].map(csvEscape);

      lines.push(line.join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'llm_output_normalized.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleRefreshModels() {
    setModelsLoading(true);
    setError('');
    setSuccessMessage('');
    try {
      const response = await getInstalledModels();
      const models = response.models || [];
      setAvailableModels(models);
      if (models.length > 0) {
        setRunnerModel(models.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : models[0]);
      }
      setSuccessMessage('Models refreshed successfully.');
    } catch (err) {
      setError(err.message || 'Failed to load Ollama models.');
    } finally {
      setModelsLoading(false);
    }
  }

  function renderStageContent() {
    if (activeStage === 1) {
      const summary = runnerResult?.summary;
      const runStatus = runnerResult?.runStatus;
      const allRows = runnerResult?.results || [];
      const progressPercent = runnerProgress.total
        ? Math.round((runnerProgress.processed / runnerProgress.total) * 100)
        : 0;
      const runnerElapsedMs =
        runnerLoading && runnerProgress.startedAt != null
          ? Date.now() - runnerProgress.startedAt
          : 0;
      void runnerElapsedTick;
      const tableRows = runnerShowFullTable
        ? allRows
        : allRows.slice(0, RUNNER_TABLE_PREVIEW);
      return (
        <section className="dataset-card">
          <h2>Runner Ollama</h2>
          <div className="controls-row">
            <label htmlFor="runner-model">Model</label>
            <select
              id="runner-model"
              value={runnerModel}
              onChange={(event) => setRunnerModel(event.target.value)}
              disabled={runnerLoading || modelsLoading || availableModels.length === 0}
            >
              {availableModels.length === 0 ? (
                <option value="">No models found</option>
              ) : (
                availableModels.map((modelName) => (
                  <option key={modelName} value={modelName}>
                    {modelName}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="secondary"
              onClick={handleRefreshModels}
              disabled={modelsLoading}
            >
              {modelsLoading ? 'Refreshing...' : 'Refresh models'}
            </button>
            <label htmlFor="runner-limit">Cases count</label>
            <input
              id="runner-limit"
              type="number"
              min="1"
              max={Math.max(1, dataset.length)}
              value={runnerLimit}
              onChange={(event) => setRunnerLimit(event.target.value)}
              disabled={runnerLoading}
            />
            <label htmlFor="runner-concurrency">Parallel requests</label>
            <input
              id="runner-concurrency"
              type="number"
              min="1"
              max="64"
              title="Concurrent Ollama API calls (tune for VRAM / GPU)"
              value={runnerConcurrency}
              onChange={(event) => setRunnerConcurrency(event.target.value)}
              disabled={runnerLoading}
            />
            <button type="button" onClick={handleRunBenchmark} disabled={runnerLoading}>
              {runnerLoading ? 'Running...' : 'Run benchmark'}
            </button>
            {metadata?.source_type === 'uploaded_csv' && runnerResult?.results?.length ? (
              <button type="button" className="secondary" onClick={handleExportRunnerCsv}>
                Export LLM output CSV
              </button>
            ) : null}
            {runnerLoading ? (
              <button
                type="button"
                className="danger"
                onClick={handleCancelRun}
                disabled={runnerCancelRequested}
              >
                {runnerCancelRequested ? 'Cancelling...' : 'Cancel run'}
              </button>
            ) : null}
            {runnerHasCsv ? (
              <a
                className="secondary"
                href="/api/runner/benchmark/csv"
                target="_blank"
                rel="noreferrer"
                style={{ alignSelf: 'center' }}
              >
                Live server CSV
              </a>
            ) : null}
          </div>

          {error ? <p className="error-message">{error}</p> : null}
          {successMessage ? <p className="success-message">{successMessage}</p> : null}

          <div className="meta-row">
            <span>Loaded dataset: {dataset.length} items</span>
            <span>Selected model: {runnerModel}</span>
            <span>Current limit: {runnerLimit}</span>
            <span>Parallelism: {runnerConcurrency}</span>
          </div>

          {runnerLoading ? (
            <div className="runner-summary">
              <strong>Host resources</strong>
              <p className="meta-row" style={{ marginTop: '6px' }}>
                This shows system RAM/CPU (and GPU if nvidia-smi exists) on the server process host — not
                your browser PC.
              </p>
              {runnerHostMetricsStatus === 'loading' && !runnerServerMetrics?.memory ? (
                <p>Fetching RAM and GPU stats…</p>
              ) : null}
              {runnerHostMetricsStatus === 'empty' ? (
                <p className="error-message">
                  Host metrics unavailable. Deploy the backend with{' '}
                  <code style={{ fontSize: '0.95em' }}>GET /api/system/metrics</code> and ensure requests
                  to <code style={{ fontSize: '0.95em' }}>/api</code> reach Node (Vite proxy or reverse
                  proxy).
                </p>
              ) : null}
              {runnerServerMetrics?.memory ? (
                <div
                  className="meta-row"
                  style={{ marginTop: '8px', flexDirection: 'column', alignItems: 'flex-start' }}
                >
                  <span>
                    <strong>System RAM</strong> — total: {runnerServerMetrics.memory.totalMb} MiB · used:{' '}
                    {runnerServerMetrics.memory.usedMb} MiB · available:{' '}
                    {runnerServerMetrics.memory.freeMb} MiB ({runnerServerMetrics.memory.usagePercent}% used)
                  </span>
                  {runnerServerMetrics.gpus?.length ? (
                    <span style={{ marginTop: '6px' }}>
                      <strong>GPU</strong>:{' '}
                      {runnerServerMetrics.gpus
                        .map(
                          (g) =>
                            `${g.name}: ${g.usedMb ?? '?'} / ${g.totalMb ?? '?'} MiB VRAM${
                              g.usagePercent != null ? ` (${g.usagePercent}% of VRAM)` : ''
                            }`,
                        )
                        .join(' · ')}
                    </span>
                  ) : (
                    <span style={{ marginTop: '6px' }}>
                      <strong>GPU</strong>: nvidia-smi not found (OK on Mac / CPU-only hosts)
                    </span>
                  )}
                  <span style={{ marginTop: '6px' }}>
                    <strong>CPU</strong>: {runnerServerMetrics.cpus} cores · load average (1m):{' '}
                    {runnerServerMetrics.loadavg?.['1m'] ?? '—'}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {runnerLoading ? (
            <div className="runner-summary">
              <strong>Progress</strong>
              <p>
                Done {runnerProgress.processed} / {runnerProgress.total} ({progressPercent}%) · in flight:{' '}
                {runnerProgress.inFlight ?? 0} · cap: {runnerProgress.concurrency ?? 1} concurrent
              </p>
              <p>
                Elapsed: {formatElapsedTime(runnerElapsedMs)}
                {!runnerProgress.notice && formatEta(runnerProgress.etaMs) ? (
                  <>
                    {' '}
                    · ~{formatEta(runnerProgress.etaMs)} remaining (estimate)
                  </>
                ) : null}
              </p>
              {runnerProgress.notice ? <p>{runnerProgress.notice}</p> : null}
              <progress value={runnerProgress.processed} max={Math.max(1, runnerProgress.total)} />
            </div>
          ) : null}

          {summary ? (
            <div className="runner-summary">
              <strong>Summary</strong>
              <p>Processed: {summary.processed}</p>
              {summary.concurrency != null ? (
                <p>Parallelism used: {summary.concurrency}</p>
              ) : null}
              <p>Valid JSON: {summary.json_valid_count}</p>
              <p>Valid JSON rate: {(summary.json_valid_rate * 100).toFixed(2)}%</p>
              <p>Average latency: {summary.avg_latency_ms} ms</p>
              <p>Total elapsed time: {formatElapsedTime(summary.total_elapsed_ms)}</p>
              {runStatus === 'canceled' ? (
                <p className="meta-row">Run ended with cancellation; partial rows are kept above.</p>
              ) : null}
            </div>
          ) : null}
          {!summary && !runnerLoading && runStatus === 'error' ? (
            <div className="runner-summary">
              <strong>Error</strong>
              <p className="error-message">{runnerResult?.lastError || 'Benchmark failed.'}</p>
            </div>
          ) : null}
          {!summary && !runnerLoading && runStatus !== 'error' ? (
            <p>No execution yet. Click &quot;Run benchmark&quot;.</p>
          ) : null}

          {allRows.length > 0 ? (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>Valid JSON</th>
                    <th>Latency (ms)</th>
                    <th>Raw output</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((row, index) => (
                    <tr
                      key={`${row.input}-${index}`}
                      className={
                        row.pending ? 'row-pending' : row.json_valid ? '' : 'row-json-invalid'
                      }
                    >
                      <td>{row.input}</td>
                      <td>{row.pending ? '—' : row.json_valid ? 'Yes' : 'No'}</td>
                      <td>{row.pending ? '—' : row.execution_time_ms}</td>
                      <td>
                        {row.pending ? '…' : row.raw_output || row.error || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {allRows.length > RUNNER_TABLE_PREVIEW ? (
                <div className="meta-row" style={{ marginTop: '0.5rem' }}>
                  <span>
                    {runnerShowFullTable
                      ? `Showing all ${allRows.length} records.`
                      : `Showing first ${RUNNER_TABLE_PREVIEW} of ${allRows.length} records.`}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRunnerShowFullTable((v) => !v)}
                  >
                    {runnerShowFullTable ? 'Show first 100 only' : 'Show all records'}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      );
    }

    if (activeStage === 2) {
      const isUploadSource = metadata?.source_type === 'uploaded_csv';
      const hasRunnerResults =
        (runnerResult?.results?.length ?? 0) > 0 &&
        (runnerResult?.runStatus === 'completed' || runnerResult?.runStatus === 'canceled');
      const embeddedFromDataset =
        isUploadSource &&
        (metadata?.embedded_expected === true || datasetHasEmbeddedGroundTruth(dataset));
      const hasSeparateGroundTruthFile =
        Array.isArray(evaluatorGroundTruthRows) && evaluatorGroundTruthRows.length > 0;
      const hasGroundTruth = embeddedFromDataset || hasSeparateGroundTruthFile;

      if (isUploadSource && !hasGroundTruth) {
        return (
          <section className="dataset-card">
            <h2>Evaluator</h2>
            <p>
              Upload on Dataset a CSV with <strong>17 input columns</strong> plus the expected block{' '}
              <strong>Name…Country</strong> (ground truth in the same file). Or load a CSV with only{' '}
              <strong>name, address1, address2, city, region, country, zip</strong> below.
            </p>
            <p>
              Row order must match the Runner (first data row = first record).
            </p>
            <div className="controls-row">
              <label htmlFor="ground-truth-csv">
                Ground truth CSV (optional — only if the Dataset has no embedded expected columns)
              </label>
              <input
                id="ground-truth-csv"
                ref={groundTruthFileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleGroundTruthFileChange}
              />
            </div>
            {evaluatorGroundTruthError ? (
              <p className="error-message">{evaluatorGroundTruthError}</p>
            ) : null}
            <p className="meta-row">
              After loading the Dataset (and running the Runner if needed), use this tab to compare field
              by field.
            </p>
          </section>
        );
      }

      if (isUploadSource && hasGroundTruth && !hasRunnerResults) {
        return (
          <section className="dataset-card">
            <h2>Evaluator</h2>
            {embeddedFromDataset && !hasSeparateGroundTruthFile ? (
              <p>
                Ground truth: <strong>expected columns from the same CSV</strong> as on Dataset (
                {dataset.length} rows).
              </p>
            ) : (
              <>
                <p>
                  Ground truth loaded from file: <strong>{evaluatorGroundTruthFileName}</strong> (
                  {evaluatorGroundTruthRows.length} rows).
                </p>
                <button type="button" className="secondary" onClick={handleClearGroundTruthFile}>
                  Remove ground truth file
                </button>
              </>
            )}
            {evaluatorGroundTruthError ? (
              <p className="error-message">{evaluatorGroundTruthError}</p>
            ) : null}
            <p>Run the benchmark on the Runner tab first; evaluation needs model output.</p>
          </section>
        );
      }

      const currentRow = evaluationRows[evaluationIndex] || null;
      const totalRows = evaluationRows.length;
      const autoApprovedCount = evaluationRows.filter((row) => row.auto_exact_match).length;
      const failedCount = evaluationRows.filter((row) => !row.json_valid).length;
      const pendingReviewCount = evaluationRows.filter(
        (row) => row.needs_manual_review && row.manual_decision === null,
      ).length;
      const manualApprovedCount = evaluationRows.filter((row) => row.manual_decision === true).length;
      const finalApprovedCount = autoApprovedCount + manualApprovedCount;
      const finalRejectedCount = totalRows - finalApprovedCount;
      const finalApprovalRate = totalRows ? ((finalApprovedCount / totalRows) * 100).toFixed(2) : '0.00';

      const embeddedFromDatasetForGt =
        isUploadSource &&
        (metadata?.embedded_expected === true || datasetHasEmbeddedGroundTruth(dataset));
      const hasGroundTruthRows =
        embeddedFromDatasetForGt ||
        (Array.isArray(evaluatorGroundTruthRows) && evaluatorGroundTruthRows.length > 0);
      const gtRowCount =
        evaluatorGroundTruthRows?.length > 0
          ? evaluatorGroundTruthRows.length
          : embeddedFromDatasetForGt
            ? dataset.length
            : 0;
      const runnerRowCount = runnerResult?.results?.length ?? 0;
      const groundTruthRowMismatch =
        metadata?.source_type === 'uploaded_csv' &&
        hasGroundTruthRows &&
        runnerRowCount > 0 &&
        gtRowCount !== runnerRowCount;

      function setManualDecision(decision) {
        if (!currentRow) {
          return;
        }
        setEvaluationRows((rows) =>
          rows.map((row) => (row.id === currentRow.id ? { ...row, manual_decision: decision } : row)),
        );
      }

      return (
        <section className="dataset-card">
          <h2>Evaluator</h2>
          {metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows ? (
            <div style={{ marginBottom: '12px' }}>
              {embeddedFromDatasetForGt && !evaluatorGroundTruthFileName ? (
                <p className="meta-row">
                  Comparing to expected values from the <strong>same CSV</strong> loaded on Dataset (
                  {dataset.length} rows).
                </p>
              ) : null}
              <div className="controls-row" style={{ flexWrap: 'wrap' }}>
                <label htmlFor="ground-truth-csv-replace">
                  {embeddedFromDatasetForGt
                    ? 'Replace expected values with another CSV (optional)'
                    : 'Replace ground truth CSV'}
                </label>
                <input
                  id="ground-truth-csv-replace"
                  ref={groundTruthFileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleGroundTruthFileChange}
                />
                {evaluatorGroundTruthFileName ? (
                  <>
                    <span className="meta-row">
                      {evaluatorGroundTruthFileName} ({evaluatorGroundTruthRows?.length ?? 0} rows)
                    </span>
                    <button type="button" className="secondary" onClick={handleClearGroundTruthFile}>
                      Clear file
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          {groundTruthRowMismatch ? (
            <p className="error-message">
              Ground truth has {gtRowCount} data rows but Runner output has {runnerRowCount}. Expected
              values are applied by row index; extra runner rows have empty expected fields until the
              CSV row count matches.
            </p>
          ) : null}
          {evaluatorGroundTruthError ? (
            <p className="error-message">{evaluatorGroundTruthError}</p>
          ) : null}
          <div className="meta-row">
            <span>Total rows: {totalRows}</span>
            <span>Auto approved: {autoApprovedCount}</span>
            <span>Failed (invalid JSON): {failedCount}</span>
            <span>Pending manual review: {pendingReviewCount}</span>
          </div>

          <div className="runner-summary">
            <strong>Final metrics (auto + manual)</strong>
            <p>Approved rows: {finalApprovedCount}</p>
            <p>Rejected rows: {finalRejectedCount}</p>
            <p>Approval rate: {finalApprovalRate}%</p>
          </div>

          {currentRow ? (
            <>
              <div className="meta-row">
                <span>
                  Reviewing row {evaluationIndex + 1} of {totalRows}
                </span>
                <span>JSON valid: {currentRow.json_valid ? 'Yes' : 'No'}</span>
                <span>
                  Auto exact match: {currentRow.auto_exact_match ? 'Yes (approved)' : 'No'}
                </span>
              </div>

              <div className="runner-summary">
                <strong>Input</strong>
                <p>{currentRow.input}</p>
              </div>

              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Expected</th>
                      <th>Model output</th>
                      <th>Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows
                      ? GROUND_TRUTH_COLUMNS
                      : EXPECTED_FIELDS
                    ).map((field) => {
                      const expectedValue = currentRow.expected?.[field] ?? '';
                      const outputValue =
                        metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows
                          ? field === 'zip'
                            ? currentRow.parsed_json?.postal ?? ''
                            : currentRow.parsed_json?.[field] ?? ''
                          : getGeneratedParsedDisplay(field, currentRow.parsed_json);
                      const match =
                        metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows
                          ? fieldValuesMatchGroundTruth(field, expectedValue, outputValue)
                          : normalizeValue(expectedValue) === normalizeValue(outputValue);
                      return (
                        <tr key={field} className={match ? '' : 'row-json-invalid'}>
                          <td>{field}</td>
                          <td>{expectedValue || '-'}</td>
                          <td>{outputValue || '-'}</td>
                          <td>{match ? 'Yes' : 'No'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!currentRow.auto_exact_match && currentRow.json_valid ? (
                <div className="controls-row" style={{ marginTop: '12px' }}>
                  <span>This row needs manual decision:</span>
                  <button
                    type="button"
                    onClick={() => setManualDecision(true)}
                    className={currentRow.manual_decision === true ? '' : 'secondary'}
                  >
                    Mark row as correct
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualDecision(false)}
                    className={currentRow.manual_decision === false ? 'danger' : 'secondary'}
                  >
                    Mark row as incorrect
                  </button>
                </div>
              ) : null}

              <div className="pagination-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEvaluationIndex((current) => Math.max(0, current - 1))}
                  disabled={evaluationIndex === 0}
                >
                  Previous row
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setEvaluationIndex((current) => Math.min(totalRows - 1, current + 1))
                  }
                  disabled={evaluationIndex >= totalRows - 1}
                >
                  Next row
                </button>
              </div>
            </>
          ) : (
            <p>Run a benchmark first to start evaluation.</p>
          )}
        </section>
      );
    }

    if (activeStage !== 0) {
      return (
        <section className="placeholder-card">
          <h2>Stage in progress</h2>
          <p>This screen will be enabled when we implement {STAGES[activeStage]}.</p>
        </section>
      );
    }

    return (
      <section className="dataset-card">
        <h2>Dataset Generator</h2>
        <div className="controls-row">
          <label>Input source</label>
          <button
            type="button"
            className={datasetInputMode === 'generated' ? '' : 'secondary'}
            onClick={() => setDatasetInputMode('generated')}
            disabled={loading}
          >
            Generate dataset
          </button>
          <button
            type="button"
            className={datasetInputMode === 'upload' ? '' : 'secondary'}
            onClick={() => setDatasetInputMode('upload')}
            disabled={loading}
          >
            Upload CSV
          </button>
        </div>
        <div className="controls-row">
          {datasetInputMode === 'generated' ? (
            <>
              <label htmlFor="dataset-size">Number of addresses</label>
              <input
                id="dataset-size"
                type="number"
                min="10"
                max="5000"
                value={size}
                onChange={(event) => setSize(event.target.value)}
              />
              <label htmlFor="dataset-locale">Dataset locale</label>
              <select
                id="dataset-locale"
                value={datasetLocale}
                onChange={(event) => setDatasetLocale(event.target.value)}
                disabled={loading}
              >
                {DATASET_LOCALE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={handleGenerate} disabled={loading}>
                {loading ? 'Generating...' : 'Generate dataset'}
              </button>
            </>
          ) : (
            <>
              <label htmlFor="upload-csv">CSV file</label>
              <input
                id="upload-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setUploadedFile(event.target.files?.[0] || null)}
                disabled={loading}
              />
              <button type="button" onClick={handleUploadCsv} disabled={loading || !uploadedFile}>
                {loading ? 'Uploading...' : 'Upload and normalize CSV'}
              </button>
            </>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => setActiveStage(1)}
            disabled={dataset.length === 0}
          >
            Continue to next stage
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {successMessage ? <p className="success-message">{successMessage}</p> : null}

        <div className="meta-row">
          <span>Current total: {dataset.length}</span>
          <span>Generated at: {metadata?.generatedAt || '-'}</span>
          <span>Last config size: {metadata?.size || '-'}</span>
          <span>Locale: {metadata?.locale || '-'}</span>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Street</th>
                <th>City</th>
                <th>State</th>
                <th>Postal code</th>
                <th>Country</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan="6">No dataset available yet.</td>
                </tr>
              ) : (
                paginatedRows.map((row, index) => (
                  <tr key={`${row.input}-${index}`}>
                    <td>{row.input}</td>
                    <td>{row.expected?.street}</td>
                    <td>{row.expected?.city}</td>
                    <td>{row.expected?.state}</td>
                    <td>{row.expected?.postal_code}</td>
                    <td>{row.expected?.country}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="pagination-row">
          <button
            type="button"
            className="secondary"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page === 1}
          >
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </div>

        <div className="history-block">
          <h3>Generated dataset history</h3>
          {history.length === 0 ? (
            <p>No history files found.</p>
          ) : (
            <ul>
              {history.map((item) => {
                const actionState = historyActionLoading[item.fileName];
                const isBusy = Boolean(actionState);
                return (
                  <li key={item.fileName} className="history-item">
                    <div className="history-main">
                      <strong>
                        {item.fileName} ({item.size} items)
                      </strong>
                      <span>
                        {item.generatedAt
                          ? new Date(item.generatedAt).toLocaleString('en-US')
                          : 'Date unavailable'}
                      </span>
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleLoadHistoryDataset(item.fileName)}
                        disabled={isBusy}
                      >
                        {actionState === 'loading' ? 'Loading...' : 'Load'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDeleteHistoryDataset(item.fileName)}
                        disabled={isBusy}
                      >
                        {actionState === 'deleting' ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className="app-shell">
      <header>
        <h1>LLM Benchmark Tool</h1>
        <p>Visual workflow to generate dataset, run models, evaluate and review results.</p>
      </header>

      <nav className="stage-tabs">
        {STAGES.map((stage, index) => (
          <button
            key={stage}
            type="button"
            className={activeStage === index ? 'tab active' : 'tab'}
            onClick={() => setActiveStage(index)}
          >
            {index + 1}. {stage}
          </button>
        ))}
      </nav>

      {renderStageContent()}
    </main>
  );
}

export default App;
