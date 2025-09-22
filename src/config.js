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

export function getStabilizeEnabled() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const v = cfg.stabilize;
  if (typeof v === 'boolean') return v;
  if (process.env.STABILIZE === '0' || process.env.STABILIZE === 'false') return false;
  if (process.env.STABILIZE === '1' || process.env.STABILIZE === 'true') return true;
  return true; // default on
}

export function getMaxShiftPx() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const v = Number(cfg.maxShiftPx);
  if (!Number.isNaN(v) && v >= 0 && v <= 50) return v;
  const e = Number(process.env.MAX_SHIFT_PX);
  if (!Number.isNaN(e) && e >= 0 && e <= 50) return e;
  return 6; // default ±6px search
}

export function getCropPercent() {
  const cfgPath = path.resolve(process.cwd(), 'config.json');
  const cfg = fs.existsSync(cfgPath) ? readJson(cfgPath) : {};
  const v = Number(cfg.cropPercent);
  if (!Number.isNaN(v) && v >= 0 && v <= 0.3) return v; // cap to 30%
  const e = Number(process.env.CROP_PERCENT);
  if (!Number.isNaN(e) && e >= 0 && e <= 0.3) return e;
  return 0.05; // default 5% inward crop
}
