const express = require('express');
const {
  runSingleCase,
  runBatchCases,
  listInstalledOllamaModels,
} = require('../services/runnerService');

const router = express.Router();

router.post('/extract', async (req, res) => {
  try {
    const { model, input } = req.body;
    if (!model || !input) {
      return res.status(400).json({
        ok: false,
        error: 'model e input são obrigatórios.',
      });
    }

    const result = await runSingleCase({ model, input });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Falha ao executar extração no Ollama.',
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
      error: error.message || 'Falha ao executar benchmark.',
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
      error: error.message || 'Falha ao listar modelos instalados no Ollama.',
    });
  }
});

module.exports = router;
