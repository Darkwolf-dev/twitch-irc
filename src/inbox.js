"use strict";

// Centre de notifications du panneau : chaque alerte (live, mention, sécurité…) y est gardée
// jusqu'à ce que tous les appareils l'aient vue. « Vu » est enregistré par appareil.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_ITEMS = 50;
const MAX_AGE_MS = 7 * 24 * 3600_000;
const DEVICE_RE = /^[\w-]{6,40}$/;

class Inbox {
  // requiredDevices() : identifiants des appareils qui doivent avoir vu une alerte pour qu'elle disparaisse
  constructor({ dataDir, requiredDevices, log }) {
    this.file = path.join(dataDir, "inbox.json");
    this.requiredDevices = requiredDevices;
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

  add({ kind, title, body, channel, icon }) {
    this.items.push({
      id: crypto.randomBytes(6).toString("hex"),
      kind,
      title: String(title ?? "").slice(0, 200),
      body: String(body ?? "").slice(0, 300),
      channel: channel || null,
      icon: icon || null,
      at: new Date().toISOString(),
      seenBy: [],
    });
    this.prune();
  }

  // Vu sur cet appareil. ids absent : tout ce qui est actuellement dans la boîte.
  markSeen(device, ids) {
    if (!DEVICE_RE.test(device ?? "")) return false;
    const wanted = Array.isArray(ids) ? new Set(ids) : null;
    for (const item of this.items) {
      if ((!wanted || wanted.has(item.id)) && !item.seenBy.includes(device)) item.seenBy.push(device);
    }
    this.prune();
    return true;
  }

  clear() {
    this.items = [];
    this.save();
  }

  // Retire ce que tous les appareils ont vu (ou, sans appareil abonné, ce qu'un appareil a vu),
  // les alertes de plus de 7 jours, et garde les 50 plus récentes
  prune() {
    const required = this.requiredDevices();
    const now = Date.now();
    this.items = this.items
      .filter((item) => now - Date.parse(item.at) < MAX_AGE_MS)
      .filter((item) => required.length
        ? !required.every((d) => item.seenBy.includes(d))
        : item.seenBy.length === 0)
      .slice(-MAX_ITEMS);
    this.save();
  }

  list() {
    return this.items.slice().reverse();
  }
}

module.exports = { Inbox };
