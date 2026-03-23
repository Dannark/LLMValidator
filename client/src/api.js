const API_BASE_URL = '/api';

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  if (!contentType.includes('application/json')) {
    if (rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html')) {
      throw new Error(
        'Resposta HTML recebida em vez de JSON. Verifique se o backend está rodando e se o proxy /api está ativo.',
      );
    }
    throw new Error('Resposta inválida da API (não-JSON).');
  }

  const payload = JSON.parse(rawText);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Falha na requisição');
  }
  return payload;
}

export async function generateDataset(size) {
  const response = await fetch(`${API_BASE_URL}/dataset/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size }),
  });
  return parseResponse(response);
}

export async function getLatestDataset() {
  const response = await fetch(`${API_BASE_URL}/dataset/latest`);
  return parseResponse(response);
}

export async function getDatasetHistory() {
  const response = await fetch(`${API_BASE_URL}/dataset/history`);
  return parseResponse(response);
}

export async function getDatasetByFileName(fileName) {
  const response = await fetch(
    `${API_BASE_URL}/dataset/${encodeURIComponent(fileName)}`,
  );
  return parseResponse(response);
}

export async function deleteDatasetByFileName(fileName) {
  const response = await fetch(
    `${API_BASE_URL}/dataset/${encodeURIComponent(fileName)}`,
    {
      method: 'DELETE',
    },
  );
  return parseResponse(response);
}

export async function runModelBenchmark(model, cases) {
  const response = await fetch(`${API_BASE_URL}/runner/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, cases }),
  });
  return parseResponse(response);
}

export async function getInstalledModels() {
  const response = await fetch(`${API_BASE_URL}/runner/models`);
  return parseResponse(response);
}

export async function runSingleExtraction(model, input) {
  const response = await fetch(`${API_BASE_URL}/runner/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  return parseResponse(response);
}
