#!/usr/bin/env bash
# Déploie le dernier commit (HEAD) sur le serveur de prod, puis vérifie qu'il répond.
#   bash scripts/deploy.sh
# Prérequis : alias « dw-twitch » dans ~/.ssh/config. Les modifications non commitées ne partent pas.
set -euo pipefail

HOST=dw-twitch
DIR=/opt/twitch-irc
COMPOSE="docker compose -f docker-compose.tunnel.yml"
FILES=(src public package.json package-lock.json Dockerfile .dockerignore)

cd "$(dirname "$0")/.."
if ! git diff --quiet HEAD -- "${FILES[@]}"; then
  echo "⚠ Modifications non commitées dans ${FILES[*]} : elles ne seront pas déployées." >&2
fi

echo "→ Sauvegarde de l'état actuel du serveur"
ssh "$HOST" "cd $DIR && mkdir -p /root/deploy-backup && tar czf /root/deploy-backup/before-\$(date +%Y%m%d-%H%M%S).tgz src public data/channels.json"

echo "→ Envoi de $(git rev-parse --short HEAD)"
git archive HEAD "${FILES[@]}" | ssh "$HOST" "cd $DIR && tar xf -"

echo "→ Reconstruction et redémarrage"
ssh "$HOST" "cd $DIR && $COMPOSE up -d --build app 2>&1 | tail -1 && sleep 8 && $COMPOSE logs --since 1m app | tail -6 && $COMPOSE exec -T app wget -qO- 127.0.0.1:3000/healthz"
echo
echo "✓ Déployé"
