"use strict";

const fs = require("fs");
const path = require("path");

const KEEP_MS = 30 * 24 * 60 * 60_000;
const MAX_DROPS = 2000;
const PRESENCE_TICK_MS = 60_000;
const MIN_DAY_MINUTES = 10;
// Annonce de drop ChatDeck, toujours postée depuis le compte du streamer :
// « 🎁 Drop ChatDeck : 782 viewers présents reçoivent 3 boosters Berlu, distribués par paliers sur 3 min → … »
const ANNOUNCE_RE = /🎁\s*Drop ChatDeck/i;
const DETAILS_RE = /(\d[\d\s  .]*)\s*viewers?\b.*?\b(\d+)\s*boosters?\s+([^,→]+)/i;
// Moments du live où les drops tombent (minutes depuis le début) : tranches de 30 min,
// l'écart minimum entre deux drops, jusqu'à 4 h
const hm = (m) => (m % 60 ? `${Math.floor(m / 60)} h 30` : `${m / 60} h`);
const MOMENTS = [
  ...Array.from({ length: 8 }, (_, i) => ({ label: `${hm(i * 30)} – ${hm((i + 1) * 30)}`, max: (i + 1) * 30 })),
  { label: "> 4 h", max: Infinity },
];

const day = (t) => new Date(t).toISOString().slice(0, 10);
// Boosters d'un drop (1 si le message n'a pas pu être lu)
const boostersOf = (d) => d.boosters ?? 1;

// Radar à drops : repère les annonces dans les chats rejoints, puis classe les chaînes
// selon les boosters gagnés par jour de présence pendant le live.
class DropTracker {
  constructor({ dataDir, getLive, isJoined, log }) {
    this.file = path.join(dataDir, "drops.json");
    this.getLive = getLive;   // () => Map chaîne -> { startedAt }
    this.isJoined = isJoined; // (chaîne) => true si le chat est rejoint
    this.log = log;
    this.drops = [];          // { at, channel, text, minute, viewers, boosters, collection }
    this.presence = {};       // chaîne -> { "AAAA-MM-JJ": minutes passées dans le chat pendant le live }
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.drops = data.drops ?? [];
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

  handle(message) {
    // Seul le streamer poste les vraies annonces : une copie par un viewer est ignorée
    if (message.login !== message.channel || !ANNOUNCE_RE.test(message.text)) return;
    const startedAt = this.getLive().get(message.channel)?.startedAt;
    const now = Date.now();
    const details = message.text.match(DETAILS_RE);
    const drop = {
      at: new Date(now).toISOString(),
      channel: message.channel,
      text: message.text.slice(0, 300),
      minute: startedAt ? Math.max(0, Math.round((now - Date.parse(startedAt)) / 60_000)) : null,
      viewers: details ? Number(details[1].replace(/\D/g, "")) : null,
      boosters: details ? Number(details[2]) : null,
      collection: details ? details[3].trim().slice(0, 40) : null,
    };
    this.drops.push(drop);
    if (this.drops.length > MAX_DROPS) this.drops.splice(0, this.drops.length - MAX_DROPS);
    this.dirty = true;
    this.save();
    this.log.log(`[drops] Drop sur #${drop.channel}${drop.boosters ? ` : ${drop.boosters} booster(s) ${drop.collection}` : ""}`);
  }

  // Drop raté par le radar (pas encore dans le chat…), saisi dans le panneau
  addManual({ channel, boosters, minute }) {
    this.drops.push({ at: new Date().toISOString(), channel, text: "Ajouté à la main", minute, viewers: null, boosters, collection: null, manual: true });
    this.dirty = true;
    this.save();
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
    const before = this.drops.length;
    this.drops = this.drops.filter((d) => now - Date.parse(d.at) < KEEP_MS);
    if (this.drops.length !== before) this.dirty = true;
    this.save();
  }

  save() {
    if (!this.dirty) return;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ drops: this.drops, presence: this.presence }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log.error(`[drops] Écriture impossible : ${err.message}`);
    }
  }

  presenceMinutes(channel) {
    return Object.values(this.presence[channel] ?? {}).reduce((a, b) => a + b, 0);
  }

  // Jours où on était dans le chat pendant le live (un jour compte dès 10 min de présence)
  presenceDays(channel) {
    return Object.values(this.presence[channel] ?? {}).filter((m) => m >= MIN_DAY_MINUTES).length;
  }

  // Chaîne -> boosters par jour de présence, lissé (+1 jour) pour qu'un seul drop vu le premier jour
  // ne passe pas en tête. Calculé en une passe : sert au tri des chaînes à rejoindre.
  scores() {
    const boosters = new Map();
    for (const d of this.drops) boosters.set(d.channel, (boosters.get(d.channel) ?? 0) + boostersOf(d));
    const scores = new Map();
    for (const [channel, count] of boosters) scores.set(channel, count / (this.presenceDays(channel) + 1));
    return scores;
  }

  channelReport(channel) {
    const drops = this.drops.filter((d) => d.channel === channel);
    const minutes = this.presenceMinutes(channel);
    const days = this.presenceDays(channel);
    const boosters = drops.reduce((n, d) => n + boostersOf(d), 0);
    const moments = MOMENTS.map((m) => ({ label: m.label, count: 0 }));
    for (const d of drops) if (d.minute !== null) moments[MOMENTS.findIndex((m) => d.minute < m.max)].count++;
    const sorted = drops.map((d) => d.minute).filter((m) => m !== null).sort((a, b) => a - b);
    return {
      channel,
      drops: drops.length,
      boosters,
      presenceHours: Math.round((minutes / 60) * 10) / 10,
      presenceDays: days,
      perDay: days ? Math.round((boosters / days) * 10) / 10 : null,
      medianMinute: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      lastAt: drops.at(-1)?.at ?? null,
      moments,
    };
  }

  report() {
    const channels = new Set([...Object.keys(this.presence), ...this.drops.map((d) => d.channel)]);
    const scores = this.scores();
    return {
      channels: [...channels].map((c) => ({ ...this.channelReport(c), score: scores.get(c) ?? 0 }))
        .sort((a, b) => b.score - a.score || b.presenceHours - a.presenceHours),
      recent: this.drops.slice(-30).reverse(),
    };
  }
}

module.exports = { DropTracker };
