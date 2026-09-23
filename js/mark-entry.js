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
})();
