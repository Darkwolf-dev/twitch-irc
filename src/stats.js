"use strict";

const fs = require("fs");
const path = require("path");

const SAMPLE_MS = 5 * 60_000;     // un relevé toutes les 5 minutes par chaîne en live
const KEEP_MS = 7 * 24 * 60 * 60_000;
const SESSION_GAP_MS = 20 * 60_000; // plus de 20 min sans relevé = nouveau live

// Statistiques par chaîne : spectateurs et messages pendant les lives, sur 7 jours.
// Relevé : { t: horodatage, v: spectateurs, m: messages reçus pendant les 5 dernières minutes }
class StatsStore {
  constructor({ dataDir, getLive, isJoined, log }) {
    this.file = path.join(dataDir, "stats.json");
    this.getLive = getLive;   // () => Map chaîne -> { viewers }
    this.isJoined = isJoined; // (chaîne) => true si le chat est rejoint (messages comptés)
    this.log = log;
    this.samples = {};        // chaîne -> [relevés]
    this.counters = new Map(); // messages depuis le dernier relevé
    try {
      this.samples = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
  }

  start() {
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  countMessage(channel) {
    this.counters.set(channel, (this.counters.get(channel) ?? 0) + 1);
  }

  sample() {
    const now = Date.now();
    for (const [channel, info] of this.getLive()) {
      const list = (this.samples[channel] ??= []);
      // m = null quand le chat n'était pas rejoint : on ne sait pas combien de messages il y a eu
      list.push({ t: now, v: info.viewers, m: this.isJoined(channel) ? this.counters.get(channel) ?? 0 : null });
    }
    this.counters.clear();

    for (const [channel, list] of Object.entries(this.samples)) {
      const kept = list.filter((s) => now - s.t < KEEP_MS);
      if (kept.length) this.samples[channel] = kept;
      else delete this.samples[channel];
    }
    this.save();
  }

  save() {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.samples));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`[stats] Écriture impossible : ${err.message}`);
    }
  }

  forget(channel) {
    delete this.samples[channel];
  }

  of(channel) {
    const samples = this.samples[channel] ?? [];

    // Découpe en lives : un trou de plus de 20 min entre deux relevés sépare deux lives
    const sessions = [];
    for (const s of samples) {
      const last = sessions.at(-1);
      if (!last || s.t - last.end > SESSION_GAP_MS) sessions.push({ start: s.t, end: s.t, peak: s.v, samples: 1 });
      else Object.assign(last, { end: s.t, peak: Math.max(last.peak, s.v), samples: last.samples + 1 });
    }

    const withMessages = samples.filter((s) => s.m !== null);
    const summary = {
      liveHours: Math.round((samples.length * SAMPLE_MS) / 360_000) / 10,
      sessions: sessions.length,
      peakViewers: samples.length ? Math.max(...samples.map((s) => s.v)) : null,
      avgViewers: samples.length ? Math.round(samples.reduce((a, s) => a + s.v, 0) / samples.length) : null,
      messagesPerMinute: withMessages.length
        ? Math.round((withMessages.reduce((a, s) => a + s.m, 0) / (withMessages.length * 5)) * 10) / 10
        : null,
      lastLive: sessions.at(-1) ? new Date(sessions.at(-1).end).toISOString() : null,
    };

    return {
      sampleMinutes: SAMPLE_MS / 60_000,
      summary,
      sessions: sessions.map((s) => ({
        start: new Date(s.start).toISOString(),
        end: new Date(s.end).toISOString(),
        hours: Math.round((s.samples * SAMPLE_MS) / 360_000) / 10,
        peak: s.peak,
      })),
      samples,
    };
  }
}

module.exports = { StatsStore };
