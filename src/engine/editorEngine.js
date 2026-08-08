// Canvas-based frame editor engine.
// All edits operate on an offscreen ImageData buffer per frame.
// Supports: brush (transparent-capable), eraser, fill, color-replace (flood + tolerance),
// rectangle, ellipse, soften (blur), adjust (brightness/contrast/saturation).

export function hexToRgba(hex, alpha = 1) {
  let h = hex.replace('#', '');
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b, Math.round(alpha * 255)];
  }
  if (h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = parseInt(h.slice(6, 8), 16) / 255;
    return [r, g, b, Math.round(a * 255)];
  }
  return [0, 0, 0, Math.round(alpha * 255)];
}

export function rgbaToHex(r, g, b, a = 255) {
  const to = (v) => v.toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}${to(a)}`;
}

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return [128, 128, 128];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function colorDistance(c1, c2) {
  // weighted euclidean
  const rm = (c1[0] + c2[0]) / 2;
  const dr = c1[0] - c2[0];
  const dg = c1[1] - c2[1];
  const db = c1[2] - c2[2];
  return Math.sqrt(
    (2 + rm / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rm) / 256) * db * db
  );
}

// Flood-fill selection by tolerance, returns set of pixel indices (x,y on width)
function floodSelect(data, w, h, sx, sy, tol) {
  const idx = (x, y) => (y * w + x) * 4;
  const start = idx(sx, sy);
  const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
  const visited = new Uint8Array(w * h);
  const stack = [[sx, sy]];
  const selected = [];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const li = y * w + x;
    if (visited[li]) continue;
    visited[li] = 1;
    const p = idx(x, y);
    const cur = [data[p], data[p + 1], data[p + 2], data[p + 3]];
    if (colorDistance(cur, target) > tol) continue;
    selected.push([x, y]);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return selected;
}

// Pick "un-premultiplied" source color at click point. The click may land on an
// anti-aliased edge of the source region (e.g. red bleeding into character outline).
// We estimate the true source color by un-premultiplying against alpha, so that
// semi-transparent edge pixels still match and get replaced.
//
// To be robust against clicking on an already-cleared area (e.g. running replace
// twice on the same frame), we search a small window around the click and pick
// the pixel with the highest alpha — that's most likely to be the "true" source.
function pickSourceColor(data, x, y, w, h) {
  const radius = 6;
  let best = null;
  let bestA = -1;
  const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
  const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const p = (yy * w + xx) * 4;
      const a = data[p + 3];
      if (a <= bestA) continue;
      bestA = a;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      if (a === 0 || a === 255) {
        best = [r, g, b, a];
      } else {
        const ar = a / 255;
        best = [
          Math.min(255, Math.round(r / ar)),
          Math.min(255, Math.round(g / ar)),
          Math.min(255, Math.round(b / ar)),
          a,
        ];
      }
    }
  }
  if (!best) {
    // window was outside image or all-zero alpha — fall back to single-pixel read
    const p = Math.max(0, Math.min(data.length - 4, (y * w + x) * 4));
    best = [data[p], data[p + 1], data[p + 2], data[p + 3]];
  }
  return best;
}

// Scan the entire image for pixels matching target color within tolerance.
// Uses un-premultiplied source comparison so anti-aliased edges are included.
// Returns array of [x, y] positions.
function globalSelectByColor(data, w, h, targetRgba, tol) {
  const selected = [];
  const total = w * h;
  const [tr, tg, tb, ta] = targetRgba;
  // If the picked source alpha is low (transparent edge), also allow matching
  // pixels whose un-premultiplied color matches, regardless of their own alpha.
  const sourceAlpha = ta / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      // Compute candidate's un-premultiplied color (or fall back to raw if opaque)
      const pxA = a > 0 ? a / 255 : 1;
      const ur = a > 0 ? Math.min(255, Math.round(r / pxA)) : r;
      const ug = a > 0 ? Math.min(255, Math.round(g / pxA)) : g;
      const ub = a > 0 ? Math.min(255, Math.round(b / pxA)) : b;
      // Match against (tr,tg,tb,ta) — distance ignores alpha by treating both as opaque here
      const dist = colorDistance([ur, ug, ub, 255], [tr, tg, tb, 255]);
      if (dist > tol) continue;
      // Also require the candidate's alpha to be in a similar "background-ish" range:
      // if source is opaque, match any pixel regardless of its own alpha;
      // if source is transparent/edge, only match pixels with low alpha (background bleed).
      if (sourceAlpha < 1 && (a / 255) > 0.95) continue;
      selected.push([x, y]);
    }
  }
  return selected;
}

// Main engine class
export class FrameEditor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.imageData = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  loadImageData(imgData) {
    this.imageData = new ImageData(
      new Uint8ClampedArray(imgData.data),
      imgData.width,
      imgData.height
    );
    this.undoStack = [];
    this.redoStack = [];
    this.syncCanvas();
  }

  // Replace the current imageData with another (used by "restore" button).
  applyData(imgData) {
    this.imageData = new ImageData(
      new Uint8ClampedArray(imgData.data),
      imgData.width,
      imgData.height
    );
    this.syncCanvas();
  }

  // 在当前画布上取点击点附近的源色（供批量换色记录，确保重放时复用固定源色）。
  pickSourceColor(x, y) {
    if (!this.imageData) return null;
    const { width: w, height: h, data } = this.imageData;
    return pickSourceColor(data, Math.round(x), Math.round(y), w, h);
  }

  setSize(w, h) {
    this.canvas.width = w;
    this.canvas.height = h;
  }

  syncCanvas() {
    if (!this.imageData) return;
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  snapshot() {
    if (!this.imageData) return;
    this.undoStack.push(new Uint8ClampedArray(this.imageData.data));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(new Uint8ClampedArray(this.imageData.data));
    this.imageData.data.set(this.undoStack.pop());
    this.syncCanvas();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(new Uint8ClampedArray(this.imageData.data));
    this.imageData.data.set(this.redoStack.pop());
    this.syncCanvas();
  }

  // pixel coords -> buffer index
  px(x, y) {
    return (y * this.imageData.width + x) * 4;
  }

  // BRESENHAM line between two points with a brush
  drawLine(x0, y0, x1, y1, color, size, mode) {
    const w = this.imageData.width;
    const h = this.imageData.height;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0;
    let cy = y0;
    const radius = size / 2;
    while (true) {
      this.stamp(cx, cy, radius, color, mode);
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
    this.syncCanvas();
  }

  // stamp a soft/round brush at x,y in image pixels
  stamp(cx, cy, radius, color, mode) {
    const w = this.imageData.width;
    const h = this.imageData.height;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(w - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(h - 1, Math.ceil(cy + radius));
    const [cr, cg, cb, ca] = color;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 > r2) continue;
        // soft edge falloff
        const falloff = radius > 0 ? 1 - Math.sqrt(d2) / (radius + 0.0001) : 1;
        const fall = Math.min(1, falloff);
        const p = this.px(x, y);
        if (mode === 'eraser') {
          // erase toward transparent (ignore color)
          const na = this.imageData.data[p + 3] * (1 - fall);
          this.imageData.data[p + 3] = na;
        } else if (ca === 0) {
          // 透明色画笔：把该区域像素完全设为透明
          this.imageData.data[p + 3] = 0;
        } else {
          const srcA = this.imageData.data[p + 3] / 255;
          const ta = (ca / 255) * fall;
          const outA = ta + srcA * (1 - ta);
          this.imageData.data[p] = (cr * ta + this.imageData.data[p] * srcA * (1 - ta)) / outA;
          this.imageData.data[p + 1] = (cg * ta + this.imageData.data[p + 1] * srcA * (1 - ta)) / outA;
          this.imageData.data[p + 2] = (cb * ta + this.imageData.data[p + 2] * srcA * (1 - ta)) / outA;
          this.imageData.data[p + 3] = outA * 255;
        }
      }
    }
  }

  // flood fill at point (image coords)
  fillAt(x, y, color, tolerance = 0) {
    const w = this.imageData.width;
    const h = this.imageData.height;
    const data = this.imageData.data;
    const sel = floodSelect(data, w, h, x, y, tolerance);
    const [cr, cg, cb, ca] = color;
    if (ca === 0) {
      // 透明色填充：把选中区域 alpha 直接清零（完全透明）
      for (const [px, py] of sel) {
        data[this.px(px, py) + 3] = 0;
      }
      this.syncCanvas();
      return sel.length;
    }
    for (const [px, py] of sel) {
      const p = this.px(px, py);
      const srcA = data[p + 3] / 255;
      const ta = ca / 255;
      const outA = ta + srcA * (1 - ta);
      data[p] = (cr * ta + data[p] * srcA * (1 - ta)) / outA;
      data[p + 1] = (cg * ta + data[p + 1] * srcA * (1 - ta)) / outA;
      data[p + 2] = (cb * ta + data[p + 2] * srcA * (1 - ta)) / outA;
      data[p + 3] = outA * 255;
    }
    this.syncCanvas();
    return sel.length;
  }

  // color replace: pick color at (x,y) (un-premultiplied), scan entire image
  // for matching pixels (within tolerance). This is the correct semantics for
  // "globally replace this color across the image" — unlike a flood fill it
  // doesn't require the source region to remain connected. Re-applying the
  // tool on the same color keeps working since the source color is detected
  // from the original frame's last untouched region.
  //
  // Optionally accepts a pre-picked `sourceColor` so batch apply can re-use the
  // color picked from the active frame across all target frames (no need to
  // re-pick from each frame, which fails when some frames have already had the
  // source region knocked out).
  replaceColorAt(x, y, newColor, tolerance = 18, sourceColor = null) {
    const w = this.imageData.width;
    const h = this.imageData.height;
    const data = this.imageData.data;
    const picked = sourceColor || pickSourceColor(data, x, y, w, h);
    const sel = globalSelectByColor(data, w, h, picked, tolerance);
    const [cr, cg, cb, ca] = newColor;
    if (ca === 0) {
      // 透明色换色（抠图）：选中区域 alpha 直接清零，保留 RGB，
      // 这样其它图层叠上来时不会因为 RGB 不清导致视觉残留。
      for (const [px, py] of sel) {
        data[(py * w + px) * 4 + 3] = 0;
      }
      this.syncCanvas();
      return sel.length;
    }
    for (const [px, py] of sel) {
      const p = (py * w + px) * 4;
      const srcA = data[p + 3] / 255;
      const ta = ca / 255;
      const outA = ta + srcA * (1 - ta);
      data[p] = (cr * ta + data[p] * srcA * (1 - ta)) / outA;
      data[p + 1] = (cg * ta + data[p + 1] * srcA * (1 - ta)) / outA;
      data[p + 2] = (cb * ta + data[p + 2] * srcA * (1 - ta)) / outA;
      data[p + 3] = outA * 255;
    }
    this.syncCanvas();
    return sel.length;
  }

  // preview color replace (returns new imagedata without committing)
  previewReplace(x, y, newColor, tolerance = 18, sourceColor = null) {
    const w = this.imageData.width;
    const h = this.imageData.height;
    const data = this.imageData.data;
    const picked = sourceColor || pickSourceColor(data, x, y, w, h);
    const sel = globalSelectByColor(data, w, h, picked, tolerance);
    const clone = new Uint8ClampedArray(data);
    const [cr, cg, cb, ca] = newColor;
    if (ca === 0) {
      for (const [px, py] of sel) {
        clone[(py * w + px) * 4 + 3] = 0;
      }
      return new ImageData(clone, w, h);
    }
    for (const [px, py] of sel) {
      const p = (py * w + px) * 4;
      const srcA = clone[p + 3] / 255;
      const ta = ca / 255;
      const outA = ta + srcA * (1 - ta);
      clone[p] = (cr * ta + clone[p] * srcA * (1 - ta)) / outA;
      clone[p + 1] = (cg * ta + clone[p + 1] * srcA * (1 - ta)) / outA;
      clone[p + 2] = (cb * ta + clone[p + 2] * srcA * (1 - ta)) / outA;
      clone[p + 3] = outA * 255;
    }
    return new ImageData(clone, w, h);
  }

  drawRect(x0, y0, x1, y1, color, size, filled = false) {
    const stroke = Math.max(1, size);
    if (filled) {
      // solid filled rectangle (anti-aliased inside)
      const lx = Math.min(x0, x1);
      const rx = Math.max(x0, x1);
      const ty = Math.min(y0, y1);
      const by = Math.max(y0, y1);
      const [cr, cg, cb, ca] = color;
      const data = this.imageData.data;
      const w = this.imageData.width;
      const h = this.imageData.height;
      for (let y = ty; y <= by; y++) {
        if (y < 0 || y >= h) continue;
        for (let x = lx; x <= rx; x++) {
          if (x < 0 || x >= w) continue;
          const p = this.px(x, y);
          if (ca === 0) {
            // 透明色填充：把区域内像素完全设为透明
            data[p + 3] = 0;
            continue;
          }
          const srcA = data[p + 3] / 255;
          const ta = ca / 255;
          const outA = ta + srcA * (1 - ta);
          data[p] = (cr * ta + data[p] * srcA * (1 - ta)) / outA;
          data[p + 1] = (cg * ta + data[p + 1] * srcA * (1 - ta)) / outA;
          data[p + 2] = (cb * ta + data[p + 2] * srcA * (1 - ta)) / outA;
          data[p + 3] = outA * 255;
        }
      }
    }
    // outline rectangle (always draws border)
    this.drawThickLine(x0, y0, x1, y0, color, stroke);
    this.drawThickLine(x0, y1, x1, y1, color, stroke);
    this.drawThickLine(x0, y0, x0, y1, color, stroke);
    this.drawThickLine(x1, y0, x1, y1, color, stroke);
    this.syncCanvas();
  }

  drawEllipse(cx, cy, rx, ry, color, size, filled = false) {
    const data = this.imageData.data;
    const w = this.imageData.width;
    const h = this.imageData.height;
    const [cr, cg, cb, ca] = color;
    if (filled) {
      // solid filled ellipse using integer scan + alpha blend
      const lx = Math.max(0, Math.floor(cx - rx));
      const rx2 = Math.min(w - 1, Math.ceil(cx + rx));
      const ty = Math.max(0, Math.floor(cy - ry));
      const by = Math.min(h - 1, Math.ceil(cy + ry));
      if (rx2 < 0 || by < 0 || lx >= w || ty >= h) return;
      const rxr = Math.max(1, rx);
      const ryr = Math.max(1, ry);
      for (let y = ty; y <= by; y++) {
        for (let x = lx; x <= rx2; x++) {
          const dx = (x - cx) / rxr;
          const dy = (y - cy) / ryr;
          if (dx * dx + dy * dy > 1) continue;
          const p = (y * w + x) * 4;
          if (ca === 0) {
            data[p + 3] = 0;
            continue;
          }
          const srcA = data[p + 3] / 255;
          const ta = ca / 255;
          const outA = ta + srcA * (1 - ta);
          data[p] = (cr * ta + data[p] * srcA * (1 - ta)) / outA;
          data[p + 1] = (cg * ta + data[p + 1] * srcA * (1 - ta)) / outA;
          data[p + 2] = (cb * ta + data[p + 2] * srcA * (1 - ta)) / outA;
          data[p + 3] = outA * 255;
        }
      }
    }
    // outline
    const steps = Math.max(60, Math.floor(Math.PI * 2 * Math.max(rx, ry)));
    const radius = size / 2;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(t) * rx;
      const y = cy + Math.sin(t) * ry;
      this.stamp(Math.round(x), Math.round(y), radius, color, 'brush');
    }
    this.syncCanvas();
  }

  drawThickLine(x0, y0, x1, y1, color, stroke) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let cx = x0;
    let cy = y0;
    while (true) {
      this.stamp(cx, cy, stroke / 2, color, 'brush');
      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
  }

  // Soften / blur a region (whole image if no region)
  soften(strength = 1) {
    const src = new Uint8ClampedArray(this.imageData.data);
    const w = this.imageData.width;
    const h = this.imageData.height;
    const data = this.imageData.data;
    const r = Math.max(1, Math.round(strength));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rr = 0, gg = 0, bb = 0, aa = 0, cnt = 0;
        for (let dy = -r; dy <= r; dy += r) {
          for (let dx = -r; dx <= r; dx += r) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const p = (ny * w + nx) * 4;
            rr += src[p];
            gg += src[p + 1];
            bb += src[p + 2];
            aa += src[p + 3];
            cnt++;
          }
        }
        const p = (y * w + x) * 4;
        data[p] = rr / cnt;
        data[p + 1] = gg / cnt;
        data[p + 2] = bb / cnt;
        data[p + 3] = aa / cnt;
      }
    }
    this.syncCanvas();
  }

  adjust({ brightness = 0, contrast = 0, saturation = 0 }) {
    const data = this.imageData.data;
    const b = brightness;
    const c = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i + 1], bl = data[i + 2];
      r = c * (r - 128) + 128 + b;
      g = c * (g - 128) + 128 + b;
      bl = c * (bl - 128) + 128 + b;
      const avg = (r + g + bl) / 3;
      r = avg + (r - avg) * (1 + saturation / 100);
      g = avg + (g - avg) * (1 + saturation / 100);
      bl = avg + (bl - avg) * (1 + saturation / 100);
      data[i] = Math.max(0, Math.min(255, r));
      data[i + 1] = Math.max(0, Math.min(255, g));
      data[i + 2] = Math.max(0, Math.min(255, bl));
    }
    this.syncCanvas();
  }

  getImageData() {
    return this.imageData;
  }

  toBlob() {
    return new Promise((resolve) => {
      const tmp = document.createElement('canvas');
      tmp.width = this.imageData.width;
      tmp.height = this.imageData.height;
      tmp.getContext('2d').putImageData(this.imageData, 0, 0);
      tmp.toBlob((b) => resolve(b), 'image/png');
    });
  }
}

// Apply an operation programmatically to an ImageData (for batch apply)
export function applyOpToImageData(imageData, op) {
  const ed = new FrameEditor(document.createElement('canvas'));
  ed.setSize(imageData.width, imageData.height);
  ed.loadImageData(imageData);
  ed.snapshot();
  runOp(ed, op, 0, 0);
  return ed.getImageData();
}

// run a single op on editor (used by both live and batch)
export function runOp(ed, op, x, y) {
  switch (op.type) {
    case 'brush':
      ed.drawLine(op.x0, op.y0, op.x1, op.y1, op.color, op.size, 'brush');
      break;
    case 'eraser':
      ed.drawLine(op.x0, op.y0, op.x1, op.y1, op.color, op.size, 'eraser');
      break;
    case 'fill':
      ed.fillAt(x, y, op.color, op.tolerance || 0);
      break;
    case 'replace':
      ed.replaceColorAt(x, y, op.color, op.tolerance || 18, op._sourceRgba || null);
      break;
    case 'rect':
      ed.drawRect(op.x0, op.y0, op.x1, op.y1, op.color, op.size, !!op.filled);
      break;
    case 'ellipse':
      ed.drawEllipse(op.cx, op.cy, op.rx, op.ry, op.color, op.size, !!op.filled);
      break;
    case 'soften':
      ed.soften(op.strength || 1);
      break;
    case 'adjust':
      ed.adjust(op);
      break;
    default:
      break;
  }
}
