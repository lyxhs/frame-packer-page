import React, { useRef, useState, useEffect, useCallback } from 'react';
import { FrameEditor, hexToRgba, rgbaToHex, hexToRgb } from '../engine/editorEngine.js';
import '../styles/edit.css';

const TOOLS = [
  { id: 'brush', icon: '🖌', label: '画笔' },
  { id: 'eraser', icon: '⌫', label: '橡皮擦' },
  { id: 'fill', icon: '🪣', label: '填充' },
  { id: 'replace', icon: '🎨', label: '换色' },
  { id: 'rect', icon: '▭', label: '矩形' },
  { id: 'ellipse', icon: '◯', label: '椭圆' },
  { id: 'soften', icon: '✺', label: '柔化' },
  { id: 'adjust', icon: '⚙', label: '调整' },
];

export default function StageEdit({ session, onDone }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [editedSet, setEditedSet] = useState(new Set());
  const editedSetRef = useRef(new Set());
  // 帧版本号：每次帧内容变化（编辑/批量保存）都递增，用于让缩略图/画布强制刷新
  const [framesVersion, setFramesVersion] = useState(0);
  const bumpFramesVersion = useCallback(() => setFramesVersion((v) => v + 1), []);
  const [tool, setTool] = useState('brush');
  const [color, setColor] = useState('#00C800');
  const [alpha, setAlpha] = useState(255);
  const [size, setSize] = useState(24);
  const [tolerance, setTolerance] = useState(18);
  const [softenStrength, setSoftenStrength] = useState(2);
  const [adjust, setAdjust] = useState({ brightness: 0, contrast: 0, saturation: 0 });
  const [fillShape, setFillShape] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [modeLabel, setModeLabel] = useState('画笔');
  const [showBatch, setShowBatch] = useState(false);
  const [batchSelected, setBatchSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);

  const editorRef = useRef(null);
  const canvasRef = useRef(null);
  const canvasWrapRef = useRef(null);
  const overlayRef = useRef(null);
  const imgRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPtRef = useRef(null);
  const lastClickRef = useRef(null);
  const shapeRef = useRef(null); // {x0,y0,x1,y1} for rect/ellipse batch
  const rectStartRef = useRef(null); // 矩形/椭圆拖拽起点（独立于 lastPtRef，避免被后续 move 覆盖）
  // per-frame undo/redo stacks + original snapshot for "restore" button
  const undoPerFrameRef = useRef({});
  const redoPerFrameRef = useRef({});
  const origImageDataRef = useRef({}); // idx -> ImageData (cloned, never mutated)
  const frameOpsRef = useRef({}); // idx -> 该帧累积的可批量操作历史（作为批量模板）
  const activeIdxRef = useRef(0);
  // current shape preview while dragging rect/ellipse
  const previewShapeRef = useRef(null); // {x0,y0,x1,y1} or {cx,cy,rx,ry}
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  // 重新进入编辑器（组件重挂载）时，从 session 持久真相恢复已编辑帧集合。
  // 否则 editedSet 会清空，导致 loadFrame 把已编辑帧误判为原图而加载 origUrl。
  useEffect(() => {
    const s = new Set();
    if (session?.isEdited) {
      for (let i = 0; i < session.frameCount; i++) {
        if (session.isEdited(i)) s.add(i);
      }
    }
    editedSetRef.current = s;
    setEditedSet(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Render the preview overlay (SVG) for rect/ellipse while dragging
  function renderPreview() {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const p = previewShapeRef.current;
    if (!p) {
      overlay.innerHTML = '';
      return;
    }
    let html = '';
    if (tool === 'rect' && p.x0 !== undefined) {
      const x = Math.min(p.x0, p.x1);
      const y = Math.min(p.y0, p.y1);
      const w = Math.abs(p.x1 - p.x0);
      const h = Math.abs(p.y1 - p.y0);
      html = `<rect x="${x}" y="${y}" width="${w}" height="${h}"
        fill="rgba(${hexToRgb(color).join(',')}, ${(alpha / 255) * 0.25})"
        stroke="${color}" stroke-width="2" stroke-dasharray="4,3"/>`;
    } else if (tool === 'ellipse' && p.cx !== undefined) {
      html = `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}"
        fill="rgba(${hexToRgb(color).join(',')}, ${(alpha / 255) * 0.25})"
        stroke="${color}" stroke-width="2" stroke-dasharray="4,3"/>`;
    }
    overlay.innerHTML = html;
  }

  // save current editor frame to in-memory store (替代 /api/save-frame)
  const persistFrame = useCallback(
    async (idx, ed) => {
      if (!ed) return;
      const blob = await ed.toBlob();
      session.persistFrame(idx, blob);
    },
    [session]
  );

  // load frame into editor
  const loadFrame = useCallback(
    (idx) => {
      // persist current frame's undo/redo (and blob) before switching, so edits
      // are never lost when navigating between frames or leaving the editor.
      const fromIdx = activeIdxRef.current;
      if (editorRef.current && fromIdx !== idx) {
        undoPerFrameRef.current[fromIdx] = editorRef.current.undoStack;
        redoPerFrameRef.current[fromIdx] = editorRef.current.redoStack;
        if (
          editedSetRef.current.has(fromIdx) ||
          session.isEdited?.(fromIdx) ||
          editorRef.current.undoStack.length
        ) {
          persistFrame(fromIdx, editorRef.current).catch((e) =>
            console.error('persist previous frame failed:', e)
          );
        }
      }

      // 选择加载源：已编辑过的帧用编辑后的 url；未编辑的用 origUrl（原始图）。
      // 注意：跨重挂载时 editedSet 会重置，因此同时参考 session.isEdited（持久真相）。
      const edited = editedSetRef.current.has(idx) || !!session.isEdited?.(idx);
      const url = edited
        ? session.frames[idx].url
        : (session.frames[idx].origUrl || session.frames[idx].url);

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onerror = () => {
        console.error('loadFrame failed:', { idx, url, edited });
      };
      img.onload = () => {
        const maxW = 720;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = canvasRef.current;
        if (!c) {
          console.error('canvasRef not available');
          return;
        }
        // 强制重置 canvas 状态：先设为 0 再设目标尺寸，避免 onerror/onload 之间残留
        c.width = 0;
        c.height = 0;
        c.width = w;
        c.height = h;
        const ed = new FrameEditor(c);
        ed.setSize(w, h);
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const id = ctx.getImageData(0, 0, w, h);
        ed.loadImageData(id);
        editorRef.current = ed;
        imgRef.current = img;
        // 记录原始 ImageData 副本（用于"还原"）。若帧已编辑，原图副本必须从
        // origUrl 单独读取，否则会误把"上一次编辑结果"当作原图。
        if (!origImageDataRef.current[idx]) {
          if (edited) {
            loadImageEl(session.frames[idx].origUrl)
              .then((oimg) => {
                const oc = document.createElement('canvas');
                oc.width = oimg.width;
                oc.height = oimg.height;
                const octx = oc.getContext('2d');
                octx.drawImage(oimg, 0, 0);
                origImageDataRef.current[idx] = octx.getImageData(
                  0,
                  0,
                  oc.width,
                  oc.height
                );
              })
              .catch(() => {});
          } else {
            origImageDataRef.current[idx] = new ImageData(
              new Uint8ClampedArray(id.data),
              id.width,
              id.height
            );
          }
        }
        // 恢复该帧的 undo/redo
        if (undoPerFrameRef.current[idx]) {
          ed.undoStack = undoPerFrameRef.current[idx];
        }
        if (redoPerFrameRef.current[idx]) {
          ed.redoStack = redoPerFrameRef.current[idx];
        }
        setCanvasSize({ w, h });
        const area = document.querySelector('.canvas-area');
        if (area) {
          const avail = Math.min(area.clientWidth - 80, area.clientHeight - 80);
          setZoom(Math.max(0.2, Math.min(2, avail / Math.max(w, h))));
        }
      };
      img.src = url;
    },
    [session]  // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    setModeLabel(TOOLS.find((t) => t.id === tool)?.label || '');
  }, [tool]);

  // 切换帧 / 帧版本号（仅批量保存后）时重新加载
  useEffect(() => {
    loadFrame(activeIdx);
    // 故意省略 framesVersion：由 commitEdit/bumpFramesVersion 之后手动调用 loadFrame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, loadFrame]);

  // pointer helpers -> image coords
  function toImgCoords(e) {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * c.width;
    const y = ((e.clientY - rect.top) / rect.height) * c.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function onPointerDown(e) {
    const ed = editorRef.current;
    if (!ed) return;
    const { x, y } = toImgCoords(e);
    lastClickRef.current = { x, y };
    drawingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {}
    ed.snapshot();
    lastPtRef.current = { x, y };

    if (tool === 'fill') {
      ed.fillAt(x, y, hexToRgba(color, alpha / 255), tolerance);
      pushFrameOp(activeIdx, { type: 'fill', color: hexToRgba(color, alpha / 255), tolerance });
      commitEdit();
      drawingRef.current = false;
    } else if (tool === 'replace') {
      // 实时取一次源色并记录，批量重放时直接复用（避免重放时各帧画布状态不同导致取色偏差）
      const picked = ed.pickSourceColor
        ? ed.pickSourceColor(x, y)
        : null;
      ed.replaceColorAt(x, y, hexToRgba(color, alpha / 255), tolerance, picked || null);
      pushFrameOp(activeIdx, {
        type: 'replace',
        color: hexToRgba(color, alpha / 255),
        tolerance,
        _sourceRgba: picked || null,
        _x: x,
        _y: y,
      });
      commitEdit();
      drawingRef.current = false;
    } else if (tool === 'soften') {
      ed.soften(softenStrength);
      pushFrameOp(activeIdx, { type: 'soften', strength: softenStrength });
      commitEdit();
      drawingRef.current = false;
    } else if (tool === 'adjust') {
      ed.adjust(adjust);
      pushFrameOp(activeIdx, { type: 'adjust', ...adjust });
      commitEdit();
      drawingRef.current = false;
    } else if (tool === 'rect' || tool === 'ellipse') {
      // start preview on overlay; final shape drawn on pointerUp
      rectStartRef.current = { x, y };
      previewShapeRef.current = { x0: x, y0: y, x1: x, y1: y };
      renderPreview();
    } else {
      ed.stamp(x, y, size / 2, hexToRgba(color, alpha / 255), tool === 'eraser' ? 'eraser' : 'brush');
      ed.syncCanvas();
    }
  }

  function onPointerMove(e) {
    if (!drawingRef.current) return;
    const ed = editorRef.current;
    const { x, y } = toImgCoords(e);
    const last = lastPtRef.current || { x, y };
    if (tool === 'brush') {
      ed.drawLine(last.x, last.y, x, y, hexToRgba(color, alpha / 255), size, 'brush');
      lastPtRef.current = { x, y };
    } else if (tool === 'eraser') {
      ed.drawLine(last.x, last.y, x, y, hexToRgba(color, alpha / 255), size, 'eraser');
      lastPtRef.current = { x, y };
    } else if (tool === 'rect') {
      const s = rectStartRef.current || { x, y };
      previewShapeRef.current = { x0: s.x, y0: s.y, x1: x, y1: y };
      lastPtRef.current = { x, y };
      renderPreview();
    } else if (tool === 'ellipse') {
      const s = rectStartRef.current || { x, y };
      const cx = (s.x + x) / 2;
      const cy = (s.y + y) / 2;
      const rx = Math.max(1, Math.abs(x - s.x) / 2);
      const ry = Math.max(1, Math.abs(y - s.y) / 2);
      previewShapeRef.current = { cx, cy, rx, ry };
      lastPtRef.current = { x, y };
      renderPreview();
    }
  }

  function onPointerUp(e) {
    if (!drawingRef.current) return;
    const ed = editorRef.current;
    const { x, y } = toImgCoords(e);
    const s = rectStartRef.current || lastPtRef.current || { x, y };
    const c = hexToRgba(color, alpha / 255);
    if (tool === 'rect') {
      ed.drawRect(s.x, s.y, x, y, c, size, fillShape);
      pushFrameOp(activeIdx, {
        type: 'rect',
        color: c,
        size,
        shape: {
          x0: s.x,
          y0: s.y,
          x1: x,
          y1: y,
          size,
          filled: fillShape,
        },
      });
      shapeRef.current = {
        x0: s.x,
        y0: s.y,
        x1: x,
        y1: y,
        size,
        filled: fillShape,
      };
    } else if (tool === 'ellipse') {
      const cx = (s.x + x) / 2;
      const cy = (s.y + y) / 2;
      const rx = Math.max(1, Math.abs(x - s.x) / 2);
      const ry = Math.max(1, Math.abs(y - s.y) / 2);
      ed.drawEllipse(cx, cy, rx, ry, c, size, fillShape);
      pushFrameOp(activeIdx, {
        type: 'ellipse',
        color: c,
        size,
        shape: {
          cx,
          cy,
          rx,
          ry,
          size,
          filled: fillShape,
        },
      });
      shapeRef.current = {
        cx,
        cy,
        rx,
        ry,
        size,
        filled: fillShape,
      };
    }
    previewShapeRef.current = null;
    rectStartRef.current = null;
    if (overlayRef.current) overlayRef.current.innerHTML = '';
    drawingRef.current = false;
    lastPtRef.current = null;
    commitEdit();
  }

  function commitEdit() {
    const n = new Set(editedSetRef.current);
    n.add(activeIdx);
    editedSetRef.current = n;
    setEditedSet(n);
    bumpFramesVersion();
  }

  // 记录一次可批量操作到指定帧的模板历史。
  function pushFrameOp(idx, op) {
    if (!frameOpsRef.current[idx]) frameOpsRef.current[idx] = [];
    frameOpsRef.current[idx].push(op);
  }

  // 还原当前帧到原图（重置该帧所有编辑）
  function restoreCurrentFrame() {
    const ed = editorRef.current;
    if (!ed) return;
    const idx = activeIdxRef.current;
    const orig = origImageDataRef.current[idx];
    if (!orig) return;
    if (!confirm('确定要将当前帧还原为原图吗？此帧的所有编辑都将丢失。')) return;
    // 1. 用原图覆盖编辑数据
    const fresh = new ImageData(new Uint8ClampedArray(orig.data), orig.width, orig.height);
    ed.snapshot();
    ed.applyData(fresh);
    // 2. 清空该帧的 undo/redo 栈（还原后再撤销毫无意义）
    ed.undoStack = [];
    ed.redoStack = [];
    undoPerFrameRef.current[idx] = [];
    redoPerFrameRef.current[idx] = [];
    // 3. 上传覆盖服务端的 frames/ 目录
    persistFrame(idx, ed)
      .then(() => {
        editedSetRef.current.delete(idx);
        setEditedSet(new Set(editedSetRef.current));
        bumpFramesVersion();
      })
      .catch((e) => console.error('还原上传失败:', e));
    // 4. 清空该帧的批量模板历史（还原后不应再批量重放旧操作）
    delete frameOpsRef.current[idx];
  }

  async function undo() {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.undoStack.length === 0) return;
    ed.undo();
    commitEdit();
    persistFrame(activeIdxRef.current, ed).catch(() => {});
  }
  async function redo() {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.redoStack.length === 0) return;
    ed.redo();
    commitEdit();
    persistFrame(activeIdxRef.current, ed).catch(() => {});
  }

  // keyboard
  useEffect(() => {
    function onKey(e) {
      if (e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'ArrowRight') {
        persistCurrent();
        setActiveIdx((i) => Math.min(session.frameCount - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        persistCurrent();
        setActiveIdx((i) => Math.max(0, i - 1));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  // save current edited frame to server before leaving / finishing
  async function persistCurrent() {
    if (editorRef.current && editedSetRef.current.has(activeIdx)) {
      await persistFrame(activeIdx, editorRef.current);
    }
  }

  // save all frames to server (apply edits) -> proceed to preview
  async function saveAndProceed() {
    setSaving(true);
    try {
      await persistCurrent();
      onDone();
    } catch (err) {
      console.error(err);
      alert('保存失败：' + (err.message || err));
    } finally {
      setSaving(false);
    }
  }

  // apply current tool to frames (batch) - processed on frontend then uploaded
  async function applyBatch() {
    const op = buildOp();
    // 透明色操作的安全网：提示用户
    if (
      op &&
      op.color &&
      op.color[3] === 0 &&
      (op.type === 'rect' || op.type === 'ellipse' || op.type === 'brush')
    ) {
      const range =
        batchSelected.size
          ? `${batchSelected.size} 帧（已选）`
          : `全部 ${session.frames.length} 帧`;
      const msg =
        op.type === 'brush'
          ? `你勾选了透明色笔刷。\n这会把 ${range} 中涂到的区域变透明，且不可恢复。\n\n继续？`
          : `你勾选了透明色填充图形。\n如果矩形/椭圆覆盖了大片画面，${range} 都会变透明。\n\n继续？`;
      if (!confirm(msg)) return;
    }
    const targets = batchSelected.size ? [...batchSelected] : session.frames.map((_, i) => i);

    // 批量模板：优先使用「激活帧上累积的可批量操作历史」。
    // 这样用户在激活帧上连续做了多次换色/填充/画图形后，一次批量即可把
    // 全部操作复制到每一帧（而非只应用最后一次点击的操作）。
    const activeIdx = activeIdxRef.current;
    const templateOps = frameOpsRef.current[activeIdx] || [];
    // 若激活帧没有历史操作，则回退为「单次当前操作」（兼容直接点批量、未先编辑的情况）。
    // 回退路径需带上点击点坐标，确保 replace/fill 的取色锚点正确。
    let opsForBatch;
    if (templateOps.length) {
      opsForBatch = templateOps;
    } else {
      const click = lastClickRef.current || { x: 0, y: 0 };
      opsForBatch = [{ ...op, _x: click.x, _y: click.y }];
    }

    setSaving(true);
    try {
      const blobs = [];
      const indices = [];
      for (const idx of targets) {
        // 基底选择：已编辑帧基于「已编辑帧」继续叠加，未编辑则基于原图。
        // 这保证多轮换色/多次批量都能累积生效。
        const isEdited = editedSetRef.current.has(idx) || !!session.isEdited?.(idx);
        const baseUrl = isEdited
          ? (session.frames[idx].url || session.frames[idx].origUrl)
          : (session.frames[idx].origUrl || session.frames[idx].url);
        const url = baseUrl + `#cb=${Date.now()}_${idx}`;
        const img = await loadImageEl(url);
        const c = document.createElement('canvas');
        const scale = 720 / img.width < 1 ? 720 / img.width : 1;
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const ed = new FrameEditor(c);
        ed.setSize(c.width, c.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        ed.loadImageData(ctx.getImageData(0, 0, c.width, c.height));
        ed.snapshot();
        // 依次重放模板中的每一次操作（坐标已是 720 缩放画布坐标，无需再乘 scale）
        for (const tOp of opsForBatch) {
          const opForFrame = { ...tOp };
          if (tOp.type === 'replace') {
            // 使用记录时固化的源色（基于激活帧当时的画布），避免各帧画布状态
            // 不同导致取色偏差；若该历史 op 没记录源色则让引擎即时取色。
            opForFrame._x = tOp._x != null ? Math.round(tOp._x * scale) : 0;
            opForFrame._y = tOp._y != null ? Math.round(tOp._y * scale) : 0;
          } else if (tOp.type === 'fill') {
            opForFrame._x = tOp._x != null ? Math.round(tOp._x * scale) : 0;
            opForFrame._y = tOp._y != null ? Math.round(tOp._y * scale) : 0;
          }
          applyOpToFrame(ed, opForFrame);
        }
        const blob = await ed.toBlob();
        blobs.push(blob);
        indices.push(idx);
      }
      // 批量保存到内存存储（替代 /api/batch-save）
      session.persistBatch(indices, blobs);
      // mark edited (同步更新 ref 以便后续 loadFrame 能正确判定 edited 状态)
      editedSetRef.current = new Set([...editedSetRef.current, ...indices]);
      setEditedSet(new Set(editedSetRef.current));
      // 递增帧版本号，让缩略图与画布强制刷新
      bumpFramesVersion();
      // 模板已固化到各帧，清空激活帧历史，避免下次批量时重复重放已固化的操作
      delete frameOpsRef.current[activeIdx];
      setShowBatch(false);
      // reload current frame with cache-bust
      loadFrame(activeIdx);
    } catch (err) {
      console.error('批量应用失败:', err);
      const detail = err?.stack ? `\n\n${String(err.stack).split('\n').slice(0, 4).join('\n')}` : '';
      alert(`${err?.message || '批量应用失败'}${detail}`);
    } finally {
      setSaving(false);
    }
  }

  function buildOp() {
    const c = hexToRgba(color, alpha / 255);
    const base = { color: c, size };
    switch (tool) {
      case 'brush':
      case 'eraser':
        return { type: tool, ...base };
      case 'fill':
        return { type: 'fill', color: c, tolerance };
      case 'replace':
        return { type: 'replace', color: c, tolerance };
      case 'soften':
        return { type: 'soften', strength: softenStrength };
      case 'adjust':
        return { type: 'adjust', ...adjust };
      case 'rect':
        return { type: 'rect', ...base, shape: shapeRef.current };
      case 'ellipse':
        return { type: 'ellipse', ...base, shape: shapeRef.current };
      default:
        return { type: 'noop' };
    }
  }

  function applyOpToFrame(ed, op) {
    const x = op._x ?? 0;
    const y = op._y ?? 0;
    switch (op.type) {
      case 'brush':
      case 'eraser':
        // brush strokes are per-frame; nothing meaningful to batch
        break;
      case 'fill':
        ed.fillAt(x, y, op.color, op.tolerance || 0);
        break;
      case 'replace': {
        // Use pre-picked source color if provided (from the active frame's
        // orig image), so we don't re-pick from each target frame (which would
        // fail when that frame has had the same region knocked out earlier).
        let sourceColor = null;
        if (op._sourceRgba) sourceColor = op._sourceRgba;
        ed.replaceColorAt(x, y, op.color, op.tolerance || 18, sourceColor);
        break;
      }
      case 'soften':
        ed.soften(op.strength || 1);
        break;
      case 'adjust':
        ed.adjust(op);
        break;
      case 'rect': {
        const s = op.shape;
        if (s) ed.drawRect(s.x0, s.y0, s.x1, s.y1, op.color, op.size, !!s.filled);
        break;
      }
      case 'ellipse': {
        const s = op.shape;
        if (s) ed.drawEllipse(s.cx, s.cy, s.rx, s.ry, op.color, op.size, !!s.filled);
        break;
      }
      default:
        break;
    }
  }

  function loadImageEl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  const activeTool = TOOLS.find((t) => t.id === tool);

  return (
    <div className="edit-wrap fade-in">
      {/* top bar */}
      <div className="edit-topbar">
        <span className="title">编辑帧 #{String(activeIdx + 1).padStart(3, '0')}</span>
        {modeLabel && (
          <span className="mode-pill">
            {modeLabel}
          </span>
        )}
        <div className="spacer" style={{ flex: 1 }} />
        <span className="hint-keys">滚轮缩放 · 方向键切帧 · Ctrl+Z 撤销</span>
        <button className="btn btn-primary btn-sm" onClick={saveAndProceed} disabled={saving}>
          {saving ? '处理中…' : '完成编辑 →'}
        </button>
      </div>

      {/* filmstrip */}
      <div className="filmstrip">
        {session.frames.map((f, i) => (
          <div
            key={i}
            className={`film-frame ${i === activeIdx ? 'active' : ''}`}
            onClick={() => setActiveIdx(i)}
            title={`帧 ${i + 1}`}
          >
            <img src={`${f.url}#v=${framesVersion}`} alt={`frame ${i}`} />
            <span className="idx">{i + 1}</span>
            {editedSet.has(i) && <span className="edited-dot" />}
          </div>
        ))}
      </div>

      {/* body */}
      <div className="edit-body">
        {/* toolbar */}
        <div className="toolbar">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool-btn ${tool === t.id ? 'active' : ''}`}
              onClick={() => {
                setTool(t.id);
                setModeLabel(t.label);
              }}
            >
              {t.icon}
              <span className="tip">
                {t.label}
              </span>
            </button>
          ))}
        </div>

        {/* canvas */}
        <div className="canvas-area">
          <div
            ref={canvasWrapRef}
            className="canvas-stage checkerboard"
            style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom, position: 'relative' }}
          >
            <canvas
              ref={canvasRef}
              style={{ width: canvasSize.w * zoom, height: canvasSize.h * zoom, display: 'block' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
            <svg
              ref={overlayRef}
              viewBox={`0 0 ${canvasSize.w} ${canvasSize.h}`}
              preserveAspectRatio="none"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                overflow: 'visible',
              }}
            />
          </div>
          <div className="zoom-controls">
            <button onClick={() => setZoom((z) => Math.max(0.2, z - 0.2))}>−</button>
            <span className="zval">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(3, z + 0.2))}>+</button>
            <button onClick={() => setZoom(1)} title="1:1">⤢</button>
          </div>
        </div>

        {/* props */}
        <div className="props">
          <h4>属性</h4>

          {(tool === 'brush' || tool === 'eraser' || tool === 'fill' || tool === 'replace' || tool === 'rect' || tool === 'ellipse') && (
            <div className="prop-group">
              <div className="prop-label">
                笔刷颜色 <b>{color}{alpha === 255 ? '' : ' · ' + alpha}</b>
              </div>
              <div className="color-row">
                <div className="color-swatch checkerboard">
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
                </div>
                <input
                  className="hex-input"
                  value={color.toUpperCase()}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
              <div className="alpha-row">
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>透明度</span>
                <input
                  className="alpha-bar"
                  type="range"
                  min={0}
                  max={255}
                  value={alpha}
                  onChange={(e) => setAlpha(parseInt(e.target.value))}
                />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{alpha}</span>
              </div>
              {alpha === 0 && tool !== 'eraser' && tool !== 'fill' && tool !== 'replace' && (
                <div className="warn-hint">
                  ⚠ 你选了<strong>透明色</strong>，画上去的区域将完全变透明（看不到任何颜色）。
                </div>
              )}
            </div>
          )}

          {(tool === 'brush' || tool === 'eraser' || tool === 'rect' || tool === 'ellipse') && (
            <div className="prop-group">
              <div className="prop-label">
                笔刷尺寸 <b>{size}px</b>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={size}
                style={{ width: '100%' }}
                onChange={(e) => setSize(parseInt(e.target.value))}
              />
            </div>
          )}

          {(tool === 'rect' || tool === 'ellipse') && (
            <div className="prop-group">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={fillShape}
                  onChange={(e) => setFillShape(e.target.checked)}
                />
                <span>填充内部（默认开启）</span>
              </label>
              <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 8 }}>
                取消勾选则仅绘制{tool === 'rect' ? '矩形' : '椭圆'}边框，适合做画框/选区。
              </p>
            </div>
          )}

          {(tool === 'fill' || tool === 'replace') && (
            <div className="prop-group">
              <div className="prop-label">
                容差 <b>{tolerance}</b>
              </div>
              <input
                type="range"
                min={1}
                max={120}
                value={tolerance}
                style={{ width: '100%' }}
                onChange={(e) => setTolerance(parseInt(e.target.value))}
              />
              <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 8 }}>
                {tool === 'replace'
                  ? '点击图片中某颜色，沿物品轮廓将该颜色区域替换为画笔色。'
                  : '点击以填充相连的同色区域。'}
              </p>
            </div>
          )}

          {tool === 'soften' && (
            <div className="prop-group">
              <div className="prop-label">
                柔化强度 <b>{softenStrength}</b>
              </div>
              <input
                type="range"
                min={1}
                max={6}
                value={softenStrength}
                style={{ width: '100%' }}
                onChange={(e) => setSoftenStrength(parseInt(e.target.value))}
              />
            </div>
          )}

          {tool === 'adjust' && (
            <div className="prop-group">
              {[
                { k: 'brightness', label: '亮度', min: -100, max: 100 },
                { k: 'contrast', label: '对比度', min: -100, max: 100 },
                { k: 'saturation', label: '饱和度', min: -100, max: 100 },
              ].map((a) => (
                <div key={a.k} style={{ marginBottom: 12 }}>
                  <div className="prop-label">
                    {a.label} <b>{adjust[a.k]}</b>
                  </div>
                  <input
                    type="range"
                    min={a.min}
                    max={a.max}
                    value={adjust[a.k]}
                    style={{ width: '100%' }}
                    onChange={(e) =>
                      setAdjust((p) => ({ ...p, [a.k]: parseInt(e.target.value) }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          <div className="prop-group">
            <div className="prop-label">历史操作</div>
            <div className="op-list">
              {editedSet.has(activeIdx) ? (
                <div className="op-item">
                  <span className="op-type">已编辑此帧</span>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>本帧暂无编辑</div>
              )}
            </div>
          </div>

          <button
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => {
              setBatchSelected(new Set());
              setShowBatch(true);
            }}
          >
            批量应用
          </button>
        </div>
      </div>

      {/* footer */}
      <div className="edit-footer">
        <button className="btn btn-sm" onClick={undo}>↶ 撤销</button>
        <button className="btn btn-sm" onClick={redo}>↷ 重做</button>
        <button className="btn btn-sm btn-ghost" onClick={restoreCurrentFrame}>⟲ 还原</button>
        <div className="spacer" />
        <span className="hint-keys">滚轮缩放 · 右键/中键拖拽平移 · ← → 切帧</span>
      </div>

      {showBatch && (
        <BatchModal
          session={session}
          batchSelected={batchSelected}
          setBatchSelected={setBatchSelected}
          onClose={() => setShowBatch(false)}
          onApply={applyBatch}
          toolLabel={activeTool?.label}
          saving={saving}
        />
      )}
    </div>
  );
}

function BatchModal({ session, batchSelected, setBatchSelected, onClose, onApply, toolLabel, saving }) {
  const allSelected = batchSelected.size === 0 || batchSelected.size === session.frameCount;
  function toggle(i) {
    setBatchSelected((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal batch-modal" onClick={(e) => e.stopPropagation()}>
        <h3>批量应用 · {toolLabel}</h3>
        <p>
          将当前工具（{toolLabel}）应用到选中的帧。默认应用到<b>全部帧</b>；也可在下方勾选指定帧。
          未勾选时视为应用到全部帧。
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <button
            className="btn btn-sm"
            onClick={() => setBatchSelected(new Set())}
          >
            全选（全部帧）
          </button>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => setBatchSelected(new Set([...Array(session.frameCount).keys()]))}
          >
            手动选择全部
          </button>
        </div>
        <div className="frame-pick">
          {session.frames.map((f, i) => (
            <div
              key={i}
              className={`film-frame ${batchSelected.has(i) ? 'selected' : ''}`}
              onClick={() => toggle(i)}
            >
              <img src={f.url} alt="" />
              <span className="idx">{i + 1}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={onApply} disabled={saving}>
            {saving ? '应用中…' : '确认批量应用'}
          </button>
        </div>
      </div>
    </div>
  );
}
