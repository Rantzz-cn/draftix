# DRAFTIX

**Real-time Valorant map & agent draft tool. No signup. Just draft.**

Live at **[draftix.tech](https://draftix.tech)** · Buy me a [coffee](https://ko-fi.com/dartzski) · MIT licensed

![DRAFTIX cover](public/images/og-1200x630.jpg)

---

## Features

- **Map veto** with the competitive map pool (Ascent, Abyss, Bind, Breeze, Fracture, Haven, Icebox, Lotus, Pearl, Split, Sunset).
- **Agent bans** — six bans per side, picked by team captain.
- **Coin flip** for first ban, **side pick** on the decider map.
- **Custom team names** set by the host in the lobby.
- **30-second turn timer** with auto-ban on expiry, so an AFK captain can't stall a draft.
- **Per-session chat** — ephemeral, ring-buffered, no accounts.
- **Refresh-proof seats** — captain or host refreshes? They get their slot back via a per-session resume token (60-second grace).
- **Export the final draft as a PNG** for sharing in your team Discord.
- **Real-time sync** via Socket.io. Built for browser tabs in different cities — perfectly consistent state.
- **No signup.** No emails. No accounts. Sessions live in memory and die when everyone leaves.

## Tech

- **Backend**: Node.js 20+, Express, Socket.io, helmet, express-rate-limit.
- **Frontend**: plain HTML / CSS / vanilla JS — no React, no build step.
- **Catalog**: agent + map data fetched live from [valorant-api.com](https://valorant-api.com) and cached.
- **No database** — everything is in-memory; only the list of issued session codes is persisted (so codes never repeat).

## Run it locally

Requires **Node 20 or newer**.

```bash
git clone https://github.com/<you>/draftix.git
cd draftix
npm install
npm start
# open http://localhost:3000
```

Run the integration test (server must be running):

```bash
npm test
```

Useful environment variables (all optional — see `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Bind port |
| `ALLOWED_ORIGINS` | (any) | Comma-separated origins for CORS in production |
| `TRUST_PROXY` | `0` | Set to `1` behind Caddy/nginx/Cloudflare |
| `TURN_TIMEOUT_MS` | `30000` | Per-turn auto-ban window |
| `RECONNECT_GRACE_MS` | `60000` | How long a disconnected player keeps their seat |
| `MAX_SESSIONS` | `5000` | In-memory session cap |
| `MAX_CLIENTS_PER_SESSION` | `32` | Roster cap |

## Deploy

Full deployment guide in **[DEPLOY.md](DEPLOY.md)** — covers:

- **Docker + Caddy** (auto-HTTPS) on any VPS or Oracle Cloud Free Tier
- **pm2 + Caddy** as a no-Docker alternative
- Backups, log monitoring, rollback

**Free hosting (no VPS):** use **[RENDER.md](RENDER.md)** — Render Web Service from this repo’s `Dockerfile` (free tier sleeps when idle; optional ping keeps it warm).

Optional **[render.yaml](render.yaml)** — Render Blueprint for one-click infra-as-code.

## Project layout

```
.
├── server.js               # Express + Socket.io entry point
├── public/                 # static assets served as-is
│   ├── index.html          # marketing landing page
│   ├── app.html            # the draft app
│   ├── app.js              # all client-side draft logic
│   ├── landing.js          # landing-page polish (scroll reveal, etc.)
│   ├── styles.css          # everything visual
│   ├── status.html         # human-readable /healthz dashboard
│   ├── privacy.html        # self-contained legal page
│   ├── terms.html          # self-contained legal page
│   ├── manifest.json       # PWA manifest
│   ├── robots.txt
│   ├── sitemap.xml
│   ├── images/             # favicons + OG card + brand assets
│   └── sounds/             # drop custom MP3s here
├── test/
│   └── test-resume.js      # Socket.io integration test for resume-on-refresh
├── Dockerfile              # multi-stage prod image
├── docker-compose.yml      # app + Caddy reverse proxy
├── Caddyfile               # auto-HTTPS reverse proxy config
├── ecosystem.config.js     # pm2 process config (no-Docker option)
├── DEPLOY.md               # full deployment guide (VPS + Docker)
├── RENDER.md               # free Render.com Web Service walkthrough
├── render.yaml             # optional Render Blueprint
├── .env.example            # documented config knobs
└── package.json
```

Session-code log (`data/codes.log`) is created at runtime and gitignored.

## Security

- `helmet` with a strict CSP (no inline scripts; only `cdn.socket.io` for the client library).
- Disabled `X-Powered-By`.
- HTTP rate-limited globally; sockets rate-limited per event type per IP.
- Image proxy is whitelisted to `valorant-api.com`, capped to 5 MB per response, type-checked.
- No personal data stored anywhere. No cookies, no analytics, no third-party trackers.

Found something? Open an issue.

## License

MIT — see [LICENSE](LICENSE).
