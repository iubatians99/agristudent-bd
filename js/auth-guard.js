// ============================================
// AGRI CORE — auth-guard.js
//
// ⚠️ UX-ONLY: This is NOT a security mechanism.
// It ensures visitors land on index.html first (UX flow),
// not to restrict access to data. All real access control
// is enforced by Firestore Security Rules on the server.
// ============================================
(function () {
  const ENTRY_KEY = "agristudentbd_entered";
  try {
    if (sessionStorage.getItem(ENTRY_KEY) !== "true") {
      // Preserve where the visitor was actually headed (e.g. a shared
      // deep link) so index.html can forward them here once entry is
      // recorded. Only the current page's own filename + query/hash is
      // ever stored — never an arbitrary external URL.
      const dest = location.pathname.split("/").pop() + location.search + location.hash;
      window.location.replace("index.html?return=" + encodeURIComponent(dest));
    }
  } catch (err) {
    // sessionStorage unavailable (privacy mode) — fail open
    console.warn("Agri Core: session storage unavailable, skipping entry check.", err);
  }
})();
