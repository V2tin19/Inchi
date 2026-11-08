/**
 * make-icons.mjs —— 用纯 Node 生成 PWA 图标（无第三方依赖）
 * 图形：Nord 岩石灰圆角底 + 三块垒起的石堆（Cairn），青/绿/金三层。
 * 跑法：node scripts/make-icons.mjs  → 覆盖 icons/icon-192.png 与 icon-512.png
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- PNG 编码最小实现 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 图形：圆角底 + 三层石堆（胶囊） ---------- */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex('#1E222A');
const STONES = ['#88C0D0', '#A3BE8C', '#EBCB8B'].map(hex);

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function makeIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  const r = S * 0.22;                       // 底板圆角
  const stoneH = S * 0.13, gap = S * 0.05;
  const widths = [0.52, 0.44, 0.36];        // 下宽上窄
  const centerY = S * 0.5 + stoneH * 1.5 + gap;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const onTile = inRoundedRect(x + 0.5, y + 0.5, 0, 0, S, S, r);
      if (!onTile) { px[i + 3] = 0; continue; }
      px[i] = BG[0]; px[i + 1] = BG[1]; px[i + 2] = BG[2]; px[i + 3] = 255;
      for (let k = 0; k < 3; k++) {
        const w = S * widths[k];
        const cy = centerY - k * (stoneH + gap);
        if (inRoundedRect(x + 0.5, y + 0.5, S / 2 - w / 2, cy - stoneH / 2, S / 2 + w / 2, cy + stoneH / 2, stoneH / 2)) {
          px[i] = STONES[k][0]; px[i + 1] = STONES[k][1]; px[i + 2] = STONES[k][2];
        }
      }
    }
  }
  return encodePNG(S, S, px);
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log('生成', file, fs.statSync(file).size, 'bytes');
}
