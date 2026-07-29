# Deploying Nutrition Journal on the existing heyimmi.com Droplet

Nutrition Journal runs alongside the `heyimmi.com` landing page (and Momentum)
on the same DigitalOcean droplet — they share the box, Caddy, and the domain,
but stay fully isolated: Nutrition Journal is a separate app under its own user
and systemd service, reached through a new `nutrition.heyimmi.com` subdomain.
The landing page and Momentum are never touched.

Why a droplet (and not App Platform): the app keeps all your meal data as
per-meal folders under `data/meals/` (plus the raw photos/audio), which App
Platform's ephemeral filesystem would wipe on every deploy, and it **spawns the
Claude Code CLI** server-side to analyze each intake — something a
static-hosting platform can't do.

The stack after this:

```
                          ┌─> /var/www/heyimmi.com        (static, unchanged)
phone/browser ─HTTPS─> Caddy ─> 127.0.0.1:3000  Momentum   (unchanged)
  (via Cloudflare)        └─> 127.0.0.1:3100  node server.js  (systemd: nutrition)
                                                    └─> claude CLI (intake analysis)
```

Make sure the droplet has enough RAM for the Node server plus the Opus-model
Claude CLI it spawns during analysis (2 GB + swap is comfortable).

## 0. Prerequisites

- SSH access to the droplet as `root`.
- Claude auth for the server — the app uses **Opus** through the Claude Code
  CLI, which bills against your **Claude subscription (Max plan)**, not the
  pay-per-token API:
  - On your *local* machine run `claude setup-token`, complete the browser
    flow, and copy the long-lived token. You'll set it as
    `CLAUDE_CODE_OAUTH_TOKEN` on the droplet.
  - (An `ANTHROPIC_API_KEY` also works but bills per token — not what this app
    is designed for.)

All commands below are run as `root` on the droplet unless noted.

## 1. DNS: add the subdomain

In Cloudflare, add a record so `nutrition.heyimmi.com` resolves to the droplet:

```text
Type: A
Name: nutrition
IPv4 address: <droplet-ip>
Proxy status: Proxied   (orange cloud — matches the root domain)
TTL: Auto
```

Proxied is fine: Cloudflare exempts `/.well-known/acme-challenge/` from its
HTTPS redirect, so Caddy's HTTP-01 certificate challenge still works.

## 2. Install Node and create the app user

(Skip the Node install if Momentum already put Node 22 on the box.)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

adduser --disabled-password --gecos "" nutrition
```

## 3. Install the app and the Claude CLI

As the `nutrition` user:

```bash
su - nutrition
git clone https://github.com/immbaur/NutritionJournal.git
cd NutritionJournal
npm install --omit=dev

# Claude Code CLI — native installer, lands in ~/.local/bin
curl -fsSL https://claude.ai/install.sh | bash
exit
```

If the GitHub repo is private, make it public or add a read-only deploy key on
the droplet first.

## 4. Configure secrets

Back as `root`, create `/etc/nutrition.env`:

```bash
cat > /etc/nutrition.env <<'EOF'
NUTRITION_PASSWORD=pick-a-strong-password
CLAUDE_CODE_OAUTH_TOKEN=paste-token-from-claude-setup-token
EOF
chmod 600 /etc/nutrition.env
```

## 5. Start the service

The systemd unit binds the app to `127.0.0.1:3100`, so it's reachable only
through Caddy — never directly from the internet.

```bash
cp /home/nutrition/NutritionJournal/deploy/nutrition.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nutrition
systemctl status nutrition        # should be active (running)
```

## 6. Add the Caddy site block

Caddy already serves the other sites from `/etc/caddy/Caddyfile`. **Append**
this app's block — don't replace the file, or you'll drop the others:

```bash
cat /home/nutrition/NutritionJournal/deploy/nutrition.caddy >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

The block raises Caddy's request-body limit so multi-photo uploads get through.

Once DNS has propagated, open `https://nutrition.heyimmi.com`, log in with the
password from `/etc/nutrition.env`, then verify end-to-end by **logging an
intake** with a photo (this is what exercises the Claude CLI under systemd).
Confirm the other sites still load.

## 7. Automated deploys (optional)

`deploy/remote-deploy.sh` runs on the droplet and does a full update: pull
`main`, `npm ci --omit=dev`, refresh the systemd unit, restart, health-check on
`:3100`. Wire it to GitHub Actions the same way Momentum does, or run it by hand:

```bash
ssh root@<droplet-ip> 'bash -s' < deploy/remote-deploy.sh
```

`data/` is gitignored, so deploys never touch your meal history, auth, or
sessions.

## 8. Day-to-day

**Logs**

```bash
journalctl -u nutrition -f
```

**Backing up your data** — everything that matters is `data/meals/` (one folder
per meal: `meal.json` + the raw photos/audio) plus `data/auth.json` and
`data/sessions.json`. Because each meal is a self-contained directory, backups
are just a directory copy:

```bash
rsync -a nutrition@<droplet-ip>:NutritionJournal/data/ ~/nutrition-data-backup/
```

**Changing the password** — update `NUTRITION_PASSWORD` in `/etc/nutrition.env`
and `systemctl restart nutrition` (the restart logs out all existing sessions).
