// 浏览器端 ffmpeg.wasm 封装：替代原后端的 /api/probe 与 /api/extract。
// 整个流程在浏览器内完成，不依赖任何后端服务。
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { readVideoFps } from './mp4Fps.js';

// wasm / worker 资源目录（放在 public/ffmpeg 下，随产物一起打包，完全离线）
// 使用相对路径，配合 vite base:'./' 可直接静态托管到任意子目录
const CORE_BASE = './ffmpeg';

let ffmpeg = null;
let loadPromise = null;

async function ensureFFmpeg(onLog) {
  if (ffmpeg) return ffmpeg;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ff = new FFmpeg();
    if (onLog) ff.on('log', ({ message }) => onLog(message));
    // 把 worker 包装成 blob URL 再作为 classWorkerURL 传入，
    // 避免 `new URL('./worker.js', import.meta.url)` 解析到 vite 打包后的 assets 目录。
    // coreURL/wasmURL 也用 blob，避免对方 CDN 失败。
    const toBlob = (u, mime) => toBlobURL(u, mime);
    await ff.load({
      coreURL: await toBlob(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlob(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL: await toBlob(`${CORE_BASE}/worker.js`, 'text/javascript'),
    });
    ffmpeg = ff;
    return ff;
  })();

  try {
    return await loadPromise;
  } catch (e) {
    loadPromise = null;
    throw e;
  }
}

// 探测基础信息（替代 /api/probe）。浏览器内用 <video> 元数据 + MP4 box 解析真实 fps。
export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const duration = await new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve(isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => reject(new Error('无法读取视频元数据'));
    v.src = url;
  });
  const v2 = document.createElement('video');
  v2.preload = 'metadata';
  await new Promise((res) => {
    v2.onloadedmetadata = () => res();
    v2.src = url;
  });
  const width = v2.videoWidth;
  const height = v2.videoHeight;
  URL.revokeObjectURL(url);
  // 真实 fps：优先解析 MP4 box；如果不是 MP4 或解析失败则返回 null（UI 会回退到默认值 30）。
  let fps = null;
  try {
    const r = await readVideoFps(file);
    if (r && isFinite(r) && r > 0) fps = r;
  } catch {}
  return { filename: file.name, duration, width, height, fps };
}

// 拆帧（替代 /api/extract）。返回 { frames:[{idx,blob}], fps, totalFrames }
// opts.trimStart / opts.trimEnd：截取区间（秒）。省略则取整个视频。
export async function extractFrames(file, { fps, onProgress, onLog, trimStart = 0, trimEnd = 0 } = {}) {
  const ff = await ensureFFmpeg(onLog);
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.mp4';
  const name = 'input' + ext;
  await ff.writeFile(name, await fetchFile(file));

  // 截取区间：trimEnd <= trimStart 或 <=0 视为未设置，取整个视频。
  const doTrim =
    isFinite(trimEnd) && isFinite(trimStart) && trimEnd > trimStart && trimStart >= 0;
  const start = doTrim ? Math.max(0, trimStart) : 0;
  const end = doTrim ? trimEnd : 0;

  const outPattern = 'frame_%05d.png';
  let rc = 0;
  try {
    // -ss 放在 -i 之前：快速关键帧跳转（更高效）；-to 放在输出侧：精确截止。
    // 这样只抽取 [trimStart, trimEnd] 区间内的帧，而非整个视频。
    const args = [];
    if (doTrim) {
      args.push('-ss', String(start.toFixed(3)));
    }
    args.push('-i', name);
    args.push('-vf', `fps=${fps}`);
    args.push('-vsync', '0');
    if (doTrim) {
      args.push('-to', String((end - start).toFixed(3)));
    }
    args.push(outPattern);
    rc = await ff.exec(args);
  } catch (e) {
    // ffmpeg.exec 本身极少 throw；这里兜底抛错让上层看到
    throw new Error('ffmpeg 执行失败：' + (e?.message || e));
  }

  const list = await ff.listDir('/');
  const frameFiles = list
    .filter((e) => e.name.startsWith('frame_') && e.name.endsWith('.png'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (rc !== 0 || frameFiles.length === 0) {
    try { await ff.deleteFile(name); } catch {}
    throw new Error(`ffmpeg 退出码 ${rc}，未产出帧（fps=${fps}, 共 ${frameFiles.length} 帧）。`);
  }

  const frames = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const data = await ff.readFile(frameFiles[i].name);
    const blob = new Blob([data.buffer], { type: 'image/png' });
    frames.push({ idx: i, blob });
    onProgress?.(i + 1, frameFiles.length, '正在解码帧…');
  }

  try { await ff.deleteFile(name); } catch {}
  for (const f of frameFiles) { try { await ff.deleteFile(f.name); } catch {} }

  return { frames, fps, totalFrames: frames.length };
}
