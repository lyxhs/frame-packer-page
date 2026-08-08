import React, { useRef, useState, useEffect } from 'react';
import '../styles/extract.css';
import { probeVideo, extractFrames } from '../lib/ffmpegClient.js';
import { createSession } from '../lib/frameStore.js';

export default function StageExtract({ onExtracted }) {
  const [file, setFile] = useState(null);
  const [videoInfo, setVideoInfo] = useState(null);
  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [fps, setFps] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);

  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError('');
    setFile(f);
    setVideoInfo(null);
    const url = URL.createObjectURL(f);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const d = v.duration;
      setDuration(d);
      setTrimStart(0);
      setTrimEnd(d);
      // 初始 fps 上限先用 30 占位，等 probeVideo 拿到真实 fps 后会覆盖。
      setFps(30);
      setVideoInfo({ name: f.name, size: f.size, url, serverFps: 30, width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => setError('无法读取该视频文件，请确认格式受支持。');
    v.src = url;
  }

  // 浏览器内探测真实信息（替代 /api/probe）
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    probeVideo(file)
      .then((d) => {
        if (cancelled) return;
        // 真实 fps：仅当探测成功（MP4 容器内已解析到 timescale/sampleDelta）时覆盖默认上限。
        const detectedFps = d.fps && isFinite(d.fps) && d.fps > 0 ? Math.round(d.fps) : null;
        setVideoInfo((vi) => ({
          ...vi,
          serverFps: detectedFps || vi?.serverFps || 30,
          width: d.width,
          height: d.height,
        }));
        if (d.duration && d.duration > 0) {
          setDuration(d.duration);
          setTrimEnd(d.duration);
        }
        // 用真实帧率初始化 fps（不超过上限）。
        if (detectedFps) {
          setFps((cur) => (cur && cur <= detectedFps ? cur : Math.min(60, detectedFps)));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [file]);

  function onTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    // keep preview clamped to trim window
    if (v.currentTime < trimStart) v.currentTime = trimStart;
    if (v.currentTime > trimEnd) {
      v.pause();
      setPlaying(false);
      v.currentTime = trimEnd;
    }
  }

  async function startExtract() {
    if (!file) return;
    setLoading(true);
    setError('');
    const logLines = [];
    const doTrim =
      isFinite(trimEnd) && isFinite(trimStart) && trimEnd > trimStart && trimStart >= 0;
    try {
      const { frames } = await extractFrames(file, {
        fps,
        trimStart,
        trimEnd,
        onProgress: (cur, total, msg) => {
          setError(`正在解码帧 ${cur}/${total}…`);
        },
        onLog: (m) => {
          // 仅保留错误/警告以及关键的 ffmpeg 输出
          if (
            /error|fail|invalid|cannot|unable|missing|aborted/i.test(m) ||
            /Output #|Stream #|frame=|fps=|Duration:/i.test(m)
          ) {
            logLines.push(m);
          }
        },
      });
      if (!frames.length) {
        const detail = logLines.slice(-12).join('\n');
        throw new Error('未能从视频中拆出任何帧。\n' + detail);
      }

      const actualDuration = doTrim ? trimEnd - trimStart : duration;
      const session = createSession({
        frames,
        fps,
        video: {
          width: videoInfo?.width || 0,
          height: videoInfo?.height || 0,
          duration: actualDuration,
        },
      });
      onExtracted(session);
    } catch (err) {
      setError(err.message || '提取失败');
    } finally {
      setLoading(false);
    }
  }

  const maxFps = videoInfo?.serverFps ? Math.min(60, Math.ceil(videoInfo.serverFps)) : 60;

  return (
    <div className="extract-wrap fade-in">
      <div className="extract-hero">
        <h1>把视频变成一帧帧动画</h1>
        <p>上传视频，截取想保留的片段，设定每秒帧数，一键拆成可编辑的序列帧。</p>
      </div>

      {!file && (
        <div
          className="dropzone"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.[0]) handleFile({ target: { files: e.dataTransfer.files } });
          }}
        >
          <div className="dropzone-icon">⤓</div>
          <div className="dropzone-title">点击或拖拽视频到此处</div>
          <div className="dropzone-sub">支持 MP4 / WebM / MOV 等常见格式，最大 2GB</div>
          <input ref={fileInputRef} type="file" accept="video/*" hidden onChange={handleFile} />
        </div>
      )}

      {file && videoInfo && (
        <div className="extract-grid">
          <div className="extract-player panel">
            <video
              ref={videoRef}
              src={videoInfo.url}
              className="extract-video"
              onTimeUpdate={onTimeUpdate}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              controls={false}
            />
            <div className="extract-controls">
              <button
                className="play-btn"
                onClick={() => {
                  const v = videoRef.current;
                  if (playing) v.pause();
                  else {
                    if (v.currentTime < trimStart || v.currentTime >= trimEnd) v.currentTime = trimStart;
                    v.play();
                  }
                }}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <input
                type="range"
                className="timeline"
                min={0}
                max={duration}
                step={0.01}
                value={(videoRef.current?.currentTime) || trimStart}
                onChange={(e) => {
                  const t = parseFloat(e.target.value);
                  videoRef.current.currentTime = t;
                }}
              />
              <span className="time-label">
                {fmt(videoRef.current?.currentTime || 0)} / {fmt(duration)}
              </span>
            </div>

            {/* trim range */}
            <div className="trim-area">
              <div className="trim-head">
                <span>截取区间</span>
                <span className="trim-vals">
                  {fmt(trimStart)} – {fmt(trimEnd)}（{fmt(trimEnd - trimStart)} 秒）
                </span>
              </div>
              <div className="dual-range">
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={trimStart}
                  onChange={(e) => {
                    const v = Math.min(parseFloat(e.target.value), trimEnd - 0.1);
                    setTrimStart(v);
                    if (videoRef.current) videoRef.current.currentTime = v;
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.01}
                  value={trimEnd}
                  onChange={(e) => {
                    const v = Math.max(parseFloat(e.target.value), trimStart + 0.1);
                    setTrimEnd(v);
                    if (videoRef.current) videoRef.current.currentTime = v;
                  }}
                />
              </div>
            </div>
          </div>

          <div className="extract-side">
            <div className="panel info-card">
              <h3>视频信息</h3>
              <Row label="文件名" value={videoInfo.name} />
              <Row label="时长" value={`${fmt(duration)} 秒`} />
              <Row label="原始帧率" value={videoInfo.serverFps ? `${videoInfo.serverFps} fps` : '探测中…'} />
              <Row label="分辨率" value={videoInfo.width ? `${videoInfo.width}×${videoInfo.height}` : '—'} />
            </div>

            <div className="panel fps-card">
              <h3>每秒帧数 (FPS)</h3>
              <p className="hint">不可大于原视频帧率，最高 60。</p>
              <div className="fps-presets">
                {[1, 6, 12, 24, 30, 60].map((p) => (
                  <button
                    key={p}
                    className={`fps-chip ${fps === p ? 'on' : ''} ${p > maxFps ? 'disabled' : ''}`}
                    disabled={p > maxFps}
                    onClick={() => setFps(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="fps-slider">
                <input
                  type="range"
                  min={1}
                  max={maxFps}
                  step={1}
                  value={Math.min(fps, maxFps)}
                  onChange={(e) => setFps(parseInt(e.target.value))}
                />
                <span className="fps-value">{Math.min(fps, maxFps)} fps</span>
              </div>
              <div className="extract-est">
                预计提取约 <b>{Math.max(1, Math.round((trimEnd - trimStart) * Math.min(fps, maxFps)))}</b> 帧
              </div>
            </div>

            {error && <div className="error-box">{error}</div>}

            <button className="btn btn-primary extract-go" disabled={loading} onClick={startExtract}>
              {loading ? '正在提取帧…' : '确认提取 →'}
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div className="extract-loading">
          <div className="spinner" />
          <span>正在用 ffmpeg 拆分视频为帧…</span>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function fmt(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}
