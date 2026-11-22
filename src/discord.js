"use strict";

// Notifications Discord via webhook quand on est mentionné dans un chat Twitch.

const WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const MAX_PER_MINUTE = 10;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isWebhookUrl(value) {
  return typeof value === "string" && WEBHOOK_RE.test(value);
}

// Identifiant d'utilisateur Discord (« snowflake »)
function isDiscordUserId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value);
}

// « darkwolfy » ou « @darkwolfy » comme mot entier, sans tenir compte de la casse
function buildMatcher(keywords) {
  const parts = keywords.filter(Boolean).map(escapeRegex);
  if (!parts.length) return () => false;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_])@?(?:${parts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
  return (text) => re.test(text);
}

class MentionNotifier {
  constructor({ getSettings, getUsername, isQuiet = () => false, push = null, inbox = null, log }) {
    this.inbox = inbox; // centre de notifications du panneau (src/inbox.js)
    this.getSettings = getSettings;
    this.getUsername = getUsername;
    this.push = push; // notifications push du navigateur (src/push.js)
    this.isQuiet = isQuiet; // heures calmes : messages envoyés en @silent (mention gardée, sans son ni push)
    this.log = log;
    this.sent = []; // horodatages des envois (limite anti-spam)
    this.dropped = 0;
  }

  // Où part chaque type d'alerte : "discord" | "push" | "both"
  route(kind) {
    return this.getSettings().pushRoutes?.[kind] ?? "discord";
  }

  // Au moins une destination possible pour ce type d'alerte
  canSend(kind) {
    const route = this.route(kind);
    return Boolean((route !== "push" && this.getSettings().discordWebhook) ||
      (route !== "discord" && this.push?.devices.length));
  }

  // Envoie sur Discord et/ou en push selon le réglage du type d'alerte
  deliver(kind, payload, mention, silent, notification) {
    const route = this.route(kind);
    const { discordWebhook } = this.getSettings();
    this.inbox?.add({ kind, ...notification });
    if (route !== "push" && discordWebhook) this.post(discordWebhook, payload, mention, silent);
    if (route !== "discord" && this.push) {
      this.push.send({ ...notification, silent }).catch((err) => this.log.error(`[push] ${err.message}`));
    }
  }

  keywords() {
    const custom = this.getSettings().mentionKeywords ?? [];
    return custom.length ? custom : [this.getUsername()].filter(Boolean);
  }

  // Limite anti-spam commune à toutes les notifications de chat
  allowSend(now) {
    this.sent = this.sent.filter((t) => now - t < 60_000);
    if (this.sent.length >= MAX_PER_MINUTE) {
      if (this.dropped++ === 0) this.log.warn(`[discord] Plus de ${MAX_PER_MINUTE} notifications de chat par minute : les suivantes sont ignorées`);
      return false;
    }
    this.sent.push(now);
    this.dropped = 0;
    return true;
  }

  // Personne surveillée : elle écrit, ou son pseudo est cité. Toujours avec @, même en heures calmes.
  watchedMatch(message) {
    const watched = this.getSettings().watchedUsers ?? [];
    if (!watched.length) return null;
    if (watched.includes(message.login)) return { who: message.login, wrote: true };
    const cited = watched.find((w) => buildMatcher([w])(message.text) || message.replyTo === w);
    return cited ? { who: cited, wrote: false } : null;
  }

  handle(message) {
    const me = this.getUsername();
    if (!this.canSend("chat") || !me || message.login === me) return;

    const watch = this.watchedMatch(message);
    if (watch) return this.watchAlert(message, watch);

    const isReply = message.replyTo === me;
    if (!isReply && !buildMatcher(this.keywords())(message.text)) return;

    const now = Date.now();
    if (!this.allowSend(now)) return;

    this.log.log(`[discord] Mention de ${message.user} dans #${message.channel}`);
    this.deliver("chat", {
      summary: `💬 ${message.user} dans #${message.channel} : ${message.text}`,
      embeds: [{
        author: { name: `${message.user} ${isReply ? "t'a répondu" : "t'a mentionné"} dans #${message.channel}` },
        title: `Ouvrir #${message.channel}`,
        url: `https://www.twitch.tv/${encodeURIComponent(message.channel)}`,
        description: message.text.slice(0, 1000),
        color: 0x9146ff,
        timestamp: new Date(now).toISOString(),
      }],
    }, true, this.isQuiet(), {
      title: `💬 ${message.user} ${isReply ? "t'a répondu" : "t'a mentionné"} dans #${message.channel}`,
      body: message.text.slice(0, 300),
      channel: message.channel,
      tag: `chat-${message.channel}`,
    });
  }

  watchAlert(message, { who, wrote }) {
    const now = Date.now();
    if (!this.allowSend(now)) return;
    this.log.log(`[discord] ${who} ${wrote ? "a écrit" : "cité"} dans #${message.channel}`);
    this.deliver("chat", {
      summary: `👀 ${message.user} dans #${message.channel} : ${message.text}`,
      embeds: [{
        author: { name: wrote ? `👀 ${message.user} a écrit dans #${message.channel}` : `👀 ${message.user} parle de ${who} dans #${message.channel}` },
        title: `Ouvrir #${message.channel}`,
        url: `https://www.twitch.tv/${encodeURIComponent(message.channel)}`,
        description: message.text.slice(0, 1000),
        color: 0x22c55e,
        timestamp: new Date(now).toISOString(),
      }],
    }, true, false, {
      title: wrote ? `👀 ${message.user} a écrit dans #${message.channel}` : `👀 ${message.user} parle de ${who} dans #${message.channel}`,
      body: message.text.slice(0, 300),
      channel: message.channel,
      tag: `watch-${message.channel}`,
    });
  }

  // Un favori vient de passer en live. mode : "on" (message) ou "ping" (message + mention)
  liveAlert(channel, info, mode, { noCard = false, miami = false, avatar = null } = {}) {
    const { miamiMode } = this.getSettings();
    const palm = miamiMode ? "🌴 " : "";
    if (!this.canSend("live") || mode === "off") return;
    this.log.log(`[discord] Alerte live : ${channel}`);
    const url = `https://www.twitch.tv/${encodeURIComponent(channel)}`;
    this.deliver("live", {
      summary: `${palm}🔴 ${info.displayName || channel} est en live${info.game ? ` sur ${info.game}` : ""}${info.title ? ` : ${info.title}` : ""}`,
      embeds: [{
        author: { name: `${palm}${info.displayName || channel} est en live` },
        title: info.title?.slice(0, 250) || `Ouvrir ${channel}`,
        url,
        description: [info.game && `🎮 ${info.game}`, noCard && "🃏 Aucune carte de ce streamer", miami && "🌴 Groupe miami"].filter(Boolean).join("\n") || undefined,
        image: info.thumbnail ? { url: `${info.thumbnail}?t=${Date.now()}` } : undefined,
        color: miamiMode ? 0xff4fa0 : 0xe91916,
        timestamp: info.startedAt,
      }],
    }, mode === "ping", this.isQuiet(), {
      title: `${palm}🔴 ${info.displayName || channel} est en live`,
      body: [info.game, info.title].filter(Boolean).join(" · ").slice(0, 300) || "Ouvrir la chaîne",
      channel,
      icon: avatar || undefined,
      image: info.thumbnail ? `${info.thumbnail}?t=${Date.now()}` : undefined,
      tag: `live-${channel}`,
    });
  }

  // Notre compte a été timeout ou banni d'un chat
  sanctionAlert({ channel, type, duration }) {
    if (!this.canSend("account")) return;
    const what = type === "ban" ? "⛔ Banni" : `⏱ Timeout ${formatDuration(duration)}`;
    this.deliver("account", {
      summary: `${what} sur #${channel}`,
      embeds: [{
        title: `${what} sur #${channel}`,
        url: `https://www.twitch.tv/${encodeURIComponent(channel)}`,
        description: type === "ban"
          ? "Un modérateur a banni ton compte de ce chat. Si ça se répète sur plusieurs chaînes, ton compte est peut-être pris pour un bot."
          : "Un modérateur t'a temporairement réduit au silence dans ce chat.",
        color: type === "ban" ? 0xef4444 : 0xf59e0b,
        timestamp: new Date().toISOString(),
      }],
    }, true, this.isQuiet(), {
      title: `${what} sur #${channel}`,
      body: type === "ban" ? "Un modérateur a banni ton compte de ce chat." : "Un modérateur t'a temporairement réduit au silence.",
      channel,
      tag: `sanction-${channel}`,
    });
  }

  // Alerte de sécurité (connexion, blocage d'IP…) : toujours avec mention
  securityAlert(title, details) {
    if (!this.canSend("account")) return;
    this.deliver("account", {
      summary: `🔐 ${title}`,
      embeds: [{
        title: `🔐 ${title}`,
        description: details,
        color: 0xf59e0b,
        timestamp: new Date().toISOString(),
      }],
    }, true, false, {
      title: `🔐 ${title}`,
      body: details.replace(/\*\*/g, "").slice(0, 300),
      tag: "security",
    });
  }

  // Token Twitch refusé : l'IRC ne peut plus se connecter tant que le compte n'est pas reconnecté
  tokenAlert(reason) {
    if (!this.canSend("account")) return;
    this.deliver("account", {
      summary: "🔌 Compte Twitch déconnecté : ouvre le panneau et clique sur Reconnecter",
      embeds: [{
        title: "🔌 Compte Twitch déconnecté",
        description: `${reason.replace(/ : relance `npm run auth`$/, "")}\n\nL'IRC ne peut plus se connecter. Ouvre le panneau et clique sur **Reconnecter**.`,
        color: 0xef4444,
        timestamp: new Date().toISOString(),
      }],
    }, true, false, {
      title: "🔌 Compte Twitch déconnecté",
      body: "Ouvre le panneau et clique sur Reconnecter.",
      tag: "token",
    });
  }

  async test() {
    const { discordWebhook } = this.getSettings();
    if (!discordWebhook) throw new Error("Aucun webhook Discord configuré");
    const ok = await this.post(discordWebhook, {
      embeds: [{
        title: "Notifications activées ✅",
        description: `Tu seras prévenu ici quand ces mots apparaissent dans un chat : ${this.keywords().join(", ")}`,
        color: 0x9146ff,
      }],
    });
    if (!ok) throw new Error("Discord a refusé le message : vérifie l'adresse du webhook");
  }

  async post(url, { summary, ...payload }, mention = true, silent = false) {
    // Mention de l'utilisateur configuré (pastille rouge sur Discord). Seul cet utilisateur peut
    // être mentionné : aucun @everyone ou @rôle ne peut venir du texte du chat.
    const userId = this.getSettings().discordUserId;
    const withPing = mention && isDiscordUserId(userId);
    // Résumé en texte simple après la mention : c'est la seule partie qu'affiche une notif de
    // téléphone (les cartes « embed » n'y apparaissent pas)
    const text = summary ? plain(summary) : "";
    const content = [withPing && `<@${userId}>`, text].filter(Boolean).join(" ");
    const ping = {
      ...(content && { content }),
      allowed_mentions: withPing ? { parse: [], users: [userId] } : { parse: [] },
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // flags 4096 = SUPPRESS_NOTIFICATIONS (@silent) : pas de son ni de push, la mention reste
        body: JSON.stringify({ username: "Twitch Deck", ...ping, ...payload, ...(silent && { flags: 4096 }) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.error(`[discord] Envoi refusé : HTTP ${res.status}`);
      return res.ok;
    } catch (err) {
      this.log.error(`[discord] Envoi impossible : ${err.message}`);
      return false;
    }
  }
}

// Une seule ligne de 180 caractères au plus. Pas d'échappement : la notif du téléphone montrerait
// les « \ », et allowed_mentions empêche déjà le texte du chat de mentionner qui que ce soit.
function plain(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

// 600 → « 10 min », 86400 → « 1 j »
function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} j`;
}

module.exports = { MentionNotifier, isWebhookUrl, isDiscordUserId, formatDuration };
