// 从 MP4/MOV 等 ISO BMFF 容器中读取 fps（与 ffmpeg.wasm 探测无关）。
// 解析 moov.trak.mdia.minf.stbl.stts / stsd 的 timescale + sample delta，得出平均 fps。
// 在浏览器中纯前端完成，不会触发解码。

const SAMPLE_PREFIX_BYTES = 1024 * 1024 * 4; // 读前 4MB 足以覆盖通常位于文件头部的 moov

async function readHeaderSlices(file, totalBytesNeeded) {
  const chunkSize = Math.min(SAMPLE_PREFIX_BYTES, file.size);
  return file.slice(0, chunkSize).arrayBuffer();
}

function readUint32(buffer, offset) {
  return (buffer[offset] * 0x1000000) +
    ((buffer[offset + 1] << 16) >>> 0) +
    (buffer[offset + 2] << 8) +
    buffer[offset + 3];
}

function readUint16(buffer, offset) {
  return (buffer[offset] << 8) + buffer[offset + 1];
}

function readUint64(buffer, offset) {
  // 这里只用作 ftyp/moov 大小检查，safari/js 安全整数，足够
  const high = readUint32(buffer, offset);
  const low = readUint32(buffer, offset + 4);
  return high * 0x100000000 + low;
}

// 递归遍历 box；命中 video track 时返回 { timescale, sampleDelta }
function findVideoFpsBox(box, depth = 0) {
  // box: { type, body, startOffset }
  if (!box) return null;
  // 找 trak -> mdia -> minf -> stbl -> stts
  if (box.type === 'trak') {
    const mdia = findChild(box, 'mdia');
    if (!mdia) return null;
    const hdlr = findChild(mdia, 'hdlr');
    if (hdlr) {
      // version(1) + flags(3) + preDefined(4) + handlerType(4) = 12 (full) or 8 (legacy)
      const body = hdlr.body;
      let handlerType = '';
      for (let i = 0; i < 4; i++) handlerType += String.fromCharCode(body[8 + i]);
      if (handlerType !== 'vide') {
        return null; // 非视频轨
      }
    }
    const minf = findChild(mdia, 'minf');
    if (!minf) return null;
    const stbl = findChild(minf, 'stbl');
    if (!stbl) return null;
    const stts = findChild(stbl, 'stts');
    if (!stts) return null;
    const mdhd = findChild(mdia, 'mdhd');
    let timescale = 1;
    if (mdhd) {
      // mdhd.version=0: ct(4)+mt(4)+timescale(4)+duration(4) => timescale 在 offset 12
      // mdhd.version=1: ct(8)+mt(8)+timescale(4)+duration(8) => timescale 在 offset 20
      const version = mdhd.body[0];
      const tsOffset = version === 1 ? 20 : 12;
      if (mdhd.body.length >= tsOffset + 4) {
        timescale = readUint32(mdhd.body, tsOffset);
      }
    }
    // stts body: version(1) + flags(3) + entryCount(4) + entries[(count,delta)...]
    const body = stts.body;
    const entryCount = readUint32(body, 4);
    if (entryCount > 0) {
      // 每个 entry 是 [sample_count(4)][sample_delta(4)]。
      // sample_delta 是相邻两个 sample 之间跨越 timescale 单位的数量，fps = timescale / sample_delta。
      const sampleCount = readUint32(body, 8);
      const sampleDelta = readUint32(body, 12);
      return { timescale, sampleDelta, sampleCount };
    }
  }
  for (const child of box.children || []) {
    const r = findVideoFpsBox(child, depth + 1);
    if (r) return r;
  }
  return null;
}

function findChild(box, type) {
  return (box.children || []).find((c) => c.type === type) || null;
}

// 顶层解析：返回根 boxes
function parseBoxes(buffer, offset, end) {
  const boxes = [];
  let p = offset;
  while (p < end) {
    if (p + 8 > end) break;
    let size = readUint32(buffer, p);
    const type =
      String.fromCharCode(buffer[p + 4]) +
      String.fromCharCode(buffer[p + 5]) +
      String.fromCharCode(buffer[p + 6]) +
      String.fromCharCode(buffer[p + 7]);
    let headerLen = 8;
    if (size === 1) {
      size = readUint64(buffer, p + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerLen) break;
    const bodyStart = p + headerLen;
    const bodyEnd = p + size;
    // container box
    const container = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'].includes(type);
    let node;
    if (container && bodyEnd <= end) {
      const children = parseBoxes(buffer, bodyStart, bodyEnd);
      node = { type, children };
    } else {
      node = {
        type,
        body: buffer.slice(bodyStart, Math.min(bodyEnd, end)),
      };
    }
    node._start = p;
    boxes.push(node);
    p = bodyEnd;
  }
  return boxes;
}

export async function readVideoFps(file) {
  // 仅读取头部就够；若 moov 在末尾（罕见于网络流）将返回 null
  const buffer = new Uint8Array(await readHeaderSlices(file));
  const boxes = parseBoxes(buffer, 0, buffer.length);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return null;
  const r = findVideoFpsBox(moov);
  if (!r || !r.timescale || !r.sampleDelta) return null;
  // fps = timescale / sampleDelta（每个 sample 跨越的 timescale 单位数）
  const fps = r.timescale / r.sampleDelta;
  // 一些 mp4 把 timescale 设成较大的 tbn（x264 16384），导致 timescale/sampleDelta 远高于实际帧率。
  // 钳到合理范围 [1, 240]，否则返回 null 让 UI 回退到默认值（30）。
  if (!isFinite(fps) || fps < 1 || fps > 240) return null;
  return fps;
}
