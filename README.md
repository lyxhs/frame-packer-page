# FramePacker · 离线版（纯前端）

本目录是 FramePacker 的**纯前端离线版本**：功能与原版完全一致（视频拆帧 → 逐帧编辑 → 动画预览 → 打包下载），但**不依赖任何后端服务器**，所有处理都在浏览器内完成。

## 与原版的区别

| 能力 | 原版（server/ + src/） | 离线版（offline/） |
| --- | --- | --- |
| 视频拆帧 | 后端 ffmpeg | 浏览器内 **ffmpeg.wasm** |
| 帧存储 | 后端磁盘 `/sessions` | 浏览器内存（Blob URL） |
| 编辑保存 | `/api/save-frame` 等 | 内存覆盖，刷新页面后清空 |
| 打包下载 | 后端 jszip | 前端 **jszip** |
| 运行要求 | Node 服务 + 浏览器 | 任意静态文件服务器（或直接 `vite preview`） |

> 注意：离线版的帧数据保存在浏览器内存中，**刷新或关闭页面会丢失**。如需持久化请使用打包下载导出 ZIP。

## 运行方式

### 方式一：开发预览
```bash
cd offline
npm install
npm run dev          # 启动 Vite 开发服务器（默认 5173）
```

### 方式二：纯静态托管（推荐用于“离线”场景）
```bash
cd offline
npm install
npm run build        # 产物输出到 offline/dist/
# 用任意静态服务器托管 dist/ 即可，例如：
npx vite preview      # 或 npx serve dist
```
`dist/` 下已包含 ffmpeg 的 wasm 运行时（`dist/ffmpeg/`），**无需联网**即可拆帧。

> 由于浏览器安全策略，部分功能（如 ffmpeg.wasm 的 Worker）建议通过 `http://` 访问，
> 而非直接 `file://` 双击打开。用上面的静态服务器即可正常体验全部功能。

## 依赖说明
- `@ffmpeg/ffmpeg` + `@ffmpeg/core`：浏览器端视频拆帧（已随 `dist/ffmpeg/` 打包，离线可用）
- `jszip`：前端把编辑后的帧打包为 ZIP
- `react` / `react-dom`：UI 框架
- `vite` + `@vitejs/plugin-react`：构建工具

## 功能一览
1. **提取画面**：上传视频，设置截取区间与 FPS，一键拆成序列帧。
2. **编辑调整**：画笔 / 橡皮擦 / 矩形 / 椭圆 / 填充 / 换色 / 透明，支持撤销重做、逐帧还原、批量应用（多次批量会累加而非覆盖）。
3. **动画预览**：以设定 FPS 播放编辑后的帧序列。
4. **打包下载**：将所有编辑后的帧打包成 `frames.zip` 下载。
