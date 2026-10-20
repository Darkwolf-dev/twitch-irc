"use strict";

// Génère les icônes de l'appli (PNG) sans dépendance : fond violet arrondi, bulle de chat blanche.
// Usage : node scripts/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "icons");
const BG = [124, 58, 237];   // #7c3aed
const FG = [255, 255, 255];
const SS = 4;                // suréchantillonnage pour l'anticrénelage

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if ((s < 0) !== (t < 0) && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return d === 0 || (d < 0) === (s + t <= 0);
}

// Couleur d'un point en coordonnées 0..1. maskable : fond plein bord à bord (Android découpe lui-même)
function shade(u, v, maskable) {
  const inside = maskable || inRoundRect(u, v, 0, 0, 1, 1, 0.22);
  if (!inside) return null;
  const k = maskable ? 0.8 : 1; // zone sûre des icônes « maskable »
  const m = (a) => 0.5 + (a - 0.5) * k;
  const bubble =
    inRoundRect(u, v, m(0.2), m(0.24), m(0.8), m(0.66), 0.09 * k) ||
    inTriangle(u, v, [m(0.3), m(0.6)], [m(0.46), m(0.6)], [m(0.28), m(0.8)]);
  if (!bubble) return BG;
  for (const dx of [0.36, 0.5, 0.64]) {
    if ((u - m(dx)) ** 2 + (v - m(0.45)) ** 2 <= (0.045 * k) ** 2) return BG;
  }
  return FG;
}

function render(size, maskable = false) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // octet de filtre + RGBA
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, maskable);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS, cov = a / 255;
      const o = 1 + x * 4;
      row[o] = cov ? r / cov : 0;
      row[o + 1] = cov ? g / cov : 0;
      row[o + 2] = cov ? b / cov : 0;
      row[o + 3] = a / n;
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const byte of buf) {
    c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // 8 bits par canal
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  "icon-192.png": render(192),
  "icon-512.png": render(512),
  "icon-maskable-512.png": render(512, true),
  "apple-touch-icon.png": render(180, true), // iOS arrondit lui-même
};
for (const [name, data] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log(`${name} (${data.length} octets)`);
}
