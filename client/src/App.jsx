import { useEffect, useMemo, useState } from 'react';
import {
  deleteDatasetByFileName,
  generateDataset,
  getDatasetByFileName,
  getDatasetHistory,
  getLatestDataset,
  getInstalledModels,
  runModelBenchmark,
} from './api';
import './App.css';

const STAGES = ['Dataset', 'Runner', 'Evaluator', 'Review & Report'];
const PAGE_SIZE = 12;

function App() {
  const [activeStage, setActiveStage] = useState(0);
  const [size, setSize] = useState(50);
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
  const [runnerResult, setRunnerResult] = useState(null);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

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
    async function loadModels() {
      setModelsLoading(true);
      try {
        const response = await getInstalledModels();
        const models = response.models || [];
        setAvailableModels(models);
        if (models.length > 0) {
          setRunnerModel((current) => (models.includes(current) ? current : models[0]));
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
      const response = await generateDataset(Number(size));
      setDataset(response.items || []);
      setMetadata(response.metadata || null);
      setPage(1);
      const historyResponse = await getDatasetHistory();
      setHistory(historyResponse.items || []);
      setSuccessMessage('Dataset gerado com sucesso.');
    } catch (err) {
      setError(err.message || 'Erro ao gerar dataset.');
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
      setSuccessMessage(`Dataset ${fileName} carregado com sucesso.`);
    } catch (err) {
      setError(err.message || 'Falha ao carregar dataset.');
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
      `Tem certeza que deseja excluir permanentemente ${fileName}?`,
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
      setSuccessMessage(`Dataset ${fileName} excluído com sucesso.`);
    } catch (err) {
      setError(err.message || 'Falha ao excluir dataset.');
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
    setError('');
    setSuccessMessage('');
    setRunnerResult(null);

    try {
      const limitedCases = dataset.slice(0, Number(runnerLimit));
      if (limitedCases.length === 0) {
        throw new Error('Carregue ou gere um dataset antes de executar o runner.');
      }

      const response = await runModelBenchmark(runnerModel, limitedCases);
      setRunnerResult(response);
      setSuccessMessage(`Runner concluído para ${runnerModel}.`);
    } catch (err) {
      setError(err.message || 'Falha ao executar runner.');
    } finally {
      setRunnerLoading(false);
    }
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
        setRunnerModel(models[0]);
      }
      setSuccessMessage('Modelos atualizados com sucesso.');
    } catch (err) {
      setError(err.message || 'Falha ao carregar modelos do Ollama.');
    } finally {
      setModelsLoading(false);
    }
  }

  function renderStageContent() {
    if (activeStage === 1) {
      const summary = runnerResult?.summary;
      const topRows = runnerResult?.results?.slice(0, 8) || [];
      return (
        <section className="dataset-card">
          <h2>Runner Ollama</h2>
          <div className="controls-row">
            <label htmlFor="runner-model">Modelo</label>
            <select
              id="runner-model"
              value={runnerModel}
              onChange={(event) => setRunnerModel(event.target.value)}
              disabled={modelsLoading || availableModels.length === 0}
            >
              {availableModels.length === 0 ? (
                <option value="">Nenhum modelo encontrado</option>
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
              {modelsLoading ? 'Atualizando...' : 'Atualizar modelos'}
            </button>
            <label htmlFor="runner-limit">Qtd de casos</label>
            <input
              id="runner-limit"
              type="number"
              min="1"
              max={Math.max(1, dataset.length)}
              value={runnerLimit}
              onChange={(event) => setRunnerLimit(event.target.value)}
            />
            <button type="button" onClick={handleRunBenchmark} disabled={runnerLoading}>
              {runnerLoading ? 'Executando...' : 'Executar benchmark'}
            </button>
          </div>

          {error ? <p className="error-message">{error}</p> : null}
          {successMessage ? <p className="success-message">{successMessage}</p> : null}

          <div className="meta-row">
            <span>Dataset carregado: {dataset.length} itens</span>
            <span>Modelo selecionado: {runnerModel}</span>
            <span>Limite atual: {runnerLimit}</span>
          </div>

          {summary ? (
            <div className="runner-summary">
              <strong>Resumo</strong>
              <p>Processados: {summary.processed}</p>
              <p>JSON válido: {summary.json_valid_count}</p>
              <p>Taxa JSON válido: {(summary.json_valid_rate * 100).toFixed(2)}%</p>
              <p>Latência média: {summary.avg_latency_ms} ms</p>
            </div>
          ) : (
            <p>Nenhuma execução ainda. Clique em "Executar benchmark".</p>
          )}

          {topRows.length > 0 ? (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Input</th>
                    <th>JSON válido</th>
                    <th>Latência (ms)</th>
                    <th>Output bruto</th>
                  </tr>
                </thead>
                <tbody>
                  {topRows.map((row, index) => (
                    <tr key={`${row.input}-${index}`}>
                      <td>{row.input}</td>
                      <td>{row.json_valid ? 'Sim' : 'Não'}</td>
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

    if (activeStage !== 0) {
      return (
        <section className="placeholder-card">
          <h2>Etapa em preparação</h2>
          <p>Esta tela será habilitada quando implementarmos o {STAGES[activeStage]}.</p>
        </section>
      );
    }

    return (
      <section className="dataset-card">
        <h2>Gerador de Dataset</h2>
        <div className="controls-row">
          <label htmlFor="dataset-size">Quantidade de endereços</label>
          <input
            id="dataset-size"
            type="number"
            min="10"
            max="5000"
            value={size}
            onChange={(event) => setSize(event.target.value)}
          />
          <button type="button" onClick={handleGenerate} disabled={loading}>
            {loading ? 'Gerando...' : 'Gerar dataset'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setActiveStage(1)}
            disabled={dataset.length === 0}
          >
            Continuar para próxima etapa
          </button>
        </div>

        {error ? <p className="error-message">{error}</p> : null}
        {successMessage ? <p className="success-message">{successMessage}</p> : null}

        <div className="meta-row">
          <span>Total atual: {dataset.length}</span>
          <span>Gerado em: {metadata?.generatedAt || '-'}</span>
          <span>Última configuração: {metadata?.size || '-'}</span>
        </div>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Input</th>
                <th>Nome</th>
                <th>Rua</th>
                <th>Cidade</th>
                <th>CEP</th>
                <th>País</th>
              </tr>
            </thead>
            <tbody>
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan="6">Nenhum dataset disponível ainda.</td>
                </tr>
              ) : (
                paginatedRows.map((row, index) => (
                  <tr key={`${row.input}-${index}`}>
                    <td>{row.input}</td>
                    <td>{row.expected?.name}</td>
                    <td>{row.expected?.street}</td>
                    <td>{row.expected?.city}</td>
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
            Anterior
          </button>
          <span>
            Página {page} de {totalPages}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
          >
            Próxima
          </button>
        </div>

        <div className="history-block">
          <h3>Histórico de datasets gerados</h3>
          {history.length === 0 ? (
            <p>Nenhum arquivo histórico encontrado.</p>
          ) : (
            <ul>
              {history.map((item) => {
                const actionState = historyActionLoading[item.fileName];
                const isBusy = Boolean(actionState);
                return (
                  <li key={item.fileName} className="history-item">
                    <div className="history-main">
                      <strong>
                        {item.fileName} ({item.size} itens)
                      </strong>
                      <span>
                        {item.generatedAt
                          ? new Date(item.generatedAt).toLocaleString('pt-BR')
                          : 'Data indisponível'}
                      </span>
                    </div>
                    <div className="history-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => handleLoadHistoryDataset(item.fileName)}
                        disabled={isBusy}
                      >
                        {actionState === 'loading' ? 'Carregando...' : 'Carregar'}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDeleteHistoryDataset(item.fileName)}
                        disabled={isBusy}
                      >
                        {actionState === 'deleting' ? 'Excluindo...' : 'Excluir'}
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
        <p>Fluxo visual para gerar dataset, rodar modelos, avaliar e revisar resultados.</p>
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
