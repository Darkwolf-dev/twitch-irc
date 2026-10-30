"use strict";

require("dotenv").config({ quiet: true });

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { TwitchIrc } = require("./irc");
const { TokenManager, DATA_DIR } = require("./token");
const { DropTracker } = require("./drops");
const { LiveMonitor } = require("./live");
const { EventLog, summarize } = require("./events");
const { SessionStore, readCookie, cookieHeader, COOKIE, SESSION_TTL_MS } = require("./sessions");
const { MentionNotifier, isWebhookUrl, isDiscordUserId, formatDuration } = require("./discord");
const { StatsStore } = require("./stats");
const { DormantTracker } = require("./dormant");
const { AvatarStore } = require("./avatars");

const {
  API_SECRET = "",
  HOST = "127.0.0.1",
  PORT = "3000",
  MAX_CHANNELS = "100",
  TRUST_PROXY,
  CLIENT_IP_HEADER,
  ALLOWED_LOGINS = "",
  COOKIE_SECURE = "true",
  HEALTHCHECK_URL,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_OAUTH_TOKEN,
} = process.env;

if (API_SECRET.length < 32) {
  console.error("API_SECRET manquant ou trop court (32 caractères minimum). Génère-le avec : npm run secret");
  process.exit(1);
}

const maxChannels = Number(MAX_CHANNELS);

// Version de l'appli : empreinte du code (src/ et public/), pour que le panneau
// se recharge tout seul après un déploiement. La date est celle du fichier le plus récent.
const APP_VERSION = (() => {
  const root = path.join(__dirname, "..");
  const hash = crypto.createHash("sha256");
  let deployedAt = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      hash.update(path.relative(root, file)).update(fs.readFileSync(file));
      deployedAt = Math.max(deployedAt, fs.statSync(file).mtimeMs);
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "public"));
  return { id: hash.digest("hex").slice(0, 7), deployedAt: new Date(deployedAt).toISOString() };
})();
const CHANNELS_FILE = path.join(DATA_DIR, "channels.json");

const MAX_SAVED = 500;

const events = new EventLog({ dir: path.join(DATA_DIR, "journal"), keepDays: 30 });
const log = events.logger();

// Connexion au panneau avec Twitch : seuls ces logins sont acceptés (vide = désactivée)
const allowedLogins = new Set(ALLOWED_LOGINS.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
const twitchLoginEnabled = Boolean(TWITCH_CLIENT_ID && allowedLogins.size);
const sessions = new SessionStore(DATA_DIR);
const secureCookie = COOKIE_SECURE !== "false";

// --- État des chaînes ---
// Format du fichier :
// { "channels": [{ "name": "x", "enabled": true, "liveOnly": false, "favorite": false, "groups": ["24h"], "watchedAt": null, "cards": ["epic"] }, …] }
// (l'ancien format { "channels": ["x", …] } est lu comme « tout activé »)
//
// enabled   : l'interrupteur de la chaîne
// liveOnly  : si activée, on ne rejoint le chat que pendant le live
// watchedAt : « assez regardée aujourd'hui », remis à zéro chaque jour à minuit UTC
// cards     : cartes streamer déjà obtenues (« epic », « legendary »), simple info pour l'instant

const saved = new Set();
const enabled = new Set();
const liveOnly = new Set();
const favorites = new Set();
const groups = new Map(); // chaîne -> Set des groupes
const watched = new Map(); // chaîne -> date du marquage (ISO)
const CARD_RARITIES = ["epic", "legendary"];
const cards = new Map(); // chaîne -> Set des raretés obtenues
const cardsOf = (name) => CARD_RARITIES.filter((r) => cards.get(name)?.has(r));

// Une « journée de visionnage » va de minuit à minuit UTC (1 h à Paris l'hiver,
// 2 h l'été) : deux dates sont dans la même journée si elles ont la même date UTC.
function watchDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}
function isWatched(name) {
  const at = watched.get(name);
  return Boolean(at) && watchDay(at) === watchDay(Date.now());
}

function normalizeGroup(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return /^[\p{L}\p{N} _-]{1,20}$/u.test(name) ? name : null;
}

function groupsOf(name) {
  return [...(groups.get(name) ?? [])].sort();
}

function loadChannels() {
  try {
    const list = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8")).channels ?? [];
    return list.map((c) => (typeof c === "string" ? { name: c, enabled: true } : c));
  } catch {
    return [];
  }
}

function saveChannels() {
  fs.mkdirSync(path.dirname(CHANNELS_FILE), { recursive: true });
  const channels = [...saved].sort().map((name) => ({
    name,
    enabled: enabled.has(name),
    liveOnly: liveOnly.has(name),
    favorite: favorites.has(name),
    groups: groupsOf(name),
    watchedAt: isWatched(name) ? watched.get(name) : null,
    cards: cardsOf(name),
  }));
  const tmp = CHANNELS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ channels }, null, 2));
  fs.renameSync(tmp, CHANNELS_FILE);
}

function normalize(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^#/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(name) ? name : null;
}

// Accepte { "channel": "x" } ou { "channels": ["x", "y"] }
function readChannels(body) {
  const list = Array.isArray(body?.channels) ? body.channels
    : body?.channel !== undefined ? [body.channel]
    : [];
  if (list.length === 0 || list.length > MAX_SAVED) {
    return { error: `Fournir "channel" ou "channels" (1 à ${MAX_SAVED} éléments)` };
  }
  const names = [];
  for (const value of list) {
    const name = normalize(value);
    if (!name) return { error: `Canal invalide : ${JSON.stringify(value)}` };
    names.push(name);
  }
  return { names: [...new Set(names)] };
}

for (const channel of loadChannels()) {
  const name = normalize(channel.name);
  if (!name) continue;
  saved.add(name);
  if (channel.enabled) enabled.add(name);
  if (channel.liveOnly) liveOnly.add(name);
  if (channel.favorite) favorites.add(name);
  if (channel.watchedAt && !Number.isNaN(Date.parse(channel.watchedAt))) watched.set(name, channel.watchedAt);
  const channelGroups = (channel.groups ?? []).map(normalizeGroup).filter(Boolean);
  if (channelGroups.length) groups.set(name, new Set(channelGroups));
  const owned = (channel.cards ?? []).filter((r) => CARD_RARITIES.includes(r));
  if (owned.length) cards.set(name, new Set(owned));
}

// --- IRC et live ---

const tokens = new TokenManager({
  clientId: TWITCH_CLIENT_ID,
  clientSecret: TWITCH_CLIENT_SECRET,
  staticToken: TWITCH_OAUTH_TOKEN,
  onNeedsAuth: (reason) => notifier.tokenAlert(reason),
  onReconnected: (login) => {
    notifier.securityAlert("Compte Twitch reconnecté", `L'IRC utilise maintenant le compte **${login}**`);
    irc.reconnectNow();
  },
});

const irc = new TwitchIrc({
  getToken: () => tokens.get(),
  onAuthFailure: () => tokens.invalidate(),
  onSanction: (sanction) => recordSanction(sanction),
  onMessage: (message) => {
    stats.countMessage(message.channel);
    drops.handle(message);
    notifier.handle(message);
  },
  log,
});

const live = new LiveMonitor({
  getToken: () => tokens.get(),
  getChannels: () => saved,
  onChange: () => {
    dormant.markLive([...live.live.keys()]);
    syncDesired();
  },
  onWentLive: (channel, info) => {
    // Une seule alerte même si la chaîne est favorite et sans carte : le mode le plus fort l'emporte
    const noCard = !cardsOf(channel).length;
    const modes = [favorites.has(channel) && settings.discordLiveAlerts, noCard && settings.discordNoCardAlerts];
    const mode = ["ping", "on"].find((m) => modes.includes(m));
    if (mode) notifier.liveAlert(channel, info, mode, { noCard });
  },
  onAuthFailure: () => tokens.invalidate(),
  log,
});

const drops = new DropTracker({
  dataDir: DATA_DIR,
  getLive: () => live.live,
  isJoined: (channel) => irc.joined.has(channel),
  log,
});

const stats = new StatsStore({
  dataDir: DATA_DIR,
  getLive: () => live.live,
  isJoined: (channel) => irc.joined.has(channel),
  log,
});

// --- Sanctions reçues par notre compte (timeout / ban) ---

const SANCTIONS_FILE = path.join(DATA_DIR, "sanctions.json");
let sanctions = [];
try { sanctions = JSON.parse(fs.readFileSync(SANCTIONS_FILE, "utf8")); } catch {}

function saveSanctions() {
  const tmp = SANCTIONS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sanctions.slice(-500), null, 1));
  fs.renameSync(tmp, SANCTIONS_FILE);
}

function recordSanction({ channel, type, duration, fromNotice }) {
  // Twitch répète « msg_banned » à chaque tentative : un ban déjà connu n'est pas renoté
  if (type === "ban" && sanctions.some((x) => x.channel === channel && x.type === "ban" && !x.cleared)) return;
  const at = new Date();
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    at: at.toISOString(),
    channel,
    type,
    duration,
    until: duration ? new Date(at.getTime() + duration * 1000).toISOString() : null,
    source: fromNotice ? "notice" : "clearchat",
    cleared: false,
  };
  sanctions.push(entry);
  saveSanctions();
  const what = type === "ban" ? "banni" : `timeout ${formatDuration(duration)}`;
  log.warn(`[mod] Ton compte a été ${what} sur #${channel}`);
  notifier.sanctionAlert(entry);
}

// Sanction en cours pour une chaîne (ban non levé, ou timeout pas encore terminé)
function activeSanction(channel) {
  const now = Date.now();
  for (let i = sanctions.length - 1; i >= 0; i--) {
    const x = sanctions[i];
    if (x.channel !== channel || x.cleared) continue;
    if (x.type === "ban" || Date.parse(x.until) > now) return { type: x.type, at: x.at, until: x.until, id: x.id };
  }
  return null;
}

const dormant = new DormantTracker({ dataDir: DATA_DIR, getToken: () => tokens.get(), log });
const avatars = new AvatarStore({ dataDir: DATA_DIR, getToken: () => tokens.get(), log });

const alwaysCount = () => [...enabled].filter((n) => !liveOnly.has(n)).length;

// --- Réglages modifiables depuis le panneau ---

const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const DEFAULT_SCHEDULE = { enabled: false, start: "18:00", end: "02:00", timeZone: "Europe/Paris" };
const settings = {
  maxConcurrent: maxChannels,
  discordWebhook: "",
  discordUserId: "",
  mentionKeywords: [],
  discordLiveAlerts: "on", // favori en live : "off" | "on" | "ping"
  discordNoCardAlerts: "ping", // chaîne sans aucune carte streamer en live : "off" | "on" | "ping"
  allowSecretLogin: true,  // connexion au panneau / à l'API avec le secret (toujours permise depuis le serveur lui-même)
  ircPaused: false,        // IRC mis en pause depuis le panneau (conservé au redémarrage)
  dormantDays: 30,         // chaîne « endormie » au-delà de N jours sans live
  dormantKeep: [],         // chaînes à ne plus jamais proposer au nettoyage
  dormantSnoozeUntil: null, // suggestion masquée jusqu'à cette date
  // Heures calmes : notifications Discord en @silent (mention gardée, sans son ni push), sauf sécurité
  quietHours: { enabled: false, start: "01:00", end: "09:00", timeZone: "Europe/Paris" },
  schedule: { ...DEFAULT_SCHEDULE },
};
try {
  Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")));
} catch {}
settings.maxConcurrent = Math.min(maxChannels, Math.max(1, Number(settings.maxConcurrent) || maxChannels));
if (!isWebhookUrl(settings.discordWebhook)) settings.discordWebhook = "";
if (!Array.isArray(settings.mentionKeywords)) settings.mentionKeywords = [];
if (!isDiscordUserId(settings.discordUserId)) settings.discordUserId = "";
if (!["off", "on", "ping"].includes(settings.discordLiveAlerts)) settings.discordLiveAlerts = "on";
if (!["off", "on", "ping"].includes(settings.discordNoCardAlerts)) settings.discordNoCardAlerts = "ping";
if (typeof settings.allowSecretLogin !== "boolean") settings.allowSecretLogin = true;
settings.ircPaused = settings.ircPaused === true;
settings.dormantDays = Math.min(365, Math.max(7, Number(settings.dormantDays) || 30));
if (!Array.isArray(settings.dormantKeep)) settings.dormantKeep = [];
if (settings.dormantSnoozeUntil && Number.isNaN(Date.parse(settings.dormantSnoozeUntil))) settings.dormantSnoozeUntil = null;
settings.schedule = validSchedule(settings.schedule) ?? { ...DEFAULT_SCHEDULE };
settings.quietHours = validSchedule(settings.quietHours) ?? { enabled: false, start: "01:00", end: "09:00", timeZone: "Europe/Paris" };

// --- Plage horaire : en dehors, les chaînes « si live » ne sont pas rejointes ---

function validSchedule(value) {
  if (!value || typeof value !== "object") return null;
  const { enabled, start, end, timeZone } = value;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof enabled !== "boolean" || !time.test(start) || !time.test(end) || start === end) return null;
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone });
  } catch {
    return null;
  }
  return { enabled, start, end, timeZone };
}

// Heure courante dans une plage (09:00-17:00) ou à cheval sur minuit (18:00-02:00)
function inTimeWindow({ start, end, timeZone }, at = new Date()) {
  const now = new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function quietNow() {
  return settings.quietHours.enabled && inTimeWindow(settings.quietHours);
}

function scheduleOpen(at = new Date()) {
  const { enabled, start, end, timeZone } = settings.schedule;
  if (!enabled) return true;
  const now = new Intl.DateTimeFormat("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  // Plage dans la journée (09:00-17:00) ou à cheval sur minuit (18:00-02:00)
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// L'adresse du webhook est un secret : elle n'est jamais renvoyée au panneau
function publicSettings() {
  return {
    maxConcurrent: settings.maxConcurrent,
    mentionKeywords: settings.mentionKeywords,
    discordUserId: settings.discordUserId,
    discordWebhookSet: Boolean(settings.discordWebhook),
    discordLiveAlerts: settings.discordLiveAlerts,
    discordNoCardAlerts: settings.discordNoCardAlerts,
    allowSecretLogin: settings.allowSecretLogin,
    quietHours: settings.quietHours,
    quietNow: quietNow(),
    schedule: settings.schedule,
    scheduleOpen: scheduleOpen(),
  };
}

const notifier = new MentionNotifier({
  getSettings: () => settings,
  getUsername: () => irc.username,
  isQuiet: () => quietNow(),
  log,
});

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 }); // contient le webhook
  fs.renameSync(tmp, SETTINGS_FILE);
}

// Calcule les chaînes à rejoindre, dans la limite du plafond de chats simultanés :
// d'abord les chaînes « toujours » (favoris en tête), puis celles « si live »
// actuellement en live (favoris, puis celles qui droppent le plus, puis plus gros lives).
function syncDesired() {
  // Une chaîne marquée « vu » n'est plus rejointe jusqu'à la remise à zéro de minuit UTC
  const candidates = [...enabled].filter((n) => !isWatched(n));
  const always = candidates
    .filter((n) => !liveOnly.has(n))
    .sort((a, b) => (favorites.has(b) - favorites.has(a)) || a.localeCompare(b));
  const open = scheduleOpen();
  // Puis les chaînes qui droppent le plus (radar à drops), puis les plus gros lives
  const dropScores = drops.scores();
  const whenLive = candidates
    .filter((n) => open && liveOnly.has(n) && live.isActive(n))
    .sort((a, b) =>
      (favorites.has(b) - favorites.has(a)) ||
      ((dropScores.get(b) ?? 0) - (dropScores.get(a) ?? 0)) ||
      ((live.info(b)?.viewers ?? 0) - (live.info(a)?.viewers ?? 0)) ||
      a.localeCompare(b));
  irc.setDesired(new Set([...always, ...whenLive].slice(0, settings.maxConcurrent)));
}

// --- Sauvegardes de la liste des chaînes ---
// Une copie par jour (si la liste a changé) et avant chaque grosse opération, 30 gardées.

const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 30;

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^channels-.+\.json$/.test(f)).sort();
  } catch {
    return [];
  }
}

function backupChannels(reason) {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return;
    const current = fs.readFileSync(CHANNELS_FILE);
    const existing = listBackups();
    const latest = existing.at(-1);
    if (latest && fs.readFileSync(path.join(BACKUP_DIR, latest)).equals(current)) return; // rien de nouveau

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `channels-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, name), current);
    for (const old of listBackups().slice(0, -BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old));
    log.log(`[backup] Sauvegarde ${name} (${reason})`);
  } catch (err) {
    log.error(`[backup] Échec de la sauvegarde : ${err.message}`);
  }
}

function backupStatus() {
  const files = listBackups();
  const latest = files.at(-1);
  let at = null;
  if (latest) {
    try { at = fs.statSync(path.join(BACKUP_DIR, latest)).mtime.toISOString(); } catch {}
  }
  return { count: files.length, keep: BACKUP_KEEP, latest: at };
}

// --- Profils : « photos » de la configuration, applicables en un clic ---
// Un profil retient, pour chaque chaîne connue au moment de l'enregistrement, son activation
// et son mode, plus le plafond et la plage horaire. Les chaînes ajoutées après ne sont pas touchées.

const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const MAX_PROFILES = 10;
let profiles = { list: [], active: null };
try {
  profiles = { list: [], active: null, ...JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")) };
} catch {}

function saveProfiles() {
  fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
  const tmp = PROFILES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2));
  fs.renameSync(tmp, PROFILES_FILE);
}

function snapshot() {
  const channels = {};
  for (const name of saved) channels[name] = { enabled: enabled.has(name), liveOnly: liveOnly.has(name) };
  return { channels, maxConcurrent: settings.maxConcurrent, schedule: { ...settings.schedule } };
}

// Différences entre l'état actuel et un profil (pour afficher « modifié »)
function profileDiffers(profile) {
  const now = snapshot();
  if (now.maxConcurrent !== profile.state.maxConcurrent) return true;
  if (JSON.stringify(now.schedule) !== JSON.stringify(profile.state.schedule)) return true;
  return Object.entries(profile.state.channels).some(([name, c]) =>
    saved.has(name) && (now.channels[name].enabled !== c.enabled || now.channels[name].liveOnly !== c.liveOnly));
}

function profilesStatus() {
  const active = profiles.list.find((p) => p.name === profiles.active) ?? null;
  return {
    names: profiles.list.map((p) => p.name),
    active: active?.name ?? null,
    modified: active ? profileDiffers(active) : false,
    max: MAX_PROFILES,
  };
}

function applyProfile(profile) {
  backupChannels(`avant le profil « ${profile.name} »`);
  for (const [name, c] of Object.entries(profile.state.channels)) {
    if (!saved.has(name)) continue; // chaîne retirée depuis
    if (c.enabled) enabled.add(name); else enabled.delete(name);
    if (c.liveOnly) liveOnly.add(name); else liveOnly.delete(name);
  }
  settings.maxConcurrent = Math.min(maxChannels, profile.state.maxConcurrent);
  settings.schedule = validSchedule(profile.state.schedule) ?? settings.schedule;
  saveSettings();
  syncDesired();
  saveChannels();
  profiles.active = profile.name;
  saveProfiles();
}

syncDesired();
setInterval(syncDesired, 30_000).unref(); // fait expirer le délai de grâce après la fin d'un live

function channelInfo(name) {
  const info = irc.channelInfo(name);
  if (enabled.has(name) && !irc.desired.has(name)) {
    info.state = isWatched(name) ? "watched"
      : !liveOnly.has(name) ? "full"
      : !live.isActive(name) ? "offline"
      : !scheduleOpen() ? "schedule"
      : "full";
  }
  return {
    ...info,
    enabled: enabled.has(name),
    liveOnly: liveOnly.has(name),
    live: live.info(name),
    lastLive: dormant.lastLiveOf(name)?.at ?? null,
    avatar: avatars.url(name),
    sanction: activeSanction(name),
    favorite: favorites.has(name),
    groups: groupsOf(name),
    watched: isWatched(name),
    cards: cardsOf(name),
    lastDrop: drops.recentDropOf(name)?.at ?? null,
  };
}

function fullStatus() {
  const status = irc.status();
  status.channels = [...saved].sort().map(channelInfo);
  status.counts.saved = saved.size;
  status.counts.enabled = enabled.size;
  status.counts.liveOnly = liveOnly.size;
  status.counts.live = status.channels.filter((c) => c.live).length;
  status.counts.favorites = favorites.size;
  status.limits = { active: maxChannels, saved: MAX_SAVED, concurrent: settings.maxConcurrent };
  status.settings = publicSettings();
  status.backups = backupStatus();
  status.profiles = profilesStatus();
  status.irc.paused = settings.ircPaused;
  status.sanctions = { total: sanctions.length, active: sanctions.filter((x) => !x.cleared && (x.type === "ban" || Date.parse(x.until) > Date.now())).length };
  const sleepers = dormantReport();
  status.version = APP_VERSION;
  status.dormant = {
    count: sleepers.length,
    days: settings.dormantDays,
    snoozed: Boolean(settings.dormantSnoozeUntil && Date.parse(settings.dormantSnoozeUntil) > Date.now()),
  };
  status.live = live.status();
  status.token = tokens.status();

  const sizes = new Map();
  for (const set of groups.values()) for (const g of set) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  status.groups = [...sizes].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count }));
  return status;
}

// --- API ---

const app = express();
app.disable("x-powered-by");
// Derrière un reverse proxy (Caddy, Nginx, PaaS) : nombre de proxys à croire pour req.ip
if (TRUST_PROXY) app.set("trust proxy", Number(TRUST_PROXY) || TRUST_PROXY);

app.use((req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});

// Sonde de santé pour l'hébergeur : ne révèle rien
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Panneau de contrôle web : fichiers statiques publics, les données passent par l'API authentifiée
app.get("/favicon.ico", (req, res) => res.status(204).end());
const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://static-cdn.jtvnw.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
};
// La page appelle app.js et app.css avec le numéro de version : après un déploiement, le navigateur
// ne peut pas garder l'ancien script avec la nouvelle page (éléments introuvables)
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8")
  .replace('href="app.css"', `href="app.css?v=${APP_VERSION.id}"`)
  .replace('src="app.js"', `src="app.js?v=${APP_VERSION.id}"`);
app.get(["/", "/index.html"], (req, res) => {
  res.set({ ...PAGE_HEADERS, "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" }).send(INDEX_HTML);
});
// Nouvelle présentation en essai sur /v2/ : même app.js et app.css, plus v2.js et v2.css
const V2_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "v2", "index.html"), "utf8")
  .replace(/(href|src)="([^"]+\.(?:css|js))"/g, `$1="$2?v=${APP_VERSION.id}"`);
app.get(["/v2", "/v2/index.html"], (req, res) => {
  // Sans la barre finale, les chemins relatifs de la page (v2.js, ../app.js) seraient faux
  if (req.path === "/v2") return res.redirect(301, "/v2/");
  res.set({ ...PAGE_HEADERS, "Cache-Control": "no-cache", "Content-Type": "text/html; charset=utf-8" }).send(V2_HTML);
});
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    setHeaders(res, filePath) {
      res.set({
        ...PAGE_HEADERS,
        // Icônes : gardées 7 jours. Le reste (page, script, style) : gardé mais revérifié à chaque
        // chargement via l'ETag (réponse 304 sans contenu s'il n'a pas changé), pour qu'un déploiement
        // soit pris tout de suite.
        "Cache-Control": filePath.includes(`${path.sep}icons${path.sep}`) ? "public, max-age=604800" : "no-cache",
      });
    },
  })
);

// Authentification avant tout parsing du corps. On compare des empreintes de
// taille fixe pour que la comparaison reste en temps constant.
const sha256 = (value) => crypto.createHash("sha256").update(value).digest();
const expectedAuth = sha256(`Bearer ${API_SECRET}`);

// Blocage temporaire d'une IP après trop d'échecs d'authentification
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
const failures = new Map(); // ip -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failures) if (entry.resetAt <= now) failures.delete(ip);
}, 60_000).unref();

// Derrière Cloudflare, la vraie IP du client est dans CF-Connecting-IP (CLIENT_IP_HEADER=cf-connecting-ip).
// À n'activer que si l'app est joignable uniquement via Cloudflare, sinon l'en-tête peut être falsifié.
const clientIp = (req) => (CLIENT_IP_HEADER && req.get(CLIENT_IP_HEADER)) || req.ip;

function isBlocked(req, res) {
  const now = Date.now();
  const entry = failures.get(clientIp(req));
  if (entry && entry.resetAt > now && entry.count >= MAX_FAILURES) {
    res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    res.status(429).json({ error: "Too many failed attempts" });
    return true;
  }
  return false;
}

function recordFailure(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) {
    failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  } else if (++entry.count === MAX_FAILURES) {
    log.warn(`[api] IP ${whereFrom(req)} bloquée 15 min après ${MAX_FAILURES} échecs d'authentification`);
    notifier.securityAlert("IP bloquée", `**${whereFrom(req)}** : ${MAX_FAILURES} échecs d'authentification, bloquée 15 min.`);
  }
}

// Requête venue du serveur lui-même (diagnostic dans le conteneur), jamais via le tunnel
function isLocalRequest(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) && !req.get(CLIENT_IP_HEADER || "x-none");
}

// Localisation d'un visiteur à partir des en-têtes ajoutés par Cloudflare :
// cf-ipcountry est toujours présent ; ville et région demandent la « Managed Transform »
// « Add visitor location headers » (gratuite). Uniquement derrière Cloudflare (CLIENT_IP_HEADER).
function flagOf(country) {
  return /^[A-Z]{2}$/.test(country ?? "")
    ? String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
    : "";
}

function locationOf(req) {
  if (!CLIENT_IP_HEADER) return null;
  const decode = (v) => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
  const country = (req.get("cf-ipcountry") ?? "").toUpperCase();
  const city = decode(req.get("cf-ipcity"));
  const region = decode(req.get("cf-region"));
  if (!country || country === "XX" || country === "T1") return country === "T1" ? "🧅 réseau Tor" : null;
  return [flagOf(country), [city, region !== city ? region : null, country].filter(Boolean).join(", ")].filter(Boolean).join(" ");
}

// « IP 1.2.3.4 (🇫🇷 Paris, Île-de-France, FR) »
function whereFrom(req) {
  const location = locationOf(req);
  return `${clientIp(req)}${location ? ` (${location})` : ""}`;
}

// Appareil lisible à partir du User-Agent (« Chrome · Windows »)
function describeDevice(userAgent = "") {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Navigateur";
  const os = /iPhone|iPad/.test(userAgent) ? "iPhone/iPad" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows"
    : /Mac OS X/.test(userAgent) ? "Mac" : /Linux/.test(userAgent) ? "Linux" : "système inconnu";
  return `${browser} · ${os}`;
}

// Utilisation du secret depuis une IP pas vue depuis 7 jours : alerte
const secretIps = new Map(); // ip -> dernière alerte
function noteSecretUse(req) {
  if (isLocalRequest(req)) return;
  const ip = clientIp(req);
  const last = secretIps.get(ip);
  secretIps.set(ip, Date.now());
  if (!last || Date.now() - last > 7 * 24 * 3600_000) {
    log.log(`[auth] Secret de l'API utilisé depuis ${whereFrom(req)}`);
    notifier.securityAlert("Accès avec le secret de l'API", `IP **${whereFrom(req)}**\n${describeDevice(req.get("user-agent"))}`);
  }
}

// --- Connexion au panneau avec Twitch (flux OAuth implicite) ---
// Le navigateur obtient un token Twitch sans scope, le serveur vérifie qu'il a été émis
// pour notre appli et pour un login autorisé, le révoque, puis ouvre une session par cookie.

// Pseudo affiché et avatar d'un compte Twitch (sans token : celui du serveur)
async function fetchProfile(login, userToken) {
  try {
    const token = userToken ?? (await tokens.get()).token;
    const r = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
    });
    const user = r.ok ? (await r.json()).data?.[0] : null;
    return user ? { displayName: user.display_name, avatar: user.profile_image_url } : {};
  } catch {
    return {};
  }
}

app.get("/auth/config", (req, res) => {
  res.json({
    twitch: twitchLoginEnabled,
    clientId: twitchLoginEnabled ? TWITCH_CLIENT_ID : null,
    // Sans connexion Twitch configurée, le secret reste proposé pour ne jamais fermer la porte
    secret: settings.allowSecretLogin || !twitchLoginEnabled,
  });
});

app.post("/auth/twitch", express.json({ limit: "2kb" }), async (req, res) => {
  if (!twitchLoginEnabled) return res.status(404).json({ error: "Connexion Twitch désactivée" });
  if (isBlocked(req, res)) return;

  const token = req.body?.accessToken;
  if (typeof token !== "string" || !/^[a-z0-9]{20,64}$/i.test(token)) {
    return res.status(400).json({ error: "Token manquant" });
  }

  let info;
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/validate", { headers: { Authorization: `OAuth ${token}` } });
    info = r.ok ? await r.json() : null;
  } catch (err) {
    log.error(`[auth] Validation Twitch impossible : ${err.message}`);
    return res.status(502).json({ error: "Twitch injoignable, réessaie" });
  }

  const valid = info && info.client_id === TWITCH_CLIENT_ID;
  const login = valid ? String(info.login).toLowerCase() : null;
  // Pseudo et avatar, récupérés avec le token de l'utilisateur avant de le révoquer
  const profile = valid && allowedLogins.has(login) ? await fetchProfile(login, token) : {};

  // Le token n'a plus d'utilité : on le révoque tout de suite
  fetch("https://id.twitch.tv/oauth2/revoke", {
    method: "POST",
    body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, token }),
  }).catch(() => {});

  if (!valid) {
    recordFailure(req);
    return res.status(401).json({ error: "Token Twitch invalide" });
  }
  if (!allowedLogins.has(login)) {
    recordFailure(req);
    log.warn(`[auth] Connexion refusée pour le compte Twitch « ${login} »`);
    return res.status(403).json({ error: `Le compte Twitch « ${login} » n'est pas autorisé` });
  }

  const ip = clientIp(req);
  const location = locationOf(req);
  const userAgent = req.get("user-agent") ?? "";
  res.set("Set-Cookie", cookieHeader(sessions.create(login, profile, { ip, location, userAgent }), SESSION_TTL_MS, secureCookie));
  log.log(`[auth] ${login} connecté au panneau via Twitch (${whereFrom(req)}, ${describeDevice(userAgent)})`);
  notifier.securityAlert("Nouvelle connexion au panneau", `Compte Twitch **${login}**\nIP **${whereFrom(req)}**\n${describeDevice(userAgent)}`);
  res.json({ ok: true, login });
});

app.post("/auth/logout", (req, res) => {
  sessions.destroy(readCookie(req, COOKIE));
  res.set("Set-Cookie", cookieHeader("", 0, secureCookie));
  res.json({ ok: true });
});

// --- Authentification de l'API : secret (Bearer) ou session Twitch (cookie) ---

app.use((req, res, next) => {
  if (isBlocked(req, res)) return;

  const authorization = req.get("authorization");
  if (authorization && crypto.timingSafeEqual(sha256(authorization), expectedAuth)) {
    if (!settings.allowSecretLogin && !isLocalRequest(req)) {
      return res.status(401).json({ error: "Connexion par secret désactivée : connecte-toi avec Twitch" });
    }
    noteSecretUse(req);
    req.user = "api-secret";
    return next();
  }

  const sid = readCookie(req, COOKIE);
  const session = !authorization && sessions.get(sid);
  if (session) {
    // Protection CSRF en plus de SameSite=Strict : une écriture doit venir de notre propre origine
    const origin = req.get("origin");
    let sameOrigin = true;
    try { sameOrigin = !origin || new URL(origin).host === req.get("host"); } catch { sameOrigin = false; }
    if (req.method !== "GET" && !sameOrigin) return res.status(403).json({ error: "Origine refusée" });
    sessions.touch(sid, clientIp(req), req.get("user-agent"), locationOf(req));
    req.user = session.login;
    req.session = session;
    req.sid = sid;
    return next();
  }

  // Seuls les identifiants présentés mais faux comptent comme échec
  // (une simple visite sans session ne doit pas bloquer l'IP)
  if (authorization || sid) recordFailure(req);
  // Session expirée ou inconnue : on efface le cookie pour ne pas compter d'échecs à chaque visite
  if (sid) res.set("Set-Cookie", cookieHeader("", 0, secureCookie));
  res.status(401).json({ error: "Unauthorized" });
});

app.use(express.json({ limit: "10kb" }));

// --- Sessions du panneau : liste et révocation ---

app.get("/auth/sessions", (req, res) => {
  res.json({
    sessions: sessions.list(req.sid).map((s) => ({ ...s, device: describeDevice(s.userAgent), userAgent: undefined })),
    allowSecretLogin: settings.allowSecretLogin,
  });
});

// { "id": "<16 caractères>" } pour une session, ou { "others": true } pour toutes sauf la courante
app.post("/auth/sessions/revoke", (req, res) => {
  const { id, others } = req.body ?? {};
  let count;
  if (others === true) {
    count = sessions.revoke({ exceptSid: req.sid });
  } else if (typeof id === "string" && /^[0-9a-f]{16}$/.test(id)) {
    count = sessions.revoke({ id });
  } else {
    return res.status(400).json({ error: `Fournir "id" ou "others": true` });
  }
  log.log(`[auth] ${count} session(s) révoquée(s) par ${req.user}`);
  res.json({ ok: true, revoked: count });
});

app.get("/me", async (req, res) => {
  if (!req.session) return res.json({ method: "secret", user: null });
  // Sessions ouvertes avant l'ajout des avatars : on complète une fois
  if (!req.session.avatar) sessions.setProfile(req.sid, await fetchProfile(req.session.login));
  res.json({
    method: "twitch",
    user: req.session.login,
    displayName: req.session.displayName ?? req.session.login,
    avatar: req.session.avatar ?? null,
  });
});

app.get("/status", (req, res) => {
  res.json(fullStatus());
});

app.get("/channels", (req, res) => {
  res.json(fullStatus().channels);
});

app.get("/events", (req, res) => {
  res.json({ events: events.since(Number(req.query.since) || 0) });
});

// Mini-chat : derniers messages reçus d'une chaîne (après l'identifiant "after")
app.get("/channels/:name/messages", (req, res) => {
  const name = normalize(req.params.name);
  if (!name || !saved.has(name)) return res.status(404).json({ error: "Chaîne inconnue" });
  res.json({ channel: name, joined: irc.joined.has(name), messages: irc.messagesOf(name, Number(req.query.after) || 0) });
});

// Statistiques des 7 derniers jours d'une chaîne
app.get("/channels/:name/stats", (req, res) => {
  const name = normalize(req.params.name);
  if (!name || !saved.has(name)) return res.status(404).json({ error: "Chaîne inconnue" });
  res.json({ channel: name, ...stats.of(name) });
});

// Journal complet des N derniers jours, en texte (1 à 30 jours)
app.get("/events/download", (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 30));
  const lines = events.lastDays(days).map((e) => `${e.at}  ${e.level.padEnd(5)}  ${e.source.padEnd(6)}  ${e.message}`);
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="journal-${new Date().toISOString().slice(0, 10)}.txt"`,
  });
  res.send(lines.join("\n") + "\n");
});

function checkSavedLimit(names, res) {
  const added = names.filter((name) => !saved.has(name));
  if (saved.size + added.length > MAX_SAVED) {
    res.status(409).json({ error: `Limite de ${MAX_SAVED} chaînes enregistrées atteinte` });
    return false;
  }
  return true;
}

// Vérifie qu'on ne dépasse pas la limite Twitch avec les chaînes en mode « toujours »
function checkAlwaysLimit(newAlways, res) {
  if (alwaysCount() + newAlways > maxChannels) {
    res.status(409).json({
      error: `Plus de ${maxChannels} chaînes en mode « toujours » : passe-en certaines en mode « si live »`,
    });
    return false;
  }
  return true;
}

function commit(names) {
  syncDesired();
  saveChannels();
  return names.map(channelInfo);
}

// Enregistre les chaînes sans les activer
app.post("/channels/add", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (!checkSavedLimit(names, res)) return;

  const added = names.filter((name) => !saved.has(name));
  for (const name of names) saved.add(name);
  dormant.track(names);
  avatars.refresh(names);
  if (added.length) {
    log.log(`[api] Ajoutées : ${summarize(added)}`);
    live.pollSoon();
  }
  res.json({ ok: true, channels: commit(names) });
});

// Enregistre (si besoin) et active les chaînes. "liveOnly" (optionnel) fixe le mode.
app.post("/channels/join", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (req.body.liveOnly !== undefined && typeof req.body.liveOnly !== "boolean") {
    return res.status(400).json({ error: `"liveOnly" doit valoir true ou false` });
  }
  if (!checkSavedLimit(names, res)) return;

  const modeOf = (name) => req.body.liveOnly ?? liveOnly.has(name);
  const newAlways = names.filter((n) => !modeOf(n) && !(enabled.has(n) && !liveOnly.has(n))).length;
  if (!checkAlwaysLimit(newAlways, res)) return;

  const added = names.filter((name) => !saved.has(name));
  for (const name of names) {
    saved.add(name);
    enabled.add(name);
    if (modeOf(name)) liveOnly.add(name);
    else liveOnly.delete(name);
    irc.retry(name);
  }
  dormant.track(names);
  avatars.refresh(names);
  log.log(`[api] Activées${req.body.liveOnly ? " (si live)" : ""} : ${summarize(names)}`);
  if (added.length) live.pollSoon();
  res.status(202).json({ ok: true, channels: commit(names) });
});

// Réglages (chaque champ est optionnel) :
// { "maxConcurrent": 1..MAX_CHANNELS, "discordWebhook": "https://discord.com/api/webhooks/…" | "",
//   "mentionKeywords": ["mot", …] }
app.get("/settings", (req, res) => {
  res.json({ settings: publicSettings(), limits: { maxConcurrent: maxChannels }, backups: backupStatus() });
});

app.post("/settings", (req, res) => {
  const { maxConcurrent, discordWebhook, discordUserId, mentionKeywords, discordLiveAlerts, discordNoCardAlerts, schedule, allowSecretLogin, quietHours } = req.body ?? {};
  const newQuiet = quietHours === undefined ? undefined : validSchedule(quietHours);
  if (newQuiet === null) return res.status(400).json({ error: "Heures calmes invalides (heures HH:MM différentes, fuseau valide)" });
  if (allowSecretLogin !== undefined) {
    if (typeof allowSecretLogin !== "boolean") return res.status(400).json({ error: `"allowSecretLogin" doit valoir true ou false` });
    // Pas de désactivation depuis une session ouverte avec le secret : on se fermerait la porte
    if (!allowSecretLogin && !req.session) {
      return res.status(400).json({ error: "Connecte-toi avec Twitch avant de désactiver la connexion par secret" });
    }
  }
  if (discordLiveAlerts !== undefined && !["off", "on", "ping"].includes(discordLiveAlerts)) {
    return res.status(400).json({ error: `"discordLiveAlerts" doit valoir off, on ou ping` });
  }
  if (discordNoCardAlerts !== undefined && !["off", "on", "ping"].includes(discordNoCardAlerts)) {
    return res.status(400).json({ error: `"discordNoCardAlerts" doit valoir off, on ou ping` });
  }
  const newSchedule = schedule === undefined ? undefined : validSchedule(schedule);
  if (newSchedule === null) {
    return res.status(400).json({ error: "Plage horaire invalide (heures HH:MM différentes, fuseau valide)" });
  }
  if (discordUserId !== undefined && discordUserId !== "" && !isDiscordUserId(discordUserId)) {
    return res.status(400).json({ error: "Identifiant Discord invalide (17 à 20 chiffres)" });
  }

  if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > maxChannels)) {
    return res.status(400).json({ error: `"maxConcurrent" doit être un entier entre 1 et ${maxChannels}` });
  }
  if (discordWebhook !== undefined && discordWebhook !== "" && !isWebhookUrl(discordWebhook)) {
    return res.status(400).json({ error: "Adresse de webhook Discord invalide (https://discord.com/api/webhooks/…)" });
  }
  let keywords;
  if (mentionKeywords !== undefined) {
    if (!Array.isArray(mentionKeywords) || mentionKeywords.length > 10) {
      return res.status(400).json({ error: "10 mots-clés au maximum" });
    }
    keywords = [...new Set(mentionKeywords.map((k) => String(k).trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
    if (keywords.some((k) => k.length > 30)) return res.status(400).json({ error: "Mot-clé trop long (30 caractères max)" });
  }

  if (maxConcurrent !== undefined && maxConcurrent !== settings.maxConcurrent) {
    log.log(`[api] Plafond de chats simultanés : ${settings.maxConcurrent} → ${maxConcurrent}`);
    settings.maxConcurrent = maxConcurrent;
    syncDesired();
  }
  if (discordWebhook !== undefined && discordWebhook !== settings.discordWebhook) {
    settings.discordWebhook = discordWebhook;
    log.log(`[api] Webhook Discord ${discordWebhook ? "configuré" : "supprimé"}`);
  }
  if (keywords) settings.mentionKeywords = keywords;
  if (discordUserId !== undefined) settings.discordUserId = discordUserId;
  if (discordLiveAlerts !== undefined) settings.discordLiveAlerts = discordLiveAlerts;
  if (discordNoCardAlerts !== undefined) settings.discordNoCardAlerts = discordNoCardAlerts;
  if (newQuiet && JSON.stringify(newQuiet) !== JSON.stringify(settings.quietHours)) {
    settings.quietHours = newQuiet;
    log.log(`[api] Heures calmes ${newQuiet.enabled ? `${newQuiet.start}–${newQuiet.end}` : "désactivées"}`);
  }
  if (allowSecretLogin !== undefined && allowSecretLogin !== settings.allowSecretLogin) {
    settings.allowSecretLogin = allowSecretLogin;
    log.log(`[auth] Connexion par secret ${allowSecretLogin ? "réactivée" : "désactivée"} par ${req.user}`);
  }
  if (newSchedule) {
    const s = newSchedule;
    if (JSON.stringify(s) !== JSON.stringify(settings.schedule)) {
      log.log(`[api] Plage horaire ${s.enabled ? `${s.start}–${s.end} (${s.timeZone})` : "désactivée"}`);
    }
    settings.schedule = s;
    syncDesired();
  }

  saveSettings();
  res.json({ ok: true, settings: publicSettings() });
});

app.post("/settings/test-discord", async (req, res) => {
  try {
    await notifier.test();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Sanctions : historique et levée manuelle ---

app.get("/sanctions", (req, res) => {
  res.json({ sanctions: sanctions.slice().reverse() });
});

// { "id": "..." } : marque une sanction comme levée (ex. débanni)
app.post("/sanctions/clear", (req, res) => {
  const entry = sanctions.find((x) => x.id === req.body?.id);
  if (!entry) return res.status(404).json({ error: "Sanction inconnue" });
  entry.cleared = true;
  saveSanctions();
  log.log(`[mod] Sanction sur #${entry.channel} marquée comme levée`);
  res.json({ ok: true });
});

// --- Chaînes endormies (pas de live depuis N jours) ---

function dormantReport() {
  return dormant.report([...saved], settings.dormantDays, new Set(settings.dormantKeep));
}

app.get("/maintenance/dormant", (req, res) => {
  res.json({
    days: settings.dormantDays,
    snoozedUntil: settings.dormantSnoozeUntil,
    kept: settings.dormantKeep.filter((n) => saved.has(n)).sort(),
    checking: dormant.checking,
    lastCheck: dormant.lastCheck?.toISOString() ?? null,
    channels: dormantReport(),
  });
});

// Relance la vérification des VOD (au plus une fois par jour et par chaîne)
app.post("/maintenance/dormant/check", async (req, res) => {
  await dormant.checkVods([...saved], settings.dormantDays);
  res.json({ ok: true, count: dormantReport().length });
});

// Chaînes à garder : ne plus les proposer au nettoyage ({ "channels": [...], "keep": true|false })
app.post("/maintenance/dormant/keep", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  const keep = new Set(settings.dormantKeep);
  for (const n of names) {
    if (req.body.keep === false) keep.delete(n);
    else keep.add(n);
  }
  settings.dormantKeep = [...keep].sort();
  saveSettings();
  res.json({ ok: true, kept: settings.dormantKeep });
});

// Masque la suggestion pendant N jours ({ "days": 7 }), ou la réaffiche ({ "days": 0 })
app.post("/maintenance/dormant/snooze", (req, res) => {
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 0 || days > 90) return res.status(400).json({ error: `"days" entre 0 et 90` });
  settings.dormantSnoozeUntil = days ? new Date(Date.now() + days * 24 * 3600_000).toISOString() : null;
  saveSettings();
  res.json({ ok: true, snoozedUntil: settings.dormantSnoozeUntil });
});

// Seuil en jours ({ "days": 30 })
app.post("/maintenance/dormant/days", (req, res) => {
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days < 7 || days > 365) return res.status(400).json({ error: `"days" entre 7 et 365` });
  settings.dormantDays = days;
  saveSettings();
  dormant.checkVods([...saved], days);
  res.json({ ok: true, days });
});

// --- Reconnexion du compte Twitch utilisé par l'IRC (Device Code Flow) ---

app.get("/auth/device", (req, res) => {
  res.json(tokens.status());
});

app.post("/auth/device", async (req, res) => {
  try {
    const device = await tokens.startDevice();
    log.log(`[token] Reconnexion du compte Twitch demandée par ${req.user}`);
    res.json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Radar à drops ChatDeck ---

app.get("/drops", (req, res) => {
  res.json(drops.report());
});

// { "channel": "berlu", "boosters": 3, "minute": 15 } : drop raté par le radar
app.post("/drops/manual", (req, res) => {
  const channel = normalize(req.body?.channel);
  const { boosters, minute } = req.body ?? {};
  if (!channel || !Number.isInteger(boosters) || boosters < 1 || boosters > 50
    || (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute > 100_000))) {
    return res.status(400).json({ error: `Fournir "channel", "boosters" (1-50) et "minute" (minutes de live, ou null)` });
  }
  drops.addManual({ channel, boosters, minute });
  log.log(`[drops] Drop ajouté à la main sur #${channel} : ${boosters} booster(s) par ${req.user}`);
  syncDesired();
  res.json({ ok: true });
});

// --- Pause de l'IRC : { "paused": true } quitte tous les chats et coupe la connexion ---

app.post("/irc/pause", (req, res) => {
  const paused = req.body?.paused;
  if (typeof paused !== "boolean") return res.status(400).json({ error: `"paused" doit valoir true ou false` });
  if (paused !== settings.ircPaused) {
    settings.ircPaused = paused;
    saveSettings();
    if (paused) irc.stop();
    else irc.start();
    log.log(`[irc] ${paused ? "Mis en pause" : "Reprise demandée"} par ${req.user}`);
  }
  res.json({ ok: true, paused: settings.ircPaused });
});

// --- Profils ---

function readProfileName(body) {
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  return /^[\p{L}\p{N} _'-]{1,30}$/u.test(name) ? name : null;
}

// Enregistre l'état actuel sous ce nom (crée ou remplace)
app.post("/profiles/save", (req, res) => {
  const name = readProfileName(req.body);
  if (!name) return res.status(400).json({ error: "Nom de profil invalide (1 à 30 lettres, chiffres, espaces)" });
  const existing = profiles.list.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!existing && profiles.list.length >= MAX_PROFILES) {
    return res.status(409).json({ error: `${MAX_PROFILES} profils au maximum` });
  }
  const now = new Date().toISOString();
  if (existing) Object.assign(existing, { state: snapshot(), updatedAt: now });
  else profiles.list.push({ name, state: snapshot(), createdAt: now, updatedAt: now });
  profiles.active = existing?.name ?? name;
  saveProfiles();
  log.log(`[api] Profil « ${profiles.active} » ${existing ? "mis à jour" : "créé"}`);
  res.json({ ok: true, profiles: profilesStatus() });
});

app.post("/profiles/apply", (req, res) => {
  const name = readProfileName(req.body);
  const profile = profiles.list.find((p) => p.name === name);
  if (!profile) return res.status(404).json({ error: "Profil inconnu" });
  applyProfile(profile);
  log.log(`[api] Profil « ${profile.name} » appliqué`);
  res.json({ ok: true, profiles: profilesStatus() });
});

app.post("/profiles/delete", (req, res) => {
  const name = readProfileName(req.body);
  const before = profiles.list.length;
  profiles.list = profiles.list.filter((p) => p.name !== name);
  if (profiles.list.length === before) return res.status(404).json({ error: "Profil inconnu" });
  if (profiles.active === name) profiles.active = null;
  saveProfiles();
  log.log(`[api] Profil « ${name} » supprimé`);
  res.json({ ok: true, profiles: profilesStatus() });
});

// Désactive les chaînes, qui restent enregistrées
app.post("/channels/part", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (names.length > 5) backupChannels(`avant désactivation de ${names.length} chaînes`);

  for (const name of names) enabled.delete(name);
  log.log(`[api] Désactivées : ${summarize(names)}`);
  res.json({ ok: true, channels: commit(names) });
});

// Choisit le mode : { "channels": [...], "liveOnly": true|false }
app.post("/channels/mode", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (typeof req.body.liveOnly !== "boolean") {
    return res.status(400).json({ error: `"liveOnly" doit valoir true ou false` });
  }
  const unknown = names.filter((name) => !saved.has(name));
  if (unknown.length) return res.status(404).json({ error: `Chaîne non enregistrée : ${unknown.join(", ")}` });

  if (!req.body.liveOnly) {
    const newAlways = names.filter((n) => enabled.has(n) && liveOnly.has(n)).length;
    if (!checkAlwaysLimit(newAlways, res)) return;
  }

  for (const name of names) {
    if (req.body.liveOnly) liveOnly.add(name);
    else liveOnly.delete(name);
  }
  log.log(`[api] Mode « ${req.body.liveOnly ? "si live" : "toujours"} » : ${summarize(names)}`);
  res.json({ ok: true, channels: commit(names) });
});

// Désactive et oublie les chaînes
app.post("/channels/remove", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  backupChannels(`avant retrait de ${summarize(names, 3)}`);

  for (const name of names) {
    saved.delete(name);
    enabled.delete(name);
    liveOnly.delete(name);
    favorites.delete(name);
    groups.delete(name);
    watched.delete(name);
    cards.delete(name);
    stats.forget(name);
    dormant.forget(name);
    avatars.forget(name);
  }
  log.log(`[api] Retirées de la liste : ${summarize(names)}`);
  commit([]);
  res.json({ ok: true, channels: names.map((name) => ({ name, state: "removed" })) });
});

// Marque ou retire des favoris : { "channels": [...], "favorite": true|false }
app.post("/channels/favorite", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (typeof req.body.favorite !== "boolean") {
    return res.status(400).json({ error: `"favorite" doit valoir true ou false` });
  }
  const unknown = names.filter((name) => !saved.has(name));
  if (unknown.length) return res.status(404).json({ error: `Chaîne non enregistrée : ${unknown.join(", ")}` });

  for (const name of names) {
    if (req.body.favorite) favorites.add(name);
    else favorites.delete(name);
  }
  res.json({ ok: true, channels: commit(names) });
});

// Note une carte streamer obtenue ou non : { "channels": [...], "rarity": "epic"|"legendary", "owned": true|false }
app.post("/channels/card", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (!CARD_RARITIES.includes(req.body.rarity)) {
    return res.status(400).json({ error: `"rarity" doit valoir ${CARD_RARITIES.join(" ou ")}` });
  }
  if (typeof req.body.owned !== "boolean") {
    return res.status(400).json({ error: `"owned" doit valoir true ou false` });
  }
  const unknown = names.filter((name) => !saved.has(name));
  if (unknown.length) return res.status(404).json({ error: `Chaîne non enregistrée : ${unknown.join(", ")}` });

  for (const name of names) {
    const set = cards.get(name) ?? new Set();
    if (req.body.owned) set.add(req.body.rarity);
    else set.delete(req.body.rarity);
    if (set.size) cards.set(name, set);
    else cards.delete(name);
  }
  res.json({ ok: true, channels: commit(names) });
});

// Marque une chaîne comme assez regardée aujourd'hui : { "channels": [...], "watched": true|false }
// Tant qu'elle est marquée, la chaîne n'est plus rejointe. Les marques tombent d'elles-mêmes à minuit UTC (voir watchDay).
app.post("/channels/watched", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  if (typeof req.body.watched !== "boolean") {
    return res.status(400).json({ error: `"watched" doit valoir true ou false` });
  }
  const unknown = names.filter((name) => !saved.has(name));
  if (unknown.length) return res.status(404).json({ error: `Chaîne non enregistrée : ${unknown.join(", ")}` });

  const at = new Date().toISOString();
  for (const name of names) {
    if (req.body.watched) watched.set(name, at);
    else watched.delete(name);
  }
  res.json({ ok: true, channels: commit(names) });
});

// Remise à zéro quotidienne : oublie les marques d'avant minuit UTC et le note au journal
setInterval(() => {
  const expired = [...watched.keys()].filter((name) => !isWatched(name));
  if (!expired.length) return;
  for (const name of expired) watched.delete(name);
  syncDesired(); // les chaînes marquées sont de nouveau rejointes
  saveChannels();
  log.log(`[app] Marques « fini » remises à zéro (${expired.length})`);
}, 60_000).unref();

// Ajoute ou retire des chaînes d'un groupe : { "channels": [...], "group": "24h", "member": true|false }
// Un groupe existe tant qu'il contient au moins une chaîne.
app.post("/channels/group", (req, res) => {
  const { names, error } = readChannels(req.body);
  if (error) return res.status(400).json({ error });
  const group = normalizeGroup(req.body.group);
  if (!group) return res.status(400).json({ error: "Nom de groupe invalide (1 à 20 lettres, chiffres, espaces, - ou _)" });
  if (typeof req.body.member !== "boolean") {
    return res.status(400).json({ error: `"member" doit valoir true ou false` });
  }
  const unknown = names.filter((name) => !saved.has(name));
  if (unknown.length) return res.status(404).json({ error: `Chaîne non enregistrée : ${unknown.join(", ")}` });

  for (const name of names) {
    const set = groups.get(name) ?? new Set();
    if (req.body.member) set.add(group);
    else set.delete(group);
    if (set.size) groups.set(name, set);
    else groups.delete(name);
  }
  res.json({ ok: true, group, channels: commit(names) });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON invalide" });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Requête trop volumineuse" });
  log.error(`[api] ${err.stack || err.message}`);
  res.status(500).json({ error: "Erreur interne" });
});

// Dans Docker, écouter sur 0.0.0.0 est normal : seul le réseau interne de Docker y accède
// tant que le port n'est pas publié (« expose » et non « ports » dans le compose).
if (!["127.0.0.1", "::1", "localhost"].includes(HOST) && !process.env.IN_CONTAINER) {
  log.warn(`[api] Attention : l'API écoute sur ${HOST}, elle n'est plus limitée à cette machine`);
}

// Redémarrages dans le journal. Si le dernier événement n'est pas un arrêt propre,
// le serveur s'est arrêté brutalement (crash, coupure, mémoire épuisée…).
const previous = events.items.at(-1);
if (previous && !(previous.source === "app" && /^Arrêt/.test(previous.message))) {
  log.warn(`[app] Le serveur ne s'était pas arrêté proprement (dernier événement : ${new Date(previous.at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })})`);
}
log.log(`[app] Démarrage du serveur (version ${APP_VERSION.id})`);

// Plantage inattendu : on garde la raison dans le journal avant de quitter
// (Docker relance le conteneur automatiquement)
process.on("uncaughtException", (err) => {
  log.error(`[app] Plantage : ${err.stack || err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log.error(`[app] Erreur non gérée : ${err?.stack || err}`);
});

const server = app.listen(Number(PORT), HOST, () => {
  log.log(`[api] En écoute sur http://${HOST}:${PORT} (${saved.size} chaînes, ${enabled.size} activées)`);
  if (settings.ircPaused) log.log("[irc] En pause (réglage conservé) : aucune connexion au démarrage");
  else irc.start();
  live.start();
  stats.start();
  drops.start();
  // Chaînes endormies : suivi de toutes les chaînes, puis vérification des VOD (1 min après, puis chaque jour)
  dormant.track([...saved]);
  setTimeout(() => dormant.checkVods([...saved], settings.dormantDays), 60_000).unref();
  setInterval(() => dormant.checkVods([...saved], settings.dormantDays), 24 * 3600_000).unref();
  // Images de profil : au démarrage puis toutes les 6 h (chaque chaîne revérifiée au plus une fois par semaine)
  avatars.refresh([...saved]);
  setInterval(() => avatars.refresh([...saved]), 6 * 3600_000).unref();
  backupChannels("démarrage");
});

setInterval(() => backupChannels("quotidienne"), 24 * 60 * 60_000).unref();

// Battement de cœur vers healthchecks.io : « OK » chaque minute tant que l'IRC est connecté,
// « échec » quand il est coupé depuis plus de 2 min. Sans nouvelles, healthchecks.io alerte.
if (HEALTHCHECK_URL) {
  let downSince = null;
  let lastReport = null;
  setInterval(async () => {
    const now = Date.now();
    // Pause volontaire : pas d'alerte, on continue de signaler que le serveur va bien
    if (irc.registered || settings.ircPaused) downSince = null;
    else downSince ??= now;

    const failing = downSince !== null && now - downSince > 2 * 60_000;
    if (downSince !== null && !failing) return; // coupure courte : on laisse la reconnexion faire

    const url = failing ? `${HEALTHCHECK_URL}/fail` : HEALTHCHECK_URL;
    const body = failing ? `IRC déconnecté depuis ${Math.round((now - downSince) / 60_000)} min : ${irc.lastError ?? "?"}` : undefined;
    try {
      await fetch(url, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
      if (lastReport !== failing) log.log(`[health] Signal ${failing ? "« échec »" : "« OK »"} envoyé à healthchecks.io`);
      lastReport = failing;
    } catch (err) {
      log.warn(`[health] healthchecks.io injoignable : ${err.message}`);
    }
  }, 60_000).unref();
}

// Validation horaire du token exigée par Twitch (et renouvellement si besoin)
setInterval(() => {
  tokens.invalidate();
  tokens.get().catch((err) => log.error(`[token] ${err.message}`));
}, 60 * 60_000).unref();

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  // SIGTERM : arrêt demandé par Docker (mise à jour, redémarrage du serveur…) ; SIGINT : Ctrl+C
  log.log(`[app] Arrêt du serveur (${signal === "SIGTERM" ? "redémarrage ou mise à jour" : signal})`);
  irc.stop();
  live.stop();
  stats.stop();
  stats.save();
  drops.stop();
  drops.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
