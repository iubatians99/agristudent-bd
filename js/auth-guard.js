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
      window.location.replace("index.html");
    }
  } catch (err) {
    // sessionStorage unavailable (privacy mode) — fail open
    console.warn("Agri Core: session storage unavailable, skipping entry check.", err);
  }
})();
