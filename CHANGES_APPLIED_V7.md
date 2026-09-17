# Changes Applied — Registration Credits Bug, Premium Profile Cards, Unlock Menu Redesign

## 1. Fixed: Registered Users Not Getting Their 5 Credits + "Couldn't Load Your Uploads"

**Root cause:** In `js/profile.js`, `renderCredits(email, fullName)` referenced
a variable `reg` on this line:

```js
const registrationCredits = Math.max(5, Number(reg?.registrationCredits || 0));
```

`reg` was never passed into this function — it only existed inside the
caller, `init()`. Every time `renderCredits()` ran, this threw a silent
`ReferenceError`, which meant the function crashed **before** it ever
computed credits, rendered the access badge, or built the uploads list.
That single crash was the cause of both reported symptoms at once:

- Registered users appeared to get 0 credits instead of 5 (the crash
  happened before the credit math ever ran).
- "My Uploads" always showed "Couldn't load your uploads right now" (the
  page's `catch` block for this crash is exactly what shows that message).

**Fix:** `renderCredits()` now takes the registration record as a third
parameter (`renderCredits(email, fullName, reg)`), and both call sites in
`init()` pass it through. The 5-credit fallback logic itself was already
correct — it just needed the data it was trying to read.

## 2. Premium Redesign — My Contributions / My Uploads / My Blog Posts

`profile.html` — the plain three-card grid is now a proper dashboard
section ("My Activity") with:

- A colored top accent per card (leaf green / wheat gold / terracotta)
  and a matching icon chip, so the three cards are visually distinct
  at a glance.
- A subtitle under each title for context.
- Subtle hover lift + shadow, scrollable list areas (so a long upload or
  post history doesn't blow out the page), and a nicer dashed empty state.

No JS changes were needed here — all existing element IDs
(`stat-approved`, `uploads-list`, `my-posts-empty`, etc.) were kept
exactly as-is, so `js/profile.js` continues to populate them unchanged.

## 3. Unlock Flow Redesign — "Unlock with Remaining Credit" / "Earn New Credit"

**Before:** clicking a locked file's 🔒 badge silently tried to spend a
credit automatically. If that attempt failed for any reason, the file row
flashed "⚠️ Unlock could not be completed. Please try again." with no way
to see *why*, and no clear next step other than clicking again.

**Now:** clicking a locked file (Hand Notes, Class Slides, or Images)
opens a new **"Unlock This File"** step first, showing:

- A wallet-style ring with the student's current remaining credit count.
- **"🔓 Unlock with Remaining Credit"** — spends exactly one credit and
  unlocks the file immediately (only shown/enabled when a credit is
  available).
- **"⚡ Earn New Credit to Unlock"** — opens the existing three-way system
  unchanged (Unlock with Notes / Unlock with Google Classroom / Buy Me a
  Coffee), now reachable via a "← Back" link from that step too.

If spending a credit fails, the error now shows inline in this menu
("⚠️ Unlock could not be completed. Please try again.") with the button
re-enabled to retry, instead of a transient message flashing on the file
row itself.

**Files touched:** `slides-notes.html` (new modal step + back button),
`js/resources.js` (new `getResourceCreditSummary()` read-only balance
lookup, exposed as `window.__getResourceCreditSummary`; `hnOpenGate()` now
routes logged-in students through the new Unlock menu instead of straight
to the 3-way choice; the old auto-unlock-on-click logic was removed),
`css/style.css` (new `.unlock-credit-card` / `.unlock-credit-ring` /
`.unlock-divider` styles).
