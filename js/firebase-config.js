// ============================================
// Firebase setup — shared across all pages
// ============================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyD6Dl94tK5tB8VJq_z-K0_xbt--fkd9UH8",
  authDomain: "agristudent-bd.firebaseapp.com",
  projectId: "agristudent-bd",
  storageBucket: "agristudent-bd.firebasestorage.app",
  messagingSenderId: "946325749814",
  appId: "1:946325749814:web:a56fbbf3765dbfbb419897",
  measurementId: "G-RLN99KFDMB"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const functions = getFunctions(app);

// ============================================
// App Check — proves requests to Firestore/Functions are coming from this
// real site running in a real browser, not a script hitting the APIs
// directly. This is what actually stops someone from calling
// requestRegistrationOtp/verifyRegistrationOtp (or Firestore) straight
// from curl/devtools to mass-create accounts or blast OTP emails.
//
// SETUP REQUIRED (one-time, in Firebase Console):
//   1. Console → App Check → register this web app → reCAPTCHA v3 →
//      copy the site key it gives you.
//   2. Paste that site key below, replacing the placeholder.
//   3. Console → App Check → APIs tab → set both "Cloud Firestore" and
//      "Cloud Functions" to Enforced (after confirming real traffic is
//      passing — App Check has an unenforced "monitor" mode first).
// Until step 1-2 are done, initializeAppCheck below will fail quietly and
// requests fall back to being unprotected by App Check (Firestore/Functions
// rules are still the real security boundary either way).
// ============================================
const RECAPTCHA_V3_SITE_KEY = "PASTE_YOUR_RECAPTCHA_V3_SITE_KEY_HERE";

if (RECAPTCHA_V3_SITE_KEY && !RECAPTCHA_V3_SITE_KEY.startsWith("PASTE_")) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  } catch (err) {
    console.warn("[firebase-config] App Check init failed:", err);
  }
} else {
  console.warn("[firebase-config] App Check site key not set — see comment above RECAPTCHA_V3_SITE_KEY in js/firebase-config.js.");
}

// ============================================
// Cloudinary setup
// ============================================
export const CLOUDINARY_CLOUD_NAME = "db6r0up6r";
export const CLOUDINARY_UPLOAD_PRESET = "Agriculture";
export const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`;
