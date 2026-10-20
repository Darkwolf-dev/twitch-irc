"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TOKEN_FILE = path.join(DATA_DIR, "token.json");
const VALIDATE_EVERY_MS = 60 * 60_000; // Twitch exige une validation au moins toutes les heures
const REFRESH_MARGIN_S = 15 * 60;
const SCOPES = "chat:read";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Erreur qui ne se règle qu'en reconnectant le compte Twitch (pas une simple panne réseau)
function reauthError(message) {
  return Object.assign(new Error(message), { reauth: true });
}

async function validate(accessToken) {
  const res = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Validation Twitch : HTTP ${res.status}`);
  return res.json();
}

// --- Device Code Flow : un code à valider sur twitch.tv/activate ---

async function requestDeviceCode(clientId) {
  const res = await fetch("https://id.twitch.tv/oauth2/device", {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, scopes: SCOPES }),
  });
  const device = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twitch a refusé la demande : ${device.message || res.status}`);
  return device;
}

// Attend que le code soit validé, puis renvoie le token à enregistrer
async function waitForDeviceToken({ clientId, clientSecret, device }) {
  let interval = device.interval * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const body = new URLSearchParams({
      client_id: clientId,
      scopes: SCOPES,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (clientSecret) body.set("client_secret", clientSecret);

    const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    const data = await r.json().catch(() => ({}));

    if (r.ok) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        scope: data.scope,
        obtained_at: new Date().toISOString(),
      };
    }
    if (data.message === "slow_down") interval += 5000;
    else if (data.message !== "authorization_pending") throw new Error(`Échec : ${data.message || r.status}`);
  }

  throw Object.assign(new Error("Code expiré"), { expired: true });
}

class TokenManager {
  constructor({ clientId, clientSecret, staticToken, onNeedsAuth, onReconnected } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.staticToken = staticToken;
    this.onNeedsAuth = onNeedsAuth; // (raison) : le compte Twitch doit être reconnecté
    this.onReconnected = onReconnected; // (login) : reconnecté depuis le panneau
    this.token = null;
    this.info = null;
    this.validatedAt = 0;
    this.pending = null;
    this.needsAuth = null; // { reason, since }
    this.device = null; // connexion en cours depuis le panneau
  }

  load() {
    if (this.staticToken) {
      return { access_token: this.staticToken.replace(/^oauth:/, "") };
    }
    try {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch {
      throw reauthError("Aucun token Twitch : lance `npm run auth` ou renseigne TWITCH_OAUTH_TOKEN");
    }
  }

  save(token) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
    this.token = token;
    this.info = null;
  }

  // Force une revalidation au prochain get() (ex. après un échec de login IRC)
  invalidate() {
    this.validatedAt = 0;
  }

  canRefresh() {
    return Boolean(this.token?.refresh_token && this.clientId);
  }

  // Reconnexion possible depuis le panneau (pas avec un token fixe TWITCH_OAUTH_TOKEN)
  canReconnect() {
    return Boolean(this.clientId && !this.staticToken);
  }

  // Un seul get() à la fois : deux renouvellements simultanés réutiliseraient le même
  // refresh token, que Twitch invalide alors (avec le nouveau token).
  get() {
    if (!this.pending) {
      this.pending = this.fetch().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async fetch() {
    // Token cassé : on relit le fichier, au cas où `npm run auth` vient d'en écrire un neuf
    if (!this.token || this.needsAuth) this.token = this.load();
    const used = this.token;

    try {
      if (!this.info || Date.now() - this.validatedAt > VALIDATE_EVERY_MS) {
        let info = await validate(this.token.access_token);
        const expiring = info && info.expires_in > 0 && info.expires_in < REFRESH_MARGIN_S;

        if ((!info || expiring) && this.canRefresh()) {
          await this.refresh();
          info = await validate(this.token.access_token);
        }
        if (!info) throw reauthError("Token refusé par Twitch : relance `npm run auth`");
        if (!info.scopes?.includes("chat:read")) {
          throw reauthError("Le token n'a pas le scope chat:read");
        }

        this.info = info;
        this.validatedAt = Date.now();
      }
    } catch (err) {
      // Ignoré si un nouveau token a été enregistré entre-temps
      if (err.reauth && this.token === used) this.markNeedsAuth(err.message);
      throw err;
    }

    if (this.needsAuth) {
      this.needsAuth = null;
      console.log("[token] Token Twitch de nouveau valide");
    }
    return { token: this.token.access_token, login: this.info.login, clientId: this.info.client_id };
  }

  markNeedsAuth(reason) {
    const first = !this.needsAuth;
    this.needsAuth = { reason, since: this.needsAuth?.since ?? new Date().toISOString() };
    if (first) this.onNeedsAuth?.(reason);
  }

  async refresh() {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.token.refresh_token,
      client_id: this.clientId,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    const res = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = `Renouvellement du token refusé (${data.message || res.status}) : relance \`npm run auth\``;
      // 400/401 : refresh token mort. Le reste (5xx…) est une panne passagère côté Twitch
      throw res.status === 400 || res.status === 401 ? reauthError(message) : new Error(message);
    }

    this.save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      obtained_at: new Date().toISOString(),
    });
    console.log("[token] Token Twitch renouvelé");
  }

  // Démarre une reconnexion du compte depuis le panneau (réutilise le code en cours s'il est encore valable)
  async startDevice() {
    if (!this.canReconnect()) throw new Error("Reconnexion impossible : token fixe (TWITCH_OAUTH_TOKEN) ou TWITCH_CLIENT_ID absent");
    const current = this.device;
    if (current?.state === "pending" && Date.parse(current.expiresAt) - Date.now() > 30_000) return this.deviceStatus();

    const device = await requestDeviceCode(this.clientId);
    const entry = {
      state: "pending",
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      expiresAt: new Date(Date.now() + device.expires_in * 1000).toISOString(),
    };
    this.device = entry;

    waitForDeviceToken({ clientId: this.clientId, clientSecret: this.clientSecret, device })
      .then(async (token) => {
        if (this.device !== entry) return; // remplacé par un code plus récent
        this.save(token);
        this.validatedAt = 0;
        await this.pending?.catch(() => {}); // un get() lancé avec l'ancien token
        const { login } = await this.get();
        Object.assign(entry, { state: "done", login });
        console.log(`[token] Compte Twitch reconnecté depuis le panneau (${login})`);
        this.onReconnected?.(login);
      })
      .catch((err) => {
        if (this.device !== entry) return;
        Object.assign(entry, { state: err.expired ? "expired" : "error", error: err.message });
        if (!err.expired) console.error(`[token] Reconnexion échouée : ${err.message}`);
      });

    return this.deviceStatus();
  }

  deviceStatus() {
    if (!this.device) return null;
    const { state, userCode, verificationUri, expiresAt, login, error } = this.device;
    return { state, userCode, verificationUri, expiresAt, login, error };
  }

  status() {
    return { needsAuth: this.needsAuth, canReconnect: this.canReconnect(), device: this.deviceStatus() };
  }
}

module.exports = { TokenManager, TOKEN_FILE, DATA_DIR, requestDeviceCode, waitForDeviceToken };
