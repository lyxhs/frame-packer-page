import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 纯静态离线版：所有资源打进 dist/，可直接用任意静态服务器托管，
// 或本地用 `npx vite preview` / `npx serve dist` 预览。
export default defineConfig({
  plugins: [react()],
  // 使用相对路径，保证产物可放在任意子目录直接打开
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  // ffmpeg.wasm 的 worker / wasm 需要以独立文件加载，不要内联
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
});
