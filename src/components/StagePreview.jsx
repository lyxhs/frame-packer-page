import React, { useRef, useState, useEffect } from 'react';
import '../styles/preview-download.css';

export default function StagePreview({ session, onNext, onBack }) {
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef(null);
  const lastTsRef = useRef(0);
  const accRef = useRef(0);

  const fps = session.extractFps || 12;
  const interval = 1000 / (fps * speed);

  useEffect(() => {
    if (!playing) return;
    function loop(ts) {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = ts - lastTsRef.current;
      lastTsRef.current = ts;
      accRef.current += dt;
      if (accRef.current >= interval) {
        accRef.current = 0;
        setFrame((f) => (f + 1) % session.frameCount);
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, interval, session.frameCount]);

  function step(dir) {
    setPlaying(false);
    setFrame((f) => (f + dir + session.frameCount) % session.frameCount);
  }

  return (
    <div className="preview-wrap fade-in">
      <div className="preview-head">
        <button className="btn btn-sm btn-ghost" onClick={onBack}>← 返回编辑</button>
        <h2>动画预览</h2>
        <span className="preview-meta">
          {session.frameCount} 帧 · {fps} fps
        </span>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-primary btn-sm" onClick={onNext}>完成，去下载 →</button>
      </div>

      <div className="preview-stage">
        <div className="preview-canvas checkerboard">
          <img
            key={frame}
            src={`${session.frames[frame].url}#f=${frame}`}
            alt={`frame ${frame}`}
            className="preview-img"
          />
        </div>
      </div>

      <div className="preview-controls">
        <button className="pc-btn" onClick={() => step(-1)}>⏮</button>
        <button className="pc-btn play" onClick={() => { setPlaying((p) => !p); lastTsRef.current = 0; }}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="pc-btn" onClick={() => step(1)}>⏭</button>
        <div className="preview-track">
          <input
            type="range"
            min={0}
            max={session.frameCount - 1}
            value={frame}
            onChange={(e) => { setPlaying(false); setFrame(parseInt(e.target.value)); }}
            style={{ flex: 1 }}
          />
          <span className="frame-num">
            {frame + 1} / {session.frameCount}
          </span>
        </div>
        <div className="speed-ctrl">
          <span>速度</span>
          {[0.25, 0.5, 1, 2].map((s) => (
            <button
              key={s}
              className={`speed-chip ${speed === s ? 'on' : ''}`}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
