#!/usr/bin/env node
// Writes the Meeting Capture toolbar icons with no image library: an RGBA buffer
// encoded straight into PNG chunks (zlib IDAT, CRC32 per chunk). Re-runnable:
//   node .claude/skills/meeting-brief/scripts/extension-icons.mjs
//
// The mark is a record dot on a rounded square. Two sets:
//   icon-<n>.png  --pri square, white dot   (idle)
//   rec-<n>.png   --bad square, white dot   (recording; swapped in by background.js)
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
// Light-palette values matching ui.css: --pri (blue), --bad (red), --pri-ink (white).
const PRI = [0x1f, 0x6f, 0xeb];
const BAD = [0xc0, 0x33, 0x2e];
const INK = [0xff, 0xff, 0xff];

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 4x4 supersampling per pixel: the square's corner arcs and the dot's edge stay smooth
// even at 16px, where every edge pixel is a large fraction of the shape.
function makeIcon(size, fill) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;
  const dotR = size * 0.2;
  const c = size / 2;
  const S = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sq = 0; let dot = 0;
      for (let j = 0; j < S; j += 1) {
        for (let i = 0; i < S; i += 1) {
          const sx = x + (i + 0.5) / S; const sy = y + (j + 0.5) / S;
          const cx = Math.min(Math.max(sx, radius), size - radius);
          const cy = Math.min(Math.max(sy, radius), size - radius);
          if (Math.hypot(sx - cx, sy - cy) <= radius) sq += 1;
          if (Math.hypot(sx - c, sy - c) <= dotR) dot += 1;
        }
      }
      const a = sq / (S * S); const d = dot / (S * S);
      if (a === 0) continue;
      const i4 = (y * size + x) * 4;
      // The dot sits wholly inside the square, so mixing by the dot coverage is exact.
      for (let k = 0; k < 3; k += 1) px[i4 + k] = Math.round(fill[k] * (1 - d) + INK[k] * d);
      px[i4 + 3] = Math.round(a * 255);
    }
  }
  return png(size, px);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon-${size}.png`), makeIcon(size, PRI));
  writeFileSync(join(OUT, `rec-${size}.png`), makeIcon(size, BAD));
}
console.log(`wrote icon-{16,32,48,128}.png and rec-{16,32,48,128}.png to ${OUT}`);
