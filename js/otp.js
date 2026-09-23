// ============================================
// REGISTRATION EMAIL OTP — generate / store / verify
//
// Same trust model as the rest of this site (see js/session.js): there is
// no backend server, so the code is generated and checked in the browser
// and held in sessionStorage for the duration of the registration attempt
// only. This proves the student can read mail sent to the address they
// typed — it is not meant to withstand a determined attacker with dev
// tools open, only to stop typos and someone registering with an email
// they don't own.
// ============================================

const OTP_KEY = "agri_register_otp_v1";
const OTP_TTL_MS = 10 * 60 * 1000;      // code valid for 10 minutes
const RESEND_COOLDOWN_MS = 45 * 1000;   // 45s between sends
const MAX_ATTEMPTS = 5;                 // wrong-code guesses allowed per code
const MAX_SENDS = 5;                    // resend cap per registration attempt

function readState() {
  try {
    const raw = sessionStorage.getItem(OTP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeState(state) {
  try {
    sessionStorage.setItem(OTP_KEY, JSON.stringify(state));
  } catch (err) {
    // sessionStorage unavailable — OTP simply won't persist across reloads
  }
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

/**
 * Starts (or restarts) an OTP challenge for the given email.
 * Returns { code } on success, or throws with a friendly message if the
 * student is sending too frequently / too many times.
 */
export function startOtp(email) {
  const now = Date.now();
  const existing = readState();
  const sameEmail = existing && existing.email === email;

  // A stale challenge (created 30+ min ago) shouldn't count against the
  // resend cap forever — treat it as a brand new attempt instead of
  // permanently locking the student out after 5 sends.
  const isStale = sameEmail && (now - existing.firstSentAt > 30 * 60 * 1000);

  if (sameEmail && !isStale) {
    if (now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
      throw new Error(`Please wait ${waitSec}s before requesting another code.`);
    }
    if (existing.sendCount >= MAX_SENDS) {
      throw new Error("Too many codes requested. Please wait a bit and try again.");
    }
  }

  const code = generateCode();
  const state = {
    email,
    code,
    createdAt: now,
    firstSentAt: sameEmail && !isStale ? existing.firstSentAt : now,
    lastSentAt: now,
    sendCount: sameEmail && !isStale ? existing.sendCount + 1 : 1,
    attempts: 0
  };
  writeState(state);
  return { code };
}

/** How many ms remain before a resend is allowed (0 if allowed now). */
export function resendCooldownRemaining(email) {
  const state = readState();
  if (!state || state.email !== email) return 0;
  const remaining = RESEND_COOLDOWN_MS - (Date.now() - state.lastSentAt);
  return remaining > 0 ? remaining : 0;
}

/**
 * Checks a student-entered code against the stored one.
 * Returns { ok: true } or { ok: false, reason: "expired"|"mismatch"|"locked"|"none" }.
 */
export function verifyOtp(email, inputCode) {
  const state = readState();
  if (!state || state.email !== email) return { ok: false, reason: "none" };

  if (Date.now() - state.createdAt > OTP_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  if (state.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "locked" };
  }

  const normalized = String(inputCode || "").trim();
  if (normalized === state.code) {
    return { ok: true };
  }

  state.attempts += 1;
  writeState(state);
  return { ok: false, reason: "mismatch", attemptsLeft: MAX_ATTEMPTS - state.attempts };
}

/** Clears the OTP challenge (call once registration succeeds, or if the student edits the email). */
export function clearOtp() {
  try { sessionStorage.removeItem(OTP_KEY); } catch (err) { /* non-fatal */ }
}
