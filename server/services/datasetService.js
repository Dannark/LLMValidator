const path = require('path');
const { buildDataset } = require(path.join(__dirname, '..', '..', 'dataset', 'generateDataset'));
const {
  saveDataset,
  readLatestDataset,
  readDatasetHistory,
  readDatasetByFileName,
  deleteDatasetByFileName,
  normalizeDatasetFileName,
  resetLatestDataset,
  removeLatestDataset,
  fileExists,
  LATEST_DATASET_FILE,
} = require('./fileStore');

const MIN_DATASET_SIZE = 10;
const MAX_DATASET_SIZE = 5000;

function validateDatasetSize(size) {
  if (!Number.isInteger(size)) {
    throw new Error('size deve ser um inteiro.');
  }
  if (size < MIN_DATASET_SIZE || size > MAX_DATASET_SIZE) {
    throw new Error(`size deve estar entre ${MIN_DATASET_SIZE} e ${MAX_DATASET_SIZE}.`);
  }
}

async function generateAndSaveDataset(size) {
  validateDatasetSize(size);
  const items = buildDataset(size);
  const metadata = {
    generatedAt: new Date().toISOString(),
    size,
  };

  const { filePath, latestFilePath } = await saveDataset(items, metadata);
  return {
    metadata,
    filePath,
    latestFilePath,
    items,
  };
}

async function getLatestDataset() {
  return readLatestDataset();
}

async function getDatasetHistory() {
  return readDatasetHistory();
}

async function getDatasetByFileName(fileName) {
  const safeFileName = normalizeDatasetFileName(fileName);
  const payload = await readDatasetByFileName(safeFileName);
  return {
    fileName: safeFileName,
    ...payload,
  };
}

async function deleteDatasetFileByFileName(fileName) {
  const safeFileName = normalizeDatasetFileName(fileName);
  await deleteDatasetByFileName(safeFileName);

  const history = await getDatasetHistory();

  if (history.length === 0) {
    await removeLatestDataset();
  } else {
    const latestCandidate = history[0];
    const latestPayload = await readDatasetByFileName(latestCandidate.fileName);
    await resetLatestDataset(latestPayload);
  }

  const hasLatest = await fileExists(LATEST_DATASET_FILE);

  return {
    deletedFileName: safeFileName,
    hasLatest,
    history,
  };
}

module.exports = {
  MIN_DATASET_SIZE,
  MAX_DATASET_SIZE,
  generateAndSaveDataset,
  getLatestDataset,
  getDatasetHistory,
  getDatasetByFileName,
  deleteDatasetFileByFileName,
};
