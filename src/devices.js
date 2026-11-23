"use strict";

// Appareils de l'appli Android native : jumelés avec un code à usage unique affiché dans le panneau,
// ils reçoivent ensuite leur propre clé d'accès (révocable). Seule l'empreinte de la clé est gardée.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CODE_TTL_MS = 5 * 60_000;
const MAX_DEVICES = 10;
const TOKEN_PREFIX = "tdapp_";
// Sans 0/O ni 1/I/L : un code lisible à recopier
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

class AppDevices {
  constructor({ dataDir, log }) {
    this.file = path.join(dataDir, "app-devices.json");
    this.log = log;
    this.codes = new Map(); // code -> { expiresAt, by }
    try {
      this.devices = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(this.devices)) this.devices = [];
    } catch {
      this.devices = [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Code de jumelage « ABCD-2345 », valable 5 minutes, utilisable une fois
  newCode(by) {
    const now = Date.now();
    for (const [code, c] of this.codes) if (c.expiresAt < now) this.codes.delete(code);
    const chars = [...crypto.randomBytes(8)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
    this.codes.set(code, { expiresAt: now + CODE_TTL_MS, by });
    return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  }

  // Échange un code contre une clé d'accès. Renvoie { token, device } ou { error }.
  pair(rawCode, label) {
    const code = String(rawCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
    const entry = this.codes.get(code);
    if (!entry || entry.expiresAt < Date.now()) return { error: "Code invalide ou expiré : génères-en un nouveau dans le panneau" };
    this.codes.delete(code);
    if (this.devices.length >= MAX_DEVICES) return { error: `${MAX_DEVICES} appareils au maximum : retires-en un dans le panneau` };
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    const device = {
      id: crypto.randomBytes(6).toString("hex"),
      label: String(label ?? "").trim().slice(0, 60) || "Téléphone",
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      pairedBy: entry.by,
    };
    this.devices.push(device);
    this.save();
    this.log.log(`[appli] Appareil jumelé : ${device.label} (par ${entry.by})`);
    return { token, device: this.publicDevice(device) };
  }

  // Appareil correspondant à l'en-tête Authorization, ou null
  authenticate(authorization) {
    const token = String(authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const h = Buffer.from(hash(token), "hex");
    const device = this.devices.find((d) => {
      const stored = Buffer.from(d.tokenHash, "hex");
      return stored.length === h.length && crypto.timingSafeEqual(stored, h);
    });
    if (!device) return null;
    // Dernière activité, écrite au plus toutes les 10 minutes
    const now = Date.now();
    if (!device.lastSeenAt || now - Date.parse(device.lastSeenAt) > 10 * 60_000) {
      device.lastSeenAt = new Date(now).toISOString();
      this.save();
    }
    return device;
  }

  isAppToken(authorization) {
    return String(authorization ?? "").replace(/^Bearer\s+/i, "").startsWith(TOKEN_PREFIX);
  }

  remove(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  publicDevice({ id, label, createdAt, lastSeenAt }) {
    return { id, label, createdAt, lastSeenAt };
  }

  list() {
    return this.devices.map((d) => this.publicDevice(d));
  }
}

module.exports = { AppDevices };
