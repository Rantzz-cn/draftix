# Deploying DRAFTIX to `draftix.tech`

This guide gets DRAFTIX live with automatic HTTPS in ~10 minutes on a fresh
Linux VPS (DigitalOcean, Hetzner, Linode, AWS Lightsail, etc).

Three paths are documented. **Pick one:**

| Path | Best for | What it needs |
| --- | --- | --- |
| **A. Docker (recommended)** | One-command deploys, easy rollback | `docker` + `docker compose` |
| **B. pm2 + Caddy** | Smaller VPSs, no Docker | `node`, `pm2`, `caddy` (system packages) |
| **C. Render (free)** | No VPS, no card; good for friends testing | GitHub + [RENDER.md](./RENDER.md) (sleeps after idle; optional keep-warm ping) |

---

## 0. Before you touch the server

1. **Buy a domain.** You already have `draftix.tech` ✅
2. **Buy a VPS** — 1 vCPU / 1 GB RAM is plenty. Suggested:
   - Hetzner CX22 (~€4/mo, EU)
   - DigitalOcean Basic Droplet ($6/mo)
   - AWS Lightsail $5
3. **Point DNS at the VPS.** In your registrar's DNS panel:
   ```
   A     @       <your VPS IPv4>     TTL 300
   A     www     <your VPS IPv4>     TTL 300
   ```
   Wait 1–5 minutes for propagation. Confirm with `nslookup draftix.tech`.
4. **SSH into the VPS as root** (or a sudo user).

---

## Path A — Docker (recommended)

### A1. Install Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out / back in after this
```

### A2. Clone or copy this repo to the VPS

```bash
sudo mkdir -p /opt/draftix && sudo chown $USER /opt/draftix
cd /opt/draftix
# Option 1: git clone if you have it on GitHub
git clone https://github.com/<you>/draftix.git .
# Option 2: rsync from your laptop
#   rsync -avz --exclude node_modules --exclude data ./ user@server:/opt/draftix/
```

### A3. Configure environment

```bash
cp .env.example .env
nano .env       # edit ALLOWED_ORIGINS if your domain differs
```

The included `docker-compose.yml` already sets the production-correct values
inline, so editing `.env` is only required if you want to override timeouts
or session caps. **Do not commit `.env`.**

### A4. Start the stack

```bash
docker compose up -d --build
```

Caddy will request a Let's Encrypt certificate on the first inbound HTTPS
hit. Open `https://draftix.tech` in a browser — that triggers the cert.

### A5. Verify

```bash
docker compose ps                                # both containers Up
curl -s https://draftix.tech/healthz | jq        # JSON, "ok": true
docker compose logs -f draftix                   # watch app logs
```

### A6. Updating after a code change

```bash
cd /opt/draftix
git pull                          # or rsync new files in
docker compose up -d --build      # zero-downtime if you have a load balancer
docker compose logs -f draftix
```

### A7. Rolling back

Docker images are tagged by build time. To roll back: `git checkout <sha> && docker compose up -d --build`.

---

## Path B — pm2 + Caddy (no Docker)

### B1. Install Node 22, pm2, and Caddy

```bash
# Ubuntu 22.04 / 24.04 — Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

sudo npm install -g pm2

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### B2. Drop the app on the box

```bash
sudo mkdir -p /opt/draftix && sudo chown $USER /opt/draftix
cd /opt/draftix
# git clone or rsync as above
npm ci --omit=dev
```

### B3. Caddyfile

Copy the project's `Caddyfile` to `/etc/caddy/Caddyfile`, but change
`reverse_proxy draftix:3000` to `reverse_proxy 127.0.0.1:3000`:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/draftix:3000/127.0.0.1:3000/g' /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

### B4. Start under pm2

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup       # run the printed command so pm2 auto-starts on reboot
```

### B5. Verify

```bash
pm2 status
curl -s https://draftix.tech/healthz | jq
```

---

## What's already production-safe (no action required)

✅ **Secrets / files** — `.env`, `data/`, `node_modules/`, `*.log` are all gitignored. Run `git status` to confirm a clean tree before pushing.
✅ **HTTP security headers** — `helmet` is enabled with a strict CSP; `X-Powered-By` is disabled.
✅ **TLS / HTTPS** — Caddy handles certs automatically.
✅ **Rate limiting** — HTTP-wide (600/min/IP), socket events (10–60/sec depending on type), image proxy (240/min/IP).
✅ **Process resilience** — crash handlers re-throw cleanly; pm2 / Docker restart on exit.
✅ **Graceful shutdown** — `SIGTERM` broadcasts a `serverShutdown` event so clients see a banner before the connection drops.
✅ **Stale session GC** — sessions idle for >2h are swept every 10 min.
✅ **Image proxy** — size-capped (5 MB) and whitelisted to `valorant-api.com` only.
✅ **No PII** — only short alphanumeric session codes are persisted; no accounts, emails, or passwords.
✅ **SEO** — `robots.txt`, `sitemap.xml`, `manifest.json`, Open Graph + Twitter Card meta.
✅ **Legal** — `/privacy.html` and `/terms.html` linked from every footer.

---

## Operational tips

### Watching the logs
```bash
docker compose logs -f --tail=200      # docker path
pm2 logs draftix                       # pm2 path
```

### Status page
- Machine-readable: `https://draftix.tech/healthz`
- Human-readable dashboard: `https://draftix.tech/status.html`

### Backups
Only one file matters: `data/codes.log` — the permanent record of issued
session codes (used so codes never repeat across deploys). With Docker
it's in the `draftix_data` named volume:

```bash
docker run --rm -v draftix_data:/data -v $PWD:/backup alpine \
  tar czf /backup/codes-$(date +%F).tgz -C / data
```

### Restarting
```bash
docker compose restart draftix       # docker
pm2 restart draftix                  # pm2
```

### Common gotchas
- **Cert fails to issue** → DNS not pointed at this server yet, or port 80/443 blocked by firewall. Check `ufw status` / cloud firewall.
- **Socket.io disconnects every ~minute** → reverse proxy isn't passing WebSocket upgrades. Caddy does this automatically; for nginx you need `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.
- **`429 Too Many Requests` for legit users** → you're probably behind a proxy you forgot to trust. Set `TRUST_PROXY=1`.

---

## Nice-to-have follow-ups (not blocking launch)

- **Error tracking**: drop in Sentry by adding `@sentry/node` and calling `Sentry.init({ dsn: process.env.SENTRY_DSN })` at the top of `server.js`.
- **Uptime monitoring**: point [Better Stack](https://betterstack.com/uptime) or UptimeRobot at `https://draftix.tech/healthz`.
- **Analytics**: Plausible / Umami self-hosted, or none at all (privacy-friendly default).
- **Bigger OG image**: replace `public/images/draftix.png` with a 1200×630 social card for Twitter / Discord previews.

Ship it.
