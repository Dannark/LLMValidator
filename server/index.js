const express = require('express');
const cors = require('cors');
const datasetRoutes = require('./routes/datasetRoutes');
const runnerRoutes = require('./routes/runnerRoutes');
const systemRoutes = require('./routes/systemRoutes');
const { getSystemMetrics } = require('./services/systemMetricsService');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
// Runner benchmark POST sends the full cases array; keep headroom for large batches.
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (_req, res) => {
  try {
    const metrics = getSystemMetrics();
    res.json({
      ok: true,
      service: 'llm-benchmark-server',
      ...metrics,
    });
  } catch {
    res.json({ ok: true, service: 'llm-benchmark-server' });
  }
});

app.use('/api/dataset', datasetRoutes);
app.use('/api/runner', runnerRoutes);
app.use('/api/system', systemRoutes);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening at http://127.0.0.1:${PORT}`);
});
