# Firebase Authentication migration

This hardened build replaces the custom browser-only password/session model with Firebase Authentication.
Existing Firestore registration data is **not deleted or rewritten except for adding `authUid` / migration metadata**.

## Before deploying the hardened rules

1. Back up the Firestore database.
2. Create a Firebase service-account key in the Firebase/Google Cloud console.
3. In a trusted migration environment, install `firebase-admin`.
4. Run:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/service-account.json node tools/migrate-existing-users.mjs
```

5. Have existing users use **Forgot password** on `login.html` to choose a new Firebase Authentication password.
6. Deploy `firestore.rules` and the hosting files.

The migration script does not recover or reuse the old SHA-256 password hashes. This is intentional: the old scheme is not a safe password-storage mechanism.

## New registration flow

New users:

1. Complete the existing email OTP step.
2. Create a Firebase Authentication password.
3. Receive a Firebase email-verification link.
4. After verification, log in normally.

The Firestore registration remains `pending` until Firebase confirms the email, then the login flow promotes it to `verified`.

## Important

Do **not** commit the Firebase service-account JSON to this repository.
Do **not** expose `GOOGLE_APPLICATION_CREDENTIALS` or any service-account private key in browser code.
