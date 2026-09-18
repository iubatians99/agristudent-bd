# Upload bug sweep

Went through every upload path in the project (resource uploads, the Hand
Notes unlock gate, "Upload Another File", terms, blog inline/gallery images,
Word-doc import, registration ID photo, profile avatar, admin bulk term
upload) looking specifically for bugs, not just styling. Found and fixed:

## 1. Duplicate-filename auto-rename silently never worked
File: js/resources.js — `autoRenameIfDuplicate()`

The Firestore query used `where("fac", "==", facultyName)` — "fac" isn't a
real field on any resource document (every write uses `facultyName`). The
typo meant the query always matched zero documents, so a file uploaded with
a name that already existed for that course/faculty was never renamed to
"file (1).pdf" — it just silently overwrote/duplicated in the listing.

This one function is shared by all three upload forms (Resources page
upload, the Hand-Notes unlock-gate upload, and "Upload Another File" on
slides-notes.html), so the fix applies everywhere at once.

## 2. Dead duplicated code in the main upload handler
File: js/resources.js

`fileUrls.forEach((f, i) => { f.fileType = detectedTypes[i]; })` was
accidentally pasted three times in a row in the Resources-page upload
submit handler. Harmless (idempotent) but cleaned up to one call.

## 3. Blog inline-image blob URLs never released (memory leak)
File: js/blog.js

Inline images use `URL.createObjectURL(file)` for an instant local preview
while the real Cloudinary upload runs. That temporary blob: URL was never
revoked — not after the real URL took over, and not if the image was
deleted before/without ever uploading. On a long blog-writing session with
several images this steadily leaks memory. Now revoked in both places.
