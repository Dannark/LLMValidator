const express = require('express');
const fs = require('fs/promises');
const {
  runSingleCase,
  runBatchCases,
  listInstalledOllamaModels,
} = require('../services/runnerService');
const {
  startBenchmark,
  requestCancel,
  getPublicStatus,
  getCsvAbsolutePath,
} = require('../services/runnerBenchmarkSession');

const router = express.Router();

router.post('/extract', async (req, res) => {
  try {
    const { model, input } = req.body;
    if (!model || !input) {
      return res.status(400).json({
        ok: false,
        error: 'model and input are required.',
      });
    }

    const result = await runSingleCase({ model, input });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to run extraction on Ollama.',
    });
  }
});

router.post('/run', async (req, res) => {
  try {
    const { model, cases } = req.body;
    const result = await runBatchCases({ model, cases });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message || 'Failed to run benchmark.',
    });
  }
});

router.get('/models', async (_req, res) => {
  try {
    const models = await listInstalledOllamaModels();
    return res.json({
      ok: true,
      models,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to list models installed in Ollama.',
    });
  }
});

router.get('/benchmark/status', (_req, res) => {
  return res.json(getPublicStatus());
});

router.get('/benchmark/csv', async (_req, res) => {
  const csvPath = getCsvAbsolutePath();
  try {
    await fs.access(csvPath);
  } catch {
    return res.status(404).type('text/plain').send('No benchmark CSV file yet. Start a benchmark first.');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.sendFile(csvPath);
});

router.post('/benchmark/cancel', (_req, res) => {
  const result = requestCancel();
  return res.json({
    ok: true,
    canceled: result.ok === true,
    message: result.message || null,
  });
});

router.post('/benchmark/start', async (req, res) => {
  try {
    const { model, cases, concurrency } = req.body;
    const payload = await startBenchmark({ model, cases, concurrency });
    return res.json({ ok: true, ...payload });
  } catch (error) {
    if (error.code === 'BUSY') {
      return res.status(409).json({
        ok: false,
        error: error.message,
      });
    }
    return res.status(400).json({
      ok: false,
      error: error.message || 'Failed to start benchmark.',
    });
  }
});

module.exports = router;
