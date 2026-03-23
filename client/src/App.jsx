import { useEffect, useMemo, useRef, useState } from 'react';
import {
  deleteDatasetByFileName,
  generateDataset,
  getDatasetByFileName,
  getDatasetHistory,
  getLatestDataset,
  getInstalledModels,
  runSingleExtraction,
} from './api';
import './App.css';

const STAGES = ['Dataset', 'Runner', 'Evaluator', 'Review & Report'];
const PAGE_SIZE = 12;
const PREFERRED_MODEL = 'gemma3:4b';
const EXPECTED_FIELDS = ['street', 'city', 'state', 'postal_code', 'country'];
const DATASET_LOCALE_OPTIONS = [
  { value: 'mixed', label: 'Mixed (US + BR + DE)' },
  { value: 'en_US', label: 'English (US)' },
  { value: 'pt_BR', label: 'Portuguese (Brazil)' },
  { value: 'de_DE', label: 'German (Germany)' },
];

function formatElapsedTime(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function normalizeValue(value) {
  return `${value ?? ''}`.trim().toLowerCase();
}

function isExactRowMatch(expected, parsed) {
  if (!expected || !parsed) {
    return false;
  }
  return EXPECTED_FIELDS.every((field) => normalizeValue(expected[field]) === normalizeValue(parsed[field]));
}

function buildEvaluationRows(results = []) {
  return results.map((row, index) => {
    const exactMatch = row.json_valid && isExactRowMatch(row.expected, row.parsed_json);
    return {
      id: `${index}-${row.input}`,
      index: index + 1,
      input: row.input,
      expected: row.expected || {},
      parsed_json: row.parsed_json,
      raw_output: row.raw_output,
      json_valid: row.json_valid,
      auto_exact_match: exactMatch,
      needs_manual_review: row.json_valid && !exactMatch,
      manual_decision: null,
    };
  });
}

function App() {
  const [activeStage, setActiveStage] = useState(0);
  const [size, setSize] = useState(50);
  const [datasetLocale, setDatasetLocale] = useState('mixed');
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
  const [runnerLoading, setRunnerLoading] = useState(false);
  const [runnerCancelRequested, setRunnerCancelRequested] = useState(false);
  const [runnerResult, setRunnerResult] = useState(null);
  const [evaluationRows, setEvaluationRows] = useState([]);
  const [evaluationIndex, setEvaluationIndex] = useState(0);
  const [runnerProgress, setRunnerProgress] = useState({
    processed: 0,
    total: 0,
    current: '',
  });
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const runnerCancelRef = useRef(false);

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
        // Ignora falhas no carregamento inicial.
      }
    }
    bootstrap();
  }, []);

  useEffect(() => {
    const results = runnerResult?.results || [];
    setEvaluationRows(buildEvaluationRows(results));
    setEvaluationIndex(0);
  }, [runnerResult]);

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
        // Se falhar, mantém campo atual para permitir valor manual futuro.
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
    runnerCancelRef.current = false;
    setError('');
    setSuccessMessage('');
    setRunnerResult(null);

    try {
      const limitedCases = dataset.slice(0, Number(runnerLimit));
      if (limitedCases.length === 0) {
        throw new Error('Load or generate a dataset before running the benchmark.');
      }

      const startedAt = Date.now();
      const results = [];
      setRunnerProgress({
        processed: 0,
        total: limitedCases.length,
        current: 'Starting execution...',
      });

      for (let index = 0; index < limitedCases.length; index += 1) {
        if (runnerCancelRef.current) {
          break;
        }

        const item = limitedCases[index];
        const step = `${index + 1}/${limitedCases.length}`;
        setRunnerProgress({
          processed: index,
          total: limitedCases.length,
          current: `Running prompt ${step}`,
        });

        try {
          const response = await runSingleExtraction(runnerModel, item.input);
          results.push({
            input: item.input,
            expected: item.expected ?? null,
            raw_output: response.raw_output,
            parsed_json: response.parsed_json,
            execution_time_ms: response.execution_time_ms,
            json_valid: response.json_valid,
            error: null,
          });
        } catch (err) {
          results.push({
            input: item.input,
            expected: item.expected ?? null,
            raw_output: '',
            parsed_json: null,
            execution_time_ms: 0,
            json_valid: false,
            error: err.message || 'Execution failed.',
          });
        }
      }

      const processed = results.length;
      const validCount = results.filter((item) => item.json_valid).length;
      const avgLatencyMs = processed
        ? Math.round(
            results.reduce((acc, item) => acc + (item.execution_time_ms || 0), 0) / processed,
          )
        : 0;
      const totalElapsedMs = Date.now() - startedAt;

      setRunnerProgress({
        processed,
        total: limitedCases.length,
        current: runnerCancelRef.current ? 'Execution canceled by user.' : 'Execution completed.',
      });
      setRunnerResult({
        model: runnerModel,
        summary: {
          processed,
          json_valid_count: validCount,
          json_valid_rate: processed ? validCount / processed : 0,
          avg_latency_ms: avgLatencyMs,
          total_elapsed_ms: totalElapsedMs,
        },
        results,
      });
      if (runnerCancelRef.current) {
        setSuccessMessage(`Runner canceled for ${runnerModel}. Partial results are shown.`);
      } else {
        setSuccessMessage(`Runner completed for ${runnerModel}.`);
      }
    } catch (err) {
      setError(err.message || 'Failed to run benchmark.');
    } finally {
      setRunnerLoading(false);
      setRunnerCancelRequested(false);
      runnerCancelRef.current = false;
    }
  }

  function handleCancelRun() {
    if (!runnerLoading) {
      return;
    }
    runnerCancelRef.current = true;
    setRunnerCancelRequested(true);
    setRunnerProgress((current) => ({
      ...current,
      current: 'Cancel requested. Finishing current request...',
    }));
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
      const allRows = runnerResult?.results || [];
      const progressPercent = runnerProgress.total
        ? Math.round((runnerProgress.processed / runnerProgress.total) * 100)
        : 0;
      return (
        <section className="dataset-card">
          <h2>Runner Ollama</h2>
          <div className="controls-row">
            <label htmlFor="runner-model">Model</label>
            <select
              id="runner-model"
              value={runnerModel}
              onChange={(event) => setRunnerModel(event.target.value)}
              disabled={modelsLoading || availableModels.length === 0}
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
            />
            <button type="button" onClick={handleRunBenchmark} disabled={runnerLoading}>
              {runnerLoading ? 'Running...' : 'Run benchmark'}
            </button>
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
          </div>

          {error ? <p className="error-message">{error}</p> : null}
          {successMessage ? <p className="success-message">{successMessage}</p> : null}

          <div className="meta-row">
            <span>Loaded dataset: {dataset.length} items</span>
            <span>Selected model: {runnerModel}</span>
            <span>Current limit: {runnerLimit}</span>
          </div>

          {runnerLoading ? (
            <div className="runner-summary">
              <strong>Progress</strong>
              <p>
                {runnerProgress.processed}/{runnerProgress.total} ({progressPercent}%)
              </p>
              <p>{runnerProgress.current || 'Waiting for execution...'}</p>
              <progress value={runnerProgress.processed} max={Math.max(1, runnerProgress.total)} />
            </div>
          ) : null}

          {summary ? (
            <div className="runner-summary">
              <strong>Summary</strong>
              <p>Processed: {summary.processed}</p>
              <p>Valid JSON: {summary.json_valid_count}</p>
              <p>Valid JSON rate: {(summary.json_valid_rate * 100).toFixed(2)}%</p>
              <p>Average latency: {summary.avg_latency_ms} ms</p>
              <p>Total elapsed time: {formatElapsedTime(summary.total_elapsed_ms)}</p>
            </div>
          ) : (
            <p>No execution yet. Click "Run benchmark".</p>
          )}

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
                  {allRows.map((row, index) => (
                    <tr
                      key={`${row.input}-${index}`}
                      className={row.json_valid ? '' : 'row-json-invalid'}
                    >
                      <td>{row.input}</td>
                      <td>{row.json_valid ? 'Yes' : 'No'}</td>
                      <td>{row.execution_time_ms}</td>
                      <td>{row.raw_output || row.error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      );
    }

    if (activeStage === 2) {
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
                    {EXPECTED_FIELDS.map((field) => {
                      const expectedValue = currentRow.expected?.[field] ?? '';
                      const outputValue = currentRow.parsed_json?.[field] ?? '';
                      const match = normalizeValue(expectedValue) === normalizeValue(outputValue);
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
