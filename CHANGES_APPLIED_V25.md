# Agri Core v25 — Complete Functional Bug Fix Pass

- Corrected the initial resource-access state so the UI does not treat a still-pending Firestore check as a real locked state.
- Preserved the working global resource-lock query/mapping and per-file lock logic.
- Own uploaded files remain permanently unlocked for their uploader.
- Credit unlock remains strictly one selected file per one credit.
- Profile container widened for desktop and hardened for tablet/mobile layouts.
- Navbar avatar + user name remains visible on narrow mobile widths.
- Added a window-level password-popup guard to prevent duplicate setup dialogs.
- Preserved registration +5 credits, upload +1 credit/file, classroom +10 credits/code, and coffee custom grants.
- Preserved existing data and legacy access records.
