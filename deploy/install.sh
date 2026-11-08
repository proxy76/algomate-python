#!/usr/bin/env bash
# Install or update AlgoMate Python on Ubuntu 22.04 / 24.04.
# Run from the repository root:   sudo ./deploy/install.sh
# Re-running it is the update procedure (rebuilds everything, restarts the service).
set -euo pipefail

APP_DIR=/opt/algomate-python
DATA_DIR=/var/lib/algomate-python
ENV_FILE=/etc/algomate-python.env
DOMAIN=${DOMAIN:-python.algomate.ro}
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io nginx python3 python3-venv rsync curl ca-certificates >/dev/null

# Node >= 18 is needed to build the frontend (Ubuntu 22.04 ships 12).
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  log "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
systemctl enable --now docker >/dev/null

log "Creating service account"
id algomate >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin algomate
usermod -aG docker algomate
install -d -o algomate -g algomate -m 750 "$DATA_DIR"

log "Copying application to $APP_DIR"
install -d "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'frontend/dist' \
    --exclude 'backend/.venv' --exclude 'backend/data' --exclude '__pycache__' \
    "$SRC_DIR"/ "$APP_DIR"/
fi

log "Backend: Python virtualenv"
python3 -m venv "$APP_DIR/backend/.venv"
"$APP_DIR/backend/.venv/bin/pip" install -q --upgrade pip
"$APP_DIR/backend/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

log "Frontend: build"
(cd "$APP_DIR/frontend" && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null)

log "Sandbox image"
docker build -q -t algomate-python-sandbox:latest "$APP_DIR/sandbox"

chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  log "Writing $ENV_FILE (edit it to tune limits)"
  install -m 640 -o root -g algomate "$APP_DIR/deploy/env.example" "$ENV_FILE"
fi

log "systemd service"
install -m 644 "$APP_DIR/deploy/algomate-python.service" /etc/systemd/system/algomate-python.service
systemctl daemon-reload
systemctl enable algomate-python >/dev/null
systemctl restart algomate-python

log "nginx"
# Installed once: certbot edits this file, so updates must not overwrite it.
if [ ! -f "/etc/nginx/sites-available/$DOMAIN" ] || [ "${FORCE_NGINX:-0}" = 1 ]; then
  sed "s/python\.algomate\.ro/$DOMAIN/g" "$APP_DIR/deploy/nginx/python.algomate.ro.conf"     > "/etc/nginx/sites-available/$DOMAIN"
fi
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t -q && systemctl reload nginx

log "Health check"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8000/api/health; then echo; break; fi
  sleep 1
done

cat <<MSG

Done. AlgoMate Python is running behind nginx on port 80.

Next step: TLS (pick one, see README):
  - Cloudflare Tunnel:  cloudflared tunnel ... --url http://localhost:80
  - Let's Encrypt:      apt install certbot python3-certbot-nginx && certbot --nginx -d $DOMAIN
MSG
