/**
 * ONE-TIME rollout script for password-based login.
 *
 * Replaces the old two-script setup (migrate-existing-users.mjs +
 * a passwordSet backfill) with a single pass that puts EVERY
 * registration into the same state: a real Firebase Auth account
 * exists, its old password (if any) no longer works, and
 * passwordSet is false so js/login.js + js/session.js walk the
 * student through choosing a fresh one via the emailed sign-in link.
 *
 * For each registrations/{id} doc (skipping removed accounts):
 *   - Has an authUid already?
 *       -> assign a brand-new random password (invalidates whatever
 *          they had before) and revoke their refresh tokens (signs
 *          out any device still logged in).
 *   - No authUid at all (only possible for accounts old enough to
 *     predate Firebase Auth entirely)?
 *       -> create the Firebase Auth account now, with a random
 *          password, and link it via authUid (same as the old
 *          migrate-existing-users.mjs did).
 *   Either way: passwordSet is set to false, and any leftover legacy
 *   passwordHash field is dropped.
 *
 * Nobody's data, registration record, or student ID is touched here —
 * only login credentials. Students sign back in with "Email me a
 * sign-in link" on the login page; js/session.js's popup then prompts
 * them to choose their new password immediately after.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/service-account.json node tools/reset-all-accounts.mjs
 *
 * Add --dry-run to see counts without writing anything.
 */
import crypto from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "node:fs";

const DRY_RUN = process.argv.includes("--dry-run");

const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credentialPath || !fs.existsSync(credentialPath)) {
  throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON file.");
}

const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

function randomPassword() {
  // Random, unguessable, never surfaced anywhere — the student always
  // gets in via the emailed sign-in link afterward, never this value.
  return crypto.randomBytes(32).toString("base64url") + "!9aA";
}

const snap = await db.collection("registrations").get();
let resetExisting = 0, createdNew = 0, skippedRemoved = 0, failed = 0;

for (const d of snap.docs) {
  const data = d.data();
  const email = String(data.email || "").trim().toLowerCase();
  if (!email) { failed++; console.warn(`Skipping ${d.id}: no email on record.`); continue; }
  if (data.removed === true) { skippedRemoved++; continue; }

  try {
    let uid = data.authUid;

    if (uid) {
      // Existing Firebase Auth account -> invalidate its password and
      // kill any live sessions.
      if (!DRY_RUN) {
        await auth.updateUser(uid, { password: randomPassword() });
        await auth.revokeRefreshTokens(uid);
      }
      resetExisting++;
    } else {
      // No Firebase Auth account at all yet (very old record) -> create
      // one now, same as the old migrate-existing-users.mjs did.
      let user;
      try {
        user = await auth.getUserByEmail(email);
      } catch (err) {
        if (err?.code !== "auth/user-not-found") throw err;
        if (!DRY_RUN) {
          user = await auth.createUser({
            email,
            emailVerified: data.status === "verified" || data.emailVerified === true,
            password: randomPassword(),
            displayName: String(data.fullName || "Agri Core Student").slice(0, 120),
            disabled: false
          });
        }
      }
      uid = user?.uid;
      createdNew++;

      if (!DRY_RUN && uid) {
        const studentId = String(data.studentIdNumber || "").trim().toUpperCase().replace(/\s+/g, " ");
        if (studentId) {
          const lockId = studentId.replace(/[^A-Za-z0-9_-]/g, "_");
          const lockRef = db.collection("studentIdLocks").doc(lockId);
          const lockSnap = await lockRef.get();
          if (!lockSnap.exists) {
            await lockRef.set({ studentIdNumber: studentId, email, authUid: uid, createdAt: FieldValue.serverTimestamp() });
          }
        }
      }
    }

    if (!DRY_RUN && uid) {
      await d.ref.update({
        authUid: uid,
        passwordSet: false,
        passwordHash: FieldValue.delete(),
        credentialsResetAt: FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    failed++;
    console.error(`Failed on ${email} (${d.id}):`, err?.message || err);
  }
}

console.log(
  `${DRY_RUN ? "[DRY RUN] " : ""}Done. reset_existing=${resetExisting}, created_new=${createdNew}, ` +
  `skipped_removed=${skippedRemoved}, failed=${failed}`
);
console.log("All affected students must now sign in via \"Email me a sign-in link\" on the login page, then set a new password when prompted.");
