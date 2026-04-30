const express = require('express');
const { getSystemMetrics } = require('../services/systemMetricsService');

const router = express.Router();

router.get('/metrics', (_req, res) => {
  try {
    const metrics = getSystemMetrics();
    return res.json({ ok: true, ...metrics });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to collect system metrics.',
    });
  }
});

module.exports = router;
