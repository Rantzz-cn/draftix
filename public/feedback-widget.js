/**
 * Feedback / report modal — shared by landing (/) and draft app (/app).
 * POST /api/feedback  { kind, message, contact?, page?, website? (honeypot) }
 */
(function () {
  function ensureModal() {
    let root = document.getElementById("feedbackRoot");
    if (root) return root;
    root = document.createElement("div");
    root.id = "feedbackRoot";
    root.innerHTML =
      '<div id="feedbackModal" class="modal feedback-modal" hidden aria-hidden="true" role="dialog" aria-labelledby="feedbackModalTitle">' +
      '<div class="modal-overlay" data-feedback-dismiss></div>' +
      '<div class="modal-card feedback-card" role="document">' +
      '<button type="button" class="modal-close" data-feedback-dismiss aria-label="Close">×</button>' +
      '<div class="modal-header">' +
      '<span class="modal-eyebrow">Help us improve</span>' +
      '<h2 id="feedbackModalTitle" class="modal-title">Feedback or report</h2>' +
      '<p class="modal-subtitle">Bug reports and ideas go straight to the maintainer. No account required.</p>' +
      "</div>" +
      '<form id="feedbackForm" class="feedback-form" novalidate>' +
      '<label class="feedback-hp" aria-hidden="true">Leave blank<input type="text" name="website" tabindex="-1" autocomplete="off" /></label>' +
      '<label class="feedback-field">Type<select id="fbKind" name="kind">' +
      '<option value="feedback">General feedback</option>' +
      '<option value="bug">Bug / something broke</option>' +
      '<option value="other">Other</option>' +
      "</select></label>" +
      '<label class="feedback-field">Message<textarea id="fbMsg" name="message" required rows="5" maxlength="4000" placeholder="What happened? What did you expect?"></textarea></label>' +
      '<label class="feedback-field">Contact (optional)<input id="fbContact" type="text" name="contact" maxlength="120" placeholder="Email or Discord — only if you want a reply" autocomplete="email" /></label>' +
      '<p id="feedbackErr" class="feedback-err" hidden></p>' +
      '<p id="feedbackOk" class="feedback-ok" hidden>Thanks — received.</p>' +
      '<div class="modal-actions feedback-actions">' +
      '<button type="button" class="secondary" data-feedback-dismiss>Cancel</button>' +
      '<button type="submit" class="primary" id="fbSubmit">Send</button>' +
      "</div></form></div></div>";
    document.body.appendChild(root);
    return root;
  }

  function openModal() {
    const root = ensureModal();
    const modal = document.getElementById("feedbackModal");
    const err = document.getElementById("feedbackErr");
    const ok = document.getElementById("feedbackOk");
    const form = document.getElementById("feedbackForm");
    if (!modal || !form) return;
    err.hidden = true;
    ok.hidden = true;
    form.reset();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    const ta = document.getElementById("fbMsg");
    if (ta) setTimeout(() => ta.focus(), 50);
  }

  function closeModal() {
    const modal = document.getElementById("feedbackModal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (t.matches("[data-feedback-dismiss]")) closeModal();
    const opener = t.closest("a[href=\"#feedback\"], [data-feedback-open]");
    if (opener) {
      ev.preventDefault();
      openModal();
    }
  });

  document.addEventListener("submit", async (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || form.id !== "feedbackForm") return;
    ev.preventDefault();
    const err = document.getElementById("feedbackErr");
    const ok = document.getElementById("feedbackOk");
    const btn = document.getElementById("fbSubmit");
    if (err) err.hidden = true;
    if (ok) ok.hidden = true;
    const hp = form.querySelector('input[name="website"]');
    const kind = (document.getElementById("fbKind") && document.getElementById("fbKind").value) || "feedback";
    const message = (document.getElementById("fbMsg") && document.getElementById("fbMsg").value) || "";
    const contact = (document.getElementById("fbContact") && document.getElementById("fbContact").value) || "";
    const page = location.pathname + location.search;
    if (hp && hp.value && hp.value.trim()) return;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sending…";
    }
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          kind,
          message: message.trim(),
          contact: contact.trim(),
          page,
          website: hp ? hp.value : "",
        }),
      });
      let payload = {};
      try {
        payload = await r.json();
      } catch (_) {}
      if (!r.ok) {
        if (err) {
          err.textContent = payload.error || (r.status === 429 ? "Too many tries — wait a bit." : "Could not send.");
          err.hidden = false;
        }
        return;
      }
      if (ok) ok.hidden = false;
      form.reset();
      setTimeout(closeModal, 1400);
    } catch (_) {
      if (err) {
        err.textContent = "Network error — check your connection.";
        err.hidden = false;
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Send";
      }
    }
  });
})();
