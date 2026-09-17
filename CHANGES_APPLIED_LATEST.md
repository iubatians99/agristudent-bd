# Changes Applied — Admin Login Fix, Slides Folder Unlock, Image Folders

## 1. Admin Login Fixed

**Root cause:** `js/admin.js` had two functions declared twice — `esc()`
(once near the top, once again later) and `fmtAdminDate()` (same thing).
`admin.html` loads this file as `<script type="module">`, and ES modules
always run in strict mode, where a duplicate top-level `function`
declaration is a **SyntaxError**. That error stopped the whole script
from ever running, so the login button's click handler was never
attached — clicking "Log In" did nothing.

**Fix:** removed the later, duplicate `esc()` and `fmtAdminDate()`
definitions and kept the originals (all existing call sites already
matched their signature/behavior). The file now passes a syntax check
cleanly.

No other JS file in the project had this problem — all of them were
checked.

## 2. Class Lecture Slides — Folder-Level Unlock

**Before:** Class Lecture Slides used the exact same per-file unlock
system as Hand Notes — each individual file had to be unlocked on its
own (by uploading, a classroom code, or an ad).

**Now:** unlocking is per **course folder** for Class Lecture Slides.
Unlocking any one slide in, say, the "AGR 351" folder (by uploading,
classroom code, or watching an ad) unlocks every slide in that course's
folder at once. Hand Notes are unaffected — they keep the original
per-file unlock.

This was done by changing the "lock key" used only for Slides from a
per-file id to a per-course-code id (`course::<CODE>`), reusing the
existing access-calculation logic in `js/access.js` unchanged. Applied
to both the compact card view and the "View All" modal. On-page copy
was updated so students see the correct explanation.

**Files touched:** `js/resources.js`, `slides-notes.html`

## 3. Images Now Grouped Into Course Folders

Hand Notes and Class Lecture Slides already grouped correctly by course
code — the first upload for a course code (e.g. "AGR 351") creates that
folder, and every later upload with the same course code lands in the
same folder automatically. This was already working correctly (all
upload forms normalize the course code the same way).

Images, however, were shown as one flat searchable grid with no folder
structure. Added the same course-folder drill-down browser used for
Hand Notes/Slides to the Images card and its "View All" modal: Level 1
lists a folder per course code, Level 2 shows every image submitted
under that course. Searching still works as a flat filter across every
course. Per-image lock/unlock behavior is unchanged (still per file/
submission) — only the browsing structure changed.

**Files touched:** `js/resources.js`

## Not Yet Verified Live

I fixed the admin login by finding and removing a fatal JavaScript
syntax error (confirmed via `node --check`), but I don't have
credentials or network access to your live Firebase project, so I
couldn't click-test the actual login flow end-to-end. Please test it
after deploying, and let me know if it still doesn't work — that would
point to a different issue (e.g. Firebase Auth user/password, or
Firestore/Auth rules) rather than the script-crash root cause.
