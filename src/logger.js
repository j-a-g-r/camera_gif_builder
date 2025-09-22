import fs from 'node:fs';
import path from 'node:path';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const level = process.env.LOG_LEVEL || 'info';
const levelNum = LOG_LEVELS[level] ?? LOG_LEVELS.info;

function ts() {
  return new Date().toISOString();
}

export function logInfo(msg) {
  if (levelNum >= LOG_LEVELS.info) console.log(`[INFO] ${ts()} ${msg}`);
}
export function logWarn(msg) {
  if (levelNum >= LOG_LEVELS.warn) console.warn(`[WARN] ${ts()} ${msg}`);
}
export function logDebug(msg) {
  if (levelNum >= LOG_LEVELS.debug) console.log(`[DEBUG] ${ts()} ${msg}`);
}
export function logError(msg) {
  if (levelNum >= LOG_LEVELS.error) console.error(`[ERROR] ${ts()} ${msg}`);
}

export function writeJsonLog(entry, outDir = 'output') {
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, 'results.log');
    fs.appendFileSync(base, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error(`[ERROR] ${ts()} Failed to write JSON log:`, e);
  }
}
