/**
 * Internal metrics dashboard — loaded by /internal/metrics (no inline script; CSP-safe).
 * Token is read from the ?token= query string (URL-encoded tokens supported).
 */
(function () {
  const out = document.getElementById("o");
  const params = new URLSearchParams(window.location.search);
  const T = params.get("token");
  if (!T) {
    if (out) out.textContent = "Missing token in URL.";
    return;
  }
  async function load() {
    if (!out) return;
    try {
      const r = await fetch("/api/admin/stats?token=" + encodeURIComponent(T), {
        cache: "no-store",
      });
      out.textContent = await r.text();
    } catch (e) {
      out.textContent = String(e && e.message ? e.message : e);
    }
  }
  load();
  setInterval(load, 12000);
})();
