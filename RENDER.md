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

## 3. Custom domain (`draftix.tech` on Render)

Your app is already branded for `draftix.tech` in HTML meta tags and `sitemap.xml`. Pointing DNS at Render only wires the name to your existing Web Service.

### 3a. Add the domain in Render

1. [Render Dashboard](https://dashboard.render.com/) → select your **draftix** Web Service.
2. **Settings** → scroll to **Custom Domains** → **+ Add Custom Domain**.
3. Enter **`draftix.tech`** (apex / root) and save.  
   Render will usually **auto-add `www.draftix.tech`** and redirect it to the apex (or the reverse if you add `www` first — either is fine).
4. Render shows a **DNS verification** panel with the exact records to create. **Copy those values** — they are unique to your service (they look like a **CNAME** target such as `draftix-xxxx.onrender.com` or similar).

> **Remove any `AAAA` (IPv6) records** for `draftix.tech` / `www` while setting this up. Render serves IPv4 only; stray `AAAA` records can break routing or TLS.  
> Render’s full guide: [Custom domains](https://render.com/docs/custom-domains) · provider help: [Cloudflare](https://render.com/docs/configure-cloudflare-dns) · [Namecheap](https://render.com/docs/configure-namecheap-dns) · [other DNS](https://render.com/docs/configure-other-dns)

### 3b. Create DNS records at your `.tech` registrar

Log in where you bought **`draftix.tech`** (Porkbun, Namecheap, Cloudflare, Google Domains successor, etc.) → **DNS** / **Manage DNS**.

Typical setup (confirm against what **Render shows you** — use Render’s values if they differ):

| Type | **Name / Host** | **Value / Target** |
| --- | --- | --- |
| **CNAME** | `@` or `draftix.tech` or leave blank *(depends on provider)* | The hostname Render gives you (often `draftix.onrender.com` or a service-specific `*.onrender.com`) |

Some registrars **do not allow a CNAME on the bare apex** (`@`). In that case Render’s dashboard will show **A records** instead — add exactly those **IPv4 addresses**.

For **`www`**: if Render did not auto-create it, add:

| Type | Name | Value |
| --- | --- | --- |
| **CNAME** | `www` | Same target Render shows for the apex (often your `*.onrender.com` hostname) |

TTL: **300** (5 min) or default is fine while testing.

### 3c. Verify in Render

1. Wait **2–15 minutes** for DNS to propagate.
2. Back in **Custom Domains**, click **Verify** next to each domain until status is **Verified** (TLS cert issued).
3. Open **`https://draftix.tech`** and **`https://www.draftix.tech`** in the browser — both should load the site (one may redirect to the other).

### 3d. Fix `ALLOWED_ORIGINS` (required for WebSockets)

In **Environment**, set **`ALLOWED_ORIGINS`** to **one line, comma-separated, no spaces**, including every origin players might use:

```text
https://draftix.onrender.com,https://draftix.tech,https://www.draftix.tech
```

(If your Render service name is not `draftix`, replace `https://draftix.onrender.com` with your real URL, e.g. `https://myname.onrender.com`.)

Then **Manual Deploy** → **Deploy latest commit** (or **Save** if Render auto-restarts) so the new env applies.

### 3e. Optional: hide the old `onrender.com` URL

After you’re happy with `draftix.tech`, you can **disable the Render subdomain** so only your custom domain works: **Settings** → **Custom Domains** → toggle **Render subdomain** off. Then update bookmarks and `ALLOWED_ORIGINS` to drop the `.onrender.com` origin if you no longer need it.

### 3f. Point your keep-warm ping at the custom domain

If you use [cron-job.org](https://cron-job.org) (see §4), after DNS is live add or switch a job to:

`https://draftix.tech/healthz`

so wakes hit your real domain too.

---

## 4. Avoid sleep (optional, still free)

Use a free cron ping every **10 minutes** so the free instance rarely idles long enough to sleep:

1. [cron-job.org](https://cron-job.org) (or UptimeRobot, Better Stack free tier, etc.)
2. Create a job: **GET** `https://draftix.tech/healthz` (or `https://<your-service>.onrender.com/healthz` until DNS is ready)
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
