import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import GIFEncoder from 'gif-encoder-2';
import { logDebug } from './logger.js';

// Purpose: Build an animated GIF from 4 images in ping-pong order.
// Inputs: images (Buffer[]), width/height (optional, default based on first image), frameDelayMs.
// Output: Buffer of GIF data.
export async function buildGifPingPong(imageBuffers, opts = {}) {
  if (!Array.isArray(imageBuffers) || imageBuffers.length !== 4) {
    throw new Error('buildGifPingPong requires exactly 4 frames');
  }
  const frameDelayMs = opts.frameDelayMs ?? Number(process.env.FRAME_DELAY_MS ?? 120);

  // Normalize frames to a consistent size using sharp
  const metas = await Promise.all(imageBuffers.map(async (buf) => sharp(buf).metadata()));
  const targetW = opts.width ?? metas[0]?.width ?? 640;
  const targetH = opts.height ?? metas[0]?.height ?? 480;

  // Build ping-pong sequence: 1,2,3,4,3,2
  const order = [0, 1, 2, 3, 2, 1];
  const encoder = new GIFEncoder(targetW, targetH); // algorithm defaults to 'neuquant'
  encoder.start();
  encoder.setRepeat(0); // loop forever
  encoder.setDelay(frameDelayMs);
  encoder.setQuality(10);

  for (const idx of order) {
    // Convert to raw RGBA for encoder directly from original buffers
    const { data, info } = await sharp(imageBuffers[idx])
      .rotate(180)
      .resize(targetW, targetH, { fit: 'cover' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!data) throw new Error(`Frame ${idx} produced no data buffer`);
    if (!info || info.channels !== 4 || info.width !== targetW || info.height !== targetH) {
      throw new Error(`Unexpected frame shape for index ${idx}: ${info?.width}x${info?.height}x${info?.channels}`);
    }
    const expected = targetW * targetH * 4;
    if (data.length !== expected) {
      throw new Error(`Frame ${idx} buffer size mismatch: got ${data.length}, expected ${expected}`);
    }
    const frameBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const frameArr = new Uint8ClampedArray(frameBuf);
    logDebug(`Adding frame idx=${idx} size=${frameBuf.length} type=${frameArr.constructor.name}`);
    try {
      encoder.addFrame(frameArr);
    } catch (e) {
      throw new Error(`addFrame failed for index ${idx}: ${e?.message || e}`);
    }
  }

  encoder.finish();
  const gifBuffer = encoder.out.getData();
  if (!gifBuffer || !gifBuffer.length) {
    throw new Error('Encoder produced empty GIF buffer');
  }
  logDebug(`GIF built with ${order.length} frames at ${targetW}x${targetH}`);
  return gifBuffer;
}

export async function saveUniqueGif(buffer, baseName, outDir) {
  // Purpose: Persist GIF buffer to disk with unique name.
  // Inputs: buffer (Buffer), baseName without extension, outDir directory.
  if (!outDir) throw new Error('Output directory is required');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let filename = `${baseName}.gif`;
  let filePath = path.join(outDir, filename);
  let suffix = 1;
  while (fs.existsSync(filePath)) {
    filename = `${baseName}_${suffix++}.gif`;
    filePath = path.join(outDir, filename);
  }
  fs.writeFileSync(filePath, buffer);
  return filePath;
}
