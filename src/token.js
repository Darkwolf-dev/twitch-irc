"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const TOKEN_FILE = path.join(DATA_DIR, "token.json");
const VALIDATE_EVERY_MS = 60 * 60_000; // Twitch exige une validation au moins toutes les heures
const REFRESH_MARGIN_S = 15 * 60;

async function validate(accessToken) {
  const res = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Validation Twitch : HTTP ${res.status}`);
  return res.json();
}

class TokenManager {
  constructor({ clientId, clientSecret, staticToken } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.staticToken = staticToken;
    this.token = null;
    this.info = null;
    this.validatedAt = 0;
  }

  load() {
    if (this.staticToken) {
      return { access_token: this.staticToken.replace(/^oauth:/, "") };
    }
    try {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    } catch {
      throw new Error("Aucun token Twitch : lance `npm run auth` ou renseigne TWITCH_OAUTH_TOKEN");
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

  async get() {
    if (!this.token) this.token = this.load();

    if (!this.info || Date.now() - this.validatedAt > VALIDATE_EVERY_MS) {
      let info = await validate(this.token.access_token);
      const expiring = info && info.expires_in > 0 && info.expires_in < REFRESH_MARGIN_S;

      if ((!info || expiring) && this.canRefresh()) {
        await this.refresh();
        info = await validate(this.token.access_token);
      }
      if (!info) throw new Error("Token refusé par Twitch : relance `npm run auth`");
      if (!info.scopes?.includes("chat:read")) {
        throw new Error("Le token n'a pas le scope chat:read");
      }

      this.info = info;
      this.validatedAt = Date.now();
    }

    return { token: this.token.access_token, login: this.info.login, clientId: this.info.client_id };
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
      throw new Error(`Renouvellement du token refusé (${data.message || res.status}) : relance \`npm run auth\``);
    }

    this.save({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      obtained_at: new Date().toISOString(),
    });
    console.log("[token] Token Twitch renouvelé");
  }
}

module.exports = { TokenManager, TOKEN_FILE, DATA_DIR };
