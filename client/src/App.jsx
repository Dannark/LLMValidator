import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
/** Stable empty reference for derived runner/evaluator result lists. */
const EMPTY_RUNNER_RESULTS = [];
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

/** Per-request latency in tables: ms when fast, else seconds or minutes + seconds. */
function formatLatencyDisplay(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return `${totalSec.toFixed(1)} s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
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

/** Dropdown options for “Export output vs expected CSV” match column. */
const EXPORT_COMPARISON_METRICS = [
  {
    id: 'custom',
    label: 'Evaluator rules (default)',
    shortHint:
      'Same logic as the Evaluator tab: tolerant zip/country, case-insensitive text fields.',
  },
  {
    id: 'exact_fields',
    label: 'Exactly field by field (ignore case)',
    shortHint: 'Trim + lowercase on every field; no country aliases; empty expected zip must match empty output zip.',
  },
  {
    id: 'address1_only',
    label: 'Only address1',
    shortHint: 'Compares only the first address line (street / address1), ignore case.',
  },
  {
    id: 'address1_address2',
    label: 'Only address1 and address2',
    shortHint: 'Compares address1 and address2 only, ignore case.',
  },
];

const EXPORT_COMPARISON_CUSTOM_RULES_HTML = (
  <p className="meta-row" style={{ marginTop: '6px', marginBottom: 0 }}>
    <strong>Evaluator rules</strong> — same as auto-match on the Evaluator: all seven fields must agree
    after <strong>trim + lowercase</strong>. Extra rules: <strong>country</strong> treats USA / US /
    United States / … as the same; if <strong>expected country is empty</strong>, any model country
    counts as match. <strong>Zip</strong>: if the expected zip is empty, any model postal code counts
    as match; if expected has a zip, it must match the model value (ignore case).
  </p>
);

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

/** Embedded upload / separate GT file: { name, address1, … zip }. Generated sets use { street, … postal_code }. */
function expectedUsesGroundTruthEvaluatorShape(expected) {
  return Boolean(expected && typeof expected === 'object' && 'address1' in expected);
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

/**
 * Per-field Match cell for Evaluator table. `null` → show "—" (field not used by this metric).
 */
function fieldMatchCellForMetric(field, expectedValue, outputValue, metricId, useGroundTruthColumns) {
  if (metricId === 'custom') {
    if (useGroundTruthColumns) {
      return fieldValuesMatchGroundTruth(field, expectedValue, outputValue);
    }
    return normalizeValue(expectedValue) === normalizeValue(outputValue);
  }
  if (metricId === 'exact_fields') {
    return normalizeValue(expectedValue) === normalizeValue(outputValue);
  }
  if (metricId === 'address1_only') {
    if (useGroundTruthColumns && field === 'address1') {
      return normalizeValue(expectedValue) === normalizeValue(outputValue);
    }
    if (!useGroundTruthColumns && field === 'street') {
      return normalizeValue(expectedValue) === normalizeValue(outputValue);
    }
    return null;
  }
  if (metricId === 'address1_address2') {
    if (useGroundTruthColumns && (field === 'address1' || field === 'address2')) {
      return normalizeValue(expectedValue) === normalizeValue(outputValue);
    }
    if (!useGroundTruthColumns && field === 'street') {
      return normalizeValue(expectedValue) === normalizeValue(outputValue);
    }
    return null;
  }
  if (useGroundTruthColumns) {
    return fieldValuesMatchGroundTruth(field, expectedValue, outputValue);
  }
  return normalizeValue(expectedValue) === normalizeValue(outputValue);
}

/** Strict GT match: every field equals after trim+lower only (no zip/country shortcuts). */
function isGroundTruthRowExactNormalizedOnly(expected, parsed) {
  if (!parsed || typeof parsed !== 'object' || !expected) {
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
  return pairs.every(([ek, pk]) => normalizeValue(expected[ek]) === normalizeValue(parsed[pk]));
}

function parsedModelAddress12(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    a1: `${p.address1 ?? p.street ?? ''}`.trim(),
    a2: `${p.address2 ?? ''}`.trim(),
  };
}

function expectedAddress12(expected) {
  if (!expected || typeof expected !== 'object') {
    return { a1: '', a2: '' };
  }
  if (expectedUsesGroundTruthEvaluatorShape(expected)) {
    return {
      a1: `${expected.address1 ?? ''}`.trim(),
      a2: `${expected.address2 ?? ''}`.trim(),
    };
  }
  return {
    a1: `${expected.street ?? ''}`.trim(),
    a2: '',
  };
}

function rowExactFieldsMatchForExport(row) {
  if (!row?.json_valid || !row.parsed_json || typeof row.parsed_json !== 'object') {
    return false;
  }
  const expected = row.expected;
  if (!expected || typeof expected !== 'object') {
    return false;
  }
  if (expectedUsesGroundTruthEvaluatorShape(expected)) {
    return isGroundTruthRowExactNormalizedOnly(expected, row.parsed_json);
  }
  return isExactRowMatch(expected, row.parsed_json);
}

function rowAddress1OnlyMatchForExport(row) {
  if (!row?.json_valid || !row.parsed_json || typeof row.parsed_json !== 'object') {
    return false;
  }
  const expected = row.expected;
  if (!expected || typeof expected !== 'object') {
    return false;
  }
  const { a1: p1 } = parsedModelAddress12(row.parsed_json);
  const { a1: e1 } = expectedAddress12(expected);
  return normalizeValue(e1) === normalizeValue(p1);
}

function rowAddress1Address2MatchForExport(row) {
  if (!row?.json_valid || !row.parsed_json || typeof row.parsed_json !== 'object') {
    return false;
  }
  const expected = row.expected;
  if (!expected || typeof expected !== 'object') {
    return false;
  }
  const { a1: p1, a2: p2 } = parsedModelAddress12(row.parsed_json);
  const { a1: e1, a2: e2 } = expectedAddress12(expected);
  return normalizeValue(e1) === normalizeValue(p1) && normalizeValue(e2) === normalizeValue(p2);
}

function runnerRowMatchForExportByMetric(row, metricId) {
  switch (metricId) {
    case 'exact_fields':
      return rowExactFieldsMatchForExport(row);
    case 'address1_only':
      return rowAddress1OnlyMatchForExport(row);
    case 'address1_address2':
      return rowAddress1Address2MatchForExport(row);
    case 'custom':
    default:
      return runnerRowMatchForExport(row);
  }
}

/** Semicolon-separated comparison CSV: model left, expected right, match last (0/1 by metric). */
function buildComparisonCsvDelimitedText(results, metricId) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }
  const delim = ';';
  const sepMarker = '<—>';
  const leftHeader = ['name', 'address1', 'address2', 'city', 'region', 'country', 'postal'];
  const rightHeader = ['Name', 'Address1', 'Address2', 'City', 'Region', 'Country', 'Zip'];
  const headerCells = [
    ...leftHeader,
    sepMarker,
    '',
    '',
    ...rightHeader,
    'match',
  ].map(csvEscape);
  const lines = [headerCells.join(delim)];

  for (const row of results) {
    const parsed = row.parsed_json || {};
    const expected = row.expected || {};
    const match = runnerRowMatchForExportByMetric(row, metricId) ? '1' : '0';
    const leftVals = [
      parsed.name || '',
      parsed.address1 || parsed.street || '',
      parsed.address2 || '',
      parsed.city || '',
      parsed.region || parsed.state || '',
      parsed.country || '',
      parsed.postal || parsed.postal_code || '',
    ];
    const rightVals = expectedCellsSevenForExport(expected);
    const line = [...leftVals, sepMarker, '', '', ...rightVals, match].map(csvEscape);
    lines.push(line.join(delim));
  }
  return lines.join('\n');
}

function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Same rules as Evaluator auto-match (ground-truth shape vs generated street/city…). */
function runnerRowMatchForExport(row) {
  if (!row?.json_valid || !row.parsed_json || typeof row.parsed_json !== 'object') {
    return false;
  }
  const expected = row.expected;
  if (!expected || typeof expected !== 'object') {
    return false;
  }
  if (expectedUsesGroundTruthEvaluatorShape(expected)) {
    return isGroundTruthRowMatch(expected, row.parsed_json);
  }
  return isExactRowMatch(expected, row.parsed_json);
}

/** Seven cells for the “expected” block in comparison CSV (upload vs generated schema). */
function expectedCellsSevenForExport(expected) {
  if (!expected || typeof expected !== 'object') {
    return ['', '', '', '', '', '', ''];
  }
  if (expectedUsesGroundTruthEvaluatorShape(expected)) {
    return [
      `${expected.name ?? ''}`.trim(),
      `${expected.address1 ?? ''}`.trim(),
      `${expected.address2 ?? ''}`.trim(),
      `${expected.city ?? ''}`.trim(),
      `${expected.region ?? ''}`.trim(),
      `${expected.country ?? ''}`.trim(),
      `${expected.zip ?? ''}`.trim(),
    ];
  }
  return [
    '',
    `${expected.street ?? ''}`.trim(),
    '',
    `${expected.city ?? ''}`.trim(),
    `${expected.state ?? ''}`.trim(),
    `${expected.country ?? ''}`.trim(),
    `${expected.postal_code ?? ''}`.trim(),
  ];
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

/** Same shape as "Export LLM output CSV" from Runner (optional address2). */
const RUNNER_OUTPUT_CSV_ALIASES = {
  name: ['name', 'customer_name', 'full_name'],
  address1: ['address1', 'address_1', 'addr1', 'street', 'line1'],
  address2: ['address2', 'address_2', 'addr2', 'line2'],
  city: ['city'],
  region: ['region', 'state', 'province'],
  country: ['country'],
  postal: ['postal', 'postal_code', 'zip', 'zipcode', 'postcode'],
};

function mapRunnerOutputCsvHeader(headerCells) {
  const colIndex = {};
  const normalized = headerCells.map(normalizeCsvHeader);
  for (const [canonical, aliases] of Object.entries(RUNNER_OUTPUT_CSV_ALIASES)) {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx >= 0) {
      colIndex[canonical] = idx;
    }
  }
  const required = ['name', 'address1', 'city', 'region', 'country', 'postal'];
  const missing = required.filter((k) => colIndex[k] === undefined);
  if (missing.length > 0) {
    return {
      colIndex: null,
      error: `Missing column(s): ${missing.join(', ')}. Found headers: ${headerCells.join(', ')}`,
    };
  }
  if (colIndex.address2 === undefined) {
    colIndex.address2 = -1;
  }
  return { colIndex, error: null };
}

function parseRunnerOutputCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    return { parsedRows: [], error: 'CSV must include a header row and at least one data row.' };
  }
  const delim = detectCsvDelimiter(lines[0]);
  const headerCells = parseCsvLine(lines[0], delim);
  const { colIndex, error: headerError } = mapRunnerOutputCsvHeader(headerCells);
  if (headerError || !colIndex) {
    return { parsedRows: [], error: headerError || 'Invalid CSV header.' };
  }
  const parsedRows = [];
  for (let li = 1; li < lines.length; li += 1) {
    const cells = parseCsvLine(lines[li], delim);
    const pick = (key) => {
      const idx = colIndex[key];
      if (idx === undefined || idx < 0) {
        return '';
      }
      return cells[idx] != null ? `${cells[idx]}`.trim() : '';
    };
    parsedRows.push({
      name: pick('name'),
      address1: pick('address1'),
      address2: pick('address2'),
      city: pick('city'),
      region: pick('region'),
      country: pick('country'),
      postal: pick('postal'),
    });
  }
  return { parsedRows, error: null };
}

function buildRunnerRowsFromImportedOutputs(datasetItems, parsedOutputs) {
  return datasetItems.map((item, index) => ({
    input: item.input ?? '',
    expected: item.expected ?? null,
    source_original: item.source_original ?? null,
    raw_output: '',
    parsed_json: parsedOutputs[index] ?? null,
    json_valid: true,
    execution_time_ms: 0,
    error: null,
    pending: false,
  }));
}

function buildEvaluationRows(results = [], groundTruthRows = null, matchMetricId = 'custom') {
  return results.map((row, index) => {
    const expected =
      groundTruthRows != null ? groundTruthRows[index] || {} : row.expected || {};
    const runnerLike = {
      json_valid: row.json_valid,
      parsed_json: row.parsed_json,
      expected,
    };
    const exactMatch =
      row.json_valid && runnerRowMatchForExportByMetric(runnerLike, matchMetricId);
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
  return `"${text.replace(/"/g, '""')}"`;
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
  const [exportComparisonMetric, setExportComparisonMetric] = useState('custom');
  const [evaluatorGroundTruthRows, setEvaluatorGroundTruthRows] = useState(null);
  const [evaluatorGroundTruthFileName, setEvaluatorGroundTruthFileName] = useState('');
  const [evaluatorGroundTruthError, setEvaluatorGroundTruthError] = useState('');
  const [evaluatorImportedResults, setEvaluatorImportedResults] = useState(null);
  const [evaluatorImportedResultsFileName, setEvaluatorImportedResultsFileName] = useState('');
  const [evaluatorImportedResultsError, setEvaluatorImportedResultsError] = useState('');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const groundTruthFileInputRef = useRef(null);
  const evaluatorResultsCsvInputRef = useRef(null);
  const runnerMetricsPollRef = useRef(null);
  const runnerStartInFlightRef = useRef(false);

  const runnerSessionHasTerminalResults =
    (runnerResult?.results?.length ?? 0) > 0 &&
    (runnerResult?.runStatus === 'completed' || runnerResult?.runStatus === 'canceled');

  const resultsForEvaluation = useMemo(() => {
    if (runnerSessionHasTerminalResults) {
      return runnerResult?.results ?? EMPTY_RUNNER_RESULTS;
    }
    if (Array.isArray(evaluatorImportedResults)) {
      return evaluatorImportedResults;
    }
    return EMPTY_RUNNER_RESULTS;
  }, [runnerSessionHasTerminalResults, runnerResult?.results, evaluatorImportedResults]);

  const clearEvaluatorImportedResults = useCallback(() => {
    setEvaluatorImportedResults(null);
    setEvaluatorImportedResultsFileName('');
    setEvaluatorImportedResultsError('');
    if (evaluatorResultsCsvInputRef.current) {
      evaluatorResultsCsvInputRef.current.value = '';
    }
  }, []);

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
    const useSeparateGroundTruthFile =
      metadata?.source_type === 'uploaded_csv' &&
      Array.isArray(evaluatorGroundTruthRows) &&
      evaluatorGroundTruthRows.length > 0;
    const gt = useSeparateGroundTruthFile ? evaluatorGroundTruthRows : null;
    setEvaluationRows((prev) => {
      const built = buildEvaluationRows(resultsForEvaluation, gt, exportComparisonMetric);
      return built.map((row) => {
        const prevRow = prev.find((p) => p.id === row.id);
        return {
          ...row,
          manual_decision: prevRow?.manual_decision ?? null,
        };
      });
    });
    setEvaluationIndex((i) => {
      const n = resultsForEvaluation.length;
      if (n <= 0) {
        return 0;
      }
      return Math.min(Math.max(0, i), n - 1);
    });
  }, [
    resultsForEvaluation,
    evaluatorGroundTruthRows,
    metadata?.source_type,
    exportComparisonMetric,
  ]);

  useEffect(() => {
    if (
      runnerResult?.runStatus === 'completed' &&
      (runnerResult?.results?.length ?? 0) > 0
    ) {
      clearEvaluatorImportedResults();
    }
  }, [runnerResult?.runStatus, runnerResult?.results?.length, clearEvaluatorImportedResults]);

  useEffect(() => {
    if (metadata?.source_type !== 'uploaded_csv') {
      setEvaluatorGroundTruthRows(null);
      setEvaluatorGroundTruthFileName('');
      setEvaluatorGroundTruthError('');
      clearEvaluatorImportedResults();
    }
  }, [metadata?.source_type, clearEvaluatorImportedResults]);

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
      clearEvaluatorImportedResults();
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
      clearEvaluatorImportedResults();
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
      clearEvaluatorImportedResults();
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
      clearEvaluatorImportedResults();
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

  function handleEvaluatorResultsCsvChange(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (metadata?.source_type !== 'uploaded_csv' || dataset.length === 0) {
      setEvaluatorImportedResults(null);
      setEvaluatorImportedResultsFileName('');
      setEvaluatorImportedResultsError('Load an uploaded CSV dataset on the Dataset tab first.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const { parsedRows, error: parseError } = parseRunnerOutputCsv(text);
      if (parseError) {
        setEvaluatorImportedResults(null);
        setEvaluatorImportedResultsFileName('');
        setEvaluatorImportedResultsError(parseError);
        return;
      }
      if (parsedRows.length !== dataset.length) {
        setEvaluatorImportedResults(null);
        setEvaluatorImportedResultsFileName('');
        setEvaluatorImportedResultsError(
          `Result CSV has ${parsedRows.length} data row(s) but the loaded dataset has ${dataset.length}. Row order must match the Dataset (or use an export from a full run on the same CSV).`,
        );
        return;
      }
      setEvaluatorImportedResults(buildRunnerRowsFromImportedOutputs(dataset, parsedRows));
      setEvaluatorImportedResultsFileName(file.name);
      setEvaluatorImportedResultsError('');
    };
    reader.onerror = () => {
      setEvaluatorImportedResults(null);
      setEvaluatorImportedResultsFileName('');
      setEvaluatorImportedResultsError('Failed to read file.');
    };
    reader.readAsText(file, 'UTF-8');
  }

  function handleExportRunnerCsv() {
    if (!runnerResult?.results?.length) {
      return;
    }

    const header = ['name', 'address1', 'address2', 'city', 'region', 'country', 'postal'];
    const lines = [header.join(',')];

    for (const row of runnerResult.results) {
      const parsed = row.parsed_json || {};

      const line = [
        parsed.name || '',
        parsed.address1 || parsed.street || '',
        parsed.address2 || '',
        parsed.city || '',
        parsed.region || parsed.state || '',
        parsed.country || '',
        parsed.postal || parsed.postal_code || '',
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

  function handleExportRunnerComparisonCsv() {
    if (!runnerResult?.results?.length) {
      return;
    }
    const text = buildComparisonCsvDelimitedText(runnerResult.results, exportComparisonMetric);
    if (!text) {
      return;
    }
    downloadTextFile('llm_output_vs_expected.csv', text);
  }

  function handleExportEvaluationComparisonCsv() {
    if (!resultsForEvaluation.length) {
      return;
    }
    const text = buildComparisonCsvDelimitedText(resultsForEvaluation, exportComparisonMetric);
    if (!text) {
      return;
    }
    downloadTextFile('llm_output_vs_expected.csv', text);
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
            {runnerResult?.results?.length ? (
              <div
                className="controls-row"
                style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px' }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 'min(100%, 22rem)' }}>
                  <label htmlFor="export-comparison-metric">Match metric (comparison CSV)</label>
                  <p className="meta-row" style={{ margin: 0, fontSize: '0.85rem', opacity: 0.9 }}>
                    Same selection updates the Evaluator summary and per-row flags.
                  </p>
                  <select
                    id="export-comparison-metric"
                    value={exportComparisonMetric}
                    onChange={(event) => setExportComparisonMetric(event.target.value)}
                  >
                    {EXPORT_COMPARISON_METRICS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {exportComparisonMetric === 'custom' ? (
                    <div className="runner-summary" style={{ maxWidth: '48rem', marginTop: 0 }}>
                      {EXPORT_COMPARISON_CUSTOM_RULES_HTML}
                    </div>
                  ) : (
                    <p className="meta-row" style={{ margin: 0, maxWidth: '48rem', opacity: 0.92 }}>
                      {EXPORT_COMPARISON_METRICS.find((m) => m.id === exportComparisonMetric)?.shortHint}
                    </p>
                  )}
                </div>
                <button type="button" className="secondary" onClick={handleExportRunnerComparisonCsv}>
                  Export output vs expected CSV
                </button>
              </div>
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
              <p>Average latency: {formatLatencyDisplay(summary.avg_latency_ms)}</p>
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
                    <th>#</th>
                    <th>Input</th>
                    <th>Valid JSON</th>
                    <th>Latency</th>
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
                      <td>{index + 1}</td>
                      <td>{row.input}</td>
                      <td>{row.pending ? '—' : row.json_valid ? 'Yes' : 'No'}</td>
                      <td>
                        {row.pending ? '—' : formatLatencyDisplay(row.execution_time_ms)}
                      </td>
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
      const hasImportedEvaluationRows =
        Array.isArray(evaluatorImportedResults) && evaluatorImportedResults.length > 0;
      const hasRunnerResults = runnerSessionHasTerminalResults || hasImportedEvaluationRows;
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
            <p className="meta-row" style={{ marginTop: '12px' }}>
              <strong>Without running the Runner again:</strong> load a previous{' '}
              <strong>model output CSV</strong> — same format as Runner → &quot;Export LLM output
              CSV&quot; (headers such as{' '}
              <code>name, address1, address2, city, region, country, postal</code>). One data row per
              row in the Dataset, same order.
            </p>
            <div className="controls-row">
              <label htmlFor="evaluator-results-csv">Results CSV</label>
              <input
                id="evaluator-results-csv"
                type="file"
                accept=".csv,text/csv"
                onChange={handleEvaluatorResultsCsvChange}
              />
            </div>
            {evaluatorImportedResultsError ? (
              <p className="error-message">{evaluatorImportedResultsError}</p>
            ) : null}
            <p className="meta-row">
              Or run the benchmark on the Runner tab; when it finishes, results appear here
              automatically.
            </p>
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
      const manualOnlyApprovedCount = evaluationRows.filter(
        (row) => row.manual_decision === true && !row.auto_exact_match,
      ).length;
      const finalApprovedCount = evaluationRows.filter(
        (row) => row.auto_exact_match === true || row.manual_decision === true,
      ).length;
      const finalRejectedCount = totalRows - finalApprovedCount;
      const finalApprovalRate = totalRows ? ((finalApprovedCount / totalRows) * 100).toFixed(2) : '0.00';
      const activeMetricLabel =
        EXPORT_COMPARISON_METRICS.find((m) => m.id === exportComparisonMetric)?.label ??
        exportComparisonMetric;

      const embeddedFromDatasetForGt =
        isUploadSource &&
        (metadata?.embedded_expected === true || datasetHasEmbeddedGroundTruth(dataset));
      const hasGroundTruthRows =
        embeddedFromDatasetForGt ||
        (Array.isArray(evaluatorGroundTruthRows) && evaluatorGroundTruthRows.length > 0);
      const useGtColsForTable =
        metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows;
      const gtRowCount =
        evaluatorGroundTruthRows?.length > 0
          ? evaluatorGroundTruthRows.length
          : embeddedFromDatasetForGt
            ? dataset.length
            : 0;
      const runnerRowCount = resultsForEvaluation.length;
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
          {!runnerSessionHasTerminalResults &&
          evaluatorImportedResultsFileName &&
          resultsForEvaluation.length > 0 ? (
            <p className="meta-row" style={{ marginBottom: '12px' }}>
              Using imported results: <strong>{evaluatorImportedResultsFileName}</strong>.{' '}
              <button type="button" className="secondary" onClick={clearEvaluatorImportedResults}>
                Remove imported CSV
              </button>
            </p>
          ) : null}
          {metadata?.source_type === 'uploaded_csv' && hasGroundTruthRows ? (
            <div style={{ marginBottom: '12px' }}>
              {embeddedFromDatasetForGt && !evaluatorGroundTruthFileName ? (
                <p className="meta-row">
                  Comparing to expected values from the <strong>same CSV</strong> loaded on Dataset (
                  {dataset.length} rows).
                </p>
              ) : null}
              {embeddedFromDatasetForGt && !evaluatorGroundTruthFileName ? (
                <details style={{ marginBottom: '10px' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                    Optional: replace expected columns from another CSV
                  </summary>
                  <p className="meta-row" style={{ marginTop: '8px' }}>
                    Only if you want to override the embedded ground truth; row order must match the
                    Dataset.
                  </p>
                  <div className="controls-row" style={{ flexWrap: 'wrap' }}>
                    <label htmlFor="ground-truth-csv-replace">Expected / ground truth CSV</label>
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
                </details>
              ) : (
                <div className="controls-row" style={{ flexWrap: 'wrap', marginBottom: '10px' }}>
                  <label htmlFor="ground-truth-csv-replace">
                    {embeddedFromDatasetForGt
                      ? 'Replace expected values with another CSV'
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
              )}
              {!runnerSessionHasTerminalResults && !hasImportedEvaluationRows ? (
                <div className="controls-row" style={{ flexWrap: 'wrap' }}>
                  <label htmlFor="evaluator-results-csv-main">Model output CSV (import)</label>
                  <input
                    id="evaluator-results-csv-main"
                    ref={evaluatorResultsCsvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleEvaluatorResultsCsvChange}
                  />
                </div>
              ) : null}
              {!runnerSessionHasTerminalResults && hasImportedEvaluationRows ? (
                <p className="meta-row" style={{ marginTop: '4px' }}>
                  To import a different model output file, click <strong>Remove imported CSV</strong> above;
                  the file picker will show again below.
                </p>
              ) : null}
            </div>
          ) : null}
          {totalRows > 0 ? (
            <div className="runner-summary" style={{ marginBottom: '12px' }}>
              <strong>Export comparison CSV</strong>
              <p className="meta-row" style={{ marginTop: '6px' }}>
                Model output columns on the left, expected on the right, <code>match</code> last (1 or 0)
                using the selected metric — same layout as Runner. Changing the metric also refreshes
                the summary counts and the per-row table below.
              </p>
              <div
                className="controls-row"
                style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: '10px', marginTop: '8px' }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    minWidth: 'min(100%, 22rem)',
                  }}
                >
                  <label htmlFor="evaluator-export-metric">Match metric</label>
                  <select
                    id="evaluator-export-metric"
                    value={exportComparisonMetric}
                    onChange={(event) => setExportComparisonMetric(event.target.value)}
                  >
                    {EXPORT_COMPARISON_METRICS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {exportComparisonMetric === 'custom' ? (
                    <div className="runner-summary" style={{ maxWidth: '48rem', marginTop: 0 }}>
                      {EXPORT_COMPARISON_CUSTOM_RULES_HTML}
                    </div>
                  ) : (
                    <p className="meta-row" style={{ margin: 0, maxWidth: '48rem', opacity: 0.92 }}>
                      {EXPORT_COMPARISON_METRICS.find((m) => m.id === exportComparisonMetric)?.shortHint}
                    </p>
                  )}
                </div>
                <button type="button" className="secondary" onClick={handleExportEvaluationComparisonCsv}>
                  Export output vs expected CSV
                </button>
              </div>
            </div>
          ) : null}
          {groundTruthRowMismatch ? (
            <p className="error-message">
              Ground truth has {gtRowCount} data rows but the loaded result rows are {runnerRowCount}.
              Expected values are applied by row index; counts should match.
            </p>
          ) : null}
          {evaluatorGroundTruthError ? (
            <p className="error-message">{evaluatorGroundTruthError}</p>
          ) : null}
          {evaluatorImportedResultsError ? (
            <p className="error-message">{evaluatorImportedResultsError}</p>
          ) : null}
          <div className="meta-row">
            <span>Total rows: {totalRows}</span>
            <span>
              Auto approved: {autoApprovedCount} <em>({activeMetricLabel})</em>
            </span>
            <span>Failed (invalid JSON): {failedCount}</span>
            <span>Pending manual review: {pendingReviewCount}</span>
          </div>

          <div className="runner-summary">
            <strong>
              Final metrics (auto + manual) — match metric: {activeMetricLabel}
            </strong>
            <p>Approved rows: {finalApprovedCount}</p>
            <p>Rejected rows: {finalRejectedCount}</p>
            <p>Approval rate: {finalApprovalRate}%</p>
            <p className="meta-row">Manual overrides (approved without auto-match): {manualOnlyApprovedCount}</p>
          </div>

          {currentRow ? (
            <>
              <div className="meta-row">
                <span>
                  Reviewing row {evaluationIndex + 1} of {totalRows}
                </span>
                <span>JSON valid: {currentRow.json_valid ? 'Yes' : 'No'}</span>
                <span>
                  Auto match ({activeMetricLabel}):{' '}
                  {currentRow.auto_exact_match ? 'Yes (approved)' : 'No'}
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
                      const matchResult = fieldMatchCellForMetric(
                        field,
                        expectedValue,
                        outputValue,
                        exportComparisonMetric,
                        useGtColsForTable,
                      );
                      const matchLabel =
                        matchResult === null ? '—' : matchResult ? 'Yes' : 'No';
                      const rowInvalid = matchResult !== null && !matchResult;
                      return (
                        <tr key={field} className={rowInvalid ? 'row-json-invalid' : ''}>
                          <td>{field}</td>
                          <td>{expectedValue || '-'}</td>
                          <td>{outputValue || '-'}</td>
                          <td>{matchLabel}</td>
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
