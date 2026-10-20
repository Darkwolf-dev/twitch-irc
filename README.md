# Twitch Deck

Un compte Twitch, jusqu'à 100 chaînes, piloté à distance par une API HTTP protégée par un secret.

```
Téléphone / autre PC ──Tailscale (HTTPS)──► API Express 127.0.0.1:3000 ──► 1 connexion IRC WSS ──► #chaine1 … #chaine100
                                                 │
                                                 └── data/channels.json (liste persistée)
```

- **État voulu → état réel** : l'API modifie seulement la liste des chaînes voulues (persistée). Une boucle de réconciliation envoie les `JOIN`/`PART` nécessaires, à 15 JOIN / 10 s maximum (la limite Twitch est de 20).
- **Robustesse** : reconnexion automatique avec délai croissant, gestion de `RECONNECT`, PING de keepalive, nouvel essai des JOIN échoués (canal suspendu, banni, sans réponse), puis retour automatique sur toutes les chaînes après une coupure.
- **Radar à drops** (bouton 🎁) : repère les messages qui parlent de ChatDeck, de booster ou de drop, te les fait valider, puis classe les chaînes par drops par heure de présence pendant le live. Les chaînes qui droppent le plus passent en premier quand le plafond de chats est atteint. Données dans `data/drops.json`, 30 jours.
- **Token** : validé toutes les heures (exigence Twitch) et renouvelé automatiquement grâce au refresh token. S'il est refusé, le panneau affiche un bandeau rouge avec un bouton **Reconnecter** (code à valider sur twitch.tv/activate, sans redémarrage) et une alerte part sur Discord.

## Installation

```powershell
npm install
copy .env.example .env
npm run secret          # copie la valeur dans API_SECRET du fichier .env
```

### Token Twitch (option A, recommandée)

1. Sur <https://dev.twitch.tv/console/apps>, crée une application, **Client Type : Public**, OAuth Redirect URL : `http://localhost`.
2. Mets son Client ID dans `TWITCH_CLIENT_ID` du fichier `.env`.
3. Lance `npm run auth`, ouvre le lien affiché et valide le code avec le compte Twitch à utiliser.

Le token est enregistré dans `data/token.json`. Ne partage jamais ce fichier ni le fichier `.env`.

Option B : renseigne `TWITCH_OAUTH_TOKEN` avec un token utilisateur qui a le scope `chat:read`. Ce token ne sera pas renouvelé automatiquement.

## Lancement

```powershell
npm start
```

## Panneau

- **Fiche de chaîne** : clique sur le nom d'une chaîne pour l'ouvrir. Elle a trois onglets.
  - **Chat** : les 100 derniers messages, mis à jour en direct.
  - **Stats** : relevés toutes les 5 min pendant les lives, sur 7 jours (heures de live, pic et moyenne de spectateurs, messages par minute, graphiques).
  - **Réglages** : activation, favori, mode, groupes, retrait de la liste.
- **Réglages généraux** :
  - plafond de chats simultanés ;
  - **plage horaire** : en dehors, les chaînes « si live » ne sont pas rejointes ;
  - Discord : mentions, et alerte quand un favori passe en live, avec ou sans @.
- **Appli mobile** : le panneau s'installe sur l'écran d'accueil (manifeste et service worker sans cache). Les icônes se régénèrent avec `node scripts/make-icons.js`.

Fichiers dans `data/` : `channels.json`, `settings.json`, `stats.json`, `drops.json`, `token.json`, `sessions.json`, `backups/` et `journal/`.

## Connexion au panneau

- **Avec Twitch** : renseigne `ALLOWED_LOGINS=ton_login` et ajoute `https://<ton-domaine>/` (et `http://localhost:3000/` en local) dans les *OAuth Redirect URLs* de l'appli Twitch. Le serveur vérifie que le token a bien été émis pour ton appli et pour un login autorisé, le révoque aussitôt, puis ouvre une session de 30 jours. La session est stockée dans un cookie `HttpOnly`, `Secure`, `SameSite=Strict`.
- **Avec le secret** : l'option « Utiliser le secret de l'API » reste disponible en secours.

## API

Toutes les routes exigent l'en-tête `Authorization: Bearer <API_SECRET>`, ou un cookie de session Twitch pour le panneau.

| Méthode | Route            | Corps                                             | Effet                                 |
|---------|------------------|---------------------------------------------------|---------------------------------------|
| GET     | `/status`          |                                                   | État IRC, compteurs, état de chaque chaîne enregistrée |
| GET     | `/channels`        |                                                   | Chaînes enregistrées et leur état     |
| GET     | `/events?since=<id>` |                                                 | Journal d'événements (300 derniers)   |
| POST    | `/channels/add`    | `{"channel":"shroud"}` ou `{"channels":["a","b"]}` | Enregistre sans activer               |
| POST    | `/channels/join`   | idem, + `"liveOnly": true` optionnel              | Enregistre si besoin et active (202)  |
| POST    | `/channels/part`   | idem                                              | Désactive, la chaîne reste enregistrée |
| POST    | `/channels/mode`   | `{"channels":["a"],"liveOnly":true}`              | Mode « si live » (`false` : toujours) |
| POST    | `/channels/remove` | idem                                              | Désactive et retire de la liste       |
| POST    | `/channels/favorite` | `{"channels":["a"],"favorite":true}`            | Ajoute aux favoris (`false` pour retirer) |
| POST    | `/channels/watched`  | `{"channels":["a"],"watched":true}`             | Marque « finie » pour aujourd'hui, jusqu'à 2 h (heure de Paris) |
| POST    | `/channels/group`  | `{"channels":["a"],"group":"24h","member":true}`  | Ajoute à un groupe (`false` pour retirer) |

Jusqu'à 500 chaînes enregistrées, dont `MAX_CHANNELS` (100) rejointes en même temps.

États possibles d'une chaîne : `parted` (désactivée), `offline` (mode « si live », attend le live), `full` (limite de 100 atteinte), `queued` (en file), `joining` (JOIN envoyé), `joined` (connectée), `retrying` (échec, nouvel essai à `retryAt`).

### Live

Toutes les minutes, le serveur interroge l'API Twitch (`Get Streams`) pour savoir quelles chaînes enregistrées sont en live. Chaque chaîne indique alors `live: { title, game, viewers, startedAt }`, ou `null` si elle n'est pas en live.

Une chaîne activée en mode **« si live »** n'est rejointe que pendant ses lives, avec 10 minutes de grâce après la fin pour couvrir une coupure de stream. Les chaînes en mode « toujours » sont limitées à 100. Les chaînes « si live » peuvent être plus nombreuses : seules celles en live occupent une place, en priorité les favoris puis les plus gros lives. Si l'API Twitch est indisponible, le serveur garde le dernier état connu et ne quitte aucun chat.

Le panneau web sur `/` affiche toutes les chaînes enregistrées, avec un interrupteur rejoindre/quitter par chaîne.

Exemples PowerShell :

```powershell
$h = @{ Authorization = "Bearer TON_API_SECRET" }
$api = "http://127.0.0.1:3000"

Invoke-RestMethod "$api/channels/join" -Method Post -Headers $h -ContentType "application/json" -Body '{"channels":["shroud","zerator"]}'
Invoke-RestMethod "$api/channels/part" -Method Post -Headers $h -ContentType "application/json" -Body '{"channel":"shroud"}'
Invoke-RestMethod "$api/status" -Headers $h | ConvertTo-Json -Depth 5
```

## Hébergement en ligne

Règles indispensables :

- **HTTPS obligatoire** : le secret circule dans chaque requête. Place l'app derrière un reverse proxy TLS et ne l'expose jamais en HTTP direct.
- **Disque persistant** : `token.json` et `channels.json` sont écrits dans `DATA_DIR`. Sur un hébergeur au disque éphémère, monte un volume, sinon tout est perdu à chaque redéploiement.
- **Une seule instance** : n'active pas la mise à l'échelle horizontale, sinon plusieurs connexions IRC se disputeraient les mêmes chaînes.
- `TRUST_PROXY=1` derrière un proxy, pour que le blocage après 10 échecs d'authentification (15 min) vise la vraie IP.
- `GET /healthz` répond sans authentification, pour les sondes de santé de l'hébergeur.

### VPS (Hetzner…) avec docker compose + Caddy

`docker-compose.yml` lance l'app et Caddy, qui obtient le certificat HTTPS tout seul. Les données vivent dans `./data` sur le serveur.

```bash
# sur le serveur, dans /opt/twitch-irc (avec DOMAIN dans .env)
mkdir -p data && chown -R 1000:1000 data     # l'app tourne sous l'utilisateur node (uid 1000)
docker compose up -d --build
docker compose logs -f app                    # suivre les logs
```

Mise à jour après modification du code : recopier les fichiers puis `docker compose up -d --build`.

### Variante Cloudflare Tunnel (recommandée)

Aucun port web ouvert sur le serveur : `cloudflared` établit une connexion sortante vers Cloudflare, qui gère le HTTPS et la protection.

1. Mets le domaine sur Cloudflare, puis va dans Zero Trust > Networks > Tunnels > Create a tunnel (type Cloudflared) et copie le jeton dans `TUNNEL_TOKEN` du fichier `.env`.
2. Dans l'onglet Public hostname : `irc.ton-domaine.fr` → service `HTTP`, URL `app:3000`.
3. Lance `docker compose -f docker-compose.tunnel.yml up -d --build`.
4. Ferme les ports 80 et 443 dans le firewall Hetzner : seul le 22 reste ouvert.
5. Optionnel : ajoute Zero Trust > Access > Application sur `irc.ton-domaine.fr` pour exiger un code envoyé par e-mail avant même d'afficher le panneau.

`CLIENT_IP_HEADER=cf-connecting-ip` (déjà réglé dans ce compose) permet au blocage après 10 échecs de viser la vraie IP du client, et non celle de Cloudflare.

### Sécurité du serveur (en place)

- SSH sur le port **48722**, connexion par clé uniquement, root sans mot de passe. Raccourci `ssh dw-twitch` dans `~/.ssh/config`.
- fail2ban en mode `aggressive`. Sur Ubuntu 26.04, il faut `journalmatch = _SYSTEMD_UNIT=ssh.service`, car les échecs sont journalisés par `sshd-session`.
- Alerte Discord à chaque connexion SSH depuis une nouvelle IP (`/usr/local/sbin/ssh-login-alert` via `pam_exec`).
- Conteneurs en lecture seule, sans capabilities, avec `no-new-privileges` et des limites de mémoire et de processus.

### Obtenir le token sur le serveur

Une fois le serveur lancé, le plus simple est le bouton **Reconnecter** du panneau. Sinon, en ligne de commande (le serveur relit le fichier tout seul tant que son token est refusé) :

Le device code flow fonctionne depuis n'importe où : il suffit d'ouvrir le lien affiché depuis ton navigateur.

```bash
docker compose run --rm app node scripts/auth.js
```

Tu peux aussi copier `data/token.json` depuis ton PC, **après avoir arrêté le serveur local**. Avec une appli Public, le refresh token change à chaque renouvellement : si deux serveurs utilisent le même fichier, le premier qui le renouvelle rend la copie de l'autre invalide.

## Accès à distance (Tailscale)

L'API n'écoute que sur `127.0.0.1`. Pour la piloter depuis un téléphone ou un autre PC :

```powershell
tailscale serve --bg 3000
```

Elle est ensuite joignable en HTTPS à l'adresse `https://<nom-du-pc>.<tailnet>.ts.net`, uniquement depuis tes appareils Tailscale. N'utilise pas `tailscale funnel`, qui rend l'API publique sur Internet.
