# Fixes applied — footer contact links, homepage stats, blog composer box

## 1. Footer "WhatsApp" / "Email" not clickable
Files: index.html, faq.html, calculators.html, blog.html

These were plain, unlinked `<li>` text in the Contact section of the footer.
Now:
- WhatsApp → https://wa.me/8801753486065 (opens in a new tab)
- Email → mailto:iubatagriculture@gmail.com (opens the user's mail app directly, no contact form)

## 2. Homepage stats stuck on "—" (Registered Users, Pending Reviews, Terms Uploaded)
File: js/stats.js

All three used `getCountFromServer()`, an aggregation query that turned out to
be unreliable for this project — it would silently fail and leave the stat on
its placeholder dash. "stat-resources" had already been switched to a plain
`getDocs()` count for the same reason. Standardized all four homepage stats
(users, resources, pending, terms) on `getDocs()` counts, removing the now-
unused `getCountFromServer` import entirely.

If a stat still doesn't populate after redeploying, open the browser console
on the homepage — any error logged there (e.g. a Firestore permission error)
will point to whether the *rules* also need re-deploying, since the local
firestore.rules already allows public reads of registrations/resources/terms.

## 3. Blog composer body box didn't match the highlighted title box
File: css/blog.css

`#post-body-input` (the "Write your post…" box) now has the same paper
background, focus glow, and smooth transition treatment as `#post-title-input`,
so the two fields read as one consistent, "highlighted" composer instead of
the title looking special and the body looking plain.
