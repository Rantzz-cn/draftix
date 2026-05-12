# Deploy DRAFTIX on Render (free tier)

Render’s **free Web Service** needs **no credit card**. The trade-off is **sleep after ~15 minutes** of zero traffic — the next visitor waits ~30 seconds while the container cold-starts. You can keep it warm with a free external ping (see below).

Your repo is already Docker-ready (`Dockerfile` at the repo root). **One service** serves the static site + Socket.io — nothing to split.

---

## 1. Create the Web Service

1. Sign in at [dashboard.render.com](https://dashboard.render.com) (GitHub login is fine).
2. **New +** → **Web Service**.
3. Connect **GitHub** → authorize Render → choose **`Rantzz-cn/draftix`**.
4. Configure:

   | Field | Value |
   | --- | --- |
   | **Name** | `draftix` (or anything — becomes `https://<name>.onrender.com`) |
   | **Region** | Closest to your players (e.g. Oregon / Frankfurt / Singapore) |
   | **Branch** | `main` |
   | **Root Directory** | *(leave empty)* |
   | **Runtime** | **Docker** |
   | **Dockerfile Path** | `./Dockerfile` |
   | **Instance type** | **Free** |

5. Expand **Advanced** → **Health Check Path**: `/healthz`  
   (Leave **Docker Command** empty — the image already runs `node server.js`.)

6. **Environment** → **Add Environment Variable**:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `TRUST_PROXY` | `1` |
   | `APP_VERSION` | `1.1.0` |

   **Optional but recommended after first deploy:** add `ALLOWED_ORIGINS` with your exact Render URL so only your site can open WebSockets in production:

   ```
   https://draftix.onrender.com,https://draftix.tech,https://www.draftix.tech
   ```

   Replace `draftix` with whatever **Name** you chose. Until you set this, the server allows any origin when `ALLOWED_ORIGINS` is unset (fine for testing).

7. Click **Create Web Service**. First build takes **5–15 minutes** (Docker pull + `npm ci`).

---

## 2. Smoke test

When the deploy shows **Live**, open:

- `https://<your-service-name>.onrender.com/` — landing page  
- `https://<your-service-name>.onrender.com/app.html` — draft app  
- `https://<your-service-name>.onrender.com/healthz` — should return JSON with `"ok":true`

Open **two browser tabs**, create a session in one, join in the other — bans should sync in real time.

---

## 3. Custom domain (`draftix.tech`)

1. Render dashboard → your service → **Settings** → **Custom Domains** → **Add** → `draftix.tech` and `www.draftix.tech`.
2. Render shows **DNS records** (usually **CNAME** to `xxx.onrender.com`). Add those at your registrar.
3. Wait for TLS to turn **Verified** (often a few minutes).
4. Update **`ALLOWED_ORIGINS`** in Render to include **all** of:

   `https://draftix.onrender.com` (keep this if you still share the old link),  
   `https://draftix.tech`,  
   `https://www.draftix.tech`

5. **Manual Deploy** → **Clear build cache & deploy** (optional) so env is picked up cleanly.

---

## 4. Avoid sleep (optional, still free)

Use a free cron ping every **10 minutes** so the free instance rarely idles long enough to sleep:

1. [cron-job.org](https://cron-job.org) (or UptimeRobot, Better Stack free tier, etc.)
2. Create a job: **GET** `https://<your-service-name>.onrender.com/healthz`
3. Interval: **10 minutes**

This is allowed on Render’s free tier for personal projects; don’t hammer sub-second intervals.

---

## 5. Known limits (free tier)

| Limit | Effect |
| --- | --- |
| **Ephemeral disk** | `data/codes.log` resets if the instance is **moved or rebuilt** — unique session codes stay unique **per running instance**. For a hobby draft tool this is usually fine. For permanent global code uniqueness, use a paid **disk** or an external DB later. |
| **750 hours/month** | One always-on free web service fits in the quota. |
| **Cold start** | First request after sleep is slow — mitigated with the ping above. |

---

## Troubleshooting

- **Build failed** → open **Logs** on the failed deploy; common issues are Docker build timeout (retry) or registry glitch (redeploy).
- **502 / application error** → check **Logs**; confirm `PORT` is not overridden manually (Render sets it automatically; our server reads `process.env.PORT`).
- **WebSocket / draft not syncing** → set `TRUST_PROXY=1` (above). Set `ALLOWED_ORIGINS` to include the **exact** `https://…` origin you use in the browser (no trailing slash).

When you’re ready to move off sleep entirely, use **Oracle Cloud Always Free** or a small VPS — see `DEPLOY.md`.
