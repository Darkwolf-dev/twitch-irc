"use strict";

// Obtient un token utilisateur Twitch (scope chat:read) via le Device Code Flow
// et l'enregistre dans data/token.json. Le serveur le renouvelle ensuite tout seul.

require("dotenv").config({ quiet: true });

const { TokenManager, TOKEN_FILE } = require("../src/token");

const clientId = process.env.TWITCH_CLIENT_ID;
const scopes = "chat:read";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!clientId) throw new Error("Renseigne TWITCH_CLIENT_ID dans .env");

  const res = await fetch("https://id.twitch.tv/oauth2/device", {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, scopes }),
  });
  const device = await res.json();
  if (!res.ok) throw new Error(`Twitch a refusé la demande : ${device.message || res.status}`);

  console.log(`\nOuvre ${device.verification_uri}`);
  console.log(`et valide le code : ${device.user_code}\n`);

  let interval = device.interval * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const body = new URLSearchParams({
      client_id: clientId,
      scopes,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (process.env.TWITCH_CLIENT_SECRET) body.set("client_secret", process.env.TWITCH_CLIENT_SECRET);

    const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body });
    const data = await r.json();

    if (r.ok) {
      new TokenManager({ clientId }).save({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        scope: data.scope,
        obtained_at: new Date().toISOString(),
      });
      console.log(`Token enregistré dans ${TOKEN_FILE}`);
      return;
    }
    if (data.message === "slow_down") interval += 5000;
    else if (data.message !== "authorization_pending") throw new Error(`Échec : ${data.message || r.status}`);
  }

  throw new Error("Code expiré, relance npm run auth");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
