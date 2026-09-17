# Agri Core — V8 Updates

## Profile / Navigation
- Added **My Profile** to the shared side menu.
- Mobile navbar now keeps the user's profile photo and first name visible instead of hiding the entire profile label.
- Reworked the Profile page responsive layout for phones and small screens.

## Password popup
- Removed the Profile page's duplicate first-time password setup modal.
- `session.js` is now the single owner of the first-time password popup.
- Existing-password users can still change their password inline from Profile.

## Credits
- New verified registration receives **5 credits** (`registrationCredits: 5`).
- Every uploaded resource file earns **1 credit**.
- Uploading 10 files earns **10 credits**.
- Every admin-approved Google Classroom unlock grants **10 credits**.
- Buy Me a Coffee can grant a custom number of credits through the existing admin approval flow.
- Credits are spent one-for-one: **1 credit = one selected file unlock**.

## New per-file resource access
- Uploaded files remain unlocked for their uploader **forever**.
- Credit unlock: **6 hours for exactly one selected file**.
- Google Classroom: **48 hours for exactly one selected file after admin approval**.
- Buy Me a Coffee: **admin-approved custom access/credits**.
- One file unlock never unlocks another file.
- Expired file unlocks can be reopened only by spending another available credit.
- Zero-credit users are automatically taken to the three earning options.
- Closing the initial balance popup with credits available uses one credit on the selected file, as requested.

## Classroom admin fix
- Fixed the classroom approval handler's scope bug that could prevent confirmation.
- Approved classroom unlocks now consistently use the new 48-hour per-file access model.
