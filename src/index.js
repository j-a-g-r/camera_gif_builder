import 'dotenv/config';
import PocketBase from 'pocketbase';
import path from 'node:path';
import fs from 'node:fs';
import EventSource from 'eventsource';
import { buildGifPingPong } from './gifBuilder.js';
import { logInfo, logWarn, logError, logDebug, writeJsonLog } from './logger.js';
import { getFrameDelayMs } from './config.js';
import { uploadGifRecord } from './pocketbaseClient.js';

const POCKETBASE_URL = process.env.POCKETBASE_URL || 'https://cameradb.jakobgrote.de';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.resolve('output');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5000);
const FRAME_DELAY_MS = getFrameDelayMs();
const DEVICES = ['esp32s3cam-01', 'esp32s3cam-02', 'esp32s3cam-03', 'esp32s3cam-04'];

// Conceptual steps this script performs:
// - Listen to real-time `create` events from `captures`.
// - Group incoming entries by a time window: start at first record's timestamp and allow up to TIMEOUT_MS (default 5s) for all 4 devices.
// - When a group's device set is complete (all 4), fetch images.
// - Build a ping-pong GIF (1→4→1), save under output/ with unique name.
// - Log JSON result per attempt; on timeout or error, log accordingly.

// Polyfill EventSource for Node.js environment
if (typeof globalThis.EventSource === 'undefined') {
  globalThis.EventSource = EventSource;
}

const pb = new PocketBase(POCKETBASE_URL);

// In-memory grouping state: key => { firstTs, deadline, recordsByDevice, order }
const groups = new Map();
const errorWindowMs = 60000; // 60s window for persistent error detection
let recentErrors = [];

function ensureGroup(key, firstRecord) {
  if (!groups.has(key)) {
    groups.set(key, {
      firstTs: new Date(firstRecord.created).toISOString(),
      deadline: Date.now() + TIMEOUT_MS,
      recordsByDevice: new Map(),
      order: [], // keep arrival order for frame sequence
    });
  }
  return groups.get(key);
}

function findAssignableGroup(rec) {
  // Choose an existing time-based group whose window includes rec.created and doesn't yet have this device.
  const createdMs = new Date(rec.created).getTime();
  let chosenKey = null;
  for (const [key, g] of groups.entries()) {
    const startMs = new Date(g.firstTs).getTime();
    if (createdMs >= startMs && createdMs <= startMs + TIMEOUT_MS && !g.recordsByDevice.has(rec.device_id)) {
      chosenKey = key;
      break;
    }
  }
  return chosenKey;
}

function assignToGroup(rec) {
  let key = findAssignableGroup(rec);
  if (!key) {
    key = `time:${new Date(rec.created).toISOString()}`;
    ensureGroup(key, rec);
  }
  const group = groups.get(key);
  // If group already expired, reset it anchored to this record's timestamp
  if (!withinWindow(group)) {
    groups.set(key, {
      firstTs: new Date(rec.created).toISOString(),
      deadline: Date.now() + TIMEOUT_MS,
      recordsByDevice: new Map(),
      order: [],
    });
  }
  const g = groups.get(key);
  g.recordsByDevice.set(rec.device_id, rec);
  if (!g.order.includes(rec.device_id)) g.order.push(rec.device_id);
  return { key, group: g };
}

function isComplete(group) {
  return DEVICES.every((d) => group.recordsByDevice.has(d));
}

function withinWindow(group) {
  return Date.now() <= group.deadline;
}

async function fetchImageBuffer(record) {
  // Purpose: Fetch image binary for a capture record.
  // Required inputs: record with `collectionId` or collectionName 'captures', id, and file field `image`.
  const { id, collectionId, collectionName, image } = record;
  if (!image) throw new Error(`Record ${id} has no image field`);
  const url = pb.files.getUrl(record, image, { thumb: undefined });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

function finalizeTimeouts() {
  const now = Date.now();
  for (const [key, group] of [...groups.entries()]) {
    if (now > group.deadline && !isComplete(group)) {
      // timeout
      const record_ids = [...group.recordsByDevice.values()].map((r) => r.id);
      const device_ids = [...group.recordsByDevice.keys()];
      const logEntry = {
        timestamp_group: group.firstTs,
        record_ids,
        device_ids,
        gif_path: null,
        status: 'timeout',
      };
      writeJsonLog(logEntry, OUTPUT_DIR);
      logWarn(`Timeout for group ${key}: got ${device_ids.length}/4 devices`);
      groups.delete(key);
    }
  }
}

async function tryProcessGroup(key) {
  const group = groups.get(key);
  if (!group) return;

  if (!isComplete(group)) return; // wait for completeness

  // We have all 4; capture and clear group early to avoid duplicates
  groups.delete(key);

  const orderedRecords = DEVICES.map((d) => group.recordsByDevice.get(d));
  const record_ids = orderedRecords.map((r) => r.id);
  const device_ids = DEVICES;
  const ts = group.firstTs;

  function fmtParts(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const mm = pad(d.getUTCMonth() + 1);
    const dd = pad(d.getUTCDate());
    const HH = pad(d.getUTCHours());
    const MM = pad(d.getUTCMinutes());
    const SS = pad(d.getUTCSeconds());
    return {
      idStamp: `${yyyy}${mm}${dd}${HH}${MM}${SS}`,
      pretty: `${yyyy}${mm}${dd}_${HH}${MM}${SS}`,
    };
  }

  // State the next operation purpose and minimal inputs
  logInfo('Fetching 4 image files (purpose: build GIF). Inputs: record ids and file names.');

  try {
    const bufs = [];
    for (const r of orderedRecords) {
      const b = await fetchImageBuffer(r);
      if (!b || !b.length) throw new Error(`Empty buffer for record ${r.id}`);
      bufs.push(b);
    }
    // Validation
    logInfo(`Fetched ${bufs.length} images. Validation: all buffers non-empty.`);

    logInfo('Building GIF (purpose: assemble ping-pong animation). Inputs: 4 image buffers, frame delay.');
  const gifBuffer = await buildGifPingPong(bufs, { frameDelayMs: FRAME_DELAY_MS });
    if (!gifBuffer || !gifBuffer.length) throw new Error('GIF build produced empty buffer');
    logInfo('GIF built successfully. Validation: non-empty buffer.');

  const { idStamp, pretty } = fmtParts(ts);
  const baseName = `gif_${idStamp}_${pretty}`; // gif_{timestamp}_{YYYYMMDD_HHMMSS}
    logInfo('Uploading GIF (purpose: persist to PocketBase). Inputs: GIF buffer, filename.');
    const created = await uploadGifRecord(pb, gifBuffer, `${baseName}.gif`);
    const fileName = created?.gif;
    if (!created?.id || !fileName) throw new Error('Upload did not return a valid record');

    const logEntry = {
      timestamp_group: ts,
      record_ids,
      device_ids,
      gif_record: { id: created.id, collectionId: created.collectionId, collectionName: created.collectionName, file: fileName },
      status: 'created',
    };
    writeJsonLog(logEntry, OUTPUT_DIR);
    logInfo(`Uploaded GIF to PocketBase gifs collection with id=${created.id}`);
  } catch (err) {
    // Track persistent errors in sliding window
    const now = Date.now();
    recentErrors.push(now);
    recentErrors = recentErrors.filter((t) => now - t <= errorWindowMs);
    if (recentErrors.length >= 3) {
      logWarn('ALERT: Persistent failures detected (>=3 errors in the last 60s). Investigate connectivity or storage.');
    }
    const logEntry = {
      timestamp_group: ts,
      record_ids,
      device_ids,
      gif_path: null,
      status: 'error',
      error: {
        message: err?.message || String(err),
        stack: err?.stack,
      },
    };
    writeJsonLog(logEntry, OUTPUT_DIR);
    logError(`Error processing group ${key}: ${err?.message}`);
  }
}

function scheduleTimeoutSweep() {
  setInterval(finalizeTimeouts, 500);
}

async function main() {
  logInfo('Starting PocketBase GIF listener...');
  logInfo(`Connecting to ${POCKETBASE_URL}`);

  // Optional authentication (admin) if credentials are provided via env
  const adminEmail = process.env.POCKETBASE_ADMIN_EMAIL;
  const adminPassword = process.env.POCKETBASE_ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    try {
      await pb.admins.authWithPassword(adminEmail, adminPassword);
      logInfo('Authenticated to PocketBase as admin.');
    } catch (e) {
      logWarn(`Admin auth failed: ${e?.message || e}`);
    }
  }

  // Real-time subscription: only new records
  await pb.collection('captures').subscribe('*', async (e) => {
    if (e.action !== 'create') return; // Out of scope: updates/deletes

    const rec = e.record;
    // Basic validation and scoping
    if (!DEVICES.includes(rec.device_id)) return; // ignore other devices

    const { key, group } = assignToGroup(rec);

    logDebug(`Event received: key=${key} devices=${[...group.recordsByDevice.keys()].join(',')}`);

    // Validate completeness and process
    if (isComplete(group)) {
      await tryProcessGroup(key);
    }
  });

  scheduleTimeoutSweep();
}

main().catch((err) => {
  logError(`Fatal error: ${err?.message}`);
  process.exit(1);
});
