// ============================================
// AGRI CORE — SERVER-SIDE REGISTRATION OTP
//
// WHY THIS EXISTS:
// The previous flow (js/otp.js) generated the 6-digit code in the
// browser and stored it in sessionStorage, then checked it in the
// browser. Anyone with DevTools open could read the real code straight
// out of storage and skip ever receiving the email — which meant the
// "prove you own this inbox" step didn't actually prove anything, and
// the email-send itself could be triggered directly (arbitrary
// recipient) by calling EmailJS from the console, since the EmailJS
// public key ships in client code by necessity on a static site.
//
// This moves both the "generate + check the code" and "actually send
// the email" steps here, where the attacker can't read the code or
// call EmailJS with our private key. The client can now only ever ask
// "send a code to this address" or "does this code match", both
// rate-limited server-side, and the actual code value never reaches
// the browser except inside the email itself.
//
// firestore.rules then requires proof of a verifyRegistrationOtp
// success (an otpVerifications/{email} doc, written ONLY by this file
// via the Admin SDK, which bypasses Firestore rules entirely — clients
// cannot write or fake this doc, see the "otpVerifications" match
// block in firestore.rules) before a registrations/studentIdLocks
// document can be created for that email.
// ============================================
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import crypto from "node:crypto";

initializeApp();
const db = getFirestore();

// Set these once with:
//   firebase functions:secrets:set EMAILJS_PRIVATE_KEY
//   firebase functions:secrets:set EMAILJS_PUBLIC_KEY
//   firebase functions:secrets:set EMAILJS_SERVICE_ID
//   firebase functions:secrets:set EMAILJS_TEMPLATE_ID
// (values: EmailJS Account → General → Private Key / Public Key, and the
// Service ID / Template ID you already use in js/email-config.js.)
const EMAILJS_PRIVATE_KEY = defineSecret("EMAILJS_PRIVATE_KEY");
const EMAILJS_PUBLIC_KEY = defineSecret("EMAILJS_PUBLIC_KEY");
const EMAILJS_SERVICE_ID = defineSecret("EMAILJS_SERVICE_ID");
const EMAILJS_TEMPLATE_ID = defineSecret("EMAILJS_TEMPLATE_ID");

const OTP_TTL_MS = 10 * 60 * 1000;        // code valid for 10 minutes
const VERIFIED_TTL_MS = 15 * 60 * 1000;   // registration must happen within 15 min of verifying
const RESEND_COOLDOWN_MS = 45 * 1000;     // 45s between sends, same email
const MAX_SENDS_PER_EMAIL = 5;            // per rolling 30-minute window
const SEND_WINDOW_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;                   // wrong-code guesses per code
const MAX_SENDS_PER_IP_PER_HOUR = 15;     // stops rotating through many emails from one script

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function docSafeId(raw) {
  // Firestore doc IDs can't contain "/"; strip anything unusual defensively.
  return String(raw || "unknown").replace(/[^a-zA-Z0-9.:_@-]/g, "_").slice(0, 300) || "unknown";
}

// Shared per-IP cap used by every callable below that a client can hit
// before it has any Firebase Auth session (requestRegistrationOtp,
// checkLoginMethod) — one place instead of a copy of the same
// transaction in each function.
async function checkIpRateLimit(ip, logCollection, maxPerHour) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection(logCollection).doc(ip);
    const snap = await tx.get(ref);
    const now = Date.now();
    const sends = (snap.exists ? snap.data().sends : []) || [];
    const recent = sends.filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= maxPerHour) {
      throw new HttpsError("resource-exhausted", "Too many attempts from this network. Please try again later.");
    }
    recent.push(now);
    tx.set(ref, { sends: recent, updatedAt: FieldValue.serverTimestamp() });
  });
}

function hashCode(code, email) {
  return crypto.createHash("sha256").update(`${email}::${code}`).digest("hex");
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// ============================================
// requestRegistrationOtp({ email, toName })
// Rate-limits, generates a code, stores only its hash, and sends it via
// EmailJS's server-side REST API (private key never leaves this function).
// ============================================
export const requestRegistrationOtp = onCall(
  {
    secrets: [EMAILJS_PRIVATE_KEY, EMAILJS_PUBLIC_KEY, EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID],
    enforceAppCheck: true,
    region: "us-central1"
  },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const toName = String(request.data?.toName || "").slice(0, 100).replace(/[<>]/g, "");
    if (!email || !email.includes("@") || email.length > 320) {
      throw new HttpsError("invalid-argument", "A valid email address is required.");
    }

    const ip = docSafeId(request.rawRequest?.ip);
    const now = Date.now();

    // Per-IP cap, independent of email, so rotating through many made-up
    // addresses from one script still hits a wall.
    await checkIpRateLimit(ip, "otpSendLog", MAX_SENDS_PER_IP_PER_HOUR);

    const ref = db.collection("otpChallenges").doc(email);
    const { code } = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const existing = snap.exists ? snap.data() : null;

      if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
        const waitSec = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        throw new HttpsError("resource-exhausted", `Please wait ${waitSec}s before requesting another code.`);
      }

      const windowStillOpen = existing && now - existing.firstSentAt < SEND_WINDOW_MS;
      const sendCount = windowStillOpen ? (existing.sendCount || 0) + 1 : 1;
      if (windowStillOpen && sendCount > MAX_SENDS_PER_EMAIL) {
        throw new HttpsError("resource-exhausted", "Too many codes requested for this email. Please wait a while and try again.");
      }

      const freshCode = generateCode();
      tx.set(ref, {
        email,
        codeHash: hashCode(freshCode, email),
        createdAt: now,
        firstSentAt: windowStillOpen ? existing.firstSentAt : now,
        lastSentAt: now,
        sendCount,
        attempts: 0
      });
      return { code: freshCode };
    });

    const emailResp = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID.value(),
        template_id: EMAILJS_TEMPLATE_ID.value(),
        user_id: EMAILJS_PUBLIC_KEY.value(),
        accessToken: EMAILJS_PRIVATE_KEY.value(),
        template_params: {
          to_email: email,
          to_name: toName || "Student",
          heading_tagline: "Verify your email",
          intro_text: `Hi ${toName || "there"},`,
          content_label: "Your Verification Code",
          content_value: code,
          footer_note: "Didn't request this? You can safely ignore this email.",
          subject_line: "Your Agri Core verification code"
        }
      })
    });

    if (!emailResp.ok) {
      const text = await emailResp.text().catch(() => "");
      console.error("[requestRegistrationOtp] EmailJS send failed:", emailResp.status, text);
      throw new HttpsError("internal", "Couldn't send the verification email right now. Please try again.");
    }

    return { sent: true };
  }
);

// ============================================
// verifyRegistrationOtp({ email, code })
// On success, writes otpVerifications/{email} — the ONLY thing
// firestore.rules trusts as proof of email ownership for registration.
// ============================================
export const verifyRegistrationOtp = onCall(
  { enforceAppCheck: true, region: "us-central1" },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const code = String(request.data?.code || "").trim();
    if (!email || !/^\d{6}$/.test(code)) {
      throw new HttpsError("invalid-argument", "Enter the 6-digit code.");
    }

    const ref = db.collection("otpChallenges").doc(email);
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: "none" };
      const data = snap.data();
      const now = Date.now();

      if (now - data.createdAt > OTP_TTL_MS) return { ok: false, reason: "expired" };
      if ((data.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: "locked" };

      if (hashCode(code, email) !== data.codeHash) {
        const attempts = (data.attempts || 0) + 1;
        tx.update(ref, { attempts });
        return { ok: false, reason: "mismatch", attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) };
      }

      tx.delete(ref);
      return { ok: true };
    });

    if (!outcome.ok) return outcome;

    await db.collection("otpVerifications").doc(email).set({
      email,
      verifiedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + VERIFIED_TTL_MS)
    });

    return { ok: true };
  }
);

// ============================================
// checkLoginMethod({ email })
// Runs BEFORE any Firebase Auth session exists, so it's the one place
// allowed to bypass the "must be signed in to read a registration" rule
// in firestore.rules — through the Admin SDK, never by loosening the
// rules themselves. It tells js/login.js which of three screens to show
// for a typed-in email:
//   { exists: false }                     -> no account; offer to register
//   { exists: true,  passwordSet: false } -> registered, but no password
//                                            set yet (fresh signup, or an
//                                            account reset by the
//                                            tools/reset-all-accounts.mjs
//                                            update) -> skip straight to
//                                            "email me a sign-in link"
//   { exists: true,  passwordSet: true }  -> normal password prompt
//
// This intentionally reveals whether an email is registered — a
// deliberate trade-off for the clearer messaging the product wants, not
// an oversight. Kept narrow (no name, no student ID, nothing else) and
// rate-limited per IP so it can't be turned into a bulk address-list
// scraper.
// ============================================
const MAX_LOGIN_CHECKS_PER_IP_PER_HOUR = 40;

export const checkLoginMethod = onCall(
  { enforceAppCheck: true, region: "us-central1" },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    if (!email || !email.includes("@") || email.length > 320) {
      throw new HttpsError("invalid-argument", "A valid email address is required.");
    }

    const ip = docSafeId(request.rawRequest?.ip);
    await checkIpRateLimit(ip, "loginCheckLog", MAX_LOGIN_CHECKS_PER_IP_PER_HOUR);

    let userRecord;
    try {
      userRecord = await getAuth().getUserByEmail(email);
    } catch (err) {
      if (err?.code === "auth/user-not-found") return { exists: false, passwordSet: false };
      throw new HttpsError("internal", "Couldn't check that email right now. Please try again.");
    }

    const regSnap = await db.collection("registrations")
      .where("authUid", "==", userRecord.uid)
      .limit(1)
      .get();

    if (regSnap.empty) {
      // A Firebase Auth user exists but has no registration doc yet —
      // treat like "not registered" so the UI sends them to register.
      return { exists: false, passwordSet: false };
    }

    const reg = regSnap.docs[0].data();
    return { exists: true, passwordSet: reg.passwordSet === true };
  }
);
