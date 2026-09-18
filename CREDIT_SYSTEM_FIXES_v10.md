# Credit Wallet — Fixes & Redesign (v10)

## What was wrong

1. **The exact same "how many credits does this student have" math was
   copied by hand into three separate files** — `js/profile.js`
   (`renderCredits`), `js/admin.js` (`computeCreditsBalance`), and
   `js/resources.js` (`hnGetRemainingCredits`). A code comment left in
   `resources.js` documents that these had already drifted out of sync
   once before: one copy silently zeroed every upload-earned credit
   while the other two still showed the correct total. Any future edit
   to one copy and not the others reintroduces that bug.

   **Fix:** added `js/credits.js`, a single pure function
   (`computeCreditWallet`) that is now the only place the formula is
   written. `profile.js`, `admin.js`, and `resources.js` all call it
   instead of re-deriving the numbers themselves.

2. **The profile page showed the same numbers twice.** The top metrics
   row had "Total Credit Earned" and "Remaining Credits" tiles, and a
   second "Your Credits" panel further down repeated Earned/Available
   again (plus Used). Two displays of the same figures, with no
   breakdown of *why* the balance is what it is — which is exactly what
   made a correct-but-surprising number (e.g. earned 109, used 9, but 0
   available because of an admin credit-penalty) look like a bug rather
   than an explainable state.

   **Fix:** the top row now shows one clear set (Contributions / Earned
   / Available), and the lower panel was rebuilt as a single premium
   **Credit Wallet** card with a progress ring and a full line-item
   breakdown: Welcome bonus, File uploads, Classroom codes, Coffee
   support, and Files unlocked (spent) — so every credit is traceable to
   where it came from or went.

## How earning/spending works now (confirmed, unchanged rules — just centralized)

- **Registration** — 5 free credits for every account (floor, never reduced).
- **⬆️ Upload Your Resource** — +1 credit per file uploaded (Hand Notes /
  Class Slides / Images), counted the moment it's submitted — it does not
  wait for admin approval.
- **🏫 Send Us Classroom Code** — +10 credits once an admin marks the code
  **approved**. Locked/pending/rejected codes earn nothing.
- **☕ Buy Admin a Coffee** — the admin decides the credit amount when
  approving a coffee-support request (prompted in the admin panel,
  0–10,000 range); stored per grant.
- **Unlocking a file** costs 1 credit, deducted the instant it's spent.
  Files a student uploads themselves are always free/permanent for them
  (never charged).
- **`creditDebt`** — an admin-only penalty applied when lifting an
  account restriction; it's a stored offset, not a change to any earned
  record, and is now applied in exactly one place inside
  `computeCreditWallet`.

## Files touched

- `js/credits.js` — **new**, canonical formula + breakdown builder.
- `js/profile.js` — now imports and calls `computeCreditWallet`; added
  `renderCreditWallet()` to drive the new single wallet card.
- `js/admin.js` — `computeCreditsBalance` now delegates to
  `computeCreditWallet` instead of re-implementing the math.
- `js/resources.js` — `hnGetRemainingCredits` (used by the per-file
  "unlock with a credit" button) now classifies its already-cached items
  and calls `computeCreditWallet` instead of re-implementing the math.
- `profile.html` — redesigned Credit Wallet card (premium dark/gold
  gradient, progress ring, breakdown list) replacing the old duplicate
  metrics + plain wallet panel.
