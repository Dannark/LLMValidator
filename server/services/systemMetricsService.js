const os = require('os');
const { execFileSync } = require('child_process');

function mb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function getMemoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: mb(total),
    usedMb: mb(used),
    freeMb: mb(free),
    usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
  };
}

function getGpuMetrics() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      [
        '--query-gpu=memory.used,memory.total,name',
        '--format=csv,noheader,nounits',
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
    );
    const lines = out
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const gpus = lines.map((line) => {
      const parts = line.split(',').map((p) => p.trim());
      const usedMb = Number(parts[0]);
      const totalMb = Number(parts[1]);
      const name = parts.slice(2).join(',') || 'GPU';
      return {
        name,
        usedMb: Number.isFinite(usedMb) ? Math.round(usedMb * 10) / 10 : null,
        totalMb: Number.isFinite(totalMb) ? Math.round(totalMb * 10) / 10 : null,
        usagePercent:
          Number.isFinite(usedMb) && Number.isFinite(totalMb) && totalMb > 0
            ? Math.round((usedMb / totalMb) * 1000) / 10
            : null,
      };
    });
    return gpus.length > 0 ? gpus : null;
  } catch {
    return null;
  }
}

function getSystemMetrics() {
  const load = os.loadavg();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    cpus: os.cpus().length,
    loadavg: {
      '1m': Math.round(load[0] * 100) / 100,
      '5m': Math.round(load[1] * 100) / 100,
      '15m': Math.round(load[2] * 100) / 100,
    },
    memory: getMemoryMetrics(),
    gpus: getGpuMetrics(),
    collectedAt: new Date().toISOString(),
  };
}

module.exports = {
  getSystemMetrics,
};
