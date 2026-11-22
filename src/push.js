"use strict";

// Notifications push du navigateur (Android, PC) : chaque appareil s'abonne depuis le panneau,
// le serveur envoie ensuite les alertes directement, sans passer par Discord.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

const MAX_DEVICES = 10;
// Seuls les services push des navigateurs sont acceptés : le serveur ne poste jamais vers une
// adresse quelconque fournie par le client
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

function isPushEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

const idOf = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 12);

class PushSender {
  constructor({ dataDir, log }) {
    this.log = log;
    this.keysFile = path.join(dataDir, "push-keys.json");
    this.devicesFile = path.join(dataDir, "push-devices.json");
    this.keys = this.loadKeys();
    // Identité de l'expéditeur demandée par les services push : une adresse générique, jamais
    // une adresse personnelle
    webpush.setVapidDetails("mailto:push@twitch-deck.invalid", this.keys.publicKey, this.keys.privateKey);
    try {
      this.devices = JSON.parse(fs.readFileSync(this.devicesFile, "utf8"));
      if (!Array.isArray(this.devices)) this.devices = [];
    } catch {
      this.devices = [];
    }
  }

  // Clés générées une seule fois : en changer désabonnerait tous les appareils
  loadKeys() {
    try {
      const keys = JSON.parse(fs.readFileSync(this.keysFile, "utf8"));
      if (keys.publicKey && keys.privateKey) return keys;
    } catch {}
    const keys = webpush.generateVAPIDKeys();
    this.write(this.keysFile, keys);
    this.log.log("[push] Clés de notification générées");
    return keys;
  }

  write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  save() {
    this.write(this.devicesFile, this.devices);
  }

  get publicKey() {
    return this.keys.publicKey;
  }

  list() {
    return this.devices.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  // Abonnement envoyé par le navigateur (PushSubscription.toJSON()). Renvoie un message d'erreur ou null.
  add(subscription, label) {
    const { endpoint, keys } = subscription ?? {};
    if (!isPushEndpoint(endpoint)) return "Service de notification non reconnu";
    if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return "Abonnement invalide";
    }
    const id = idOf(endpoint);
    const others = this.devices.filter((d) => d.id !== id);
    if (others.length >= MAX_DEVICES) return `${MAX_DEVICES} appareils au maximum : retires-en un d'abord`;
    const name = String(label ?? "").trim().slice(0, 60) || "Appareil";
    this.devices = [...others, { id, label: name, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: new Date().toISOString() }];
    this.save();
    this.log.log(`[push] Appareil ajouté : ${name}`);
    return null;
  }

  remove(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  // { title, body, url, icon, tag, silent } vers tous les appareils. Renvoie le nombre d'envois réussis.
  async send(notification) {
    if (!this.devices.length) return 0;
    const payload = JSON.stringify(notification);
    const results = await Promise.all(this.devices.map(async (device) => {
      try {
        await webpush.sendNotification(device, payload, { TTL: 3600, urgency: notification.silent ? "normal" : "high", timeout: 10_000 });
        return true;
      } catch (err) {
        // 404 / 410 : l'appareil s'est désabonné (appli désinstallée, autorisation retirée…)
        if (err.statusCode === 404 || err.statusCode === 410) {
          this.log.log(`[push] Appareil désabonné, retiré : ${device.label}`);
          this.remove(device.id);
        } else {
          this.log.error(`[push] Envoi impossible vers ${device.label} : ${err.statusCode ? `HTTP ${err.statusCode}` : err.message}`);
        }
        return false;
      }
    }));
    return results.filter(Boolean).length;
  }
}

module.exports = { PushSender, idOf };
