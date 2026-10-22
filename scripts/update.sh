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
  # Keep the working config until the new one passes nginx -t, so a bad file is
  # never left in place for the next restart to trip over.
  backup=$(mktemp)
  [ -f "$NGINX_CONF" ] && sudo cp "$NGINX_CONF" "$backup"
  sudo cp deploy/nginx.momarchive.conf "$NGINX_CONF"
  if sudo nginx -t; then
    sudo systemctl reload nginx
  else
    echo "nginx -t failed, putting the previous config back" >&2
    [ -s "$backup" ] && sudo cp "$backup" "$NGINX_CONF"
    rm -f "$backup"
    exit 1
  fi
  rm -f "$backup"
fi

pnpm pm2:reload
echo "updated $before -> $after"
