import React, { useMemo, useState } from 'react';
import '../styles/preview-download.css';
import { downloadZip, downloadSpriteSheet } from '../lib/frameStore.js';

const SIZE_PRESETS = [
  { id: 'orig', label: '原始', getValue: (w) => w },
  { id: '64', label: '64×64', value: 64 },
  { id: '128', label: '128×128', value: 128 },
  { id: '256', label: '256×256', value: 256 },
  { id: '512', label: '512×512', value: 512 },
  { id: 'custom', label: '自定义', value: null },
];

const FORMAT_OPTIONS = [
  { id: 'zip', label: 'ZIP', desc: '一叠帧图打包下载' },
  { id: 'sprite', label: 'Sprite Sheet', desc: '一张网格大图 + 帧元数据' },
];

export default function StageDownload({ session, onBack }) {
  const [format, setFormat] = useState('zip');
  const [presetId, setPresetId] = useState('orig');
  const [customW, setCustomW] = useState(256);
  const [customH, setCustomH] = useState(342);
  const [aspectLocked, setAspectLocked] = useState(true);
  const [smoothing, setSmoothing] = useState('smooth');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // 原始尺寸（取自 session.video）
  const srcW = session?.video?.width || session?.width || 720;
  const srcH = session?.video?.height || session?.height || 960;

  // 当前选中的目标宽度
  const preset = SIZE_PRESETS.find((p) => p.id === presetId) || SIZE_PRESETS[0];
  const targetWidth = useMemo(() => {
    if (preset.id === 'orig') return srcW;
    if (preset.id === 'custom') return Math.max(1, Math.round(customW));
    return preset.value;
  }, [preset, srcW, customW]);
  const targetHeight = useMemo(() => {
    if (preset.id === 'orig') return srcH;
    return Math.max(1, Math.round((srcH * targetWidth) / srcW));
  }, [preset, srcH, targetWidth, srcW]);

  // 自定义宽高同步：保持等比时改一个同步另一个
  function updateCustomW(v) {
    const nw = Math.max(1, Math.min(4096, Math.round(v) || 1));
    setCustomW(nw);
    if (aspectLocked) setCustomH(Math.max(1, Math.round((srcH * nw) / srcW)));
  }
  function updateCustomH(v) {
    const nh = Math.max(1, Math.min(4096, Math.round(v) || 1));
    setCustomH(nh);
    if (aspectLocked) setCustomW(Math.max(1, Math.round((srcW * nh) / srcH)));
  }

  function handlePresetChange(id) {
    setPresetId(id);
    if (id === 'custom') {
      // 首次进入自定义时，用原图等比缩放到合理起点
      const startW = Math.min(512, srcW);
      setCustomW(startW);
      setCustomH(Math.max(1, Math.round((srcH * startW) / srcW)));
    }
  }

  async function handleExport() {
    if (downloading) return;
    setDownloading(true);
    setProgress({ done: 0, total: session.totalFrames });
    try {
      const opts = {
        targetWidth,
        smoothing,
        onProgress: (done, total) => setProgress({ done, total }),
      };
      if (format === 'zip') {
        await downloadZip(session, opts);
      } else {
        await downloadSpriteSheet(session, opts);
      }
    } catch (e) {
      console.error('导出失败', e);
      alert('导出失败：' + (e.message || e));
    } finally {
      // 稍等让用户看到完成态
      setTimeout(() => {
        setDownloading(false);
        setProgress({ done: 0, total: 0 });
      }, 600);
    }
  }

  const progressPct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="download-wrap fade-in">
      <div className="download-grid">
        {/* 概览卡片 */}
        <div className="download-card panel">
          <div className="dl-icon">📦</div>
          <h2>打包下载</h2>
          <p>所有编辑后的帧已就绪。选择导出格式与目标尺寸，将它们打包下载。</p>
          <div className="dl-stats">
            <div className="dl-stat">
              <b>{session.frameCount}</b>
              <span>帧数量</span>
            </div>
            <div className="dl-stat">
              <b>{session.fps || session.extractFps}</b>
              <span>帧率 fps</span>
            </div>
            <div className="dl-stat">
              <b>
                {srcW}×{srcH}
              </b>
              <span>原分辨率</span>
            </div>
            <div className="dl-stat">
              <b>PNG</b>
              <span>格式</span>
            </div>
          </div>

          <button
            className="btn btn-primary dl-btn"
            onClick={handleExport}
            disabled={downloading}
          >
            {downloading
              ? `正在打包 ${progress.done}/${progress.total}`
              : `⬇ 导出 ${FORMAT_OPTIONS.find((f) => f.id === format)?.label || ''}`}
          </button>
          {downloading && (
            <div className="dl-progress">
              <div className="dl-progress-bar" style={{ width: `${progressPct}%` }} />
              <span className="dl-progress-text">{progressPct}%</span>
            </div>
          )}
          <button className="btn btn-ghost dl-back" onClick={onBack}>
            ← 返回预览
          </button>
        </div>

        {/* 选项面板 */}
        <div className="download-options panel">
          {/* 导出格式 */}
          <section className="dl-section">
            <h3 className="dl-section-title">导出格式</h3>
            <div className="dl-chip-group">
              {FORMAT_OPTIONS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`dl-chip ${format === f.id ? 'on' : ''}`}
                  onClick={() => setFormat(f.id)}
                  title={f.desc}
                >
                  {f.label}
                </button>
              ))}
              <span className="dl-chip disabled" title="暂未支持">GIF</span>
              <span className="dl-chip disabled" title="暂未支持">MP4</span>
            </div>
            <p className="dl-hint">
              {FORMAT_OPTIONS.find((f) => f.id === format)?.desc}
            </p>
          </section>

          {/* 导出分辨率 */}
          <section className="dl-section">
            <h3 className="dl-section-title">导出分辨率</h3>
            <div className="dl-chip-group">
              {SIZE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`dl-chip ${presetId === p.id ? 'on' : ''}`}
                  onClick={() => handlePresetChange(p.id)}
                >
                  {p.id === 'orig' ? `原始 (${srcW}×${srcH})` : p.label}
                </button>
              ))}
            </div>

            {presetId === 'custom' && (
              <div className="dl-custom">
                <label className="dl-input-label">
                  宽
                  <input
                    type="number"
                    min={1}
                    max={4096}
                    value={customW}
                    onChange={(e) => updateCustomW(Number(e.target.value))}
                  />
                </label>
                <span className="dl-times">×</span>
                <label className="dl-input-label">
                  高
                  <input
                    type="number"
                    min={1}
                    max={4096}
                    value={customH}
                    onChange={(e) => updateCustomH(Number(e.target.value))}
                  />
                </label>
                <label className="dl-aspect">
                  <input
                    type="checkbox"
                    checked={aspectLocked}
                    onChange={(e) => setAspectLocked(e.target.checked)}
                  />
                  等比
                </label>
              </div>
            )}

            <p className="dl-hint">
              {presetId === 'orig'
                ? '保持原始分辨率。'
                : `等比缩放到 ${targetWidth}×${targetHeight}。`}
            </p>
          </section>

          {/* 缩放算法 */}
          <section className="dl-section">
            <h3 className="dl-section-title">缩放算法</h3>
            <div className="dl-chip-group">
              <button
                type="button"
                className={`dl-chip ${smoothing === 'smooth' ? 'on' : ''}`}
                onClick={() => setSmoothing('smooth')}
              >
                平滑缩放
              </button>
              <button
                type="button"
                className={`dl-chip ${smoothing === 'pixel' ? 'on' : ''}`}
                onClick={() => setSmoothing('pixel')}
              >
                像素风格
              </button>
            </div>
            <p className="dl-hint">
              {smoothing === 'smooth'
                ? '适合照片、半透明过渡，效果柔顺。'
                : '适合像素艺术、最近邻，保持硬边缘。'}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
