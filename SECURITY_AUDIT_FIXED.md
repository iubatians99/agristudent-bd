# Agri Core — Security Hardened Build

This ZIP preserves the existing UI, resource files, Firestore data model, and user-facing features as far as possible while moving identity-sensitive operations to Firebase Authentication.

## Fixed

- Removed public read/list access to registration records.
- Removed the ability for unauthenticated clients to change `passwordHash`.
- Replaced client-side password storage with Firebase Authentication for new/ migrated accounts.
- Added Firebase email verification before an account becomes `verified`.
- Added authenticated Student-ID uniqueness locks.
- Restricted classroom codes, ad unlocks, file unlocks, coffee requests, manual/folder access records, and admin inbox reads to the authenticated owner/admin.
- Restricted blog creation/edit/delete and engagement writes to authenticated users.
- Restricted blog likes to the authenticated email and stopped public email enumeration through `blogLikes`.
- Added authenticated ownership checks for faculty suggestions/reviews.
- Added a render-time HTML sanitizer defense for blog content in addition to the existing write-time sanitizer.
- Added a global Firebase Hosting CSP, HSTS, frame protection, referrer policy, and permissions policy.
- Kept Firebase Storage default-deny behavior.
- Kept the existing admin custom-claim boundary.

## Important migration requirement

Existing accounts created under the old custom password/session system do not have a Firebase Auth identity. Before deploying the hardened Firestore rules, run `tools/migrate-existing-users.mjs` from a trusted machine using a Firebase service-account key.

The migration creates Firebase Auth identities with temporary random passwords, links each existing registration using `authUid`, creates Student-ID uniqueness locks, and removes the obsolete `passwordHash` field. Users then use Firebase's password-reset flow to choose a new password.

**Never put the service-account JSON in this website or commit it to Git.**

## What was intentionally not changed

- Existing Firestore documents are not deleted.
- Existing resource URLs and content are not rewritten.
- Existing page layouts/styles and navigation are preserved.
- Public approved resources, approved terms, faculty directory, timeline, settings, and public blog content remain publicly readable where the application requires them to be.
- Firebase project configuration values already intended for browser use remain in `js/firebase-config.js`.

## Deployment order

1. Back up Firestore.
2. Run the existing-user migration.
3. Verify migrated users can reset their Firebase password and sign in.
4. Deploy the hardened `firestore.rules`.
5. Deploy hosting files.
6. Test registration, email verification, login, resource upload/unlock, blog posting, faculty review, inbox, admin operations, and logout.
