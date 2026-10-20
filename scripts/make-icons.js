"use strict";

// Génère les icônes de Twitch Deck (PNG) sans dépendance : fond violet Twitch, trois cartes empilées
// (le « deck »), celle de devant en mini lecteur vidéo avec badge « LIVE ».
// Même dessin que public/icons/icon.svg (coordonnées sur 100). Usage : node scripts/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "public", "icons");
const BG = [145, 70, 255];     // #9146ff
const WHITE = [255, 255, 255];
const SCREEN = [24, 24, 27];   // #18181b
const RED = [233, 25, 22];     // #e91916
const SOFT = [205, 186, 248];  // #cdbaf8
const SS = 4;                  // suréchantillonnage pour l'anticrénelage

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Point dans un polygone convexe (sommets dans l'ordre)
function inConvex(x, y, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign && Math.sign(c) !== sign) return false;
      sign = Math.sign(c);
    }
  }
  return true;
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Lettres « LIVE » du badge, en traits (coordonnées sur 100)
const LIVE_RECTS = [
  [27.6, 41.7, 28.4, 45.3], [27.6, 44.5, 30.0, 45.3],                          // L
  [30.8, 41.7, 31.6, 45.3],                                                    // I
  [36.9, 41.7, 37.7, 45.3], [36.9, 41.7, 39.0, 42.4], [36.9, 43.15, 38.6, 43.85], [36.9, 44.6, 39.0, 45.3], // E
];
const LIVE_POLYS = [
  [[32.4, 41.7], [33.3, 41.7], [34.6, 45.3], [33.7, 45.3]],                    // V, trait gauche
  [[35.0, 41.7], [35.9, 41.7], [34.6, 45.3], [33.7, 45.3]],                    // V, trait droit
];

// Couleur d'un point en coordonnées 0..1. maskable : fond plein bord à bord (Android découpe lui-même)
function shade(u, v, maskable) {
  const inside = maskable || inRoundRect(u, v, 0, 0, 1, 1, 0.22);
  if (!inside) return null;
  const k = maskable ? 0.8 : 1; // zone sûre des icônes « maskable »
  // Point courant ramené dans le repère du dessin (sur 100)
  const x = (0.5 + (u - 0.5) / k) * 100, y = (0.5 + (v - 0.5) / k) * 100;
  const rect = (x0, y0, x1, y1, r) => inRoundRect(x, y, x0, y0, x1, y1, r);

  let c = BG;
  if (rect(31, 17, 81, 59, 7)) c = mix(c, WHITE, 0.3);    // carte du fond
  if (rect(25, 25, 75, 67, 7)) c = mix(c, WHITE, 0.55);   // carte du milieu
  if (rect(19, 33, 69, 79, 7)) {                          // carte de devant : mini lecteur
    c = WHITE;
    if (rect(24, 38, 64, 63, 3)) c = SCREEN;
    if (inConvex(x, y, [[40, 45], [49, 50.5], [40, 56]])) c = WHITE; // lecture
    if (rect(26.5, 40.5, 39.5, 46.5, 1.5)) {
      c = RED;
      if (LIVE_RECTS.some(([a, b, cc, d]) => x >= a && x <= cc && y >= b && y <= d) ||
          LIVE_POLYS.some((p) => inConvex(x, y, p))) c = WHITE;
    }
    if (rect(24, 67, 50, 71.5, 2.25)) c = BG;
    if (rect(24, 73.5, 41, 76.5, 1.5)) c = SOFT;
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
