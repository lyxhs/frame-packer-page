import React, { useState } from 'react';
import StageExtract from './components/StageExtract.jsx';
import StageEdit from './components/StageEdit.jsx';
import StagePreview from './components/StagePreview.jsx';
import StageDownload from './components/StageDownload.jsx';

const STAGES = [
  { id: 'extract', label: '提取画面' },
  { id: 'edit', label: '编辑调整' },
  { id: 'preview', label: '动画预览' },
  { id: 'download', label: '打包下载' },
];

export default function App() {
  const [stage, setStage] = useState('extract');
  const [session, setSession] = useState(null);
  const stageIndex = STAGES.findIndex((s) => s.id === stage);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▣</span>
          FramePacker
        </div>
        <nav className="stage-steps">
          {STAGES.map((s, i) => (
            <React.Fragment key={s.id}>
              <div className={`stage-step ${stage === s.id ? 'active' : ''} ${i < stageIndex ? 'done' : ''}`}>
                <span className="dot">{i < stageIndex ? '✓' : i + 1}</span>
                {s.label}
              </div>
              {i < STAGES.length - 1 && <span className="stage-sep" />}
            </React.Fragment>
          ))}
        </nav>
      </header>

      <main className="main-area">
        {stage === 'extract' && (
          <StageExtract
            onExtracted={(data) => {
              setSession(data);
              setStage('edit');
            }}
          />
        )}
        {stage === 'edit' && session && (
          <StageEdit session={session} onDone={() => setStage('preview')} />
        )}
        {stage === 'preview' && session && (
          <StagePreview session={session} onNext={() => setStage('download')} onBack={() => setStage('edit')} />
        )}
        {stage === 'download' && session && (
          <StageDownload session={session} onBack={() => setStage('preview')} />
        )}
      </main>
    </div>
  );
}
