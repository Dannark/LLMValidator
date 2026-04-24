const API_BASE_URL = '/api';

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();

  if (!contentType.includes('application/json')) {
    if (rawText.trim().startsWith('<!DOCTYPE') || rawText.trim().startsWith('<html')) {
      throw new Error(
        'Received HTML instead of JSON. Is the API server running and the /api proxy enabled?',
      );
    }
    throw new Error('Invalid API response (not JSON).');
  }

  const payload = JSON.parse(rawText);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

export async function generateDataset(size, locale = 'mixed') {
  const response = await fetch(`${API_BASE_URL}/dataset/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ size, locale }),
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

async function fetchOptionalJson(url) {
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    const rawText = await response.text();
    if (!contentType.includes('application/json')) {
      return null;
    }
    const payload = JSON.parse(rawText);
    if (!response.ok || payload.ok === false) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Host RAM/CPU/GPU (Node process machine). Tries /api/system/metrics, then /api/health (same payload after deploy).
 */
export async function getSystemMetrics() {
  let data = await fetchOptionalJson(`${API_BASE_URL}/system/metrics`);
  if (data?.memory) {
    return data;
  }
  data = await fetchOptionalJson(`${API_BASE_URL}/health`);
  if (data?.memory) {
    const { memory, cpus, loadavg, gpus, hostname, platform, collectedAt } = data;
    return { ok: true, memory, cpus, loadavg, gpus, hostname, platform, collectedAt };
  }
  return null;
}

export async function runSingleExtraction(model, input) {
  const response = await fetch(`${API_BASE_URL}/runner/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  return parseResponse(response);
}

export async function startRunnerBenchmark(model, cases, concurrency) {
  const response = await fetch(`${API_BASE_URL}/runner/benchmark/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, cases, concurrency }),
  });
  return parseResponse(response);
}

export async function cancelRunnerBenchmark() {
  const response = await fetch(`${API_BASE_URL}/runner/benchmark/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error('Invalid API response (not JSON).');
  }
  const payload = JSON.parse(rawText);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

export async function getRunnerBenchmarkStatus() {
  const response = await fetch(`${API_BASE_URL}/runner/benchmark/status`);
  const contentType = response.headers.get('content-type') || '';
  const rawText = await response.text();
  if (!contentType.includes('application/json')) {
    throw new Error('Invalid API response (not JSON).');
  }
  const payload = JSON.parse(rawText);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

export async function uploadCsvDataset(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${API_BASE_URL}/dataset/upload-csv`, {
    method: 'POST',
    body: formData,
  });
  return parseResponse(response);
}
