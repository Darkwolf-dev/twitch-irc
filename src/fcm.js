"use strict";

// Notifications de l'appli Android native via Firebase Cloud Messaging (API HTTP v1).
// La clé du compte de service reste sur le serveur (data/firebase-service-account.json), jamais dans le dépôt.

const fs = require("fs");
const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

class FcmSender {
  constructor({ keyFile, log }) {
    this.log = log;
    this.key = null;
    this.accessToken = null;
    this.expiresAt = 0;
    try {
      const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      if (key.type === "service_account" && key.private_key && key.client_email && key.project_id) this.key = key;
    } catch {}
    if (!this.key) log.log("[fcm] Pas de clé Firebase : pas de notifications dans l'appli Android native");
  }

  get enabled() {
    return Boolean(this.key);
  }

  // Jeton OAuth2 obtenu avec un JWT signé par la clé du compte de service, gardé jusqu'à 1 min de sa fin
  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: this.key.client_email, scope: SCOPE, aud: this.key.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    })}`;
    const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key).toString("base64url");
    const res = await fetch(this.key.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`jeton Google refusé (HTTP ${res.status})`);
    const data = await res.json();
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  // Message « data » : l'appli construit elle-même la notification (boutons, ouverture de la fiche).
  // Renvoie "ok", "gone" (jeton périmé : appli désinstallée) ou "error".
  async send(fcmToken, data) {
    if (!this.enabled) return "error";
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.key.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            // Les valeurs d'un message data doivent être des chaînes
            data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])),
            android: { priority: data.silent ? "NORMAL" : "HIGH", ttl: "3600s" },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return "ok";
      const body = await res.text();
      if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(body)) return "gone";
      this.log.error(`[fcm] Envoi refusé : HTTP ${res.status} ${body.slice(0, 200)}`);
      return "error";
    } catch (err) {
      this.log.error(`[fcm] Envoi impossible : ${err.message}`);
      return "error";
    }
  }
}

module.exports = { FcmSender };
