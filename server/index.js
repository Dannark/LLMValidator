const express = require('express');
const cors = require('cors');
const datasetRoutes = require('./routes/datasetRoutes');
const runnerRoutes = require('./routes/runnerRoutes');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'llm-benchmark-server' });
});

app.use('/api/dataset', datasetRoutes);
app.use('/api/runner', runnerRoutes);

app.listen(PORT, () => {
  console.log(`Server rodando em http://localhost:${PORT}`);
});
