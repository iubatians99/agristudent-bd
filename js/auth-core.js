// ============================================
// AUTH CORE — shared helpers for the login/registration system.
//
// Real passwords live only in Firebase Authentication (via
// createUserWithEmailAndPassword / updatePassword) — never in
// Firestore, never hashed client-side. This file used to also contain
// a client-side SHA-256 password hash (see the old js/password.js) but
// that hash was never actually checked against anything: sign-in has
// always gone through signInWithEmailAndPassword, which Firebase itself
// verifies server-side. Keeping a second, unused, weaker hash sitting
// in Firestore for every account was dead weight and a needless target
// — it has been removed. This file keeps only what's still needed: the
// client-side minimum-length check used before calling Firebase.
// ============================================

/** Kept intentionally simple — this is a student academic-resource
 * site, not a banking app. Just enough to stop a blank/one-character
 * password before it reaches Firebase (Firebase itself also enforces
 * a 6-character minimum server-side). */
export function isPasswordValid(password) {
  return typeof password === "string" && password.length >= 6;
}
