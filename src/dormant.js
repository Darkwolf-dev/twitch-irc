"use strict";

const fs = require("fs");
const path = require("path");

const HELIX = "https://api.twitch.tv/helix";
const DAY_MS = 24 * 3600_000;
const VOD_RECHECK_MS = DAY_MS; // dernière VOD revérifiée au plus une fois par jour et par chaîne

// Chaînes « endormies » : pas de live depuis N jours.
// Deux sources pour la date du dernier live :
//  - le suivi du serveur (chaque passage en live observé) : fiable, mais seulement depuis sa mise en place ;
//  - la dernière VOD Twitch (rediffusion archivée) : disponible tout de suite, si la chaîne garde ses VOD.
// Une chaîne sans aucune des deux n'est signalée qu'après N jours de suivi (sinon : « inconnu »).
class DormantTracker {
  constructor({ dataDir, getToken, log }) {
    this.file = path.join(dataDir, "lastlive.json");
    this.getToken = getToken;
    this.log = log;
    this.data = { lastLive: {}, firstSeen: {}, vods: {} };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {}
    this.ids = new Map();
    this.checking = false;
    this.lastCheck = null;
  }

  save() {
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log.error(`[dormant] Écriture impossible : ${err.message}`);
    }
  }

  // Appelé à chaque vérification des lives : mémorise la date pour les chaînes en live
  markLive(names) {
    const now = new Date().toISOString();
    for (const n of names) this.data.lastLive[n] = now;
    if (names.length) this.dirty = true;
    // Écriture au plus toutes les 10 min (la date du jour suffit)
    if (this.dirty && (!this.savedAt || Date.now() - this.savedAt > 10 * 60_000)) {
      this.savedAt = Date.now();
      this.save();
    }
  }

  // Date à partir de laquelle une chaîne est suivie (pour ne pas juger une chaîne ajoutée hier)
  track(names) {
    const now = new Date().toISOString();
    let changed = false;
    for (const n of names) {
      if (!this.data.firstSeen[n]) {
        this.data.firstSeen[n] = now;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  forget(name) {
    delete this.data.lastLive[name];
    delete this.data.firstSeen[name];
    delete this.data.vods[name];
    this.save();
  }

  lastLiveOf(name) {
    const local = this.data.lastLive[name] ?? null;
    const vod = this.data.vods[name]?.at ?? null;
    if (local && vod) return local > vod ? { at: local, source: "suivi" } : { at: vod, source: "vod" };
    if (local) return { at: local, source: "suivi" };
    if (vod) return { at: vod, source: "vod" };
    return null;
  }

  async helix(pathAndQuery) {
    const { token, clientId } = await this.getToken();
    const res = await fetch(`${HELIX}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${pathAndQuery.split("?")[0]} : HTTP ${res.status}`);
    return res.json();
  }

  // Interroge les VOD des chaînes dont on ne connaît pas de live récent
  async checkVods(names, thresholdDays) {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = Date.now();
      const recent = (iso) => iso && now - Date.parse(iso) < thresholdDays * DAY_MS;
      const todo = names.filter((n) =>
        !recent(this.data.lastLive[n]) &&
        !(this.data.vods[n] && now - Date.parse(this.data.vods[n].checkedAt) < VOD_RECHECK_MS));
      if (!todo.length) return;

      for (let i = 0; i < todo.length; i += 100) {
        const batch = todo.slice(i, i + 100).filter((n) => !this.ids.has(n));
        if (!batch.length) continue;
        const { data } = await this.helix(`/users?${batch.map((n) => `login=${encodeURIComponent(n)}`).join("&")}`);
        for (const u of data) this.ids.set(u.login.toLowerCase(), u.id);
      }

      for (const name of todo) {
        const id = this.ids.get(name);
        const entry = { at: null, checkedAt: new Date().toISOString(), exists: Boolean(id) };
        if (id) {
          const { data } = await this.helix(`/videos?user_id=${id}&type=archive&first=1`);
          entry.at = data[0]?.created_at ?? null;
        }
        this.data.vods[name] = entry;
      }
      this.save();
      this.lastCheck = new Date();
      this.log.log(`[dormant] Dernières VOD vérifiées pour ${todo.length} chaîne(s)`);
    } catch (err) {
      this.log.warn(`[dormant] Vérification des VOD impossible : ${err.message}`);
    } finally {
      this.checking = false;
    }
  }

  // Liste des chaînes endormies parmi celles enregistrées (hors chaînes à garder)
  report(names, thresholdDays, keep = new Set()) {
    const now = Date.now();
    const dormant = [];
    for (const name of names) {
      if (keep.has(name)) continue;
      const last = this.lastLiveOf(name);
      const vod = this.data.vods[name];
      if (vod && vod.exists === false) {
        dormant.push({ name, lastLive: null, days: null, reason: "Chaîne introuvable sur Twitch (supprimée ou renommée)" });
        continue;
      }
      if (last) {
        const days = Math.floor((now - Date.parse(last.at)) / DAY_MS);
        if (days >= thresholdDays) {
          dormant.push({ name, lastLive: last.at, days, source: last.source });
        }
      } else {
        const trackedDays = Math.floor((now - Date.parse(this.data.firstSeen[name] ?? new Date().toISOString())) / DAY_MS);
        if (trackedDays >= thresholdDays) {
          dormant.push({ name, lastLive: null, days: trackedDays, reason: `Aucun live vu depuis ${trackedDays} j de suivi (pas de VOD)` });
        }
      }
    }
    return dormant.sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
  }
}

module.exports = { DormantTracker };
