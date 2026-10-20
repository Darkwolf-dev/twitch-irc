"use strict";

// Obtient un token utilisateur Twitch (scope chat:read) via le Device Code Flow
// et l'enregistre dans data/token.json. Le serveur le renouvelle ensuite tout seul.
// (Aussi faisable depuis le panneau, bouton « Reconnecter » quand le token est refusé.)

require("dotenv").config({ quiet: true });

const { TokenManager, TOKEN_FILE, requestDeviceCode, waitForDeviceToken } = require("../src/token");

const clientId = process.env.TWITCH_CLIENT_ID;

async function main() {
  if (!clientId) throw new Error("Renseigne TWITCH_CLIENT_ID dans .env");

  const device = await requestDeviceCode(clientId);
  console.log(`\nOuvre ${device.verification_uri}`);
  console.log(`et valide le code : ${device.user_code}\n`);

  const token = await waitForDeviceToken({ clientId, clientSecret: process.env.TWITCH_CLIENT_SECRET, device });
  new TokenManager({ clientId }).save(token);
  console.log(`Token enregistré dans ${TOKEN_FILE}`);
}

main().catch((err) => {
  console.error(err.expired ? "Code expiré, relance npm run auth" : err.message);
  process.exit(1);
});
