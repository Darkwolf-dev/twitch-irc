"use strict";

// Centre de notifications du panneau : chaque alerte (live, mention, sécurité…) y est gardée.
// Vue sur un appareil = vue partout ; une alerte vue reste 24 h dans l'historique, puis disparaît.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_ITEMS = 50;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const SEEN_KEEP_MS = 24 * 3600_000;

class Inbox {
  constructor({ dataDir, log }) {
    this.file = path.join(dataDir, "inbox.json");
    this.log = log;
    try {
      this.items = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(this.items)) this.items = [];
    } catch {
      this.items = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`[inbox] Écriture impossible : ${err.message}`);
    }
  }

  // Renvoie l'identifiant de l'alerte (bouton « Vu » de la notification)
  add({ kind, title, body, channel, icon }) {
    const id = crypto.randomBytes(6).toString("hex");
    this.items.push({
      id,
      kind,
      title: String(title ?? "").slice(0, 200),
      body: String(body ?? "").slice(0, 300),
      channel: channel || null,
      icon: icon || null,
      at: new Date().toISOString(),
      seenAt: null,
    });
    this.prune();
    return id;
  }

  // Vu (sur n'importe quel appareil). ids absent : tout ce qui est actuellement dans la boîte.
  markSeen(ids) {
    const wanted = Array.isArray(ids) ? new Set(ids) : null;
    const now = new Date().toISOString();
    for (const item of this.items) {
      if ((!wanted || wanted.has(item.id)) && !item.seenAt) item.seenAt = now;
    }
    this.prune();
  }

  clear() {
    this.items = [];
    this.save();
  }

  // Retire les alertes vues depuis plus de 24 h et celles de plus de 7 jours, garde les 50 plus récentes
  prune() {
    const now = Date.now();
    this.items = this.items
      .filter((item) => now - Date.parse(item.at) < MAX_AGE_MS)
      .filter((item) => !item.seenAt || now - Date.parse(item.seenAt) < SEEN_KEEP_MS)
      .map((item) => ({ ...item, seenAt: item.seenAt ?? null, seenBy: undefined })) // ancien format
      .slice(-MAX_ITEMS);
    this.save();
  }

  // Les alertes vues expirent avec le temps, sans autre événement : nettoyage à la lecture
  list() {
    const now = Date.now();
    if (this.items.some((item) => item.seenAt && now - Date.parse(item.seenAt) >= SEEN_KEEP_MS)) this.prune();
    return this.items.slice().reverse();
  }
}

module.exports = { Inbox };
