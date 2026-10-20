"use strict";

// Surveille quelles chaînes sont en live via l'API Helix (Get Streams, 100 chaînes par requête).

const HELIX_STREAMS = "https://api.twitch.tv/helix/streams";
const POLL_MS = 60_000;
const OFFLINE_GRACE_MS = 10 * 60_000; // on reste dans le chat 10 min après la fin du live (coupure, raid…)

class LiveMonitor {
  constructor({ getToken, getChannels, onChange, onWentLive, onAuthFailure, log = console }) {
    this.getToken = getToken;
    this.getChannels = getChannels;
    this.onChange = onChange;
    this.onWentLive = onWentLive; // (chaîne, info) à chaque début de live (pas au démarrage du serveur)
    this.onAuthFailure = onAuthFailure;
    this.log = log;

    this.live = new Map();      // chaîne -> { title, game, viewers, startedAt }
    this.offlineAt = new Map(); // chaîne -> fin du live observée (pour le délai de grâce)
    this.lastPoll = null;
    this.lastError = null;
    this.polled = false;
    this.polling = false;
  }

  start() {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.poll();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.soonTimer);
  }

  // Après l'ajout de chaînes, pour connaître leur état sans attendre une minute
  pollSoon() {
    clearTimeout(this.soonTimer);
    this.soonTimer = setTimeout(() => this.poll(), 2000);
  }

  isLive(name) {
    return this.live.has(name);
  }

  // En live, ou terminé depuis moins que le délai de grâce
  isActive(name) {
    if (this.live.has(name)) return true;
    const end = this.offlineAt.get(name);
    return end !== undefined && Date.now() - end < OFFLINE_GRACE_MS;
  }

  info(name) {
    return this.live.get(name) ?? null;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const names = [...this.getChannels()];
      const { token, clientId } = await this.getToken();
      const next = new Map();

      for (let i = 0; i < names.length; i += 100) {
        const url = new URL(HELIX_STREAMS);
        url.searchParams.set("first", "100");
        for (const name of names.slice(i, i + 100)) url.searchParams.append("user_login", name);

        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Client-Id": clientId } });
        if (res.status === 401) {
          this.onAuthFailure?.();
          throw new Error("token refusé par l'API (401)");
        }
        if (!res.ok) throw new Error(`API Twitch : HTTP ${res.status}`);

        const { data } = await res.json();
        for (const s of data) {
          if (s.type !== "live") continue;
          next.set(s.user_login.toLowerCase(), {
            displayName: s.user_name,
            title: s.title,
            game: s.game_name,
            viewers: s.viewer_count,
            startedAt: s.started_at,
            thumbnail: s.thumbnail_url?.replace("{width}", "440").replace("{height}", "248") ?? null,
          });
        }
      }

      const now = Date.now();
      const wentLive = [...next.keys()].filter((n) => !this.live.has(n));
      const wentOffline = [...this.live.keys()].filter((n) => !next.has(n) && names.includes(n));
      for (const n of wentLive) this.offlineAt.delete(n);
      for (const n of wentOffline) this.offlineAt.set(n, now);

      if (!this.polled) {
        this.log.log(`[live] ${next.size} chaîne(s) en live sur ${names.length}`);
      } else {
        for (const n of wentLive) this.log.log(`[live] ${n} est en live (${next.get(n).game || "sans catégorie"})`);
        for (const n of wentOffline) this.log.log(`[live] ${n} n'est plus en live`);
      }
      if (this.lastError) this.log.log("[live] API Twitch de nouveau joignable");

      const firstPoll = !this.polled;
      this.live = next;
      this.polled = true;
      if (!firstPoll) for (const n of wentLive) this.onWentLive?.(n, next.get(n));
      this.lastPoll = new Date();
      this.lastError = null;
      this.onChange?.();
    } catch (err) {
      // On garde le dernier état connu : une panne de l'API ne doit pas faire quitter les chats
      if (err.message !== this.lastError) this.log.error(`[live] ${err.message}`);
      this.lastError = err.message;
    } finally {
      this.polling = false;
    }
  }

  status() {
    return {
      lastPoll: this.lastPoll?.toISOString() ?? null,
      lastError: this.lastError,
      count: this.live.size,
    };
  }
}

module.exports = { LiveMonitor, OFFLINE_GRACE_MS };
