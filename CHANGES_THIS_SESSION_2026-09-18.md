# Bug fixes — this session (2026-09-18)

## 1. Coffee Support: "Could not approve request: Registered student not found."
Root cause: the admin approval flow (and 3 related lookups) queried
Firestore for a field called `emailNormalized` on `registrations` docs,
but registration records are actually saved under the field `email`
(see `js/registration.js`). That field never existed, so the lookup
always came back empty.
Fixed in: `js/admin.js` (2 sites), `js/resources.js` (2 sites).

## 2. Classroom Codes admin buttons doing nothing
The "Confirm & Unlock" / "Mark Reviewed" button's click handler
referenced `isMaterialsRequest`, a variable that only existed in a
different function's closure — clicking it threw a silent
`ReferenceError` (visible only in the browser console). Fixed by
passing the flag through a `data-materials` attribute. Also added
visible `alert()` error messages to the lock / unlock / mark-contacted
/ delete buttons in this panel so future failures aren't silent.
Fixed in: `js/admin.js`.

## 3. Mobile: profile picture not shown, only the name
A CSS rule `@media (max-width:700px){ .navbar-auth-slot span{
display:none; } }` was hiding every `<span>` inside the navbar auth
slot — including `.navbar-auth-avatar-wrap` (a `<span>` wrapping the
avatar `<img>` and the unread-message dot), even though a more
specific rule elsewhere correctly re-showed the name text. Narrowed
the rule to only what it was meant for.
Fixed in: `css/style.css`.

## 4. Credits shown on profile but not spendable
`js/profile.js` computes upload credits by tagging resource docs with
`kind: "resource"` before counting them — that's correct and is what
the profile page displays. But the *actual* spend-balance check used
when unlocking a file (`hnGetRemainingCredits()` in `js/resources.js`)
filtered the same kind of docs on `i.kind === "resource"` against a
different in-memory list (`window.__hnAccessItems`) where resource
docs are never tagged with `kind` at all. That filter always matched
zero items, so every upload-earned credit silently vanished from the
spendable balance, even though the profile page showed the correct
(larger) total. Fixed to detect resource docs by their `resourceType`
field instead.
Fixed in: `js/resources.js`.

## 5. Buy Me a Coffee: nothing visible happens after submitting
There was no success panel for this flow (unlike the Classroom /
Ad-watch flows, which each show a clear confirmation screen). The old
code just set a small, easy-to-miss status line and left the payment
form on screen. Added a proper confirmation panel: "Submitted
successfully — wait for admin review," with a button that goes to the
Agricultural Blog. Also resets the form/success state correctly if the
gate is reopened for another file.
Fixed in: `slides-notes.html`, `js/resources.js`.

## 6. Profile Inbox showing every message at once
Added a "Show all messages" toggle; the inbox now shows only the 3
most recent messages by default (already newest-first).
Fixed in: `profile.html`, `js/profile.js`.

## 7. Security: unbounded `durationMs` on fileUnlocks
Students never hold a Firebase Auth session in this app (by design —
see the trust-model notes throughout `firestore.rules`), so writes are
guarded by field validation rather than an auth check. The
`fileUnlocks` create rule validated several fields but never bounded
`durationMs`, even though `js/access.js` trusts whatever value is
there — so a forged doc written directly against the Firestore SDK
(bypassing the UI entirely) could grant an arbitrarily long access
window without ever spending a credit. Capped it at 48 hours (every
legitimate grant in the app uses 6h or 36h), matching the pattern
already used elsewhere in the same rules file.
Fixed in: `firestore.rules`.

---

## Not yet done (flagged, not started)
- **`storage.rules` looks like dead code.** It's written assuming
  students sign in with Firebase Auth (`request.auth.uid`,
  `hasActiveResourceAccess()`), but nothing in the app ever calls
  `signInWithEmailAndPassword` for students — only the admin panel
  authenticates. Every real file upload (Student ID photos, Hand
  Notes/Class Slides/Images, blog images) goes through Cloudinary via
  `uploadToCloudinary`, not Firebase Storage. This file likely isn't
  gating anything real today and should be confirmed and either
  removed or rewritten to match how the app actually stores files.
- **"Logout not shown on mobile."** I couldn't find a CSS/JS cause
  distinct from the avatar bug (fix #3) — the logout `<button>` isn't
  targeted by any `display:none` rule I could find. It may already be
  fixed as a side effect of #3; needs your confirmation on a real
  phone.
- **Full security pass** on the rest of `firestore.rules`, plus a
  check for any remaining XSS/`innerHTML` risk in `js/blog.js` and
  `js/admin.js`, is still outstanding.
