/**
 * Internal metrics dashboard UI — /internal/metrics (CSP-safe external script).
 */
(function () {
  const root = document.getElementById("dash-root");
  const grid = document.getElementById("dash-grid");
  const banner = document.getElementById("dash-banner");
  const meta = document.getElementById("dash-meta");
  const params = new URLSearchParams(window.location.search);
  const T = params.get("token");

  function setBanner(cls, html) {
    if (!banner) return;
    banner.className = "dash-banner" + (cls ? " " + cls : "");
    banner.innerHTML = html;
    banner.hidden = false;
  }

  function fmtTime(ms) {
    if (ms == null || Number.isNaN(ms)) return "—";
    try {
      return new Date(ms).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch (_) {
      return "—";
    }
  }

  function fmtUptime(sec) {
    if (sec == null || sec < 0) return "—";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function card(label, value, sub) {
    const el = document.createElement("article");
    el.className = "dash-card";
    el.innerHTML =
      '<div class="dash-card-label"></div>' +
      '<div class="dash-card-value"></div>' +
      (sub ? '<div class="dash-card-sub"></div>' : "");
    el.querySelector(".dash-card-label").textContent = label;
    el.querySelector(".dash-card-value").textContent = value;
    const subEl = el.querySelector(".dash-card-sub");
    if (subEl && sub) subEl.textContent = sub;
    return el;
  }

  function section(title) {
    const h = document.createElement("h2");
    h.className = "dash-section-title";
    h.textContent = title;
    return h;
  }

  function render(data) {
    if (!grid) return;
    const loading = document.getElementById("dash-loading");
    if (loading) loading.hidden = true;
    grid.textContent = "";
    grid.hidden = false;

    grid.appendChild(section("Server"));
    grid.appendChild(card("Deploy version", String(data.version || "—"), "From APP_VERSION / healthz"));
    grid.appendChild(card("Process uptime", fmtUptime(data.uptimeSec), "Since this instance started"));
    grid.appendChild(card("Snapshot time", fmtTime(data.at), "Last API read"));

    grid.appendChild(section("Live"));
    grid.appendChild(
      card(
        "WebSocket clients",
        String(data.socketsConnected ?? "—"),
        "Socket.io connections right now"
      )
    );
    grid.appendChild(
      card("Peak sockets (boot)", String(data.traffic?.peakSockets ?? "—"), "High-water mark this run")
    );
    grid.appendChild(
      card("Active draft rooms", String(data.draftSessions ?? "—"), "In-memory sessions on this instance")
    );

    grid.appendChild(section("Traffic (this instance)"));
    const tr = data.traffic || {};
    grid.appendChild(card("GET / (landing)", String(tr.landingViews ?? "—"), "Since process start"));
    grid.appendChild(card("GET /app", String(tr.appShellViews ?? "—"), "App shell loads"));
    grid.appendChild(card("Feedback posts", String(tr.feedbackTotal ?? "—"), "Successful /api/feedback"));
    grid.appendChild(
      card("Counters since", fmtTime(tr.since), "Resets on deploy / restart")
    );

    grid.appendChild(section("Catalog"));
    const cat = data.catalog || {};
    grid.appendChild(card("Competitive maps", String(cat.maps ?? "—"), "Valorant API pool"));
    grid.appendChild(card("Agents", String(cat.agents ?? "—"), "Playable agents"));

    setBanner(
      "",
      "These numbers are <strong>per server instance</strong> and reset on redeploy. " +
        "For request latency, CPU, and long-term traffic, use " +
        '<a href="https://render.com/docs/web-service-metrics" rel="noopener noreferrer">Render metrics</a> ' +
        "or an analytics product."
    );

    if (meta) {
      meta.innerHTML =
        "<span>Last fetch: <strong>" +
        fmtTime(Date.now()) +
        "</strong></span>" +
        "<span>Auto-refresh: <strong>12s</strong></span>";
    }
  }

  function renderError(status, bodyText) {
    const loading = document.getElementById("dash-loading");
    if (loading) loading.hidden = true;
    if (grid) {
      grid.hidden = true;
      grid.textContent = "";
    }
    setBanner("err", "<strong>Could not load metrics.</strong> Check the token or sign in to Render and verify <code>ADMIN_STATS_TOKEN</code>.");
    if (meta) meta.textContent = status ? "HTTP " + status : "";
    if (root) {
      const pre = document.createElement("pre");
      pre.style.cssText =
        "margin-top:1rem;padding:1rem;background:#121826;border:1px solid #223047;border-radius:8px;font-size:12px;overflow:auto;max-height:12rem;color:#8899b7";
      pre.textContent = bodyText.slice(0, 2000);
      const old = root.querySelector(".dash-error-dump");
      if (old) old.remove();
      pre.className = "dash-error-dump";
      root.appendChild(pre);
    }
  }

  if (!T) {
    const loading = document.getElementById("dash-loading");
    if (loading) {
      loading.hidden = true;
    }
    setBanner("warn", "Missing <code>token</code> in the URL. Open the link Render gave you or add <code>?token=…</code>.");
    return;
  }

  async function load() {
    try {
      const r = await fetch("/api/admin/stats?token=" + encodeURIComponent(T), { cache: "no-store" });
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_) {
        renderError(r.status, text);
        return;
      }
      if (!r.ok || !data.ok) {
        renderError(r.status, text);
        return;
      }
      const dump = document.querySelector(".dash-error-dump");
      if (dump) dump.remove();
      render(data);
    } catch (e) {
      renderError(0, String(e && e.message ? e.message : e));
    }
  }

  load();
  setInterval(load, 12000);
})();
