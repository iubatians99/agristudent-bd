# Deploying the OTP + App Check hardening

This covers two changes:

1. **Registration OTP moved server-side** (`functions/`) — closes the
   bug where the verification code was generated/checked in the
   browser and could be read straight out of `sessionStorage`, and
   where the EmailJS send could be triggered directly, to any address,
   from the browser console.
2. **Firebase App Check (reCAPTCHA v3)** wired into `js/firebase-config.js`
   and enforced on the two new Cloud Functions — stops scripts from
   calling your APIs directly at all, even with valid-looking data.

Also fixed along the way: `firestore.rules`'s `studentIdLocks` create
rule had a broken self-referential check (`request.resource.data.studentIdLockId`
— a field that write never actually contains), which likely made
**every single registration attempt fail** at the very first Firestore
write, before the student ever got a real error message. See the
comment left in `firestore.rules` above that block.

## 1. Prerequisite: Blaze (pay-as-you-go) plan

Cloud Functions that call an external API (EmailJS) require the Blaze
plan — the free Spark plan blocks outbound network requests to
non-Google hosts. Blaze still has a generous free tier for a
low-traffic student site; you only pay if you exceed it.

Firebase Console → your project → ⚙️ → Usage and billing → **Modify plan** → Blaze.

## 2. Install and configure the Cloud Functions

```bash
cd functions
npm install
```

Get your EmailJS **Private Key** (Account → General, next to the
Public Key you already use in `js/email-config.js`), then set all four
secrets (values only — do not commit them anywhere):

```bash
firebase functions:secrets:set EMAILJS_PRIVATE_KEY
firebase functions:secrets:set EMAILJS_PUBLIC_KEY
firebase functions:secrets:set EMAILJS_SERVICE_ID
firebase functions:secrets:set EMAILJS_TEMPLATE_ID
```

(`EMAILJS_PUBLIC_KEY` / `SERVICE_ID` / `TEMPLATE_ID` are the same
values already in `js/email-config.js` — just re-entered here so the
function can use them too.)

## 3. Set up App Check (reCAPTCHA v3)

1. Firebase Console → **App Check** → register your web app → provider
   **reCAPTCHA v3** → follow the prompt to create a reCAPTCHA v3 key
   (or reuse one from Google Cloud Console → reCAPTCHA Enterprise/v3).
2. Copy the **site key** it gives you.
3. Paste it into `js/firebase-config.js`, replacing
   `RECAPTCHA_V3_SITE_KEY`'s placeholder value.
4. Still in App Check, leave enforcement in **monitor/unenforced** mode
   for now — turn it on after step 5 confirms real traffic is passing.

## 4. Deploy

```bash
firebase deploy --only functions,firestore:rules,hosting
```

## 5. Verify before enforcing anything

1. Open `register.html` on the live site, register a **real** test
   account end to end (code should arrive by email; DevTools should no
   longer show the code anywhere).
2. In Firebase Console → App Check → **Apps**, confirm your web app is
   reporting verified requests (this takes a few minutes to show up).
3. In App Check → **APIs**, confirm `requestRegistrationOtp` and
   `verifyRegistrationOtp` show verified traffic.

## 6. Turn on enforcement

- **Cloud Functions**: App Check → APIs → set **Cloud Functions** to
  **Enforced**. This only affects the two new OTP functions (both
  already pass `enforceAppCheck: true`), so it's safe to enforce as
  soon as step 5 looks healthy — it only blocks non-browser callers.
- **Cloud Firestore**: hold off. Enforcing this protects *every*
  Firestore read/write on the site, but every other page (`index.html`,
  `profile.html`, `admin.html`, etc.) has its **own** `<meta
  Content-Security-Policy>` tag that doesn't yet allow
  `https://www.google.com` / `https://www.recaptcha.net` the way
  `login.html`/`register.html` now do. Enforcing Firestore before
  updating those pages' CSP would break the whole site (App Check's
  reCAPTCHA script would be blocked from loading, so no page could get
  a token). Update every page's CSP the same way first (see the diff
  in `login.html`/`register.html`), confirm App Check tokens are
  attaching site-wide, then enforce Firestore.

## What changed, file by file

- `functions/index.js`, `functions/package.json` — new. The two
  callable functions.
- `js/otp.js` — rewritten to call the functions instead of generating
  the code locally. Same exported function names/shapes, so no other
  file besides `js/registration.js` needed logic changes.
- `js/registration.js` — awaits the now-async `startOtp`/`verifyOtp`,
  no longer imports or calls `sendOtpEmail` directly (the function
  sends the email now).
- `js/firebase-config.js` — adds `functions` export and App Check
  initialization (inert until you paste in a real site key).
- `firestore.rules` — adds `otpVerifications` / `otpChallenges` /
  `otpSendLog` (all deny-all to clients; only the Admin SDK inside the
  Cloud Functions can write them), requires a live `otpVerifications`
  doc before `studentIdLocks` or `registrations` can be created, and
  fixes the broken self-check described above.
- `login.html`, `register.html`, `firebase.json` — CSP updated to allow
  `*.cloudfunctions.net` (for the callable functions) and
  `www.google.com` / `www.recaptcha.net` (for reCAPTCHA v3).
