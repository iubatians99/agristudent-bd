// ============================================
// AGRI CORE — mark-entry.js
//
// Runs only on index.html. Marks this browser session as having
// entered through the front door, which js/auth-guard.js checks on
// every other page before allowing it to render.
// ============================================
(function () {
  try {
    sessionStorage.setItem("agristudentbd_entered", "true");
  } catch (err) {
    // sessionStorage unavailable — sub-pages will fail open in this case
    // (see auth-guard.js), so nothing further to do here.
    console.warn("Agri Core: session storage unavailable, entry not recorded.", err);
  }

  // If a sub-page (e.g. a shared teacher-recommendation.html link)
  // redirected here because entry hadn't been recorded yet, forward the
  // visitor on to it now. Only allow a same-site relative "name.html"
  // path (optionally with a query/hash) — never an external URL.
  try {
    const params = new URLSearchParams(location.search);
    const dest = params.get("return");
    if (dest && /^[a-zA-Z0-9_-]+\.html(?:[?#].*)?$/.test(dest)) {
      window.location.replace(dest);
    }
  } catch (err) {
    // If anything looks off, just stay on index.html.
  }
})();
