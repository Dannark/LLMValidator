const fs = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATASET_DIR = path.join(DATA_DIR, 'datasets');
const LATEST_DATASET_FILE = path.join(DATASET_DIR, 'latest.json');
const DATASET_FILE_REGEX = /^dataset-.*\.json$/;

async function ensureDataDirs() {
  await fs.mkdir(DATASET_DIR, { recursive: true });
}

async function writeJson(filePath, payload) {
  await ensureDataDirs();
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function buildTimestampedDatasetPath() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(DATASET_DIR, `dataset-${stamp}.json`);
}

async function saveDataset(datasetItems, metadata) {
  const filePath = buildTimestampedDatasetPath();
  const payload = {
    metadata,
    items: datasetItems,
  };

  await writeJson(filePath, payload);
  await writeJson(LATEST_DATASET_FILE, payload);

  return {
    filePath,
    latestFilePath: LATEST_DATASET_FILE,
  };
}

async function readLatestDataset() {
  return readJson(LATEST_DATASET_FILE);
}

async function readDatasetHistory() {
  await ensureDataDirs();
  const entries = await fs.readdir(DATASET_DIR, { withFileTypes: true });
  const datasetFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => DATASET_FILE_REGEX.test(name))
    .sort()
    .reverse();

  const historyWithMetadata = await Promise.all(
    datasetFiles.map(async (name) => {
      const filePath = path.join(DATASET_DIR, name);
      const payload = await readJson(filePath);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const metadata = payload.metadata || {};

      return {
        fileName: name,
        filePath,
        size: Number.isInteger(metadata.size) ? metadata.size : items.length,
        generatedAt: metadata.generatedAt || null,
      };
    }),
  );

  return historyWithMetadata;
}

function normalizeDatasetFileName(fileName) {
  if (typeof fileName !== 'string') {
    throw new Error('Invalid file name.');
  }

  const sanitized = path.basename(fileName);
  if (sanitized !== fileName || !DATASET_FILE_REGEX.test(sanitized)) {
    throw new Error('Invalid file name.');
  }

  return sanitized;
}

function resolveDatasetFilePath(fileName) {
  const sanitized = normalizeDatasetFileName(fileName);
  return path.join(DATASET_DIR, sanitized);
}

async function readDatasetByFileName(fileName) {
  const filePath = resolveDatasetFilePath(fileName);
  return readJson(filePath);
}

async function deleteDatasetByFileName(fileName) {
  const filePath = resolveDatasetFilePath(fileName);
  await fs.unlink(filePath);
  return filePath;
}

async function resetLatestDataset(datasetPayload) {
  await writeJson(LATEST_DATASET_FILE, datasetPayload);
}

async function removeLatestDataset() {
  const exists = await fileExists(LATEST_DATASET_FILE);
  if (exists) {
    await fs.unlink(LATEST_DATASET_FILE);
  }
}

module.exports = {
  DATASET_DIR,
  LATEST_DATASET_FILE,
  saveDataset,
  readLatestDataset,
  readDatasetHistory,
  readDatasetByFileName,
  deleteDatasetByFileName,
  normalizeDatasetFileName,
  resetLatestDataset,
  removeLatestDataset,
  fileExists,
};
