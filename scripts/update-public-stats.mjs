// ============================================
// AGRI CORE — update-public-stats.mjs
//
// Computes the two homepage counters that need a full-collection scan
// the browser is NOT allowed to make (see firestore.rules):
//   - registeredUsers : count of verified, non-removed accounts
//   - pendingReviews  : count of items currently awaiting admin review
//                       (resources, terms, faculty submissions, faculty
//                        reviews, course suggestions, blog posts/edits)
//
// This runs with the Admin SDK, which bypasses Firestore security
// rules entirely — that's what lets it count private collections
// (registrations, facultyReviews) without ever exposing them to a
// client. Only the two resulting NUMBERS are written to the public,
// read-only /publicStats/counts document (see firestore.rules:
// "allow write: if false" — no client, admin or student, can write
// there; only this script, with a service-account credential, can).
//
// No student-identifying data — no name, email, ID, or individual
// document — ever leaves this script.
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//     node scripts/update-public-stats.mjs
//
// Run it once by hand to backfill the homepage immediately, then wire
// it to run on a schedule (e.g. the included GitHub Actions workflow,
// or a cron job / Cloud Scheduler hitting a small wrapper) so the
// counters stay fresh. It intentionally does NOT need Cloud Functions
// or a paid Firebase plan.
// ============================================
import admin from 'firebase-admin';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file outside the project.');
}
admin.initializeApp();
const db = admin.firestore();

async function countWhere(collectionName, field, value) {
  const snap = await db.collection(collectionName).where(field, '==', value).count().get();
  return snap.data().count;
}

async function main() {
  // Registered users: verified accounts that haven't been removed.
  // (A 'removed' account is soft-deleted, so it shouldn't count.)
  const verifiedSnap = await db.collection('registrations').where('status', '==', 'verified').count().get();
  // The Admin SDK's count() can't express "field absent OR false" in
  // one query, so we do a second, cheap count() for removed==true and
  // subtract it. This still never reads any document body.
  const removedSnap = await db.collection('registrations')
    .where('status', '==', 'verified').where('removed', '==', true).count().get();
  const registeredUsers = verifiedSnap.data().count - removedSnap.data().count;

  // Pending Reviews: everything currently sitting in an admin
  // moderation queue across the app.
  const pendingCounts = await Promise.all([
    countWhere('resources', 'status', 'pending'),
    countWhere('terms', 'status', 'pending'),
    countWhere('faculty', 'status', 'pending'),
    countWhere('facultyReviews', 'status', 'pending'),
    countWhere('courseSuggestions', 'status', 'pending'),
    countWhere('blogPosts', 'status', 'pending'),
    countWhere('blogPosts', 'status', 'pending_edit'),
  ]);
  const pendingReviews = pendingCounts.reduce((sum, n) => sum + n, 0);

  await db.collection('publicStats').doc('counts').set({
    registeredUsers,
    pendingReviews,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(`publicStats/counts updated: registeredUsers=${registeredUsers}, pendingReviews=${pendingReviews}`);
}

main().catch((err) => {
  console.error('[update-public-stats] failed:', err);
  process.exit(1);
});
