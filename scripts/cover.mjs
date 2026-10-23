// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-indigo gradient, a
// garage outline with two sectional doors (one open, one closed) and the
// controller on the wall between them, its status LED lit. Plain Node (zlib),
// no dependency. Adapted from LM1LC3N7/gladys-opengarage (same author).
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [14, 18, 42];
const INDIGO = [70, 60, 170];
const WHITE = [255, 255, 255];
const CYAN = [80, 220, 255];

/** Distance to the border of a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixel(x, y) {
  let color = mix(DARK, INDIGO, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The garage: a roof and walls.
  const roof = Math.abs(y - 70 - Math.abs(x - 400) * 0.45);
  if (x > 180 && x < 620 && y < 175) {
    color = mix(color, WHITE, smooth(5, roof));
  }
  const walls = roundedBox(x, y, 400, 300, 200, 130, 6);
  color = mix(color, WHITE, smooth(5, Math.abs(walls)));
  // Two doors: the left one closed (panels down to the floor), the right one
  // open (a few panels left at the top).
  for (const [left, right, bottom] of [
    [225, 375, 420],
    [425, 575, 225],
  ]) {
    if (x > left && x < right && y > 200 && y < bottom) {
      const panel = (y - 200) % 26;
      color = mix(color, WHITE, panel < 3 ? 0.9 : 0.2);
    }
  }
  // The controller between them, and its status LED with a soft glow.
  color = mix(color, WHITE, smooth(1, roundedBox(x, y, 400, 250, 14, 22, 5)) * 0.9);
  const led = Math.hypot(x - 400, y - 240);
  color = mix(color, CYAN, Math.min(1, smooth(5, led) + Math.max(0, 1 - led / 40) * 0.35));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
