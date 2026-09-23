/**
 * One-time migration for existing Agri Core registration records.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/service-account.json node tools/migrate-existing-users.mjs
 *
 * The script NEVER reads or writes the legacy passwordHash as a usable
 * credential. It creates a Firebase Auth user with a random temporary
 * password, marks the email verified because the existing registration is
 * already marked verified, links authUid to the existing registration, and
 * optionally prints a reset-link command for your admin workflow.
 *
 * Install in the migration environment only:
 *   npm i firebase-admin
 */
import crypto from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import fs from "node:fs";

const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!credentialPath || !fs.existsSync(credentialPath)) {
  throw new Error("Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account JSON file.");
}

const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

const snap = await db.collection("registrations").get();
let migrated = 0;
let skipped = 0;

for (const d of snap.docs) {
  const data = d.data();
  const email = String(data.email || "").trim().toLowerCase();
  if (!email || data.removed === true) { skipped++; continue; }
  if (data.authUid) { skipped++; continue; }

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
    user = await auth.createUser({
      email,
      emailVerified: data.status === "verified" || data.emailVerified === true,
      password: crypto.randomBytes(32).toString("base64url") + "!9aA",
      displayName: String(data.fullName || "Agri Core Student").slice(0, 120),
      disabled: data.removed === true
    });
  }

  const studentId = String(data.studentIdNumber || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (studentId) {
    const lockId = studentId.replace(/[^A-Za-z0-9_-]/g, "_");
    const lockRef = db.collection("studentIdLocks").doc(lockId);
    const lockSnap = await lockRef.get();
    if (!lockSnap.exists) {
      await lockRef.set({ studentIdNumber: studentId, email, authUid: user.uid, createdAt: FieldValue.serverTimestamp() });
    }
  }

  await d.ref.update({
    authUid: user.uid,
    emailVerified: user.emailVerified === true,
    migratedToFirebaseAuthAt: FieldValue.serverTimestamp(),
    passwordHash: FieldValue.delete()
  });
  migrated++;
  console.log(`Migrated ${email} -> ${user.uid}`);
}

console.log(`Migration complete. migrated=${migrated}, skipped=${skipped}`);
console.log("Next step: have migrated users use Firebase password reset to choose their new password.");
