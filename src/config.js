import fs from 'node:fs';
import path from 'node:path';

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function getFrameDelayMs() {
  // Preference order: config.json > ENV FRAME_DELAY_MS > default 120
  const cwd = process.cwd();
  const cfgPath = path.resolve(cwd, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const fromCfg = Number(cfg.frameDelayMs);
  if (!Number.isNaN(fromCfg) && fromCfg > 0) return fromCfg;
  const fromEnv = Number(process.env.FRAME_DELAY_MS);
  if (!Number.isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return 120;
}
