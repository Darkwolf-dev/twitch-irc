"use strict";

const WebSocket = require("ws");

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";
const JOIN_LIMIT = 15; // Twitch autorise 20 JOIN / 10 s pour un compte standard : on garde de la marge
const JOIN_WINDOW_MS = 10_000;
const JOIN_TIMEOUT_MS = 15_000;
const TICK_MS = 250;
const PING_INTERVAL_MS = 60_000;
const IDLE_TIMEOUT_MS = 150_000;
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;
const RECONNECT_MAX_MS = 60_000;

// NOTICE (msg-id) indiquant qu'un JOIN n'a pas abouti
const JOIN_FAILURE_IDS = new Set(["msg_channel_suspended", "msg_banned", "tos_ban"]);

function parse(line) {
  const tags = {};
  let prefix = null;
  let rest = line;

  if (rest.startsWith("@")) {
    const i = rest.indexOf(" ");
    for (const pair of rest.slice(1, i).split(";")) {
      const [key, value = ""] = pair.split("=");
      tags[key] = value;
    }
    rest = rest.slice(i + 1);
  }
  if (rest.startsWith(":")) {
    const i = rest.indexOf(" ");
    prefix = rest.slice(1, i);
    rest = rest.slice(i + 1);
  }

  let trailing = null;
  const t = rest.indexOf(" :");
  if (t !== -1) {
    trailing = rest.slice(t + 2);
    rest = rest.slice(0, t);
  }

  const params = rest.split(" ").filter(Boolean);
  const command = params.shift();
  if (trailing !== null) params.push(trailing);

  return { tags, prefix, nick: prefix ? prefix.split("!")[0].toLowerCase() : null, command, params };
}

const channelOf = (param = "") => param.replace(/^#/, "").toLowerCase();

class TwitchIrc {
  constructor({ getToken, onAuthFailure, onMessage, onSanction, log = console }) {
    this.getToken = getToken;
    this.onAuthFailure = onAuthFailure;
    this.onMessage = onMessage;
    this.onSanction = onSanction; // ({ channel, type: "timeout"|"ban", duration }) quand NOTRE compte est sanctionné
    this.log = log;

    this.desired = new Set();   // canaux voulus (source de vérité, persistée par le serveur)
    this.joined = new Set();    // canaux confirmés par Twitch
    this.pending = new Map();   // canal -> horodatage du JOIN envoyé
    this.failures = new Map();  // canal -> { reason, attempts, retryAt }
    this.lastMessages = new Map(); // canal -> { at, user, text, count }
    this.chatLogs = new Map();     // canal -> 100 derniers messages (mini-chat du panneau)
    this.messageSeq = 0;
    this.joinTimes = [];

    this.ws = null;
    this.username = null;
    this.registered = false;
    this.connectedSince = null;
    this.lastError = null;
    this.lastSeen = 0;
    this.reconnectAttempts = 0;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.pingTimer = setInterval(() => this.keepAlive(), PING_INTERVAL_MS);
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.tickTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }

  // Remplace la liste des canaux à rejoindre ; la réconciliation se fait au prochain tick
  setDesired(channels) {
    for (const c of channels) if (!this.desired.has(c)) this.failures.delete(c);
    for (const c of this.desired) if (!channels.has(c)) this.failures.delete(c);
    this.desired = new Set(channels);
  }

  // Un join explicite relance immédiatement un canal en échec
  retry(channel) {
    this.failures.delete(channel);
  }

  async connect() {
    if (this.stopped) return;

    let credentials;
    try {
      credentials = await this.getToken();
    } catch (err) {
      this.lastError = err.message;
      this.log.error(`[irc] ${err.message}`);
      return this.scheduleReconnect();
    }
    if (this.stopped) return;

    this.username = credentials.login.toLowerCase();
    const ws = new WebSocket(IRC_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.lastSeen = Date.now();
      this.raw("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.raw(`PASS oauth:${credentials.token}`);
      this.raw(`NICK ${this.username}`);
    });

    ws.on("message", (data) => {
      this.lastSeen = Date.now();
      for (const line of data.toString().split("\r\n")) {
        if (line) this.handle(parse(line));
      }
    });

    ws.on("error", (err) => {
      this.lastError = err.message;
      this.log.error(`[irc] Erreur WebSocket : ${err.message}`);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.registered = false;
      this.connectedSince = null;
      this.joined.clear();
      this.pending.clear();
      this.log.warn("[irc] Déconnecté");
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.reconnectAttempts) + Math.random() * 1000;
    this.reconnectAttempts++;
    this.log.log(`[irc] Reconnexion dans ${Math.round(delay / 1000)} s`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  raw(line) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(line + "\r\n");
    return true;
  }

  handle(msg) {
    switch (msg.command) {
      case "PING":
        this.raw(`PONG :${msg.params[0] ?? "tmi.twitch.tv"}`);
        break;

      case "001":
        this.registered = true;
        this.connectedSince = new Date();
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.log.log(`[irc] Connecté en tant que ${this.username}`);
        break;

      case "JOIN":
        if (msg.nick === this.username) {
          const channel = channelOf(msg.params[0]);
          this.pending.delete(channel);
          this.failures.delete(channel);
          this.joined.add(channel);
          this.log.log(`[irc] #${channel} rejoint`);
        }
        break;

      case "PART":
        if (msg.nick === this.username) {
          const channel = channelOf(msg.params[0]);
          this.pending.delete(channel);
          this.joined.delete(channel);
          this.log.log(`[irc] #${channel} quitté`);
        }
        break;

      case "PRIVMSG": {
        const channel = channelOf(msg.params[0]);
        const action = /^\x01ACTION (.*)\x01$/.exec(msg.params[1] ?? "");
        const text = action ? action[1] : msg.params[1] ?? "";
        const user = msg.tags["display-name"] || msg.nick;
        this.lastMessages.set(channel, {
          at: Date.now(),
          user,
          text: text.slice(0, 200),
          count: (this.lastMessages.get(channel)?.count ?? 0) + 1,
        });
        const log = this.chatLogs.get(channel) ?? [];
        log.push({
          id: ++this.messageSeq,
          at: Date.now(),
          user,
          color: /^#[0-9a-f]{6}$/i.test(msg.tags.color ?? "") ? msg.tags.color : null,
          text: text.slice(0, 500),
          action: Boolean(action),
        });
        if (log.length > 100) log.shift();
        this.chatLogs.set(channel, log);

        this.onMessage?.({
          channel,
          user,
          login: msg.nick,
          text,
          replyTo: msg.tags["reply-parent-user-login"]?.toLowerCase() || null,
        });
        break;
      }

      // CLEARCHAT #canal :login → un utilisateur a été timeout (ban-duration en secondes) ou banni.
      // Sans login : le chat entier a été vidé (on ignore).
      case "CLEARCHAT": {
        const target = msg.params[1]?.toLowerCase();
        if (target && target === this.username) {
          const duration = msg.tags["ban-duration"] ? Number(msg.tags["ban-duration"]) : null;
          this.onSanction?.({ channel: channelOf(msg.params[0]), type: duration ? "timeout" : "ban", duration });
        }
        break;
      }

      case "NOTICE":
        this.handleNotice(msg);
        break;

      case "RECONNECT":
        this.log.warn("[irc] Twitch demande une reconnexion");
        this.ws?.close();
        break;
    }
  }

  handleNotice(msg) {
    const [target = "", text = ""] = msg.params;

    if (target === "*" && /authentication failed|improperly formatted auth/i.test(text)) {
      this.lastError = `Authentification IRC refusée : ${text}`;
      this.log.error(`[irc] ${this.lastError}`);
      this.onAuthFailure?.();
      this.ws?.close();
      return;
    }

    const channel = channelOf(target);
    const id = msg.tags["msg-id"];
    if (JOIN_FAILURE_IDS.has(id) && this.pending.has(channel)) {
      this.failJoin(channel, id);
    }
    // Twitch signale aussi qu'on est banni d'un chat (en rejoignant ou en écrivant)
    if (id === "msg_banned") this.onSanction?.({ channel, type: "ban", duration: null, fromNotice: true });
    this.log.log(`[irc] NOTICE ${target} ${id ?? ""} ${text}`);
  }

  failJoin(channel, reason) {
    this.pending.delete(channel);
    const attempts = (this.failures.get(channel)?.attempts ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    this.failures.set(channel, { reason, attempts, retryAt: Date.now() + delay });
    this.log.warn(`[irc] JOIN #${channel} échoué (${reason}), nouvel essai dans ${Math.round(delay / 1000)} s`);
  }

  // Réconcilie l'état réel avec l'état voulu, en respectant la limite de JOIN.
  tick() {
    if (!this.registered) return;
    const now = Date.now();

    for (const [channel, sentAt] of this.pending) {
      if (!this.desired.has(channel)) {
        this.raw(`PART #${channel}`);
        this.pending.delete(channel);
      } else if (now - sentAt > JOIN_TIMEOUT_MS) {
        this.failJoin(channel, "timeout");
      }
    }

    for (const channel of this.joined) {
      if (!this.desired.has(channel)) {
        this.raw(`PART #${channel}`);
        this.joined.delete(channel);
      }
    }

    this.joinTimes = this.joinTimes.filter((t) => now - t < JOIN_WINDOW_MS);
    for (const channel of this.desired) {
      if (this.joinTimes.length >= JOIN_LIMIT) break;
      if (this.joined.has(channel) || this.pending.has(channel)) continue;
      const failure = this.failures.get(channel);
      if (failure && failure.retryAt > now) continue;
      if (!this.raw(`JOIN #${channel}`)) break;
      this.pending.set(channel, now);
      this.joinTimes.push(now);
    }
  }

  keepAlive() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastSeen > IDLE_TIMEOUT_MS) {
      this.log.warn("[irc] Connexion muette, on la coupe");
      this.ws.terminate();
      return;
    }
    this.raw("PING :keepalive");
  }

  messagesOf(name, afterId = 0) {
    return (this.chatLogs.get(name) ?? []).filter((m) => m.id > afterId);
  }

  channelInfo(name) {
    const info = { name, ...this.channelState(name) };
    const last = this.lastMessages.get(name);
    if (last) {
      info.lastMessage = {
        user: last.user,
        text: last.text,
        at: new Date(last.at).toISOString(),
        ageSeconds: Math.round((Date.now() - last.at) / 1000),
        count: last.count, // messages reçus depuis le démarrage du serveur
      };
    }
    return info;
  }

  channelState(name) {
    if (this.joined.has(name)) return { state: "joined" };
    if (this.pending.has(name)) return { state: "joining" };
    const failure = this.failures.get(name);
    if (failure) {
      return {
        state: "retrying",
        reason: failure.reason,
        attempts: failure.attempts,
        retryAt: new Date(failure.retryAt).toISOString(),
      };
    }
    return { state: this.desired.has(name) ? "queued" : "parted" };
  }

  status() {
    const channels = [...this.desired].sort().map((name) => this.channelInfo(name));
    return {
      irc: {
        connected: this.registered,
        username: this.username,
        connectedSince: this.connectedSince?.toISOString() ?? null,
        lastError: this.lastError,
      },
      counts: {
        desired: this.desired.size,
        joined: channels.filter((c) => c.state === "joined").length,
        joining: this.pending.size,
        retrying: channels.filter((c) => c.state === "retrying").length,
      },
      channels,
    };
  }
}

module.exports = { TwitchIrc, parse };
