# Fixes applied — footer contact links, homepage Terms count, blog composer box

## 1. Footer "WhatsApp" / "Email" not clickable
Files: index.html, faq.html, calculators.html, blog.html

These were plain, unlinked `<li>` text in the Contact section of the footer.
Now:
- WhatsApp → https://wa.me/8801753486065 (opens in a new tab)
- Email → mailto:iubatagriculture@gmail.com (opens the user's mail app directly, no contact form)

## 2. Homepage "📖 Terms Uploaded" stat stuck on "—"
File: js/stats.js

`stat-terms` used `getCountFromServer()`, the same aggregation-query call that
`stat-resources` had already been switched away from (see the existing comment
above `stat-resources` in that file) because it was unreliable for this
project and silently failed, leaving the stat on its placeholder dash.
`stat-terms` now counts approved terms with a plain `getDocs()` query — the
same query already proven to work on the Knowledge Hub page (js/knowledge-hub.js).

If this still doesn't populate after redeploying, open the browser console on
the homepage — any error logged there (e.g. a Firestore permission error)
will point to whether the *rules* also need re-deploying, since the local
firestore.rules already allows public reads of terms.

## 3. Blog composer body box didn't match the highlighted title box
File: css/blog.css

`#post-body-input` (the "Write your post…" box) now has the same paper
background, focus glow, and smooth transition treatment as `#post-title-input`,
so the two fields read as one consistent, "highlighted" composer instead of
the title looking special and the body looking plain.
