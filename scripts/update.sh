#!/usr/bin/env bash
# VPS update: pull, install, build, publish the frontend, reload the backend.
# The nginx config is re-installed only when it changed. Safe to run any time.
set -euo pipefail

cd "$(dirname "$0")/.."

WEB_ROOT=/var/www/momarchive
NGINX_CONF=/etc/nginx/sites-enabled/momarchive

before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)

pnpm install --frozen-lockfile
pnpm build

sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete front/dist/ "$WEB_ROOT"/

if ! sudo cmp -s deploy/nginx.momarchive.conf "$NGINX_CONF"; then
  echo "nginx config changed, installing and reloading"
  sudo cp deploy/nginx.momarchive.conf "$NGINX_CONF"
  sudo nginx -t && sudo systemctl reload nginx
fi

pnpm pm2:reload
echo "updated $before -> $after"
