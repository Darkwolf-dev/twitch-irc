"use strict";

// Génère les icônes de Twitch Deck (PNG) sans dépendance : fond violet en dégradé, trois cartes
// empilées (le « deck »), la première avec un point rouge « live » et deux lignes de texte.
// Même dessin que public/icons/icon.svg. Usage : node scripts/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "icons");
const TOP = [139, 68, 247];    // #8b44f7
const BOTTOM = [91, 31, 191];  // #5b1fbf
const WHITE = [255, 255, 255];
const RED = [233, 25, 22];     // #e91916
const INK = [119, 44, 232];    // #772ce8
const SOFT = [205, 186, 248];  // #cdbaf8
const SS = 4;                  // suréchantillonnage pour l'anticrénelage

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Couleur d'un point en coordonnées 0..1. maskable : fond plein bord à bord (Android découpe lui-même)
function shade(u, v, maskable) {
  const inside = maskable || inRoundRect(u, v, 0, 0, 1, 1, 0.22);
  if (!inside) return null;
  const k = maskable ? 0.8 : 1; // zone sûre des icônes « maskable »
  const m = (a) => 0.5 + (a - 0.5) * k;
  const rect = (x0, y0, x1, y1, r) => inRoundRect(u, v, m(x0), m(y0), m(x1), m(y1), r * k);

  let c = mix(TOP, BOTTOM, v);
  if (rect(0.31, 0.17, 0.81, 0.59, 0.07)) c = mix(c, WHITE, 0.32); // carte du fond
  if (rect(0.25, 0.25, 0.75, 0.67, 0.07)) c = mix(c, WHITE, 0.6);  // carte du milieu
  if (rect(0.19, 0.33, 0.69, 0.79, 0.07)) {                        // carte de devant
    c = WHITE;
    if ((u - m(0.3)) ** 2 + (v - m(0.47)) ** 2 <= (0.05 * k) ** 2) c = RED;
    if (rect(0.38, 0.44, 0.6, 0.5, 0.03)) c = INK;
    if (rect(0.27, 0.6, 0.6, 0.66, 0.03)) c = SOFT;
    if (rect(0.27, 0.69, 0.5, 0.73, 0.02)) c = SOFT;
  }
  return c;
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
