const express = require('express');
const multer = require('multer');
const {
  generateAndSaveDatasetWithLocale,
  getLatestDataset,
  getDatasetHistory,
  getDatasetByFileName,
  deleteDatasetFileByFileName,
  createDatasetFromUploadedCsv,
  MIN_DATASET_SIZE,
  MAX_DATASET_SIZE,
  SUPPORTED_LOCALES,
} = require('../services/datasetService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

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
      error: 'No dataset generated yet.',
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
      error: 'Failed to load dataset history.',
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
      error: error.message || 'Dataset not found.',
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
      error: error.message || 'Failed to delete dataset.',
    });
  }
});

router.post('/upload-csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'CSV file is required.',
      });
    }

    const csvContent = req.file.buffer.toString('utf8');
    const response = await createDatasetFromUploadedCsv(csvContent, req.file.originalname);
    return res.status(201).json({
      ok: true,
      ...response,
    });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message || 'Failed to process uploaded CSV.',
    });
  }
});

module.exports = router;
