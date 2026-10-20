"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_CANDIDATES = 2000;
const PRESENCE_TICK_MS = 60_000;
// Annonce de drop ChatDeck, envoyée par ChatDeck depuis le compte du streamer :
// « 🎁 Drop ChatDeck : 782 viewers présents reçoivent 3 boosters Berlu, distribués par paliers sur 3 min → … »
const ANNOUNCE_RE = /🎁\s*Drop ChatDeck/i;
const DETAILS_RE = /(\d[\d\s  .]*)\s*viewers?\b.*?\b(\d+)\s*boosters?\s+([^,→]+)/i;
// Annonce venant d'un autre compte que le streamer (relais, copie) : à valider dans le panneau.
// Un expéditeur dont 2 annonces ont été validées (90 % des siennes) est ensuite validé d'office ;
// un expéditeur dont 2 annonces ont été écartées (et aucune validée) est écarté d'office.
const AUTO_MIN = 2;
const AUTO_RATIO = 0.9;
// Moments du live où les drops tombent (minutes depuis le début)
const MOMENTS = [
  { label: "< 30 min", max: 30 },
  { label: "30 min – 1 h", max: 60 },
  { label: "1 – 2 h", max: 120 },
  { label: "2 – 4 h", max: 240 },
  { label: "> 4 h", max: Infinity },
];

const day = (t) => new Date(t).toISOString().slice(0, 10);
// Boosters d'un drop (1 si le message n'a pas pu être lu)
const boostersOf = (c) => c.boosters ?? 1;

// Radar à drops : repère les annonces dans les chats rejoints, puis classe les chaînes
// selon les boosters gagnés par heure de présence pendant le live.
class DropTracker {
  constructor({ dataDir, getLive, isJoined, log }) {
    this.file = path.join(dataDir, "drops.json");
    this.getLive = getLive;   // () => Map chaîne -> { startedAt }
    this.isJoined = isJoined; // (chaîne) => true si le chat est rejoint
    this.log = log;
    // { id, at, channel, user, login, text, minute, viewers, boosters, collection, drop: null | true | false, auto }
    this.candidates = [];
    this.presence = {};       // chaîne -> { "AAAA-MM-JJ": minutes passées dans le chat pendant le live }
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      // Les messages repérés par l'ancienne détection large (sans « 🎁 Drop ChatDeck ») sont oubliés
      this.candidates = (data.candidates ?? []).filter((c) => ANNOUNCE_RE.test(c.text));
      this.presence = data.presence ?? {};
    } catch {}
    this.dirty = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), PRESENCE_TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  handle(message, me) {
    if (message.login === me || !ANNOUNCE_RE.test(message.text)) return;
    const startedAt = this.getLive().get(message.channel)?.startedAt;
    const now = Date.now();
    const details = message.text.match(DETAILS_RE);
    const fromStreamer = message.login === message.channel;
    const entry = {
      id: crypto.randomBytes(6).toString("hex"),
      at: new Date(now).toISOString(),
      channel: message.channel,
      user: message.user,
      login: message.login,
      text: message.text.slice(0, 300),
      minute: startedAt ? Math.max(0, Math.round((now - Date.parse(startedAt)) / 60_000)) : null,
      viewers: details ? Number(details[1].replace(/\D/g, "")) : null,
      boosters: details ? Number(details[2]) : null,
      collection: details ? details[3].trim().slice(0, 40) : null,
      drop: fromStreamer ? true : this.autoVerdict(message.login, message.channel),
    };
    entry.auto = entry.drop !== null;
    this.candidates.push(entry);
    if (this.candidates.length > MAX_CANDIDATES) this.candidates.splice(0, this.candidates.length - MAX_CANDIDATES);
    this.dirty = true;
    if (entry.drop) {
      this.log.log(`[drops] Drop sur #${entry.channel}${entry.boosters ? ` : ${entry.boosters} booster(s) ${entry.collection}` : ""}`);
    }
  }

  autoVerdict(login, channel) {
    let yes = 0, no = 0;
    for (const c of this.candidates) {
      if (c.login !== login || c.channel !== channel || c.drop === null || c.auto) continue;
      if (c.drop) yes++;
      else no++;
    }
    if (yes >= AUTO_MIN && yes / (yes + no) >= AUTO_RATIO) return true;
    if (no >= AUTO_MIN && yes === 0) return false;
    return null;
  }

  // drop : true, false, ou null (annule la validation)
  setVerdict(id, drop) {
    const entry = this.candidates.find((c) => c.id === id);
    if (!entry) return false;
    entry.drop = drop;
    entry.auto = false;
    this.dirty = true;
    this.save();
    return true;
  }

  tick() {
    const now = Date.now();
    const today = day(now);
    for (const channel of this.getLive().keys()) {
      if (!this.isJoined(channel)) continue;
      const days = (this.presence[channel] ??= {});
      days[today] = (days[today] ?? 0) + 1;
      this.dirty = true;
    }
    // Nettoyage : plus de 30 jours
    const oldest = day(now - KEEP_MS);
    for (const [channel, days] of Object.entries(this.presence)) {
      for (const d of Object.keys(days)) if (d < oldest) delete days[d];
      if (!Object.keys(days).length) delete this.presence[channel];
    }
    const before = this.candidates.length;
    this.candidates = this.candidates.filter((c) => now - Date.parse(c.at) < KEEP_MS);
    if (this.candidates.length !== before) this.dirty = true;
    this.save();
  }

  save() {
    if (!this.dirty) return;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ candidates: this.candidates, presence: this.presence }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log.error(`[drops] Écriture impossible : ${err.message}`);
    }
  }

  presenceMinutes(channel) {
    return Object.values(this.presence[channel] ?? {}).reduce((a, b) => a + b, 0);
  }

  // Chaîne -> boosters par heure de présence, lissé (+2 h) pour qu'un seul drop sur 10 min de présence
  // ne passe pas en tête. Calculé en une passe : sert au tri des chaînes à rejoindre.
  scores() {
    const boosters = new Map();
    for (const c of this.candidates) {
      if (c.drop === true) boosters.set(c.channel, (boosters.get(c.channel) ?? 0) + boostersOf(c));
    }
    const scores = new Map();
    for (const [channel, count] of boosters) scores.set(channel, count / (this.presenceMinutes(channel) / 60 + 2));
    return scores;
  }

  channelReport(channel) {
    const drops = this.candidates.filter((c) => c.channel === channel && c.drop === true);
    const minutes = this.presenceMinutes(channel);
    const boosters = drops.reduce((n, d) => n + boostersOf(d), 0);
    const moments = MOMENTS.map((m) => ({ label: m.label, count: 0 }));
    for (const d of drops) if (d.minute !== null) moments[MOMENTS.findIndex((m) => d.minute < m.max)].count++;
    const sorted = drops.map((d) => d.minute).filter((m) => m !== null).sort((a, b) => a - b);
    return {
      channel,
      drops: drops.length,
      boosters,
      presenceHours: Math.round((minutes / 60) * 10) / 10,
      perHour: minutes ? Math.round((boosters / (minutes / 60)) * 100) / 100 : null,
      medianMinute: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      lastAt: drops.at(-1)?.at ?? null,
      moments,
    };
  }

  report() {
    const channels = new Set([...Object.keys(this.presence), ...this.candidates.map((c) => c.channel)]);
    const scores = this.scores();
    return {
      channels: [...channels].map((c) => ({ ...this.channelReport(c), score: scores.get(c) ?? 0 }))
        .sort((a, b) => b.score - a.score || b.presenceHours - a.presenceHours),
      pending: this.candidates.filter((c) => c.drop === null).slice(-50).reverse(),
      recent: this.candidates.filter((c) => c.drop !== null).slice(-30).reverse(),
    };
  }

  pendingCount() {
    return this.candidates.reduce((n, c) => n + (c.drop === null), 0);
  }
}

module.exports = { DropTracker };
