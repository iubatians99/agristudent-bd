# Fix — duplicate ✕ close buttons on the Hand Notes unlock gate

## What was wrong
On the resource-unlock gate (slides-notes.html), the top-right "exit the
whole gate" button (#hn-gate-back) and a step's own inline "back to choice"
button (#hn-notes-back / #hn-classroom-back / #hn-coffee-back) could both be
visible at the same time, rendering as two overlapping circular ✕ buttons in
the corner — exactly the bug the code already had a comment warning about,
but never actually prevented.

Root cause: `hnShowStep()` (js/resources.js) only ever toggled which step
was visible — it never hid the top-right button when switching to a step
that has its own inline back control.

## Fix
`hnShowStep()` now hides the top-right #hn-gate-back button whenever it
shows the Notes, Classroom, or Coffee step (each of which has its own
inline back button), and shows it again for the Login/Choice steps, which
have no back control of their own.

## Also — premium redesign of the ✕ button itself
File: css/style.css (`.modal-box .modal-close`)

Restyled every close/back ✕ button across the site (they all share this
class) with a softer glass-gradient background, a layered shadow, and a
smoother rotate + scale hover into a warm terracotta gradient, replacing the
flat single-shadow circle.
