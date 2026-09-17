# Updates — Admin panel & Hand Notes layout

## 1. Registered Users — restored
The panel and all its logic were still intact; only the sidebar button had been
removed, so nothing was actually lost. Re-added as **👥 Registered Users**.

## 2. Approvals & Arrange Files — removed
Both nav buttons, both panels, and ~11.8 KB of supporting JS deleted.
Resources is now the default tab on login.

## 3. Blog — "Reset all Love reactions" removed
The red box and its handler are gone. Note: `🗑 Delete ALL Blog Likes` still
exists in Danger Zone — say the word if that should go too.

## 4. Bulk Upload Terms — now works from a sheet
Two modes, both ending at the same confirm-then-publish preview.

**From a Sheet** — upload `.csv` / `.xlsx` / `.xls`, one term per row, headers
in row 1. Columns are matched in any order, ignoring case/spaces/underscores:

| Field | Accepted headers | Required |
|---|---|---|
| name | name, term, title, word, keyword | yes |
| description | description, desc, definition, meaning, details, about | no |
| image | image, imageUrl, img, photo, picture, url, link | yes* |

The image cell takes **either** a direct link **or** a filename — pick the
matching image files in the second input and they're matched by name
(`rhizobium` matches `Rhizobium.JPG`).

Image links are handed to Cloudinary as a URL, so Cloudinary downloads them
server-side — no CORS problem, nothing to download yourself. If Cloudinary
can't fetch a link, the original URL is saved instead so the term still
publishes.

A **Download blank template (.csv)** button is in the help box.

**From Images** — the original flow, unchanged.

Preview shows a numbered row per term with thumbnail, editable name,
description and image link, plus a ✕ to drop a row. Rows with no image are
flagged and skipped (the Knowledge Hub renders `imageUrl` directly, so a term
without one shows a broken image). Nothing is written to Firestore until you
press Upload.

SheetJS is loaded from cdn.jsdelivr.net in `admin.html`.

## 5. Status filters
Added to **Resources**, **Blog**, **Terms** and **Registered Users**. Each shows
a "Showing X of Y" counter and a proper empty state.

Registered Users also gets a name/email/ID search box. Because a registration
has no single status field, its filter maps onto the real state: ID Verified,
ID Not Verified, Restricted (expired restrictions correctly don't count),
Removed, Active.

## 6. Resources — three sections
**Admin:** the list now groups by **Hand Notes / Class Slides / Images** using
the same rule as the public page, instead of the old PDF/Images/Other split.
A Section dropdown sits beside the Status one.

**Hand Notes page (`slides-notes.html`):** the three cramped columns are now a
tab switcher, one full-width section at a time — much better on a phone. Counts
mirror into the tab badges, arrow keys move between tabs, and a one-line hint
explains each section's unlock behaviour.

Every element ID the loaders use still exists in the DOM at all times (hidden
panels are only visually hidden), so `js/resources.js` and
`js/slides-notes-loading-fix.js` needed no changes.

## Files touched
- `admin.html`
- `js/admin.js`
- `slides-notes.html`
- `css/style.css` (additions only, appended at the end)
