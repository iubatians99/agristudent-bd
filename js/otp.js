// ============================================
// REGISTRATION EMAIL OTP — client wrapper around the server-side Cloud
// Functions (functions/index.js: requestRegistrationOtp,
// verifyRegistrationOtp).
//
// SECURITY FIX: this used to generate the 6-digit code in the browser,
// store it in sessionStorage, and check it in the browser too — anyone
// with DevTools open could read the real code and skip ever receiving
// the email, and the EmailJS send could be triggered directly (to any
// address) from the console. Both the generation/check and the actual
// email send now happen in functions/index.js, where the code and the
// EmailJS private key never reach the browser. This file just calls
// those two functions and reports back the same { ok, reason, ... }
// shape the rest of the app already expects, so registration.js needed
// no changes to its logic beyond awaiting these calls.
// ============================================
import { functions } from "./firebase-config.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const requestOtpFn = httpsCallable(functions, "requestRegistrationOtp");
const verifyOtpFn = httpsCallable(functions, "verifyRegistrationOtp");

// Local-only bookkeeping so the UI can grey out "resend" between server
// round-trips — NOT the security boundary anymore (the Cloud Function
// enforces the real cooldown/attempt/send limits server-side no matter
// what this says).
let lastSentAt = 0;
const RESEND_COOLDOWN_MS = 45 * 1000;

function friendlyError(err) {
  const msg = err?.message || "";
  if (err?.code === "functions/resource-exhausted") return msg || "Too many attempts. Please wait a bit and try again.";
  if (err?.code === "functions/invalid-argument") return msg || "Please check the details you entered.";
  return "Something went wrong. Please try again.";
}

/**
 * Requests a fresh code be sent to `email`. Throws with a friendly
 * message on cooldown/rate-limit/send failure (matches the old
 * startOtp() contract that registration.js already expects to catch).
 */
export async function startOtp(email, toName) {
  const now = Date.now();
  if (now - lastSentAt < RESEND_COOLDOWN_MS) {
    const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - lastSentAt)) / 1000);
    throw new Error(`Please wait ${waitSec}s before requesting another code.`);
  }
  try {
    await requestOtpFn({ email, toName });
    lastSentAt = now;
  } catch (err) {
    console.error("[otp] requestRegistrationOtp failed:", err);
    throw new Error(friendlyError(err));
  }
  // No code is returned to the browser — it only ever exists in the
  // email and in the Cloud Function's hashed Firestore record.
  return {};
}

/** How many ms remain before a resend is allowed (0 if allowed now). */
export function resendCooldownRemaining() {
  const remaining = RESEND_COOLDOWN_MS - (Date.now() - lastSentAt);
  return remaining > 0 ? remaining : 0;
}

/**
 * Checks a student-entered code against the server-held one.
 * Returns { ok: true } or { ok: false, reason: "expired"|"mismatch"|"locked"|"none", attemptsLeft? }.
 */
export async function verifyOtp(email, inputCode) {
  try {
    const result = await verifyOtpFn({ email, code: inputCode });
    return result.data;
  } catch (err) {
    console.error("[otp] verifyRegistrationOtp failed:", err);
    return { ok: false, reason: "none", message: friendlyError(err) };
  }
}

/** Kept for callers that reset local UI state between attempts — the
 * server-side record is cleared automatically on success/expiry. */
export function clearOtp() {
  lastSentAt = 0;
}
