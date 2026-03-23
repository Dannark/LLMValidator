const express = require('express');
const {
  generateAndSaveDatasetWithLocale,
  getLatestDataset,
  getDatasetHistory,
  getDatasetByFileName,
  deleteDatasetFileByFileName,
  MIN_DATASET_SIZE,
  MAX_DATASET_SIZE,
  SUPPORTED_LOCALES,
} = require('../services/datasetService');

const router = express.Router();

router.post('/generate', async (req, res) => {
  try {
    const { size, locale = 'mixed' } = req.body;
    const response = await generateAndSaveDatasetWithLocale(size, locale);

    res.status(201).json({
      ok: true,
      ...response,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message,
      limits: {
        min: MIN_DATASET_SIZE,
        max: MAX_DATASET_SIZE,
      },
      supported_locales: SUPPORTED_LOCALES,
    });
  }
});

router.get('/latest', async (_req, res) => {
  try {
    const dataset = await getLatestDataset();
    res.json({
      ok: true,
      ...dataset,
    });
  } catch (error) {
    res.status(404).json({
      ok: false,
      error: 'Nenhum dataset gerado ainda.',
    });
  }
});

router.get('/history', async (_req, res) => {
  try {
    const history = await getDatasetHistory();
    res.json({
      ok: true,
      items: history,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: 'Falha ao carregar histórico de datasets.',
    });
  }
});

router.get('/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const dataset = await getDatasetByFileName(fileName);
    res.json({
      ok: true,
      ...dataset,
    });
  } catch (error) {
    res.status(404).json({
      ok: false,
      error: error.message || 'Dataset não encontrado.',
    });
  }
});

router.delete('/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const result = await deleteDatasetFileByFileName(fileName);
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message || 'Falha ao excluir dataset.',
    });
  }
});

module.exports = router;
