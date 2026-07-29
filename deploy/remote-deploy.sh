#!/usr/bin/env bash
# Runs ON THE DROPLET as root. A GitHub Actions workflow (or you, by hand) feeds
# it in with:
#   ssh root@droplet 'bash -s' < deploy/remote-deploy.sh
# It updates the checked-out repo, reinstalls prod deps, refreshes the systemd
# unit, restarts the service, and health-checks it.
#
# Assumes the one-time bootstrap in deploy/DIGITALOCEAN.md is already done
# (nutrition user + repo clone + Node + Claude CLI + /etc/nutrition.env).
set -euo pipefail

APP_DIR=/home/nutrition/NutritionJournal

# Update code as the nutrition user, which owns the repo. data/ is gitignored,
# so git never touches your meal history, auth, or sessions.
su - nutrition -s /bin/bash -c "
  set -euo pipefail
  cd '$APP_DIR'
  git fetch --prune origin
  git reset --hard origin/main
  npm ci --omit=dev
"

# Refresh the systemd unit (in case it changed in the repo) and restart.
install -m 644 "$APP_DIR/deploy/nutrition.service" /etc/systemd/system/nutrition.service
systemctl daemon-reload
systemctl enable nutrition >/dev/null 2>&1 || true
systemctl restart nutrition

# Wait for the app to answer on its local port before calling the deploy good.
for _ in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
    echo "Nutrition Journal is healthy after deploy."
    exit 0
  fi
  sleep 1
done

echo "Health check failed — service did not answer on :3100" >&2
systemctl status nutrition --no-pager -l | tail -30 >&2
exit 1
