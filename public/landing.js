/**
 * DRAFTIX landing-page polish.
 * Tiny, framework-free. No socket.io, no draft logic — that lives in app.js on /app.
 *   - Footer year + version (from /healthz)
 *   - Smooth-scroll for in-page anchors
 *   - Scroll-reveal via IntersectionObserver
 *   - Auto-redirect legacy /?code=XXX to /app?code=XXX
 */
(function () {
  // ─── Auto-redirect legacy shared session URLs ───
  // (someone shares "/?code=XXX" → take them straight to the app)
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get("code")) {
      location.replace("/app" + location.search + location.hash);
      return;
    }
  } catch (_) { /* ignore */ }

  // ─── Footer year + version ───
  const yearEl = document.getElementById("footerYear");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const verEl = document.getElementById("footerVersion");
  if (verEl) {
    fetch("/healthz", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && j.version) verEl.textContent = String(j.version); })
      .catch(() => { /* server not running; harmless */ });
  }

  // ─── Smooth scroll for in-page anchors ───
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", function (ev) {
      const href = a.getAttribute("href");
      if (!href || href === "#") return;
      const target = document.querySelector(href);
      if (!target) return;
      ev.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // ─── Scroll-reveal ───
  const revealEls = document.querySelectorAll(".reveal");
  if (!revealEls.length) return;

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    revealEls.forEach((el) => el.classList.add("is-revealed"));
    return;
  }

  if (!("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("is-revealed"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const delay = parseInt(el.getAttribute("data-reveal-delay") || "0", 10);
        setTimeout(() => el.classList.add("is-revealed"), Math.max(0, delay));
        io.unobserve(el);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  revealEls.forEach((el) => io.observe(el));
})();
