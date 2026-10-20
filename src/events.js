"use strict";

const fs = require("fs");
const path = require("path");

const DAY_MS = 24 * 60 * 60_000;

// Journal d'événements (connexions, coupures, lives, actions), consultable depuis le panneau.
// Les derniers événements sont gardés en mémoire ; avec un dossier, chaque événement est aussi
// ajouté à un fichier par jour (journal-AAAA-MM-JJ.jsonl), conservé keepDays jours.
class EventLog {
  constructor({ size = 300, dir = null, keepDays = 30 } = {}) {
    this.size = size;
    this.dir = dir;
    this.keepDays = keepDays;
    this.items = [];
    this.nextId = 1;
    this.lastPrune = 0;
    if (dir) this.load();
  }

  files() {
    try {
      return fs.readdirSync(this.dir).filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    } catch {
      return [];
    }
  }

  readFile(file) {
    try {
      return fs.readFileSync(path.join(this.dir, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Recharge les derniers événements au démarrage et reprend la numérotation
  load() {
    this.prune(); // d'abord, pour ne pas recharger des événements périmés
    const loaded = [];
    for (const file of this.files().reverse()) {
      loaded.unshift(...this.readFile(file));
      if (loaded.length >= this.size) break;
    }
    this.items = loaded.slice(-this.size);
    this.nextId = (this.items.at(-1)?.id ?? 0) + 1;
  }

  prune() {
    this.lastPrune = Date.now();
    const limit = new Date(Date.now() - this.keepDays * DAY_MS).toISOString().slice(0, 10);
    for (const file of this.files()) {
      if (file.slice(8, 18) < limit) {
        try { fs.unlinkSync(path.join(this.dir, file)); } catch {}
      }
    }
  }

  push(level, source, message) {
    const event = { id: this.nextId++, at: new Date().toISOString(), level, source, message };
    this.items.push(event);
    if (this.items.length > this.size) this.items.shift();

    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(path.join(this.dir, `journal-${event.at.slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n");
        if (Date.now() - this.lastPrune > DAY_MS) this.prune();
      } catch (err) {
        console.error(`[journal] Écriture impossible : ${err.message}`);
      }
    }
    return event;
  }

  since(id = 0) {
    return this.items.filter((e) => e.id > id);
  }

  // Tous les événements des N derniers jours (pour le téléchargement)
  lastDays(days) {
    if (!this.dir) return this.items.slice();
    const limit = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    return this.files().filter((f) => f.slice(8, 18) >= limit).flatMap((f) => this.readFile(f));
  }

  // Logger compatible console : "[source] message" va à la fois dans la console et dans le journal
  logger() {
    const write = (level, out) => (message) => {
      out(message);
      const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(String(message));
      this.push(level, m ? m[1] : "app", m ? m[2] : String(message));
    };
    return { log: write("info", console.log), warn: write("warn", console.warn), error: write("error", console.error) };
  }
}

// "a, b, c… (+12)" pour journaliser une action sur beaucoup de chaînes
function summarize(names, max = 5) {
  const head = names.slice(0, max).join(", ");
  return names.length > max ? `${head}… (+${names.length - max})` : head;
}

module.exports = { EventLog, summarize };
