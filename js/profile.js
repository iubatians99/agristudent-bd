import { db, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  doc, getDoc, updateDoc, deleteDoc, collection, query, where, getDocs, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail } from "./identity.js";
import { getSession, saveSession, clearSession } from "./session.js";
import { initEmailNotifications } from "./email-config.js";
import { hashPassword, isPasswordValid } from "./password.js";
import { computeResourceAccessStatus, maybeSendAccessReminder, renderAccessBadge, renderAccessScale, formatDate, formatRemaining, DAY_MS } from "./access.js";
import { fetchMessagesForUser, markMessageRead, formatMessageDateTime } from "./inbox.js";

initEmailNotifications();


// ============================================
// ACCESS STATUS SYNC
// ============================================
// Save the computed access status back to Firestore so storage.rules can verify it.
async function syncAccessToRegistration(db, session, access) {
  if (!session || !session.regId) return;

  try {
    await updateDoc(doc(db, "registrations", session.regId), {
      accessUntil: access.accessUntil ? Timestamp.fromDate(new Date(access.accessUntil)) : null,
      restricted: access.restricted,
      restrictedUntil: access.restrictedUntil ? Timestamp.fromDate(new Date(access.restrictedUntil)) : null,
      lastAccessSyncAt: serverTimestamp(),
      approvedFileCount: access.approvedFileCount || 0,
      pendingActiveCount: access.pendingActiveCount || 0
    });

    console.log("[Profile] Synced access status → accessUntil:", access.accessUntil);
  } catch (err) {
    console.warn("[Profile] Failed to sync access status:", err);
  }
}

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const loadingEl = document.getElementById("profile-loading");
const contentEl = document.getElementById("profile-content");
const loggedOutEl = document.getElementById("profile-logged-out");

function showLoggedOut() {
  loadingEl.classList.add("hidden");
  contentEl.classList.add("hidden");
  loggedOutEl.classList.remove("hidden");
}

// ============================================
// PROFILE AVATAR UPLOAD — tap the camera badge on the circular avatar
// to replace it. Uploads to Cloudinary (same pipeline as blog images),
// then saves the URL onto the student's own registration doc.
// ============================================
const MAX_AVATAR_SIZE = 8 * 1024 * 1024; // 8MB
const avatarWrap = document.getElementById("profile-avatar-wrap");
const avatarImg = document.getElementById("profile-avatar");
const avatarEditBtn = document.getElementById("profile-avatar-edit-btn");
const avatarInput = document.getElementById("profile-avatar-input");
const avatarStatus = document.getElementById("profile-avatar-status");

avatarEditBtn?.addEventListener("click", () => avatarInput?.click());

avatarInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  avatarInput.value = "";
  if (!file) return;

  const session = getSession();
  if (!session) return;

  avatarStatus.classList.remove("is-error");

  if (!file.type.startsWith("image/")) {
    avatarStatus.textContent = "Please choose an image file.";
    avatarStatus.classList.add("is-error");
    return;
  }
  if (file.size > MAX_AVATAR_SIZE) {
    avatarStatus.textContent = "Image too large (max 8MB).";
    avatarStatus.classList.add("is-error");
    return;
  }

  avatarStatus.textContent = "Uploading…";
  avatarWrap.classList.add("is-uploading");
  avatarEditBtn.disabled = true;

  // Instant local preview while the real upload runs in the background.
  const previewUrl = URL.createObjectURL(file);
  avatarImg.src = previewUrl;

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    const response = await fetch(CLOUDINARY_UPLOAD_URL, { method: "POST", body: formData });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    const data = await response.json();
    if (!data.secure_url) throw new Error("Upload failed");

    await updateDoc(doc(db, "registrations", session.regId), { avatarUrl: data.secure_url });

    avatarImg.src = data.secure_url;
    saveSession({ ...session, avatarUrl: data.secure_url });

    // Reflect the change in the navbar avatar immediately too, without
    // needing a page reload.
    document.querySelectorAll(".navbar-auth-avatar").forEach(img => { img.src = data.secure_url; });

    avatarStatus.textContent = "Profile photo updated ✅";
    setTimeout(() => {
      if (avatarStatus.textContent === "Profile photo updated ✅") avatarStatus.textContent = "";
    }, 3000);
  } catch (err) {
    console.error("[Profile] avatar upload failed:", err);
    avatarImg.src = session.avatarUrl || (session.gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg");
    avatarStatus.textContent = "Upload failed — check your connection and try again.";
    avatarStatus.classList.add("is-error");
  } finally {
    avatarWrap.classList.remove("is-uploading");
    avatarEditBtn.disabled = false;
    URL.revokeObjectURL(previewUrl);
  }
});

async function init() {
  const session = getSession();
  if (!session) { showLoggedOut(); return; }

  try {
    // Re-fetch the live registration record rather than trusting the
    // cached session — status can change (admin verifies/rejects) after
    // login, and this keeps the profile accurate.
    const regSnap = await getDoc(doc(db, "registrations", session.regId));
    if (!regSnap.exists()) {
      clearSession();
      showLoggedOut();
      return;
    }
    const reg = regSnap.data();
    // Keep the local session in sync with any status change.
    saveSession({
      regId: session.regId,
      fullName: reg.fullName,
      email: reg.email,
      studentIdNumber: reg.studentIdNumber,
      gender: reg.gender,
      avatarUrl: reg.avatarUrl,
      status: reg.status || "unverified"
    });

    renderIdentity(reg);
    renderPasswordSection(session.regId, reg);

    // Each section loads independently — a failure in one (e.g. a blocked
    // Firestore query for blog posts) no longer blanks out the whole page.
    loadingEl.classList.add("hidden");
    contentEl.classList.remove("hidden");

    try {
      await renderCredits(normalizeEmail(reg.email), reg.fullName, reg);
    } catch (err) {
      console.error("[Profile] failed to load resource credits:", err);
      const listEl = document.getElementById("uploads-list");
      if (listEl) listEl.innerHTML = `<p style="color:var(--terracotta-500);font-size:.85rem;">Couldn't load your uploads right now. <button type="button" id="retry-credits" style="background:none;border:none;color:var(--leaf-500);font-weight:600;cursor:pointer;text-decoration:underline;">Retry</button></p>`;
      document.getElementById("retry-credits")?.addEventListener("click", () => renderCredits(normalizeEmail(reg.email), reg.fullName, reg).catch(e => console.error(e)));
    }

    try {
      await renderMyBlogPosts(normalizeEmail(reg.email));
    } catch (err) {
      console.error("[Profile] failed to load blog posts:", err);
    }

    try {
      await renderInbox(session.regId);
    } catch (err) {
      console.error("[Profile] failed to load inbox:", err);
    }
  } catch (err) {
    console.error("[Profile] failed to load:", err);
    loadingEl.innerHTML = `
      <p style="color:var(--terracotta-500);font-weight:600;">Something went wrong loading your profile.</p>
      <p style="font-size:.85rem;color:var(--moss-600);margin-top:.4rem;">${esc(err?.message || "Please check your connection and try again.")}</p>
      <button type="button" id="profile-retry-btn" class="btn-primary" style="margin-top:1rem;">Try Again</button>`;
    document.getElementById("profile-retry-btn")?.addEventListener("click", () => {
      loadingEl.innerHTML = "Loading your profile…";
      init();
    });
  }
}

function renderIdentity(reg) {
  document.getElementById("profile-avatar").src = reg.avatarUrl || (reg.gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg");
  document.getElementById("profile-name").textContent = reg.fullName || "—";
  document.getElementById("profile-email").textContent = reg.email || "—";
  document.getElementById("profile-studentid").textContent = reg.studentIdNumber || "—";

  const idBadge = document.getElementById("profile-id-verified-badge");
  const avatarWrapEl = document.getElementById("profile-avatar-wrap");
  idBadge?.classList.toggle("hidden", !reg.idVerified);
  avatarWrapEl?.classList.toggle("is-id-verified", !!reg.idVerified);

  const status = reg.status || "unverified";
  const pill = document.getElementById("profile-status-pill");
  const note = document.getElementById("profile-status-note");
  const labels = { verified: "✅ Email Verified", unverified: "🕓 Unverified", rejected: "❌ Rejected" };
  pill.textContent = labels[status] || status;
  pill.className = "profile-status-pill " + status;

  if (status !== "verified") {
    note.classList.remove("hidden");
    note.innerHTML = status === "rejected"
      ? `<p>Your registration was rejected. Please <a href="register.html" style="color:var(--leaf-500);font-weight:600;">register again</a> with correct details.</p>`
      : `<p>Your registration is still awaiting admin review — this usually takes 24–48 hours. You'll get full access once verified.</p>`;
  } else {
    note.classList.add("hidden");
  }
}

// ============================================
// LOGIN PASSWORD SECTION
// Shows a "set up a password" prompt for legacy accounts that were
// created before password login existed (no passwordHash yet), or a
// plain "change password" form for accounts that already have one.
// ============================================
function renderPasswordSection(regId, reg) {
  const noPasswordBlock = document.getElementById("password-section-no-password");
  const hasPasswordBlock = document.getElementById("password-section-has-password");
  const hasPassword = !!reg.passwordHash;
  const cardCopy = document.getElementById("password-card-copy");
  const openBtn = document.getElementById("profile-password-open-btn");
  const modal = document.getElementById("profile-password-modal");

  noPasswordBlock?.classList.toggle("hidden", hasPassword);
  hasPasswordBlock?.classList.toggle("hidden", !hasPassword);

  if (cardCopy) cardCopy.textContent = hasPassword
    ? "Update the password you use to log in."
    : "Set a password for secure login.";

  // Existing-password users update directly from the profile card.
  // The popup is reserved exclusively for first-time password setup.
  if (openBtn) {
    openBtn.classList.toggle("hidden", hasPassword);
    openBtn.textContent = "Set Password";
  }

  const closeModal = () => {
    modal?.classList.add("hidden");
    modal?.setAttribute("aria-hidden", "true");
  };

  if (openBtn && !openBtn.dataset.wired) {
    openBtn.dataset.wired = "1";
    openBtn.addEventListener("click", () => {
      modal?.classList.remove("hidden");
      modal?.setAttribute("aria-hidden", "false");
      document.getElementById("profile-new-password")?.focus();
    });
  }
  const modalClose = document.getElementById("profile-password-modal-close");
  if (modalClose && !modalClose.dataset.wired) {
    modalClose.dataset.wired = "1";
    modalClose.addEventListener("click", closeModal);
  }
  if (modal && !modal.dataset.wired) {
    modal.dataset.wired = "1";
    modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  }

  const setupSubmitBtn = document.getElementById("profile-password-submit-btn");
  const setupStatusEl = document.getElementById("profile-password-status");
  const setupNewInput = document.getElementById("profile-new-password");
  const setupConfirmInput = document.getElementById("profile-new-password-confirm");

  async function savePassword(password, statusEl, button, successText, onSuccess) {
    if (!isPasswordValid(password)) {
      statusEl.textContent = "Password must be at least 6 characters.";
      statusEl.style.color = "var(--terracotta-500)";
      return false;
    }
    button.disabled = true;
    const oldText = button.textContent;
    button.textContent = "Saving…";
    statusEl.textContent = "Saving your password…";
    statusEl.style.color = "var(--moss-600)";
    try {
      const passwordHash = await hashPassword(password, reg.email);
      await updateDoc(doc(db, "registrations", regId), { passwordHash });
      reg.passwordHash = passwordHash;
      statusEl.textContent = successText;
      statusEl.style.color = "var(--moss-600)";
      onSuccess?.();
      return true;
    } catch (err) {
      console.error("[Profile] failed to save password:", err);
      statusEl.textContent = "Something went wrong saving your password. (" + err.message + ")";
      statusEl.style.color = "var(--terracotta-500)";
      return false;
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  // First-time setup: popup only. The profile button opens it; session.js deliberately
  // skips its global popup on profile.html so this is the only setup dialog here.
  if (setupSubmitBtn && !setupSubmitBtn.dataset.wired) {
    setupSubmitBtn.dataset.wired = "1";
    setupSubmitBtn.addEventListener("click", async () => {
      const password = setupNewInput?.value || "";
      const confirm = setupConfirmInput?.value || "";
      if (password !== confirm) {
        setupStatusEl.textContent = "Passwords don't match.";
        setupStatusEl.style.color = "var(--terracotta-500)";
        return;
      }
      const saved = await savePassword(
        password,
        setupStatusEl,
        setupSubmitBtn,
        "✅ Password set successfully. You can now use it to log in.",
        () => {
          if (setupNewInput) setupNewInput.value = "";
          if (setupConfirmInput) setupConfirmInput.value = "";
          closeModal();
          renderPasswordSection(regId, reg);
        }
      );
      if (!saved) return;
    });
  }

  // Existing password: update inline on the profile page — no popup.
  const inlineBtn = document.getElementById("profile-inline-password-submit-btn");
  const inlineStatus = document.getElementById("profile-inline-password-status");
  const inlineNew = document.getElementById("profile-inline-new-password");
  const inlineConfirm = document.getElementById("profile-inline-new-password-confirm");
  if (inlineBtn && !inlineBtn.dataset.wired) {
    inlineBtn.dataset.wired = "1";
    inlineBtn.addEventListener("click", async () => {
      const password = inlineNew?.value || "";
      const confirm = inlineConfirm?.value || "";
      if (password !== confirm) {
        inlineStatus.textContent = "Passwords don't match.";
        inlineStatus.style.color = "var(--terracotta-500)";
        return;
      }
      await savePassword(
        password,
        inlineStatus,
        inlineBtn,
        "✅ Password updated successfully.",
        () => {
          if (inlineNew) inlineNew.value = "";
          if (inlineConfirm) inlineConfirm.value = "";
        }
      );
    });
  }

  if (hasPassword) closeModal();
}

async function renderCredits(email, fullName, reg = {}) {
  // Load each source independently. One unavailable/legacy collection must not
  // blank the entire profile or hide the guaranteed registration credits.
  const safeDocs = async (q) => { try { const snap = await getDocs(q); return snap.docs; } catch (err) { console.warn("[Profile] optional credit query failed:", err); return []; } };
  const [resourceDocs, termDocs, classroomDocsRaw, manualDocsRaw, fileUnlockDocsRaw, folderUnlockDocsRaw] = await Promise.all([
    safeDocs(query(collection(db, "resources"), where("uploaderEmail", "==", email))),
    safeDocs(query(collection(db, "terms"), where("uploaderEmail", "==", email))),
    safeDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", email))),
    safeDocs(query(collection(db, "manualUnlocks"), where("fromEmail", "==", email))),
    safeDocs(query(collection(db, "fileUnlocks"), where("fromEmail", "==", email))),
    safeDocs(query(collection(db, "folderUnlocks"), where("fromEmail", "==", email)))
  ]);

  const items = [
    ...resourceDocs.map(d => ({ id: d.id, kind: "resource", ...d.data() })),
    ...termDocs.map(d => ({ id: d.id, kind: "term", ...d.data() }))
  ].sort((a, b) => (b.submittedAt?.toDate?.() || 0) - (a.submittedAt?.toDate?.() || 0));

  // Classroom-code unlocks aren't shown in "My Contributions" (they aren't
  // reviewed uploads) but they DO count toward resource access time.
  const classroomItems = classroomDocsRaw.map(d => ({ id: d.id, kind: "classroom", ...d.data() }));
  const manualItems = manualDocsRaw.map(d => ({ id: d.id, kind: "manual", ...d.data() }));
  const fileUnlockItems = fileUnlockDocsRaw.map(d => ({ id:d.id, ...d.data() }));
  const folderUnlockItems = folderUnlockDocsRaw.map(d => ({ id:d.id, ...d.data() }));

  const approved = items.filter(i => i.status === "approved").length;
  const pending = items.filter(i => (i.status || "pending") === "pending").length;
  const rejected = items.filter(i => i.status === "rejected").length;

  document.getElementById("stat-total").textContent = items.length;
  document.getElementById("stat-total-card")?.replaceChildren(document.createTextNode(String(items.length)));
  document.getElementById("stat-approved").textContent = approved;
  document.getElementById("stat-pending").textContent = pending;
  document.getElementById("stat-rejected").textContent = rejected;

  // Every uploaded resource file earns one credit. This includes files in
  // Hand Notes, Class Slides, Images, and other resource uploads.
  const resourceItems = items.filter(i => i.kind === "resource");
  const uploadCredits = resourceItems.reduce((n, i) => n + (Array.isArray(i.fileUrls) ? i.fileUrls.length : 1), 0);
  // Every approved Classroom unlock earns 10 credits. Locked/rejected codes do not.
  const classroomCredits = classroomItems.reduce((n, i) => n + (i.status === "approved" ? 10 : 0), 0);
  // Coffee approvals/manual credit grants can award a custom number of credits.
  const coffeeCredits = manualItems.reduce((n, i) => n + (i.source === "coffee" ? Number(i.creditsGranted || 0) : 0), 0);
  // Every registered user receives 5 free registration credits.
  // The fallback keeps existing users eligible even if their older registration
  // document does not yet contain the new field.
  const registrationCredits = Math.max(5, Number(reg?.registrationCredits || 0));
  const creditsEarned = registrationCredits + uploadCredits + classroomCredits + coffeeCredits;
  // Only wallet-credit unlocks consume credits. Notes/Classroom access grants
  // are access records, not credit deductions.
  const creditsUsed = fileUnlockItems.filter(i => !i.revoked && i.source !== "notes_earn" && i.source !== "classroom_earn").length;
  // One-off penalty applied when an admin lifts an account restriction
  // (js/admin.js deductFullCreditBalance) — wipes whatever balance existed
  // at that moment. Stored as a running offset since credits aren't a
  // single stored number; see js/resources.js hnGetRemainingCredits for
  // the same subtraction on the student-facing unlock flow.
  const creditDebt = Number(reg?.creditDebt || 0);
  const creditsRemaining = Math.max(0, creditsEarned - creditsUsed - creditDebt);
  document.getElementById("handnote-credit-earned-top")?.replaceChildren(document.createTextNode(String(creditsEarned)));
  document.getElementById("handnote-credit-remaining-top")?.replaceChildren(document.createTextNode(String(creditsRemaining)));
  const creditPanel = document.getElementById("handnote-credit-panel");
  if (creditPanel) {
    creditPanel.classList.toggle("hidden", creditsEarned === 0 && creditsUsed === 0);
    document.getElementById("handnote-credit-earned")?.replaceChildren(document.createTextNode(String(creditsEarned)));
    document.getElementById("handnote-credit-used")?.replaceChildren(document.createTextNode(String(creditsUsed)));
    document.getElementById("handnote-credit-remaining")?.replaceChildren(document.createTextNode(String(creditsRemaining)));
    document.getElementById("handnote-credit-remaining-mini")?.replaceChildren(document.createTextNode(String(creditsRemaining)));
    const ring = document.querySelector(".credit-balance-ring");
    if (ring) {
      const pct = creditsEarned ? Math.max(0, Math.min(100, (creditsRemaining / creditsEarned) * 100)) : 0;
      ring.style.background = `radial-gradient(circle,#fff 55%,transparent 56%), conic-gradient(var(--leaf-500) ${pct * 3.6}deg,#dfe9df ${pct * 3.6}deg)`;
    }
  }
  const access = computeResourceAccessStatus([...resourceItems, ...classroomItems, ...manualItems, ...fileUnlockItems, ...folderUnlockItems]);
  renderAccessBadge({
    badgeEl: document.getElementById("access-badge"),
    detailEl: document.getElementById("access-detail")
  }, access);
  maybeSendAccessReminder(access, { email, name: fullName });
  const circle = document.getElementById("profile-access-circle");
  const daysEl = document.getElementById("profile-access-days");
  const daysLabel = document.getElementById("profile-access-days-label");
  if (circle && daysEl) {
    const days = access.lifetimeActive ? 100 : Math.max(0, Math.ceil((access.accessUntil - Date.now()) / DAY_MS));
    daysEl.textContent = access.lifetimeActive ? "∞" : String(days);
    if (daysLabel) daysLabel.textContent = access.lifetimeActive ? "lifetime" : "days left";
    const pct = access.lifetimeActive ? 100 : Math.max(0, Math.min(100, (access.msRemaining / (36*60*60*1000))*100));
    circle.style.background = `conic-gradient(var(--leaf-500) ${pct*3.6}deg,#e5ece5 ${pct*3.6}deg)`;
  }

  // The scale bar shows how much of the MOST RECENTLY granted top-up is
  // left (36h Hand Note credit / lifetime folder) — access.lastGrantMs already
  // accounts for which kind of grant is currently the active one.
  renderAccessScale({
    wrapEl: document.getElementById("access-scale-wrap"),
    fillEl: document.getElementById("access-scale-fill"),
    remainingEl: document.getElementById("access-scale-remaining"),
    untilEl: document.getElementById("access-scale-until")
  }, access, access.lastGrantMs);
  // Sync the computed access status back to Firestore for storage.rules
  const session = getSession();
  if (access && session?.regId) {
    await syncAccessToRegistration(db, session, access);
  }

  renderAccessTimeline(access);

  const accessDetail = document.getElementById("access-detail");
  const accessAlert = document.getElementById("resource-access-alert");
  if (accessAlert) {
    if (access.restricted) {
      accessAlert.classList.remove("hidden");
      accessAlert.innerHTML = `⚠️ Upload relevant files only. Resource access and uploads are restricted until ${formatDate(access.restrictedUntil)}.`;
    } else {
      accessAlert.classList.add("hidden");
      accessAlert.innerHTML = "";
    }
  }
  if (accessDetail && access.lifetimeActive) {
    accessDetail.textContent = "♾️ Lifetime folder access active · admin can lock it again";
  } else if (accessDetail && access.restricted) {
    accessDetail.innerHTML = `⚠️ <strong>Upload relevant files only.</strong> You are restricted until <strong>${formatDate(access.restrictedUntil)}</strong>.`;
  } else if (accessDetail && access.active) {
    accessDetail.textContent = `${access.daysRemaining} day${access.daysRemaining === 1 ? "" : "s"} remaining · expires ${formatDate(access.accessUntil)}`;
  }

  const listEl = document.getElementById("uploads-list");
  const emptyEl = document.getElementById("uploads-empty");

  if (items.length === 0) {
    listEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  listEl.innerHTML = items.map(item => {
    const status = item.status || "pending";
    const title = item.kind === "term"
      ? `📖 ${esc(item.name || "Untitled term")}`
      : `📄 ${esc(item.courseCode || "Unknown course")} — ${esc(item.resourceType === "previous_questions" ? "Previous Questions" : "Slides/Notes")}`;
    const date = item.submittedAt?.toDate?.() ? formatDate(item.submittedAt.toDate()) : "";
    return `
      <div class="upload-row">
        <div>
          <div class="upload-title">${title}</div>
          <div class="upload-date">${date}</div>
        </div>
        <span class="status-tag ${esc(status)}">${status === "approved" ? "✅ Approved" : status === "rejected" ? "❌ Rejected" : "⏳ Pending"}</span>
      </div>`;
  }).join("");
}

/** DD/MM HH:MM — used only for the per-file access breakdown, where the
    hour matters (unlike formatDate elsewhere which is date-only). */
function formatDateTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month} ${hh}:${mm}`;
}

// Shows exactly how much access time each individual upload (file or
// classroom code) contributed, and the window it occupies within the
// stacked total — so a student never has to guess "how much time did I
// get for which file".
function renderAccessTimeline(access) {
  const wrap = document.getElementById("access-timeline-wrap");
  const totalEl = document.getElementById("access-timeline-total");
  const listEl = document.getElementById("access-timeline-list");
  if (!wrap || !totalEl || !listEl) return;

  const breakdown = access.breakdown || [];
  if (breakdown.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");

  const totalHoursGranted = Math.round((access.totalGrantedMs || 0) / (60 * 60 * 1000));
  totalEl.innerHTML = `
    <span>Total access earned: <strong>${totalHoursGranted} hour${totalHoursGranted === 1 ? "" : "s"}</strong> across ${breakdown.length} upload${breakdown.length === 1 ? "" : "s"}</span>
    <span>${access.active ? `⏱ ${formatRemaining(access.msRemaining)} left right now` : "No time left right now"}</span>
  `;

  listEl.innerHTML = breakdown.slice().reverse().map(entry => {
    const isClassroom = entry.kind === "classroom";
    const isManual = entry.kind === "manual";
    const item = entry.item || {};
    const title = isClassroom
      ? `🏫 Classroom Code — ${esc(item.classroomCode || "Unlock")}`
      : isManual
        ? `🔓 Admin Manual Unlock — ${esc(item.unlockType || "Access")}`
        : `📄 ${esc(item.courseCode || "Unknown course")} — Slides/Notes`;
    const hours = Math.round(entry.durationMs / (60 * 60 * 1000));
    const startStr = formatDateTime(entry.startsAt);
    const endStr = formatDateTime(entry.endsAt);
    const statusCls = entry.active ? "is-active" : "is-expired";
    const statusText = entry.active ? "Active" : "Used up";
    return `
      <div class="access-timeline-row">
        <div>
          <div class="atl-title">${title}</div>
          <div class="atl-sub">+${hours}h · uploaded ${formatDate(entry.grantedAt)}</div>
        </div>
        <div class="atl-window">
          ${startStr} → ${endStr}
          <div><span class="atl-status ${statusCls}">${statusText}</span></div>
        </div>
      </div>`;
  }).join("");
}

// ============================================
// MY BLOG POSTS — lets the student edit or delete their own posts
// without hunting for them in the main feed. Edit hands off to
// blog.html?editPost=ID, which loads the same composer used on the
// blog page itself (title, body, and gallery images all carried over,
// updating the original post in place rather than creating a new one).
// ============================================
function blogStatusTag(status) {
  if (status === "pending_edit") return { cls: "pending", text: "📝 Pending Approval" };
  if (status === "approved") return { cls: "approved", text: "✅ Verified" };
  if (status === "rejected") return { cls: "rejected", text: "❌ Rejected" };
  return { cls: "pending", text: "🕓 Not verified" };
}

async function renderMyBlogPosts(email) {
  const listEl = document.getElementById("my-posts-list");
  const emptyEl = document.getElementById("my-posts-empty");
  if (!listEl) return;

  let posts;
  try {
    const snap = await getDocs(query(collection(db, "blogPosts"), where("authorEmail", "==", email)));
    posts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toDate?.() || 0) - (a.createdAt?.toDate?.() || 0));
  } catch (err) {
    console.error("[Profile] failed to load blog posts:", err);
    return;
  }

  if (posts.length === 0) {
    listEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  listEl.innerHTML = posts.map(item => {
    const tag = blogStatusTag(item.status);
    const date = item.createdAt?.toDate?.() ? formatDate(item.createdAt.toDate()) : "";
    return `
      <div class="upload-row" data-post-id="${esc(item.id)}">
        <div>
          <div style="font-weight:600;font-size:.92rem;">${esc(item.title || "Untitled post")}</div>
          <div style="font-size:.75rem;color:var(--moss-600);">${date} · 👁️ ${item.views || 0} views</div>
        </div>
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
          <span class="status-tag ${tag.cls}">${tag.text}</span>
          <button type="button" class="my-post-edit-btn" data-id="${esc(item.id)}"
            style="background:none;border:1px solid var(--line);border-radius:6px;padding:.3rem .6rem;font-size:.78rem;cursor:pointer;">✏️ Edit</button>
          <button type="button" class="my-post-delete-btn" data-id="${esc(item.id)}"
            style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);border-radius:6px;padding:.3rem .6rem;font-size:.78rem;cursor:pointer;">🗑️ Delete</button>
        </div>
      </div>`;
  }).join("");

  listEl.querySelectorAll(".my-post-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      window.location.href = `blog.html?editPost=${encodeURIComponent(btn.dataset.id)}`;
    });
  });

  listEl.querySelectorAll(".my-post-delete-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this blog post? This cannot be undone.")) return;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, "blogPosts", btn.dataset.id));
        listEl.querySelector(`[data-post-id="${btn.dataset.id}"]`)?.remove();
        if (!listEl.children.length) emptyEl.classList.remove("hidden");
      } catch (err) {
        console.error("[Profile] failed to delete post:", err);
        alert("Failed to delete post. Please try again.");
        btn.disabled = false;
      }
    });
  });
}

// ============================================
// INBOX — messages sent by an admin (js/admin.js "Notify User").
// Opening a message marks it read; the admin panel then shows exactly
// when it was seen. See js/inbox.js for the shared read/write helpers.
// ============================================
let inboxCache = [];
let inboxShowAll = false;

function inboxUnreadCount() {
  return inboxCache.filter(m => !m.read).length;
}

function renderInboxBadge() {
  const badge = document.getElementById("inbox-unread-badge");
  if (!badge) return;
  const count = inboxUnreadCount();
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

async function renderInbox(regId) {
  const listEl = document.getElementById("inbox-list");
  const emptyEl = document.getElementById("inbox-empty");
  const showAllBtn = document.getElementById("inbox-show-all");
  if (!listEl) return;

  inboxCache = await fetchMessagesForUser(regId);
  const coffeeMessage = inboxCache.find(m => !m.read && String(m.subject || "").toLowerCase().includes("coffee"));
  if (coffeeMessage) {
    let modal = document.getElementById("profile-coffee-popup");
    if (!modal) {
      modal = document.createElement("div"); modal.id="profile-coffee-popup"; modal.style.cssText="position:fixed;inset:0;background:rgba(20,28,22,.58);z-index:9998;display:flex;align-items:center;justify-content:center;padding:1rem;";
      modal.innerHTML=`<div style="width:min(480px,100%);background:#fff;border-radius:18px;padding:1.4rem;box-shadow:0 24px 70px rgba(0,0,0,.25);text-align:center;"><div style="font-size:2.2rem;">☕</div><h2 style="margin:.4rem 0 .5rem;">Coffee Support Approved</h2><p id="profile-coffee-popup-body" style="color:var(--moss-700);line-height:1.65;"></p><button id="profile-coffee-popup-close" class="btn-primary" style="margin-top:.8rem;width:100%;">Open My Inbox</button></div>`; document.body.appendChild(modal);
      modal.querySelector("#profile-coffee-popup-close").addEventListener("click", async()=>{ modal.remove(); const item=inboxCache.find(m=>m.id===coffeeMessage.id); if(item&&!item.read){item.read=true; try{await markMessageRead(item.id);}catch{}} renderInboxBadge(); document.getElementById("inbox")?.scrollIntoView({behavior:"smooth"}); });
    }
    modal.querySelector("#profile-coffee-popup-body").textContent = coffeeMessage.body || "Your custom access has been approved.";
  }

  if (inboxCache.length === 0) {
    listEl.innerHTML = "";
    emptyEl?.classList.remove("hidden");
    showAllBtn?.classList.add("hidden");
    renderInboxBadge();
    return;
  }
  emptyEl?.classList.add("hidden");

  // Profile inbox preview only shows the 3 most recent messages by
  // default (inboxCache is already newest-first) — a "Show all messages"
  // button reveals the rest without navigating away.
  const visibleItems = inboxShowAll ? inboxCache : inboxCache.slice(0, 3);
  if (showAllBtn) {
    showAllBtn.classList.toggle("hidden", inboxCache.length <= 3);
    showAllBtn.textContent = inboxShowAll ? "Show only recent messages" : `Show all messages (${inboxCache.length})`;
  }

  listEl.innerHTML = visibleItems.map(item => {
    const isUnread = !item.read;
    const preview = (item.body || "").trim().replace(/\s+/g, " ");
    const previewText = preview.length > 60 ? preview.slice(0, 60) + "…" : preview;
    return `
      <div class="inbox-row ${isUnread ? "is-unread" : ""}" data-id="${esc(item.id)}">
        <div class="inbox-row-head">
          <span class="inbox-row-dot" aria-hidden="true"></span>
          <div class="inbox-row-headline">
            <span class="inbox-row-subject">${esc(previewText)}</span>
            <span class="inbox-row-date">${esc(formatMessageDateTime(item.sentAt))}</span>
          </div>
          <span class="inbox-row-chevron">▾</span>
        </div>
        <div class="inbox-row-body hidden">
          <p>${esc(item.body)}</p>
          <div class="inbox-row-footer">— Agri Core Admin${item.readAt ? ` · seen ${esc(formatMessageDateTime(item.readAt))}` : ""}</div>
        </div>
      </div>`;
  }).join("");

  renderInboxBadge();

  listEl.querySelectorAll(".inbox-row").forEach(row => {
    row.querySelector(".inbox-row-head").addEventListener("click", async () => {
      const bodyEl = row.querySelector(".inbox-row-body");
      const wasHidden = bodyEl.classList.contains("hidden");
      // Close any other open message first — one message open at a time.
      listEl.querySelectorAll(".inbox-row-body").forEach(b => b.classList.add("hidden"));
      listEl.querySelectorAll(".inbox-row").forEach(r => r.classList.remove("is-open"));
      if (!wasHidden) return; // was open — clicking again just closes it
      bodyEl.classList.remove("hidden");
      row.classList.add("is-open");

      const id = row.dataset.id;
      const item = inboxCache.find(m => m.id === id);
      if (item && !item.read) {
        item.read = true; // optimistic — avoids a flash back to "unread" on re-render
        row.classList.remove("is-unread");
        try {
          await markMessageRead(id);
        } catch (err) {
          console.error("[Profile] failed to mark message read:", err);
        }
        renderInboxBadge();
      }
    });
  });

  if (showAllBtn && !showAllBtn.dataset.wired) {
    showAllBtn.dataset.wired = "1";
    showAllBtn.addEventListener("click", () => {
      inboxShowAll = !inboxShowAll;
      renderInbox(regId);
    });
  }
}

const logoutBtn = document.getElementById("profile-logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    clearSession();
    window.location.href = "index.html";
  });
}

init();
