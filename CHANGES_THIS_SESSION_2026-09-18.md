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

## 8. `storage.rules` was dead code — rewritten to deny-all
Confirmed by code search: `js/firebase-config.js` never calls
`getStorage()`, and nothing in the app calls `uploadBytes`/
`ref(storage, ...)`. Every real upload (student ID photos, Hand
Notes/Class Slides/Images, blog images, avatars) goes through
Cloudinary via `uploadToCloudinary()`. The old rules were written as
if students sign in with Firebase Auth and upload straight to this
bucket (`request.auth.uid`, `hasActiveResourceAccess()`) — neither is
true, so they weren't gating anything real. Replaced with an explicit
deny-all so an accidentally-activated bucket can't leak anything.
Fixed in: `storage.rules`.

## 9. Mobile: Logout not visible/reachable
Root cause: Logout only ever lived in the top navbar's auth slot,
squeezed in next to the search icon and hamburger button — on
narrow phones that row runs out of room and the button can end up
effectively unreachable/invisible depending on device width and name
length. This was a different bug from #3 (the avatar-hiding CSS
rule), which is why no CSS cause turned up there. Fix: Logout (and,
when signed out, Login) now also gets a dedicated, always-visible row
pinned to the bottom of the slide-in mobile menu (the sidebar),
independent of how tight the top bar gets.
Fixed in: `navbar.html`, `css/style.css`, `js/session.js`.

## 10. Firestore rules: "admin panel only" checks weren't actually admin-only
Every rule commented "admin panel only" / "admin-only" was written as
`request.auth != null` — any signed-in Firebase Auth user, not
specifically an admin. That happened to be safe only because
`js/admin.js` is currently the sole page that ever calls
`signInWithEmailAndPassword`, and its own admin-claim check
(`token.claims.admin !== true` → sign out) is a **client-side** UI
gate, not a server-side one. Any other valid Firebase Auth account for
this project (a leftover console test account, a second admin created
without running `scripts/set-admin-claim.mjs`, or any account created
through a sign-in method enabled later) could have bypassed the
admin.js UI entirely and used the Firestore SDK directly to read/
update/delete registrations, resources, terms, messages, classroom
codes, unlock grants, coffee requests, blog moderation, settings, etc.
Added an `isAdmin()` helper (checks the real `admin` custom claim —
the same check `resourceLocks` already used correctly) and replaced
every one of those `request.auth != null` checks with it, across all
19 collections in the file. No behavior changes for the real admin
account, which already carries the claim.
Fixed in: `firestore.rules`.

## 11. Security pass: XSS/innerHTML in `js/blog.js` and `js/admin.js`
Audited all ~90 `innerHTML`/`insertAdjacentHTML` sites across both
files (automated scan for un-escaped `${...}` interpolation of
object fields, plus manual review of every hit). Result: no live
XSS holes found. Both files already route user-submitted text
(names, emails, comments, messages, course codes, transaction IDs,
etc.) through the existing `esc()` helper before it reaches
`innerHTML`, and blog post `content` is pre-sanitized by
`sanitizeHTML()`'s tag/attribute allowlist before it's ever written
to Firestore, so rendering it back via `innerHTML` on read is safe by
construction. One small gap found and closed while touching this
code: `js/session.js` rendered the logged-in student's own
`fullName`/`avatarUrl` into the navbar without escaping (self-XSS —
a student who set an HTML-y display name could execute it in their
own browser on every page load). Now escaped there too.
Fixed in: `js/session.js` (see #9's file list — same edit).

---

## Not yet done (flagged, not started)
- None from this session's requested list. Two smaller, lower-severity
  items were noticed during the security pass and are being flagged
  rather than changed, since fixing them well means either a real
  design discussion or a riskier refactor than fits a drive-by fix:
  - **`registrations` documents (including `passwordHash`) are
    publicly readable via `list`/`get`.** This is a long-standing,
    deliberately documented trade-off (see the extensive comments in
    `firestore.rules` — the login/registration flow genuinely has no
    other way to look up a student without a Firebase Auth session),
    and `passwordHash` is itself a per-account-salted SHA-256 hash,
    not a plaintext password, with `js/password.js` explicitly
    documenting that this is "not meant to withstand a determined
    attacker... this is a student academic-resource site, not a
    banking app." Worth knowing this means a weak/reused password
    could in principle be brute-forced offline by anyone who queries
    the collection directly. The proper fix (moving `passwordHash`
    into a separate, non-listable subcollection) touches the login/
    registration/profile password flows in three files and needs to
    be tested end-to-end against the real Firebase project rather
    than done blind — happy to take this on as its own focused task
    if you want it.
  - Several `create` rules (e.g. `coffeeRequests`, `messages`,
    `classroomCodes`) validate field *types* and non-emptiness but not
    upper-bound *lengths* on every free-text field (a few do — e.g.
    `blogPosts.title`/`content`, `messages.message`,
    `classroomCodes.classroomCode` — but not all). Not a live
    vulnerability today (nothing sensitive is exposed by it), just a
    minor DoS/storage-bloat hardening opportunity if you ever want a
    follow-up pass.

## 12. Unlock modal showed "0 credits" while Profile showed the real balance
Fix #4 (above) corrected *how* `hnGetRemainingCredits()` in
`js/resources.js` identifies a student's own resource uploads for
credit — but the very next line, `fileCount(i)`, calls a function that
was never imported into this file. `fileCount` is only exported from
`js/access.js`; `resources.js`'s import list pulled in
`computeResourceAccessStatus`, `computeFileAccessStatus`,
`formatDate`, etc. from that same file, but not `fileCount`. Calling
an unimported function throws a `ReferenceError` — and
`hnGetRemainingCredits()` wraps its whole body in a `try/catch` that
silently returns `0` on any error, so the File Unlock modal always
showed "0 credits remaining / No credits available" regardless of the
real balance, while Profile (which computes its own total separately
and never calls `fileCount`) showed the correct number. Fixed by
adding `fileCount` to the existing `access.js` import in
`js/resources.js`.
Fixed in: `js/resources.js`.
