// 内存帧存储：替代后端 /sessions 磁盘存储。所有帧以 Blob URL 形式常驻内存，
// 无需服务器。每个 session 暴露与后端兼容的 frames:[{idx,url,origUrl}] 结构。
import JSZip from 'jszip';

export function createSession({ frames, fps, video }) {
  const origBlobs = frames.map((f) => f.blob);
  const editBlobs = new Array(frames.length).fill(null);
  const urlCache = new Map(); // key -> objectURL

  function makeUrl(blob) {
    return URL.createObjectURL(blob);
  }

  const frameList = frames.map((_, i) => ({
    idx: i,
    origUrl: makeUrl(origBlobs[i]),
    url: makeUrl(origBlobs[i]),
  }));

  function refreshEditUrl(idx) {
    const blob = editBlobs[idx] || origBlobs[idx];
    const old = frameList[idx].url;
    // 只刷新编辑 URL（origUrl 不变）
    if (urlCache.has('e' + idx)) URL.revokeObjectURL(urlCache.get('e' + idx));
    const u = makeUrl(blob);
    urlCache.set('e' + idx, u);
    frameList[idx].url = u;
  }

  return {
    sessionId: 'offline-' + Date.now().toString(36),
    fps,
    totalFrames: frames.length,
    frameCount: frames.length,
    origFrameCount: frames.length,
    video: { width: video?.width || 0, height: video?.height || 0, duration: video?.duration || 0 },
    frames: frameList,
    origBlobs,
    editBlobs,

    // 替换为持久化后的编辑帧（替代 /api/save-frame）
    persistFrame(idx, blob) {
      editBlobs[idx] = blob;
      refreshEditUrl(idx);
    },
    // 批量保存（替代 /api/batch-save）
    persistBatch(indices, blobs) {
      indices.forEach((idx, k) => {
        editBlobs[idx] = blobs[k];
        refreshEditUrl(idx);
      });
    },
    // 还原（替代 /api/revert）：清空该帧编辑，回到原图
    revert(idx) {
      editBlobs[idx] = null;
      refreshEditUrl(idx);
    },
    isEdited(idx) {
      return !!editBlobs[idx];
    },
    getEditBlob(idx) {
      return editBlobs[idx] || origBlobs[idx];
    },
  };
}

/**
 * 将一个 Blob（图片）按目标尺寸等比缩放，再返回新的 PNG Blob。
 * @param {Blob} blob  原始 PNG blob
 * @param {number} targetWidth  目标宽度。<=0 或 undefined 表示保持原图。
 * @param {object} [opts]
 * @param {'smooth'|'pixel'} [opts.smoothing]  缩放算法：smooth=双线性（默认），pixel=最近邻
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function resizeFrameBlob(blob, targetWidth, opts = {}) {
  const { smoothing = 'smooth' } = opts || {};
  const bitmap = await createImageBitmap(blob);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // 计算等比缩放后的尺寸
  let outW = srcW;
  let outH = srcH;
  if (targetWidth && targetWidth > 0 && targetWidth !== srcW) {
    outW = Math.max(1, Math.round(targetWidth));
    outH = Math.max(1, Math.round((srcH * outW) / srcW));
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = smoothing !== 'pixel';
  if (smoothing === 'pixel') {
    ctx.imageSmoothingQuality = 'low';
  } else {
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(bitmap, 0, 0, outW, outH);

  const outBlob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png')
  );
  bitmap.close?.();
  return { blob: outBlob, width: outW, height: outH };
}

/**
 * 前端打包下载（替代 /api/download）。
 *
 * @param {object} session  会话对象
 * @param {object} [opts]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @param {number} [opts.targetWidth]  ZIP 内每帧的目标宽度（等比缩放）。省略则保持原图分辨率。
 * @param {'smooth'|'pixel'} [opts.smoothing]  缩放算法，默认 smooth
 * @param {string} [opts.filename]  输出 zip 文件名
 */
export async function downloadZip(session, opts = {}) {
  const { onProgress, targetWidth, smoothing = 'smooth', filename } = opts || {};
  const zip = new JSZip();
  const folder = zip.folder('frames');
  const n = session.totalFrames;
  let actualW = 0;
  let actualH = 0;
  const wantResize = targetWidth && targetWidth > 0;

  for (let i = 0; i < n; i++) {
    const srcBlob = session.getEditBlob(i);
    let outBlob = srcBlob;
    if (wantResize) {
      const r = await resizeFrameBlob(srcBlob, targetWidth, { smoothing });
      outBlob = r.blob;
      actualW = r.width;
      actualH = r.height;
    } else {
      // 不缩放：直接使用原始 blob
      outBlob = srcBlob;
    }
    const buf = await outBlob.arrayBuffer();
    folder.file(`frame_${String(i + 1).padStart(5, '0')}.png`, buf);
    onProgress?.(i + 1, n);
  }

  // 如果没缩放，至少读一次第一帧尺寸（避免为了元数据多走一次缩放，直接读取 blob header）
  if (!wantResize) {
    try {
      const r = await readPngSize(session.getEditBlob(0));
      actualW = r.width;
      actualH = r.height;
    } catch {
      actualW = session?.video?.width || 0;
      actualH = session?.video?.height || 0;
    }
  }

  // 元数据：方便用户知道尺寸/帧数
  const meta = {
    frameCount: n,
    fps: session.fps,
    width: actualW,
    height: actualH,
    sourceWidth: actualW,
    sourceHeight: actualH,
    targetWidth: targetWidth && targetWidth > 0 ? targetWidth : actualW,
    smoothing,
    format: 'png',
    generator: 'FramePacker-offline',
    createdAt: new Date().toISOString(),
  };
  folder.file('frames.json', JSON.stringify(meta, null, 2));

  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, filename || `framepacker_${actualW}x${actualH}_${n}frames.zip`);
}

/**
 * 生成雪碧图（Sprite Sheet）：将所有帧合并为一张大 PNG，并附带 frames.json 元数据。
 *
 * 网格采用接近正方形的紧凑布局：cols = ceil(sqrt(n))，rows = ceil(n / cols)。
 *
 * @param {object} session
 * @param {object} [opts]
 * @param {number} [opts.targetWidth]  每帧的目标宽度（等比缩放）
 * @param {'smooth'|'pixel'} [opts.smoothing]
 * @param {string} [opts.filename]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 */
export async function downloadSpriteSheet(session, opts = {}) {
  const {
    onProgress,
    targetWidth,
    smoothing = 'smooth',
    filename,
  } = opts || {};

  const n = session.totalFrames;
  if (n <= 0) throw new Error('没有可导出的帧');

  // 1) 先读取所有帧并缩放到目标尺寸，记录单帧尺寸（保证整套比例一致）
  const tiles = []; // { blob, w, h }
  for (let i = 0; i < n; i++) {
    const srcBlob = session.getEditBlob(i);
    const r = await resizeFrameBlob(srcBlob, targetWidth, { smoothing });
    tiles.push(r);
    onProgress?.(i + 1, n);
  }

  const tileW = tiles[0].width;
  const tileH = tiles[0].height;

  // 2) 计算紧凑网格：列数 = ceil(sqrt(n))
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  // 3) 拼成一张大图
  const sheet = document.createElement('canvas');
  sheet.width = cols * tileW;
  sheet.height = rows * tileH;
  const sctx = sheet.getContext('2d');
  sctx.imageSmoothingEnabled = smoothing !== 'pixel';

  const frames = []; // 元数据
  for (let i = 0; i < n; i++) {
    const r = i % cols;
    const c = Math.floor(i / cols);
    const img = await createImageBitmap(tiles[i].blob);
    sctx.drawImage(img, r * tileW, c * tileH);
    img.close?.();
    frames.push({
      index: i,
      x: r * tileW,
      y: c * tileH,
      width: tileW,
      height: tileH,
      filename: `frame_${String(i + 1).padStart(5, '0')}.png`,
    });
  }

  const sheetBlob = await new Promise((resolve) =>
    sheet.toBlob((b) => resolve(b), 'image/png')
  );

  // 4) 打包：sprite_sheet.png + frames.json + frames/ 子目录(原图)
  const zip = new JSZip();
  zip.file('sprite_sheet.png', sheetBlob);
  zip.file(
    'frames.json',
    JSON.stringify(
      {
        frameCount: n,
        fps: session.fps,
        tileWidth: tileW,
        tileHeight: tileH,
        cols,
        rows,
        sheetWidth: sheet.width,
        sheetHeight: sheet.height,
        targetWidth: targetWidth && targetWidth > 0 ? targetWidth : tileW,
        smoothing,
        frames,
        generator: 'FramePacker-offline',
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // 同时把单帧放进 frames/ 子目录，便于需要时单独取出
  const folder = zip.folder('frames');
  for (let i = 0; i < n; i++) {
    const buf = await tiles[i].blob.arrayBuffer();
    folder.file(frames[i].filename, buf);
  }

  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(
    content,
    filename || `sprite_${tileW}x${tileH}_${cols}x${rows}.zip`
  );
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/**
 * 轻量解析 PNG IHDR 读取宽高（不解析像素）。失败返回 0。
 * PNG 文件头: 8B 签名 + 4B 长度 + 4B 类型("IHDR") + 4B 宽 + 4B 高 + ...
 */
export async function readPngSize(blob) {
  const buf = await blob.slice(0, 24).arrayBuffer();
  const view = new DataView(buf);
  // PNG 签名固定为 89 50 4E 47 0D 0A 1A 0A
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== sig[i]) return { width: 0, height: 0 };
  }
  // chunk length 在 8..11，type 在 12..15（"IHDR"），width 在 16..19，height 在 20..23
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return { width, height };
}
