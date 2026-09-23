// ============================================
// AGRI CORE — share-page.js
//
// Powers the "Share This Page" button on teacher-recommendation.html.
// Uses the native Web Share API (mobile browsers, and many desktop
// browsers too) when available, and falls back to copying the link
// to the clipboard — with a final fallback to a manual copy prompt
// for very old browsers.
//
// This page is deliberately not gated by js/auth-guard.js, so the
// shared link opens directly for anyone, without first bouncing
// through index.html.
// ============================================
(function () {
  const btn = document.getElementById("share-page-btn");
  if (!btn) return;

  const defaultLabel = btn.textContent;

  function getShareUrl() {
    return window.location.origin + window.location.pathname;
  }

  function flashLabel(text, ms) {
    btn.textContent = text;
    btn.classList.add("is-copied");
    setTimeout(() => {
      btn.textContent = defaultLabel;
      btn.classList.remove("is-copied");
    }, ms || 2200);
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older/non-secure contexts.
    const tmp = document.createElement("textarea");
    tmp.value = text;
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    document.body.appendChild(tmp);
    tmp.focus();
    tmp.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(tmp);
    return ok;
  }

  btn.addEventListener("click", async () => {
    const shareUrl = getShareUrl();
    const shareData = {
      title: "Teacher Recommendation — Agri Core",
      text: "Find IUBAT Agriculture faculty by course or name and see what students recommend — Agri Core.",
      url: shareUrl
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // User cancelled the share sheet — not an error worth surfacing.
        if (err && err.name !== "AbortError") {
          console.warn("[Share] navigator.share failed, falling back to copy.", err);
          try {
            const copied = await copyToClipboard(shareUrl);
            flashLabel(copied ? "✅ Link Copied!" : "🔗 " + shareUrl);
          } catch (copyErr) {
            window.prompt("Copy this link to share:", shareUrl);
          }
        }
      }
      return;
    }

    try {
      const copied = await copyToClipboard(shareUrl);
      flashLabel(copied ? "✅ Link Copied!" : "🔗 " + shareUrl, copied ? 2200 : 4000);
      if (!copied) window.prompt("Copy this link to share:", shareUrl);
    } catch (err) {
      window.prompt("Copy this link to share:", shareUrl);
    }
  });
})();
