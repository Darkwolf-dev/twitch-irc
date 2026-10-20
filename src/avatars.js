"use strict";

const fs = require("fs");
const path = require("path");

const HELIX_USERS = "https://api.twitch.tv/helix/users";
const RECHECK_MS = 7 * 24 * 3600_000; // une image de profil change rarement : revérifiée chaque semaine

// Images de profil des chaînes (Get Users, 100 chaînes par requête), gardées dans avatars.json.
class AvatarStore {
  constructor({ dataDir, getToken, log }) {
    this.file = path.join(dataDir, "avatars.json");
    this.getToken = getToken;
    this.log = log;
    this.data = {}; // chaîne -> { url, checkedAt }
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {}
    this.refreshing = false;
  }

  // Version 70×70 de l'image (Twitch fournit du 300×300), seulement depuis le CDN de Twitch
  url(name) {
    const url = this.data[name]?.url;
    return url && url.startsWith("https://static-cdn.jtvnw.net/") ? url.replace("300x300", "70x70") : null;
  }

  forget(name) {
    delete this.data[name];
  }

  async refresh(names) {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      const todo = names.filter((n) => !this.data[n] || now - Date.parse(this.data[n].checkedAt) > RECHECK_MS);
      if (!todo.length) return;
      const { token, clientId } = await this.getToken();
      for (let i = 0; i < todo.length; i += 100) {
        const batch = todo.slice(i, i + 100);
        const url = new URL(HELIX_USERS);
        for (const name of batch) url.searchParams.append("login", name);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = await res.json();
        const found = new Map(data.map((u) => [u.login.toLowerCase(), u.profile_image_url]));
        const checkedAt = new Date().toISOString();
        for (const name of batch) this.data[name] = { url: found.get(name) ?? null, checkedAt };
      }
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      this.log.log(`[avatars] Images de profil mises à jour pour ${todo.length} chaîne(s)`);
    } catch (err) {
      this.log.warn(`[avatars] Mise à jour impossible : ${err.message}`);
    } finally {
      this.refreshing = false;
    }
  }
}

module.exports = { AvatarStore };
