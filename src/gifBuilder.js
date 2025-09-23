import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import GIFEncoder from 'gif-encoder-2';
import { logDebug } from './logger.js';
import { getFrameDelayMs } from './config.js';
import { getStabilizeEnabled, getMaxShiftPx, getCropPercent, getAutoBorderDetect, getAlphaThreshold, getBlackThreshold, getAutoBorderMarginPx } from './config.js';

// Purpose: Build an animated GIF from 4 images in ping-pong order.
// Inputs: images (Buffer[]), width/height (optional, default based on first image), frameDelayMs.
// Output: Buffer of GIF data.
export async function buildGifPingPong(imageBuffers, opts = {}) {
  if (!Array.isArray(imageBuffers) || imageBuffers.length !== 4) {
    throw new Error('buildGifPingPong requires exactly 4 frames');
  }
  const frameDelayMs = opts.frameDelayMs ?? getFrameDelayMs();

  // Normalize frames to a consistent size using sharp
  const metas = await Promise.all(imageBuffers.map(async (buf) => sharp(buf).metadata()));
  const targetW = opts.width ?? metas[0]?.width ?? 640;
  const targetH = opts.height ?? metas[0]?.height ?? 480;

  // Preprocess: rotate 180 and resize to target using cover, keep as PNG for compositing
  const preFramesPng = await Promise.all(
    imageBuffers.map(async (buf) =>
      sharp(buf).rotate(180).resize(targetW, targetH, { fit: 'cover' }).png().toBuffer()
    )
  );

  // Stabilization parameters
  const stabilize = getStabilizeEnabled();
  const maxShift = getMaxShiftPx();
  const cropPercent = getCropPercent();

  // Compute translational offsets via simple SAD search on downscaled grayscale images
  let offsetsWork = [ {dx:0,dy:0}, {dx:0,dy:0}, {dx:0,dy:0}, {dx:0,dy:0} ];
  let scaleX = 1, scaleY = 1;
  let padX = 0, padY = 0; // per-axis padding for compositing
  let offsets = [ {dx:0,dy:0}, {dx:0,dy:0}, {dx:0,dy:0}, {dx:0,dy:0} ];
  if (stabilize) {
    const workW = 320;
    const workH = Math.max(120, Math.round((workW / targetW) * targetH));
    scaleX = targetW / workW;
    scaleY = targetH / workH;
    logDebug(`Stabilizer scales: work=${workW}x${workH} target=${targetW}x${targetH} scaleX=${scaleX.toFixed(2)} scaleY=${scaleY.toFixed(2)}`);

    async function toGray(buf) {
      const { data, info } = await sharp(buf).grayscale().resize(workW, workH).raw().toBuffer({ resolveWithObject: true });
      return { data, w: info.width, h: info.height };
    }

    const grayFrames = await Promise.all(preFramesPng.map(toGray));
    const ref = grayFrames[0]; // use first frame as reference
    const marginX = Math.floor(ref.w * 0.1);
    const marginY = Math.floor(ref.h * 0.1);

    function sadAt(a, b, dx, dy) {
      // Compute SAD over overlapping region of a vs b shifted by (dx,dy)
      const x0 = Math.max(marginX, marginX + dx);
      const y0 = Math.max(marginY, marginY + dy);
      const x1 = Math.min(a.w - marginX, b.w - marginX + dx);
      const y1 = Math.min(a.h - marginY, b.h - marginY + dy);
      if (x1 <= x0 || y1 <= y0) return Number.POSITIVE_INFINITY;
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const ay = y * a.w;
        const by = (y - dy) * b.w;
        for (let x = x0; x < x1; x++) {
          const ax = ay + x;
          const bx = by + (x - dx);
          const d = a.data[ax] - b.data[bx];
          sum += d >= 0 ? d : -d;
        }
      }
      return sum / ((x1 - x0) * (y1 - y0));
    }

    for (let i = 1; i < 4; i++) {
      let best = { dx: 0, dy: 0, score: Number.POSITIVE_INFINITY };
      const b = grayFrames[i];
      for (let dy = -maxShift; dy <= maxShift; dy++) {
        for (let dx = -maxShift; dx <= maxShift; dx++) {
          const s = sadAt(ref, b, dx, dy);
          if (s < best.score) best = { dx, dy, score: s };
        }
      }
      offsetsWork[i] = { dx: best.dx, dy: best.dy };
      logDebug(`Stabilize(work): frame ${i} best dx=${best.dx} dy=${best.dy} score=${best.score.toFixed(2)}`);
    }
    // Scale offsets to target resolution and compute padding
    let maxAbsX = 0, maxAbsY = 0;
    for (let i = 0; i < 4; i++) {
      const dxFull = Math.round(offsetsWork[i].dx * scaleX);
      const dyFull = Math.round(offsetsWork[i].dy * scaleY);
      offsets[i] = { dx: dxFull, dy: dyFull };
      if (Math.abs(dxFull) > maxAbsX) maxAbsX = Math.abs(dxFull);
      if (Math.abs(dyFull) > maxAbsY) maxAbsY = Math.abs(dyFull);
    }
    const minPadX = Math.ceil(maxShift * scaleX);
    const minPadY = Math.ceil(maxShift * scaleY);
    padX = Math.max(minPadX, maxAbsX);
    padY = Math.max(minPadY, maxAbsY);
    logDebug(`Stabilize(target): offsets=${offsets.map(o=>`(${o.dx},${o.dy})`).join(' ')} padX=${padX} padY=${padY}`);
  }

  // Compute additional crop in pixels (user-defined) beyond stabilization margin (use max axis)
  const baseCropPx = Math.round(Math.min(targetW, targetH) * cropPercent);
  const finalCropPx = Math.max(0, baseCropPx) + (stabilize ? Math.max(padX, padY) : 0);

  // Apply shifts and crop to eliminate borders introduced by stabilization and intentional crop
  const origin = finalCropPx; // extract from this offset after padding
  let croppedW = targetW - 2 * finalCropPx;
  let croppedH = targetH - 2 * finalCropPx;
  if (croppedW < 16 || croppedH < 16) {
    // Ensure minimum viable size
    const minSize = 16;
    croppedW = Math.max(minSize, croppedW);
    croppedH = Math.max(minSize, croppedH);
  }

  async function stabilizeAndCrop(pngBuf, dx, dy) {
    if (!stabilize) {
      // Just crop inwards a bit if requested
      const img = sharp(pngBuf);
      const out = await img
        .extract({ left: finalCropPx, top: finalCropPx, width: croppedW, height: croppedH })
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });
      return out;
    }
    // Use extend() to pad image asymmetrically according to shift, then extract
    const leftExt = Math.max(0, padX + Math.round(dx));
    const topExt = Math.max(0, padY + Math.round(dy));
    const rightExt = Math.max(0, padX - Math.round(dx));
    const bottomExt = Math.max(0, padY - Math.round(dy));
    const extW = targetW + leftExt + rightExt;
    const extH = targetH + topExt + bottomExt;
    logDebug(`Extend: L=${leftExt} T=${topExt} R=${rightExt} B=${bottomExt} -> ${extW}x${extH}; Extract: origin=${origin} size=${croppedW}x${croppedH}`);
    const extended = sharp(pngBuf)
      .extend({ top: topExt, left: leftExt, right: rightExt, bottom: bottomExt, background: { r:0,g:0,b:0,alpha:0 } });
    const out = await extended
      .extract({ left: origin, top: origin, width: croppedW, height: croppedH })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    return out;
  }

  const processedFrames = [];
  for (let i = 0; i < 4; i++) {
    const { data, info } = await stabilizeAndCrop(preFramesPng[i], offsets[i].dx, offsets[i].dy);
    if (!data || !data.length) throw new Error(`Stabilization produced empty buffer for frame ${i}`);
    processedFrames.push({ data, info });
  }

  // Optional auto-cropping to remove black/transparent borders across all frames
  let encW = processedFrames[0].info.width;
  let encH = processedFrames[0].info.height;
  if (getAutoBorderDetect()) {
    const alphaT = getAlphaThreshold();
    const blackT = getBlackThreshold();
    const margin = getAutoBorderMarginPx();
    // Determine tight bounding box common to all frames where pixels are not black/transparent
  // Track per-frame bounds, then intersect
  let maxLeft = 0, maxTop = 0, minRight = encW - 1, minBottom = encH - 1;
    for (const { data } of processedFrames) {
      const w = encW, h = encH;
      // Scan top
      let top = 0;
      for (; top < h; top++) {
        let rowHasContent = false;
        for (let x = 0; x < w; x++) {
          const i = (top * w + x) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (a > alphaT && (r > blackT || g > blackT || b > blackT)) { rowHasContent = true; break; }
        }
        if (rowHasContent) break;
      }
      // Scan bottom
      let bottom = h - 1;
      for (; bottom >= 0; bottom--) {
        let rowHasContent = false;
        for (let x = 0; x < w; x++) {
          const i = (bottom * w + x) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (a > alphaT && (r > blackT || g > blackT || b > blackT)) { rowHasContent = true; break; }
        }
        if (rowHasContent) break;
      }
      // Scan left
      let left = 0;
      for (; left < w; left++) {
        let colHasContent = false;
        for (let y = 0; y < h; y++) {
          const i = (y * w + left) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (a > alphaT && (r > blackT || g > blackT || b > blackT)) { colHasContent = true; break; }
        }
        if (colHasContent) break;
      }
      // Scan right
      let right = w - 1;
      for (; right >= 0; right--) {
        let colHasContent = false;
        for (let y = 0; y < h; y++) {
          const i = (y * w + right) * 4;
          const a = data[i + 3];
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (a > alphaT && (r > blackT || g > blackT || b > blackT)) { colHasContent = true; break; }
        }
        if (colHasContent) break;
      }
      maxLeft = Math.max(maxLeft, left);
      maxTop = Math.max(maxTop, top);
      minRight = Math.min(minRight, right);
      minBottom = Math.min(minBottom, bottom);
    }

    if (minRight >= maxLeft && minBottom >= maxTop) {
      // Apply inward margin to avoid touching content edges
      const leftI = Math.max(0, maxLeft + margin);
      const topI = Math.max(0, maxTop + margin);
      const rightI = Math.min(encW - 1, minRight - margin);
      const bottomI = Math.min(encH - 1, minBottom - margin);
      const cropW = Math.max(1, rightI - leftI + 1);
      const cropH = Math.max(1, bottomI - topI + 1);
      if (cropW >= 8 && cropH >= 8 && (cropW !== encW || cropH !== encH)) {
        logDebug(`Auto-crop (intersection) to remove borders: left=${leftI} top=${topI} right=${rightI} bottom=${bottomI} -> ${cropW}x${cropH}`);
        for (let i = 0; i < processedFrames.length; i++) {
          const { data, info } = processedFrames[i];
          const w = encW, h = encH;
          const out = Buffer.alloc(cropW * cropH * 4);
          for (let y = 0; y < cropH; y++) {
            const srcY = topI + y;
            const srcStart = (srcY * w + leftI) * 4;
            const dstStart = y * cropW * 4;
            data.copy(out, dstStart, srcStart, srcStart + cropW * 4);
          }
          processedFrames[i] = { data: out, info: { ...info, width: cropW, height: cropH } };
        }
        encW = cropW; encH = cropH;
      }
    }
  }

  // Build ping-pong sequence: 1,2,3,4,3,2
  const order = [0, 1, 2, 3, 2, 1];
  const encoder = new GIFEncoder(encW, encH); // defaults to 'neuquant'
  encoder.start();
  encoder.setRepeat(0); // loop forever
  encoder.setDelay(frameDelayMs);
  encoder.setQuality(10);

  for (const idx of order) {
    const { data, info } = processedFrames[idx];
    if (!data) throw new Error(`Frame ${idx} produced no data buffer`);
    if (!info || info.channels !== 4 || info.width !== encW || info.height !== encH) {
      throw new Error(`Unexpected frame shape for index ${idx}: ${info?.width}x${info?.height}x${info?.channels}`);
    }
    const expected = encW * encH * 4;
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
