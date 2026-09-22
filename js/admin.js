import { db, auth, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, updateDoc, deleteDoc, addDoc, setDoc, orderBy, query, where, limit, Timestamp, writeBatch, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initEmailNotifications, sendReviewEmail } from "./email-config.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { computeResourceAccessStatus } from "./access.js";
import { initAdminNotifications, stopAdminNotifications, initAdminNotifyBell, clearAdminNotifyBadge, clearAdminTabBlink } from "./admin-notify.js";
import { sendMessageToUser, fetchAllSentMessages, formatMessageDateTime } from "./inbox.js";
import { computeCreditWallet } from "./credits.js";

initEmailNotifications();


// ============================================
// RESOURCE ACCESS SYNC
// ============================================
// When resource approval/rejection changes, recalculate and sync the student's
// access status to Firestore so storage.rules can verify it.
async function syncStudentAccessStatus(db, uploaderEmail) {
  const normalizedEmail = normalizeEmail(uploaderEmail);
  if (!normalizedEmail) return;

  try {
    const regSnap = await getDocs(
      query(collection(db, "registrations"), where("email", "==", normalizedEmail))
    );

    if (regSnap.empty) return;

    const regDoc = regSnap.docs[0];
    const regId = regDoc.id;

    const resourcesSnap = await getDocs(
      query(collection(db, "resources"), where("uploaderEmail", "==", normalizedEmail))
    );
    
    const classroomSnap = await getDocs(
      query(collection(db, "classroomCodes"), where("fromEmail", "==", normalizedEmail))
    );
    const manualSnap = await getDocs(
      query(collection(db, "manualUnlocks"), where("fromEmail", "==", normalizedEmail))
    );
    const fileUnlockSnap = await getDocs(
      query(collection(db, "fileUnlocks"), where("fromEmail", "==", normalizedEmail))
    );
    const folderUnlockSnap = await getDocs(
      query(collection(db, "folderUnlocks"), where("fromEmail", "==", normalizedEmail))
    );

    const resourceDocs = resourcesSnap.docs.map(d => ({ id: d.id, kind: "resource", ...d.data() }));
    const classroomDocs = classroomSnap.docs.map(d => ({ id: d.id, kind: "classroom", ...d.data() }));
    const manualDocs = manualSnap.docs.map(d => ({ id: d.id, kind: "manual", ...d.data() }));
    const fileUnlockDocs = fileUnlockSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const folderUnlockDocs = folderUnlockSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const access = computeResourceAccessStatus([...resourceDocs, ...classroomDocs, ...manualDocs, ...fileUnlockDocs, ...folderUnlockDocs]);

    await updateDoc(doc(db, "registrations", regId), {
      accessUntil: access.accessUntil ? Timestamp.fromDate(new Date(access.accessUntil)) : null,
      restricted: access.restricted,
      restrictedUntil: access.restrictedUntil ? Timestamp.fromDate(new Date(access.restrictedUntil)) : null,
      lastAccessSyncAt: serverTimestamp()
    });

    console.log("[Admin] Synced access for", uploaderEmail);
  } catch (err) {
    console.error("[Admin] Failed to sync student access:", err);
  }
}

// ============================================
// ESCAPE HELPER — prevents stored XSS from user-submitted
// content (course names, registration details, messages, etc.) being
// rendered as live HTML/JS via innerHTML.
// ============================================
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** DD/MM/YYYY — matches js/access.js formatDate so admin and student
    pages agree on date format. */
function fmtAdminDate(val) {
  const d = val?.toDate?.() ? val.toDate() : new Date(Number(val) || val);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}`;
}

// ============================================
// STATUS FILTER HELPERS
// ============================================
// Every filterable panel (Resources, Blog, Terms, Registered Users) shows a
// small "showing X of Y" counter beside its dropdown, so it's always obvious
// when a filter is hiding rows rather than the data simply being empty.
function setFilterCount(elId, shown, total, noun) {
  const el = document.getElementById(elId);
  if (!el) return;
  const plural = total === 1 ? noun : `${noun}s`;
  el.textContent = shown === total
    ? `${total} ${plural}`
    : `Showing ${shown} of ${total} ${plural}`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Re-runs a panel's loader whenever one of its filter controls changes.
// "change" covers the selects; typing in a search box is debounced.
function wireFilterControls(ids, reload) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", reload);
    if (el.tagName === "INPUT") el.addEventListener("input", debounce(reload, 250));
  });
}

// ============================================
// ACCOUNT RESTRICTION — shared helpers (used from both the Registrations
// tab and, one click away, right from a Resources review row).
//
// Restricting an account used to only freeze the whole site with an
// overlay (js/session.js) while leaving every file that student had
// already unlocked showing as unlocked, and leaving their credit
// balance untouched. Now restriction also immediately revokes every
// active unlock (file_unlock / classroom / manual / ad grants) so
// locked files actually show locked, and immediately resets the whole
// credit wallet via `creditsResetAt` (see deductFullCreditBalance
// below) — being restricted even once means the account goes back to
// looking exactly like a brand-new registration for credit purposes: a
// fresh 5-credit welcome bonus, no leftover balance, and no visible
// earn/spend history from before the reset. That reset is permanent
// (it doesn't get undone when the restriction period ends), but the
// student can freely earn and spend credits again from that point on,
// same as any other account.
// ============================================
async function restrictAccountById(id, days, reason, email) {
  const until = Date.now() + days * 24 * 60 * 60 * 1000;
  const tasks = [
    updateDoc(doc(db, "registrations", id), {
      accountRestrictedUntil: until,
      accountRestrictedReason: reason || "",
      accountRestrictedAt: new Date()
    })
  ];
  if (email) {
    tasks.push(revokeAllUnlocksForEmail(email));
    tasks.push(deductFullCreditBalance(id, email));
  }
  await Promise.all(tasks);
}

async function restrictAccountByEmail(email, days, reason) {
  const normalized = normalizeEmail(email || "");
  if (!normalized) throw new Error("This submission has no uploader email to restrict.");
  const snap = await getDocs(query(collection(db, "registrations"), where("email", "==", normalized)));
  if (snap.empty) throw new Error(`No registered account found for ${email}.`);
  await restrictAccountById(snap.docs[0].id, days, reason, normalized);
}

// ============================================
// CREDIT RESET ON RESTRICTION — restricting an account wipes the
// student's whole credit wallet, past and future, back to a clean
// slate. Credits are never stored as one number (js/resources.js
// hnGetRemainingCredits and js/profile.js renderCredits both compute
// them live from the resources / classroomCodes / manualUnlocks /
// fileUnlocks collections), so the penalty is stored as a
// `creditsResetAt` timestamp on the registration doc instead — every
// page subtracts it the same way by simply ignoring any earn/spend
// item dated at or before that stamp (see js/credits.js
// computeCreditWallet). Restricting the same account again later just
// moves the stamp forward, so nothing "re-earned" since the last reset
// survives the next one either.
//
// This replaces the older `creditDebt` offset, which only zeroed the
// balance at that moment but left the underlying earned-credit records
// (and the student's visible activity history) untouched — so the
// balance, and the history, could grow right back. `creditDebt` is
// still read by js/credits.js for any account that was restricted
// before this shipped, so nobody's balance jumps retroactively. For an
// already-restricted account that predates `creditsResetAt` entirely,
// js/credits.js falls back to that account's existing
// `accountRestrictedAt` stamp instead, so it reads correctly right
// away without needing to be restricted again.
// ============================================
// Delegates to the single canonical formula in js/credits.js — this used
// to be its own hand-copied implementation here (and a third, separately
// hand-copied implementation in js/resources.js), which is exactly how a
// student could see a different "Available" number depending on which
// page computed it. All three now share one formula.
async function computeCreditsBalance(email) {
  const normalized = normalizeEmail(email || "");
  if (!normalized) return { earned: 0, used: 0 };
  const [resourcesSnap, classroomSnap, manualSnap, fileUnlockSnap, regSnap] = await Promise.all([
    getDocs(query(collection(db, "resources"), where("uploaderEmail", "==", normalized))),
    getDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "manualUnlocks"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "fileUnlocks"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "registrations"), where("email", "==", normalized)))
  ]);
  const regData = regSnap.empty ? {} : regSnap.docs[0].data();
  const wallet = computeCreditWallet({
    resourceItems: resourcesSnap.docs.map(d => d.data()),
    classroomItems: classroomSnap.docs.map(d => d.data()),
    manualItems: manualSnap.docs.map(d => d.data()),
    // A fileUnlocks doc means the credit was spent at that moment — that
    // stays true forever, whether or not the unlock itself is later
    // revoked (e.g. by revokeAllUnlocksForEmail as a restriction
    // penalty). Revocation is about access, not about whether a credit
    // was ever used, so computeCreditWallet deliberately still counts
    // revoked docs as spent here (unless it predates a reset, in which
    // case it's excluded like everything else pre-reset).
    fileUnlockItems: fileUnlockSnap.docs.map(d => d.data()),
    registrationCredits: regData.registrationCredits,
    creditsResetAt: regData.creditsResetAt,
    accountRestrictedAt: regData.accountRestrictedAt
  });
  return { earned: wallet.creditsEarned, used: wallet.creditsUsed, available: wallet.creditsRemaining };
}

async function deductFullCreditBalance(regId, email) {
  // Stamping "now" is the whole penalty: js/credits.js computeCreditWallet
  // then excludes every earn/spend item dated at or before this moment
  // from both the balance and the visible history, on every page, the
  // next time it recomputes the wallet for this student.
  await updateDoc(doc(db, "registrations", regId), { creditsResetAt: Date.now() });
}

// ============================================
// LOCK ALL FILES ON RESTRICTION — marks every unlock grant this student
// currently holds (credit-based file unlocks, approved classroom-code
// unlocks, admin manual grants, and watched-ad unlocks) as revoked, so
// computeResourceAccessStatus/computeFileAccessStatus (js/access.js)
// treats them as inactive and every file that was showing "View"
// immediately shows locked again. Safe to call repeatedly — docs
// already revoked are left alone.
// ============================================
// ============================================
// REVOKE THE FILE UNLOCK A REJECTED UPLOAD GRANTED — when a student
// uploads to unlock one specific file (js/resources.js hnOpenGate /
// createFileCreditUnlock), the upload creates its own separate
// `fileUnlocks` doc stamped with `sourceResourceId`. That doc is what
// actually grants the 6-hour "View" access — rejecting the resources
// doc alone never touched it, so a rejected upload kept the file
// unlocked for the rest of its window. This revokes that specific
// grant (and only that one, so no other file the student unlocked is
// affected) the moment the resource is rejected.
// ============================================
async function revokeFileUnlockForResource(resourceId) {
  if (!resourceId) return;
  const snap = await getDocs(query(collection(db, "fileUnlocks"), where("sourceResourceId", "==", resourceId)));
  const toRevoke = snap.docs.filter(d => !d.data().revoked);
  if (!toRevoke.length) return;
  const batch = writeBatch(db);
  toRevoke.forEach(d => batch.update(d.ref, { revoked: true }));
  await batch.commit();
}

async function revokeAllUnlocksForEmail(email) {
  const normalized = normalizeEmail(email || "");
  if (!normalized) return;
  const [fileUnlockSnap, classroomSnap, manualSnap, adSnap] = await Promise.all([
    getDocs(query(collection(db, "fileUnlocks"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "manualUnlocks"), where("fromEmail", "==", normalized))),
    getDocs(query(collection(db, "adUnlocks"), where("fromEmail", "==", normalized)))
  ]);
  const toRevoke = [
    ...fileUnlockSnap.docs, ...classroomSnap.docs, ...manualSnap.docs, ...adSnap.docs
  ].filter(d => !d.data().revoked);
  if (!toRevoke.length) return;
  const batch = writeBatch(db);
  toRevoke.forEach(d => batch.update(d.ref, { revoked: true }));
  await batch.commit();
}

// ============================================
// FULLY REMOVE A USER (registration + every trace they left behind)
// ============================================
// Deletes the registration record AND everything tied to that email
// across every collection a student can write to, so "remove user" really
// means the account and its footprint are gone — not just hidden.
async function deleteDocsByField(collectionName, field, value) {
  if (!value) return 0;
  const snap = await getDocs(query(collection(db, collectionName), where(field, "==", value)));
  if (snap.empty) return 0;
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  return snap.docs.length;
}

async function deleteUserFully(regId, email) {
  const normalized = normalizeEmail(email || "");
  await Promise.all([
    deleteDocsByField("resources", "uploaderEmail", normalized),
    deleteDocsByField("terms", "uploaderEmail", normalized),
    deleteDocsByField("blogPosts", "authorEmail", normalized),
    deleteDocsByField("classroomCodes", "fromEmail", normalized),
    deleteDocsByField("messages", "fromEmail", normalized)
  ]);
  await deleteDoc(doc(db, "registrations", regId));
}

// ============================================
// REMOVE / RESTORE A USER (reversible)
// ============================================
// This is now the primary "Remove User" action. It does NOT delete
// anything — it just marks the registration as removed, which:
//   • blocks that email/Student ID from logging in (js/login.js)
//   • shows a "removed" overlay if they're already logged in elsewhere
//     on the site (js/session.js), same pattern as account restriction
// Every upload, blog post, classroom code, and message they ever
// submitted is left untouched, so "Restore User" (below) brings the
// account back exactly as it was. Permanently erasing all trace of a
// user is still possible via deleteUserFully() above, kept as a
// separate, clearly-labelled danger action for cases that genuinely
// need it (e.g. a takedown request) rather than the default path.
async function removeUserAccount(regId, reason) {
  await updateDoc(doc(db, "registrations", regId), {
    removed: true,
    removedAt: new Date(),
    removedReason: reason || ""
  });
}

async function restoreUserAccount(regId) {
  await updateDoc(doc(db, "registrations", regId), {
    removed: false,
    removedAt: null,
    removedReason: ""
  });
}

// ============================================
// SHOW A GENERIC ERROR IN A PANEL without leaking internals
// (full error still goes to console for debugging)
// ============================================
function showLoadError(container, label, err) {
  console.error(`[AgriAdmin] Failed to load ${label}:`, err);
  container.innerHTML = `<p style="color:var(--terracotta-500);">Couldn't load ${esc(label)}. Please refresh and try again.</p>`;
}

// ============================================
// GLOBAL RESOURCE LOCK
// ============================================
async function assertAdminClaim() {
  const user = auth.currentUser;
  if (!user) throw new Error("Admin authentication required.");
  const token = await user.getIdTokenResult(true);
  if (token?.claims?.admin !== true) throw new Error("Admin permission required.");
  return user;
}

async function lockAllCurrentlyUnlockedFiles() {
  await assertAdminClaim();
  const btn = document.getElementById("global-resource-lock-btn");
  const status = document.getElementById("global-resource-lock-status");
  if (!confirm("Lock all currently unlocked files for students? Their own uploaded files will remain permanently available.")) return;
  if (btn) { btn.disabled = true; btn.textContent = "Locking…"; }
  try {
    const lockRef = doc(db, "resourceLocks", "global");
    await setDoc(lockRef, { lockedAt: Timestamp.now(), lockedBy: getCurrentUserEmail() }, { merge: true });
    if (status) status.textContent = "✓ All existing unlock grants were locked. New unlocks can still be earned normally.";
    if (btn) btn.textContent = "🔒 Locked Current Access";
  } catch (err) {
    console.error("[AgriAdmin] global resource lock failed:", err);
    if (status) status.textContent = "Could not lock current access. Please try again.";
    if (btn) { btn.disabled = false; btn.textContent = "🔒 Lock Current Access"; }
  }
}

document.getElementById("global-resource-lock-btn")?.addEventListener("click", lockAllCurrentlyUnlockedFiles);

// ============================================
// AUTH
// ============================================
const loginBox = document.getElementById("login-box");
const adminPanel = document.getElementById("admin-panel");
const logoutBtn = document.getElementById("logout-btn");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const adminUserChip = document.getElementById("admin-user-chip");

loginBtn.addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  loginError.classList.add("hidden");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    console.error("[AgriAdmin] login failed:", err);
    loginError.textContent = "Login failed — please check your email and password.";
    loginError.classList.remove("hidden");
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

let currentAdminEmail = "";

onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      const token = await user.getIdTokenResult(true);
      if (token?.claims?.admin !== true) throw new Error("Admin permission required.");
      currentAdminEmail = user.email || "";
      loginBox.classList.add("hidden");
      adminPanel.classList.remove("hidden");
      logoutBtn.classList.remove("hidden");
      if (adminUserChip) adminUserChip.textContent = currentAdminEmail;
      loadResources();
      initAdminNotifications();
    } catch (err) {
      console.warn("[AgriAdmin] authenticated user is not an admin:", err);
      await signOut(auth);
      loginError.textContent = "This account does not have admin permission.";
      loginError.classList.remove("hidden");
    }
  } else {
    loginBox.classList.remove("hidden");
    adminPanel.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    if (adminUserChip) adminUserChip.textContent = "";
    stopAdminNotifications();
  }
});

initAdminNotifyBell(document.getElementById("admin-notify-bell"));
document.getElementById("admin-notify-bell")?.addEventListener("click", clearAdminNotifyBadge);

// ============================================
// FORGOT / RESET PASSWORD
// ============================================
const loginFields = document.getElementById("login-fields");
const resetFields = document.getElementById("reset-fields");
const forgotPasswordLink = document.getElementById("forgot-password-link");
const backToLoginLink = document.getElementById("back-to-login-link");
const sendResetBtn = document.getElementById("send-reset-btn");
const resetEmailInput = document.getElementById("reset-email");
const resetMsg = document.getElementById("reset-msg");

function showResetMsg(text, isError) {
  resetMsg.textContent = text;
  resetMsg.classList.toggle("is-error", !!isError);
  resetMsg.classList.remove("hidden");
}

forgotPasswordLink?.addEventListener("click", () => {
  loginError.classList.add("hidden");
  resetMsg.classList.add("hidden");
  resetEmailInput.value = document.getElementById("login-email").value.trim();
  loginFields.classList.add("hidden");
  resetFields.classList.remove("hidden");
});

backToLoginLink?.addEventListener("click", () => {
  resetMsg.classList.add("hidden");
  resetFields.classList.add("hidden");
  loginFields.classList.remove("hidden");
});

sendResetBtn?.addEventListener("click", async () => {
  const email = resetEmailInput.value.trim();
  resetMsg.classList.add("hidden");
  if (!email) {
    showResetMsg("Please enter your email address.", true);
    return;
  }
  sendResetBtn.disabled = true;
  sendResetBtn.textContent = "Sending…";
  try {
    await sendPasswordResetEmail(auth, email);
    showResetMsg("✅ If an account exists for that email, a reset link is on its way — check your inbox.", false);
  } catch (err) {
    console.error("[AgriAdmin] password reset failed:", err);
    // Avoid confirming/denying whether an account exists for this email.
    showResetMsg("✅ If an account exists for that email, a reset link is on its way — check your inbox.", false);
  } finally {
    sendResetBtn.disabled = false;
    sendResetBtn.textContent = "Send Reset Link";
  }
});

// ============================================
// TABS
// ============================================
const list = document.getElementById("admin-resource-list");
const termList = document.getElementById("admin-term-list");
const timelineList = document.getElementById("admin-timeline-list");
const regList = document.getElementById("admin-registrations-list");
const msgList = document.getElementById("admin-messages-list");
const classroomCodesList = document.getElementById("admin-classroom-codes-list");
const adUnlocksList = document.getElementById("admin-ad-unlocks-list");
const coffeeRequestsList = document.getElementById("admin-coffee-requests-list");
const folderAccessList = document.getElementById("admin-folder-access-list");
const blogList = document.getElementById("admin-blog-list");
const facultyList = document.getElementById("admin-faculty-list");
const facultyReviewsList = document.getElementById("admin-faculty-reviews-list");

// Caches of last-loaded docs, keyed by id — used to populate the "Edit any content" modal
// without a second round-trip to Firestore.
const resourcesCache = {};
const termsCache = {};
const timelineCache = {};
const registrationsCache = {};
const blogCache = {};

const tabs = {
  resources: { btn: document.getElementById("tab-resources"), panel: document.getElementById("resources-panel"), load: loadResources },
  blog: { btn: document.getElementById("tab-blog"), panel: document.getElementById("blog-panel"), load: loadBlogPosts },
  terms: { btn: document.getElementById("tab-terms"), panel: document.getElementById("terms-panel"), load: loadTerms },
  registrations: { btn: document.getElementById("tab-registrations"), panel: document.getElementById("registrations-panel"), load: loadRegistrations },
  manualUnlock: { btn: document.getElementById("tab-manual-unlock"), panel: document.getElementById("manual-unlock-panel"), load: initManualUnlock },
  timeline: { btn: document.getElementById("tab-timeline"), panel: document.getElementById("timeline-panel"), load: loadTimeline },
  messages: { btn: document.getElementById("tab-messages"), panel: document.getElementById("messages-panel"), load: loadMessages },
  notifyUser: { btn: document.getElementById("tab-notify-user"), panel: document.getElementById("notify-user-panel"), load: loadNotifyUser },
  classroomCodes: { btn: document.getElementById("tab-classroom-codes"), panel: document.getElementById("classroom-codes-panel"), load: loadClassroomCodes },
  coffeeRequests: { btn: document.getElementById("tab-coffee-requests"), panel: document.getElementById("coffee-requests-panel"), load: loadCoffeeRequests },
  folderAccess: { btn: document.getElementById("tab-folder-access"), panel: document.getElementById("folder-access-panel"), load: loadFolderAccess },
  faculty: { btn: document.getElementById("tab-faculty"), panel: document.getElementById("faculty-panel"), load: loadFaculty },
  facultyReviews: { btn: document.getElementById("tab-faculty-reviews"), panel: document.getElementById("faculty-reviews-panel"), load: loadFacultyReviews },
  danger: { btn: document.getElementById("tab-danger"), panel: document.getElementById("danger-panel"), load: () => {} }
};

const adminPageTitle = document.getElementById("admin-page-title");

// Status filters — each one just re-runs its panel's loader, which reads the
// current dropdown value itself.
wireFilterControls(["resource-status-filter", "resource-section-filter"], () => loadResources());
wireFilterControls(["blog-status-filter"], () => loadBlogPosts());
wireFilterControls(["term-status-filter"], () => loadTerms());
wireFilterControls(["registration-status-filter", "registration-search"], () => loadRegistrations());
wireFilterControls(["faculty-review-status-filter"], () => loadFacultyReviews());

Object.entries(tabs).forEach(([key, tab]) => {
  tab.btn.addEventListener("click", () => {
    Object.values(tabs).forEach(t => {
      t.btn.classList.remove("is-active");
      t.panel.classList.add("hidden");
    });
    tab.btn.classList.add("is-active");
    tab.panel.classList.remove("hidden");
    clearAdminTabBlink(tab.btn.id);
    if (adminPageTitle) adminPageTitle.textContent = tab.btn.dataset.label || key;
    tab.load();
  });
});

// Activate the first tab by default so the sidebar/topbar reflect the initial panel shown.
tabs.resources.btn.classList.add("is-active");
if (adminPageTitle) adminPageTitle.textContent = tabs.resources.btn.dataset.label || "Resources";

// ============================================
// MANUAL UNLOCK — Grant Access to Users
// ============================================
async function initManualUnlock() {
  const form = document.getElementById("manual-unlock-form");
  const presetBtns = document.querySelectorAll(".mu-preset-btn");
  const daysInput = document.getElementById("mu-days");
  
  if (!form) return;

  // Preset day buttons
  presetBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      daysInput.value = btn.dataset.days;
      // Highlight selected
      presetBtns.forEach(b => b.style.background = "white");
      btn.style.background = "var(--leaf-50)";
    });
  });

  // Registered-student search: name, Student ID, or email. Selecting a result fills the hidden email field used by the grant logic.
  const searchInput = document.getElementById("mu-user-search");
  const results = document.getElementById("mu-user-results");
  let registeredCache = [];
  async function loadStudentSearch() {
    if (registeredCache.length) return registeredCache;
    const snap = await getDocs(query(collection(db, "registrations"), limit(300)));
    registeredCache = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    return registeredCache;
  }
  searchInput?.addEventListener("input", async () => {
    const term = searchInput.value.trim().toLowerCase();
    if (!term) { results?.classList.add("hidden"); return; }
    try {
      const users = await loadStudentSearch();
      const matches = users.filter(u => [u.fullName,u.email,u.studentIdNumber,u.studentId].some(v => String(v||"").toLowerCase().includes(term))).slice(0,20);
      if (!results) return;
      results.innerHTML = matches.length ? matches.map(u => `<button type="button" class="mu-result" data-email="${esc(u.email||"")}" style="display:block;width:100%;text-align:left;padding:.65rem .75rem;border:0;border-bottom:1px solid var(--line);background:#fff;cursor:pointer"><strong>${esc(u.fullName||"Student")}</strong><br><small>${esc(u.studentIdNumber||u.studentId||"")} · ${esc(u.email||"")}</small></button>`).join("") : `<div style="padding:.7rem;color:var(--moss-600);font-size:.82rem">No registered student found.</div>`;
      results.classList.remove("hidden");
      results.querySelectorAll(".mu-result").forEach(btn => btn.addEventListener("click", () => { document.getElementById("mu-user-email").value = btn.dataset.email; searchInput.value = btn.textContent.split("\n")[0].trim(); results.classList.add("hidden"); }));
    } catch (err) { console.error("[Manual Unlock] search failed",err); }
  });

  // Form submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const email = document.getElementById("mu-user-email").value.trim().toLowerCase();
    const days = parseInt(document.getElementById("mu-days").value);
    const unlockType = document.getElementById("mu-unlock-type").value;
    const reason = document.getElementById("mu-reason").value || "Admin manual unlock";

    if (!email || !days || !unlockType) {
      alert("Please fill all required fields");
      return;
    }

    if (days < 1 || days > 365) {
      alert("Days must be between 1 and 365");
      return;
    }

    await grantManualUnlock(email, days, unlockType, reason);
  });

  // Load history
  await loadUnlockHistory();
}

async function grantManualUnlock(email, days, unlockType, reason) {
  try {
    const normalizedEmail = normalizeEmail(email);

    // Students live in "registrations" (see js/login.js, js/resources.js) —
    // there is no separate "users" collection in this app.
    let regSnap = await getDocs(query(collection(db, "registrations"), where("email", "==", normalizedEmail)));
    if (regSnap.empty) regSnap = await getDocs(query(collection(db, "registrations"), where("emailNormalized", "==", normalizedEmail)));

    if (regSnap.empty) {
      alert("❌ User not found. Make sure email is registered.");
      return;
    }

    const userData = regSnap.docs[0].data();
    const durationMs = days * 24 * 60 * 60 * 1000;
    // "all_resources" grants everywhere (no category filter); the three
    // specific options scope the grant to that one section only — see the
    // category check in js/access.js computeFileAccessStatus().
    const category = unlockType === "all_resources" ? null : unlockType;

    // This is the record js/resources.js reads (kind: "manual") to
    // actually compute the student's live access — see getResourceAccessState()
    // there and the "manual" branch in js/access.js.
    await addDoc(collection(db, "manualUnlocks"), {
      fromEmail: normalizedEmail,
      studentName: userData.fullName || userData.studentName || "Unknown",
      userEmail: normalizedEmail,
      kind: "manual",
      category,
      unlockType,
      days,
      durationMs,
      reason,
      grantedAt: serverTimestamp(),
      grantedBy: getCurrentUserEmail()
    });

    // Immediately mirror the grant into the registration access fields used
    // by storage.rules, so the manual unlock works without waiting for the
    // student to open Profile first.
    await syncStudentAccessStatus(db, normalizedEmail);

    alert(`✅ Access granted to ${userData.fullName || normalizedEmail} for ${days} days!`);

    // Reset form
    document.getElementById("manual-unlock-form").reset();
    document.getElementById("mu-days").value = "";
    document.querySelectorAll(".mu-preset-btn").forEach(b => b.style.background = "white");

    // Reload history
    await loadUnlockHistory();

  } catch (err) {
    console.error("[Manual Unlock] Error:", err);
    alert(`❌ Error granting access: ${err.message}`);
  }
}

async function loadUnlockHistory() {
  const historyEl = document.getElementById("mu-history");
  if (!historyEl) return;

  try {
    // Load recent manual unlocks
    const unlocksSnap = await getDocs(
      query(
        collection(db, "manualUnlocks"),
        orderBy("grantedAt", "desc"),
        limit(50)
      )
    );

    if (unlocksSnap.empty) {
      historyEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>No manual unlocks yet</p>";
      return;
    }

    let html = "<h3 style='font-size:1rem;margin-bottom:1rem;'>Recent Unlocks</h3>";
    html += "<div style='border-top:1px solid var(--line);'>";

    unlocksSnap.docs.forEach(docSnap => {
      const data = docSnap.data();
      const granted = fmtAdminDate(data.grantedAt);
      const typeEmoji = data.unlockType === "all_resources" ? "🔓" : data.unlockType === "hand_notes" ? "📝" : data.unlockType === "class_slides" ? "🖥️" : "🖼️";

      html += `
        <div style='padding:.8rem;border-bottom:1px solid var(--line);'>
          <p style='margin:0 0 .3rem;font-weight:600;'>${typeEmoji} ${esc(data.studentName)}</p>
          <p style='margin:0 0 .2rem;font-size:.85rem;color:var(--moss-600);'>${esc(data.userEmail)}</p>
          <p style='margin:0 0 .2rem;font-size:.85rem;color:var(--moss-600);'>${data.days} days | Granted: ${granted}</p>
          <p style='margin:0;font-size:.8rem;color:var(--moss-500);'>Reason: ${esc(data.reason || "—")}</p>
        </div>
      `;
    });

    html += "</div>";
    historyEl.innerHTML = html;

  } catch (err) {
    console.error("[Load History] Error:", err);
  }
}

// ============================================
// COFFEE SUPPORT REQUESTS
// ============================================
async function loadCoffeeRequests() {
  if (!coffeeRequestsList) return;
  coffeeRequestsList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "coffeeRequests"), orderBy("submittedAt", "desc"), limit(100)));
    if (snap.empty) { coffeeRequestsList.innerHTML = `<p style="color:var(--moss-600);">No coffee support requests yet.</p>`; return; }
    coffeeRequestsList.innerHTML = "";
    snap.forEach(ds => {
      const d = ds.data(); const approved = d.status === "approved"; const rejected = d.status === "rejected";
      const row = document.createElement("div"); row.className="resource-row";
      row.innerHTML = `<div style="min-width:0;flex:1;">
        <strong>☕ ${esc(d.fromName || "Student")}</strong> <span style="font-size:.8rem;color:var(--moss-600);">${esc(d.fromEmail || "")}</span>
        <div style="font-size:.82rem;margin-top:.35rem;color:var(--moss-700);">bKash: <strong>${esc(d.senderNumber || "—")}</strong> · Amount: <strong>৳${esc(d.amount || "—")}</strong> · Txn: <strong>${esc(d.transactionId || "—")}</strong></div>
        <div style="font-size:.75rem;color:var(--moss-500);margin-top:.2rem;">${esc(formatMessageDateTime(d.submittedAt))} · ${esc(d.status || "pending")}</div>
      </div>
      <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:center;">
        ${approved || rejected ? `<span style="font-size:.75rem;font-weight:700;">${approved ? "✅ Approved" : "❌ Rejected"}</span>` : `<button type="button" class="coffee-approve-btn" data-id="${ds.id}" style="background:var(--leaf-500);color:#fff;border:0;border-radius:7px;padding:.4rem .7rem;cursor:pointer;">Approve & Grant</button><button type="button" class="coffee-reject-btn" data-id="${ds.id}" style="background:none;border:1px solid var(--line);border-radius:7px;padding:.4rem .7rem;cursor:pointer;">Reject</button>`}
      </div>`;
      coffeeRequestsList.appendChild(row);
    });
    coffeeRequestsList.querySelectorAll(".coffee-approve-btn").forEach(btn => btn.addEventListener("click", async () => {
      const days = prompt("How many days of access should be granted?", "7"); if (days === null) return;
      const n = Number(days); if (!Number.isFinite(n) || n < 1 || n > 3650) { alert("Enter a valid duration between 1 and 3650 days."); return; }
      const creditInput = prompt("How many unlock credits should this coffee support grant?", "10"); if (creditInput === null) return; const creditsGranted = Math.max(0, Math.floor(Number(creditInput))); if (!Number.isFinite(creditsGranted) || creditsGranted > 10000) { alert("Enter credits between 0 and 10000."); return; }
      const message = prompt("Message to the student (shown in Profile → Inbox):", "Thank you for buying the admin a coffee! Your access has been granted."); if (message === null) return;
      btn.disabled=true;
      try {
        const ref = doc(db, "coffeeRequests", btn.dataset.id); const snap = await getDocs(query(collection(db,"coffeeRequests"), where("__name__", "==", btn.dataset.id)));
        if (snap.empty) throw new Error("Request not found."); const d=snap.docs[0].data();
        const regSnap = await getDocs(query(collection(db,"registrations"), where("email", "==", normalizeEmail(d.fromEmail || ""))));
        if (regSnap.empty) throw new Error("Registered student not found."); const regId=regSnap.docs[0].id;
        await addDoc(collection(db,"manualUnlocks"), { kind:"manual", source:"coffee", fromEmail:normalizeEmail(d.fromEmail), userEmail:normalizeEmail(d.fromEmail), studentName:d.fromName||"", unlockType:d.targetFileId ? (d.category || "hand_notes") : "all_resources", targetFileId:d.targetFileId || "", category:d.targetFileId ? (d.category || "hand_notes") : null, days:n, durationMs:n*24*60*60*1000, reason:"Buy Me a Coffee", creditsGranted, grantedAt:serverTimestamp(), grantedBy:currentAdminEmail || getCurrentUserEmail() });
        await syncStudentAccessStatus(db, normalizeEmail(d.fromEmail));
        await sendMessageToUser({ toRegId:regId, toEmail:d.fromEmail, toName:d.fromName, subject:"☕ Coffee support access approved", body:message, sentBy:getCurrentUserEmail() });
        await updateDoc(ref, { status:"approved", approvedAt:serverTimestamp(), approvedDays:n, creditsGranted, adminMessage:message, approvedBy:getCurrentUserEmail() });
        loadCoffeeRequests();
      } catch(err) { alert("Could not approve request: " + err.message); btn.disabled=false; }
    }));
    coffeeRequestsList.querySelectorAll(".coffee-reject-btn").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("Reject this coffee support request?")) return;
      try { await updateDoc(doc(db,"coffeeRequests",btn.dataset.id), {status:"rejected", rejectedAt:serverTimestamp(), rejectedBy:getCurrentUserEmail()}); loadCoffeeRequests(); } catch(err){ alert(err.message); }
    }));
  } catch(err) { showLoadError(coffeeRequestsList,"coffee support requests",err); }
}

// ============================================
// LIFETIME FOLDER ACCESS CONTROL
// ============================================
async function loadFolderAccess() {
  if (!folderAccessList) return;
  folderAccessList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const snap = await getDocs(query(collection(db,"folderUnlocks"), orderBy("grantedAt","desc"), limit(100)));
    if (snap.empty) { folderAccessList.innerHTML=`<p style="color:var(--moss-600);">No lifetime folder grants yet.</p>`; return; }
    folderAccessList.innerHTML="";
    snap.forEach(ds=>{ const d=ds.data(); const row=document.createElement("div"); row.className="resource-row";
      row.innerHTML=`<div><strong>${d.category === "class_slides" ? "🖥️" : d.category === "images" ? "🖼️" : "📝"} ${esc(d.courseCode || d.targetFileId || "Folder")}</strong><div style="font-size:.8rem;color:var(--moss-600);margin-top:.2rem;">${esc(d.fromName || d.fromEmail || "Student")} · ${esc(d.category || "")}</div><div style="font-size:.75rem;color:var(--moss-500);margin-top:.2rem;">${d.revoked ? "Locked by admin" : "Lifetime access active"}</div></div><button type="button" class="folder-revoke-btn" data-id="${ds.id}" ${d.revoked ? "disabled" : ""} style="background:${d.revoked ? "#eee" : "var(--terracotta-500)"};color:${d.revoked ? "#777" : "#fff"};border:0;border-radius:7px;padding:.4rem .7rem;cursor:${d.revoked ? "default" : "pointer"};">${d.revoked ? "🔒 Locked" : "🔒 Lock Again"}</button>`; folderAccessList.appendChild(row); });
    folderAccessList.querySelectorAll(".folder-revoke-btn").forEach(btn=>btn.addEventListener("click",async()=>{ if(!confirm("Lock this folder access again? The student's lifetime access from this grant will stop.")) return; btn.disabled=true; try{await updateDoc(doc(db,"folderUnlocks",btn.dataset.id),{revoked:true,revokedAt:serverTimestamp(),revokedBy:getCurrentUserEmail()}); loadFolderAccess();}catch(err){alert(err.message);btn.disabled=false;} }));
  } catch(err){ showLoadError(folderAccessList,"lifetime folder access",err); }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function getCurrentUserEmail() {
  return currentAdminEmail || auth.currentUser?.email || "admin@system";
}

// ============================================
// FILE-TYPE CATEGORIZATION — used to split the admin resources
// list into separate PDF / Images / Other sections.
// ============================================
const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic"];

function getFileExt(name) {
  const clean = String(name || "").split("?")[0];
  const parts = clean.split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

// Decide which of the three student-facing sections a resource belongs in.
// This deliberately mirrors the exact split used by the public Hand Notes
// page (js/resources.js → loadThreeCardLayout), so what the admin sees here
// is what students see there:
//   fileType "image"            → 🖼️ Images
//   noteType "hand_notes"       → 📝 Hand Notes
//   anything else               → 🖥️ Class Slides
// Falls back to sniffing the file extension for very old docs that were
// saved before fileType existed.
function getResourceCategory(item) {
  if (item.fileType === "image") return "image";

  if (!item.fileType) {
    const exts = (item.fileUrls || []).map(f => getFileExt(f.name || f.url));
    if (exts.length && exts.every(e => IMAGE_EXTS.includes(e))) return "image";
  }

  return item.noteType === "hand_notes" ? "hand_notes" : "class_slide";
}

const RESOURCE_SECTIONS = [
  { key: "hand_notes",  title: "Hand Notes",   icon: "📝" },
  { key: "class_slide", title: "Class Slides", icon: "🖥️" },
  { key: "image",       title: "Images",       icon: "🖼️" }
];

function buildResourceRowHTML(d) {
  const item = d.data ? d.data() : d.item;
  const id = d.id;
  return `
    <div>
      <strong>${esc(item.courseCode)} — ${esc(item.courseName) || ""}</strong>
      <div style="font-size:.8rem;color:var(--moss-600);">
        ${item.resourceType === "previous_questions" ? "💡 Suggestion" : "📚 Hand Notes"}
        ${item.examType ? " · " + esc(item.examType) : ""} · ${esc(item.facultyName) || ""}
      </div>
      <div style="font-size:.78rem;color:var(--moss-600);margin-top:.2rem;">By: ${esc(item.uploaderName) || "—"} (${esc(item.uploaderEmail) || "no email"})${item.uploaderStudentId ? ` · Student ID: <strong>${esc(item.uploaderStudentId)}</strong>` : ""}</div>
      <div style="font-size:.76rem;color:var(--moss-500);margin-top:.15rem;">🕒 Uploaded ${esc(formatMessageDateTime(item.uploadedAt || item.submittedAt))} — resource access starts counting from this moment</div>
      <div style="margin-top:.4rem;display:flex;flex-wrap:wrap;gap:.3rem;align-items:center;">
        ${(item.fileUrls || []).map((f, i) => `
          <span style="display:inline-flex;align-items:center;gap:.25rem;">
            <a href="${esc(f.url)}" target="_blank" rel="noopener" style="font-size:.78rem;color:var(--leaf-500);">${esc(f.name)}</a>
            <button type="button" class="delete-file-btn" data-id="${esc(id)}" data-index="${i}" title="Delete this file" style="background:none;border:none;color:var(--terracotta-500);cursor:pointer;font-size:.85rem;line-height:1;padding:0 .15rem;">✕</button>
          </span>`).join("")}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;">
      <select data-id="${esc(id)}" class="status-select">
        <option value="pending" ${item.status === "pending" ? "selected" : ""}>🕓 Pending</option>
        <option value="approved" ${item.status === "approved" ? "selected" : ""}>✅ Approved</option>
        <option value="rejected" ${item.status === "rejected" ? "selected" : ""}>❌ Rejected</option>
      </select>
      <div style="display:flex;gap:.4rem;">
        <button type="button" class="edit-btn" data-schema="resources" data-id="${esc(id)}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✏️ Edit</button>
        ${item.status !== "approved" ? `<button type="button" class="publish-resource-btn" data-id="${esc(id)}" style="background:var(--leaf-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🚀 Publish</button>` : ""}
        <button type="button" class="restrict-account-btn" data-email="${esc(item.uploaderEmail || "")}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;" title="Restrict this uploader's whole account">⛔ Restrict Account</button>
        <button type="button" class="delete-resource-btn" data-id="${esc(id)}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🗑 Delete</button>
      </div>
    </div>`;
}

function buildResourceSectionHTML(title, icon, items) {
  if (items.length === 0) return "";
  const rows = items.map(({ id, item }) =>
    `<div class="resource-row" data-id="${esc(id)}">${buildResourceRowHTML({ id, item })}</div>`
  ).join("");
  return `
    <div class="resource-type-section" style="margin-bottom:1.5rem;">
      <h3 style="font-size:.95rem;text-transform:uppercase;letter-spacing:.04em;color:var(--moss-600);border-bottom:1px solid var(--line);padding-bottom:.4rem;margin-bottom:.6rem;">
        ${icon} ${esc(title)} <span style="font-weight:400;color:var(--moss-600);">(${items.length})</span>
      </h3>
      <div class="resource-section-list" style="display:flex;flex-direction:column;gap:.6rem;">
        ${rows}
      </div>
    </div>`;
}

async function loadResources() {
  list.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "resources"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { list.innerHTML = `<p style="color:var(--moss-600);">No resources submitted yet.</p>`; return; }

    // Filters are read fresh on every load, so changing either dropdown
    // just re-runs this function.
    const statusFilter = document.getElementById("resource-status-filter")?.value || "";
    const sectionFilter = document.getElementById("resource-section-filter")?.value || "";

    const buckets = { hand_notes: [], class_slide: [], image: [] };
    let total = 0;
    let shown = 0;

    snap.forEach(d => {
      const item = d.data();
      resourcesCache[d.id] = item;
      total++;

      const status = item.status || "pending";
      if (statusFilter && status !== statusFilter) return;

      const section = getResourceCategory(item);
      if (sectionFilter && section !== sectionFilter) return;

      buckets[section].push({ id: d.id, item });
      shown++;
    });

    setFilterCount("resource-filter-count", shown, total, "resource");

    if (shown === 0) {
      list.innerHTML = `<div class="admin-empty-state">No resources match this filter. Try widening it above.</div>`;
      return;
    }

    list.innerHTML = RESOURCE_SECTIONS
      .map(s => buildResourceSectionHTML(s.title, s.icon, buckets[s.key]))
      .join("");

    list.querySelectorAll(".edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = resourcesCache[btn.dataset.id];
        if (item) openEditModal("resources", btn.dataset.id, item);
      });
    });

    // Admin can delete an entire resource entry (and every file attached
    // to it) at any time, regardless of its pending/approved/rejected
    // status — there is no status gate on this action.
    list.querySelectorAll(".delete-resource-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this resource and all its files? This cannot be undone.")) return;
        btn.disabled = true;
        try {
          await deleteDoc(doc(db, "resources", btn.dataset.id));
          delete resourcesCache[btn.dataset.id];
          loadResources();
        } catch (err) {
          console.error("[AgriAdmin] resource delete failed:", err);
          alert("Something went wrong deleting this resource: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });

    // Admin can delete a single file out of a multi-file resource entry
    // at any time, without touching the rest of the entry's files.
    list.querySelectorAll(".delete-file-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const index = Number(btn.dataset.index);
        const item = resourcesCache[id];
        if (!item) return;
        const fileUrls = item.fileUrls || [];
        const file = fileUrls[index];
        if (!file) return;
        if (!confirm(`Delete "${file.name}" from this resource?`)) return;
        btn.disabled = true;
        try {
          const updatedFileUrls = fileUrls.filter((_, i) => i !== index);
          if (updatedFileUrls.length === 0) {
            // No files left — remove the whole entry instead of leaving
            // an empty resource behind.
            await deleteDoc(doc(db, "resources", id));
            delete resourcesCache[id];
          } else {
            await updateDoc(doc(db, "resources", id), { fileUrls: updatedFileUrls, editedAt: new Date() });
            item.fileUrls = updatedFileUrls;
          }
          loadResources();
        } catch (err) {
          console.error("[AgriAdmin] file delete failed:", err);
          alert("Something went wrong deleting this file: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });

    // One-click publish: sets status=approved directly (same effect as
    // picking "✅ Approved" from the dropdown, without opening it) — lets
    // the admin review a file and push it live to Resources in one tap.
    list.querySelectorAll(".publish-resource-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Publishing…";
        const id = btn.dataset.id;
        try {
          await updateDoc(doc(db, "resources", id), {
            status: "approved",
            reviewedAt: new Date(),
            rejectedAt: null,
            restrictedUntil: null
          });
          const item = resourcesCache[id];
          if (item) {
            item.status = "approved";
            sendReviewEmail({
              toEmail: item.uploaderEmail,
              toName: item.uploaderName || item.courseCode,
              status: "Approved",
              itemType: item.resourceType === "previous_questions" ? "Suggestion upload" : "Hand Notes upload",
              courseCode: item.courseCode,
              courseName: item.courseName,
              detail: item.fileUrls?.[0]?.name || ""
            });
            await syncStudentAccessStatus(db, item.uploaderEmail);
          }
          loadResources();
        } catch (err) {
          console.error("[AgriAdmin] one-click publish failed:", err);
          alert("Something went wrong publishing this resource: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
          btn.textContent = "🚀 Publish";
        }
      });
    });

    list.querySelectorAll(".restrict-account-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const email = btn.dataset.email;
        if (!email) { alert("This submission has no uploader email to restrict."); return; }
        const daysStr = prompt(`Restrict ${email}'s whole account for how many days?`, "7");
        if (!daysStr) return;
        const days = Number(daysStr);
        if (!Number.isFinite(days) || days <= 0) { alert("Please enter a valid number of days."); return; }
        const reason = prompt("Reason to show the user (optional):", "Irrelevant or false upload") || "";
        btn.disabled = true;
        btn.textContent = "Restricting…";
        try {
          await restrictAccountByEmail(email, days, reason);
          alert(`${email} is now restricted for ${days} day(s).`);
        } catch (err) {
          console.error("[AgriAdmin] restrict-by-email failed:", err);
          alert(err.message || "Something went wrong applying the restriction.");
        } finally {
          btn.disabled = false;
          btn.textContent = "⛔ Restrict Account";
        }
      });
    });

    list.querySelectorAll(".status-select").forEach(sel => {
      sel.addEventListener("change", async (e) => {
        e.target.disabled = true;
        const id = e.target.dataset.id;
        const newStatus = e.target.value;
        try {
          const moderationData = {
            status: newStatus,
            reviewedAt: new Date(),
            ...(newStatus === "rejected"
              ? { rejectedAt: new Date(), restrictedUntil: null }
              : { rejectedAt: null, restrictedUntil: null })
          };
          await updateDoc(doc(db, "resources", id), moderationData);
          e.target.style.borderColor = "var(--leaf-500)";
          const item = resourcesCache[id];
          if (item) {
            const statusLabel = newStatus === "approved" ? "Approved" : newStatus === "rejected" ? "Rejected" : "Pending";
            sendReviewEmail({
              toEmail: item.uploaderEmail,
              toName: item.uploaderName || item.courseCode,
              status: statusLabel,
              itemType: item.resourceType === "previous_questions" ? "Suggestion upload" : "Hand Notes upload",
              courseCode: item.courseCode,
              courseName: item.courseName,
              detail: item.fileUrls?.[0]?.name || ""
            });
            item.status = newStatus;
            // A rejection no longer applies any account-wide restriction
            // (see js/access.js) — it only needs to lock back up the one
            // file this specific upload had unlocked, and re-sync the
            // student's stored access status.
            if (newStatus === "rejected") await revokeFileUnlockForResource(id);
            if (item.uploaderEmail) await syncStudentAccessStatus(db, item.uploaderEmail);
          }
        } catch (err) {
          console.error("[AgriAdmin] resource status update failed:", err);
          alert("Something went wrong updating the status: " + (err && err.message ? err.message : "please try again."));
        }
        finally { e.target.disabled = false; }
      });
    });
  } catch (err) {
    showLoadError(list, "resources", err);
  }
}

// ============================================
// BLOG POSTS
// ============================================
function buildBlogRowHTML(id, item) {
  const created = item.createdAt?.toDate?.()?.toLocaleString?.() || "—";
  // Strip HTML down to plain text for a compact admin preview — the
  // full formatted post (with images) is one click away via "View live".
  const previewDiv = document.createElement("div");
  previewDiv.innerHTML = item.content || "";
  const preview = (previewDiv.textContent || "").slice(0, 220);

  return `
    <div>
      <strong>${esc(item.title)}</strong>
      <div style="font-size:.8rem;color:var(--moss-600);margin-top:.15rem;">
        By: ${esc(item.authorName) || "—"} (${esc(item.authorEmail) || "no email"})${item.authorStudentId ? ` · Student ID: <strong>${esc(item.authorStudentId)}</strong>` : ""}
      </div>
      <div style="font-size:.78rem;color:var(--moss-600);margin-top:.15rem;">${esc(created)}</div>
      <p style="font-size:.85rem;color:var(--moss-900);margin:.5rem 0;">${esc(preview)}${preview.length === 220 ? "…" : ""}</p>
      <div style="font-size:.78rem;color:var(--moss-600);display:flex;gap:.9rem;">
        <span>👁️ ${item.views || 0} views</span>
        <span>❤️ ${item.likesCount || 0} likes</span>
        <span>💬 ${item.commentsCount || 0} comments</span>
        <span>↗️ ${item.sharesCount || 0} shares</span>
      </div>
      <a href="blog.html?post=${esc(id)}" target="_blank" rel="noopener" style="font-size:.8rem;color:var(--leaf-500);font-weight:600;">🔗 View live</a>
    </div>
    <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;">
      <select data-id="${esc(id)}" class="blog-status-select">
        ${item.status === "pending_edit" ? `<option value="pending_edit" selected>📝 Edited (pending review)</option>` : ""}
        <option value="pending" ${item.status === "pending" ? "selected" : ""}>🕓 Not verified</option>
        <option value="approved" ${item.status === "approved" ? "selected" : ""}>✅ Approved</option>
        <option value="rejected" ${item.status === "rejected" ? "selected" : ""}>❌ Rejected (hidden)</option>
      </select>
      <button type="button" class="delete-blog-btn" data-id="${esc(id)}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🗑 Delete</button>
    </div>`;
}

async function loadBlogPosts() {
  blogList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "blogPosts"), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { blogList.innerHTML = `<p style="color:var(--moss-600);">No blog posts submitted yet.</p>`; return; }

    // "pending_edit" gets its OWN bucket — previously it fell through to
    // buckets.pending via the `|| buckets.pending` fallback, so an edited
    // (possibly already-approved) post looked identical to a brand-new,
    // never-reviewed submission with no way to tell them apart.
    const statusFilter = document.getElementById("blog-status-filter")?.value || "";

    const buckets = { pending: [], pending_edit: [], approved: [], rejected: [] };
    let total = 0;
    let shown = 0;

    snap.forEach(d => {
      const item = d.data();
      blogCache[d.id] = item;
      total++;
      // Anything with an unrecognised status is treated as pending, both for
      // bucketing and for filtering, so the two always agree.
      const status = buckets[item.status] ? item.status : "pending";
      if (statusFilter && status !== statusFilter) return;
      buckets[status].push({ id: d.id, item });
      shown++;
    });

    setFilterCount("blog-filter-count", shown, total, "post");

    if (shown === 0) {
      blogList.innerHTML = `<div class="admin-empty-state">No blog posts match this filter. Try widening it above.</div>`;
      return;
    }

    const section = (title, icon, items) => {
      if (items.length === 0) return "";
      const rows = items.map(({ id, item }) =>
        `<div class="resource-row" data-id="${esc(id)}">${buildBlogRowHTML(id, item)}</div>`
      ).join("");
      return `
        <div class="resource-type-section" style="margin-bottom:1.5rem;">
          <h3 style="font-size:.95rem;text-transform:uppercase;letter-spacing:.04em;color:var(--moss-600);border-bottom:1px solid var(--line);padding-bottom:.4rem;margin-bottom:.6rem;">
            ${icon} ${esc(title)} <span style="font-weight:400;color:var(--moss-600);">(${items.length})</span>
          </h3>
          <div class="resource-section-list" style="display:flex;flex-direction:column;gap:.6rem;">${rows}</div>
        </div>`;
    };

    blogList.innerHTML = [
      section("Edited — Pending Review", "📝", buckets.pending_edit),
      section("Not Verified (Pending Review)", "🕓", buckets.pending),
      section("Approved", "✅", buckets.approved),
      section("Rejected", "❌", buckets.rejected)
    ].join("");

    blogList.querySelectorAll(".blog-status-select").forEach(sel => {
      sel.addEventListener("change", async (e) => {
        e.target.disabled = true;
        const id = e.target.dataset.id;
        const newStatus = e.target.value;
        try {
          await updateDoc(doc(db, "blogPosts", id), { status: newStatus, reviewedAt: new Date() });
          const item = blogCache[id];
          if (item) {
            const statusLabel = newStatus === "approved" ? "Approved" : newStatus === "rejected" ? "Rejected" : "Pending";
            sendReviewEmail({
              toEmail: item.authorEmail,
              toName: item.authorName || item.authorEmail,
              status: statusLabel,
              itemType: "Blog post",
              courseCode: item.title,
              courseName: "",
              detail: ""
            });
            item.status = newStatus;
          }
          loadBlogPosts();
            await syncStudentAccessStatus(db, item.uploaderEmail);
        } catch (err) {
          console.error("[AgriAdmin] blog status update failed:", err);
          alert("Something went wrong updating the status: " + (err && err.message ? err.message : "please try again."));
          e.target.disabled = false;
        }
      });
    });

    blogList.querySelectorAll(".delete-blog-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this post permanently, along with all its likes and comments? This cannot be undone.")) return;
        btn.disabled = true;
        try {
          const id = btn.dataset.id;
          const [commentsSnap, likesSnap] = await Promise.all([
            getDocs(query(collection(db, "blogComments"), where("postId", "==", id))),
            getDocs(query(collection(db, "blogLikes"), where("postId", "==", id)))
          ]);
          const batch = writeBatch(db);
          commentsSnap.forEach(d => batch.delete(d.ref));
          likesSnap.forEach(d => batch.delete(d.ref));
          batch.delete(doc(db, "blogPosts", id));
          await batch.commit();
          delete blogCache[id];
          loadBlogPosts();
        } catch (err) {
          console.error("[AgriAdmin] blog delete failed:", err);
          alert("Something went wrong deleting this post: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    showLoadError(blogList, "blog posts", err);
  }
}

// ============================================
// TERMS
// ============================================
async function loadTerms() {
  termList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "terms"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { termList.innerHTML = `<p style="color:var(--moss-600);">No terms submitted yet.</p>`; return; }

    const statusFilter = document.getElementById("term-status-filter")?.value || "";
    let total = 0;
    let shown = 0;

    termList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      termsCache[d.id] = item;
      total++;

      const status = item.status || "pending";
      if (statusFilter && status !== statusFilter) return;
      shown++;

      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div style="display:flex;gap:.8rem;align-items:flex-start;">
          <img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0;">
          <div>
            <strong>${esc(item.name)}</strong>
            ${item.possibleDuplicate ? '<span style="color:var(--terracotta-500);font-size:.75rem;margin-left:.4rem;">⚠️ possible duplicate</span>' : ''}
            <div style="font-size:.8rem;color:var(--moss-600);max-width:380px;margin-top:.2rem;">${esc((item.description || "").slice(0, 140))}${(item.description || "").length > 140 ? "…" : ""}</div>
            <div style="font-size:.78rem;color:var(--moss-600);margin-top:.3rem;">By: ${esc(item.uploaderEmail) || "—"}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;">
          <select data-id="${esc(d.id)}" class="status-select-term">
            <option value="pending" ${item.status === "pending" ? "selected" : ""}>🕓 Pending</option>
            <option value="approved" ${item.status === "approved" ? "selected" : ""}>✅ Approved</option>
            <option value="rejected" ${item.status === "rejected" ? "selected" : ""}>❌ Rejected</option>
          </select>
          <div style="display:flex;gap:.4rem;">
            <button type="button" class="edit-btn" data-schema="terms" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✏️ Edit</button>
            <button type="button" class="delete-term-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🗑 Delete</button>
          </div>
        </div>`;
      termList.appendChild(row);
    });

    setFilterCount("term-filter-count", shown, total, "term");

    if (shown === 0) {
      termList.innerHTML = `<div class="admin-empty-state">No terms match this filter. Try widening it above.</div>`;
      return;
    }

    termList.querySelectorAll(".edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = termsCache[btn.dataset.id];
        if (item) openEditModal("terms", btn.dataset.id, item);
      });
    });

    // Admin can delete any term (and its image) at any time, regardless
    // of pending/approved/rejected status.
    termList.querySelectorAll(".delete-term-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this term entry? This cannot be undone.")) return;
        btn.disabled = true;
        try {
          await deleteDoc(doc(db, "terms", btn.dataset.id));
          delete termsCache[btn.dataset.id];
          loadTerms();
        } catch (err) {
          console.error("[AgriAdmin] term delete failed:", err);
          alert("Something went wrong deleting this term: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });

    termList.querySelectorAll(".status-select-term").forEach(sel => {
      sel.addEventListener("change", async (e) => {
        e.target.disabled = true;
        const id = e.target.dataset.id;
        const newStatus = e.target.value;
        try {
          await updateDoc(doc(db, "terms", id), { status: newStatus, reviewedAt: new Date() });
          e.target.style.borderColor = "var(--leaf-500)";
          const item = termsCache[id];
          if (item) {
            const statusLabel = newStatus === "approved" ? "Approved" : newStatus === "rejected" ? "Rejected" : "Pending";
            sendReviewEmail({
              toEmail: item.uploaderEmail,
              toName: item.name,
              status: statusLabel,
              itemType: "Knowledge Hub term submission",
              courseName: item.name,
              detail: item.name
            });
            item.status = newStatus;
          }
        } catch (err) {
            await syncStudentAccessStatus(db, item.uploaderEmail);
          console.error("[AgriAdmin] term status update failed:", err);
          alert("Something went wrong updating the status: " + (err && err.message ? err.message : "please try again."));
        }
        finally { e.target.disabled = false; }
      });
    });
  } catch (err) {
    showLoadError(termList, "terms", err);
  }
}

// ============================================
// TIMELINE
// ============================================
const TYPE_LABELS = {
  registration: "Registration", advising: "Advising", add_drop: "Add/Drop Deadline",
  class_test: "Class Test", midterm: "Midterm Examination", final: "Final Examination",
  break: "Semester Break", semester_end: "Semester Ends"
};

document.getElementById("add-event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("event-title").value.trim();
  const dateVal = document.getElementById("event-date").value;
  const endDateVal = document.getElementById("event-end-date").value;
  const type = document.getElementById("event-type").value;
  if (!title || !dateVal) return;

  try {
    const docData = { title, date: Timestamp.fromDate(new Date(dateVal + "T00:00:00")), type, createdAt: new Date() };
    if (endDateVal) docData.endDate = Timestamp.fromDate(new Date(endDateVal + "T23:59:59"));
    await addDoc(collection(db, "timeline"), docData);
    document.getElementById("event-title").value = "";
    document.getElementById("event-date").value = "";
    document.getElementById("event-end-date").value = "";
    loadTimeline();
  } catch (err) {
    console.error("[AgriAdmin] add event failed:", err);
    alert("Something went wrong adding this event: " + (err && err.message ? err.message : "please try again."));
  }
});

async function loadTimeline() {
  timelineList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "timeline"), orderBy("date", "asc"));
    const snap = await getDocs(q);

    if (snap.empty) { timelineList.innerHTML = `<p style="color:var(--moss-600);">No events added yet — use the form above.</p>`; return; }

    timelineList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      timelineCache[d.id] = item;
      const dateObj = item.date?.toDate ? item.date.toDate() : new Date(item.date);
      const endObj = item.endDate ? (item.endDate.toDate ? item.endDate.toDate() : new Date(item.endDate)) : null;
      const dateLabel = endObj
        ? `${dateObj.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })} - ${endObj.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}`
        : dateObj.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div>
          <strong>${esc(item.title)}</strong>
          <div style="font-size:.8rem;color:var(--moss-600);">${dateLabel} · ${esc(TYPE_LABELS[item.type] || item.type)}</div>
        </div>
        <div style="display:flex;gap:.5rem;">
          <button type="button" data-id="${esc(d.id)}" class="edit-btn" data-schema="timeline" style="background:none;border:1px solid var(--line);padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem;">✏️ Edit</button>
          <button data-id="${esc(d.id)}" class="delete-event-btn" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.4rem .8rem;border-radius:6px;cursor:pointer;font-size:.8rem;">🗑 Delete</button>
        </div>`;
      timelineList.appendChild(row);
    });

    timelineList.querySelectorAll(".edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = timelineCache[btn.dataset.id];
        if (item) openEditModal("timeline", btn.dataset.id, item);
      });
    });

    timelineList.querySelectorAll(".delete-event-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this event?")) return;
        try { await deleteDoc(doc(db, "timeline", btn.dataset.id)); loadTimeline(); }
        catch (err) {
          console.error("[AgriAdmin] timeline delete failed:", err);
          alert("Something went wrong deleting this event: " + (err && err.message ? err.message : "please try again."));
        }
      });
    });
  } catch (err) {
    showLoadError(timelineList, "timeline events", err);
  }
}

// ============================================
// REGISTRATIONS (student ID verification)
// ============================================
// A registration has no single "status" field — its state is spread across
// idVerified, accountRestrictedUntil and removed — so the filter maps each
// dropdown option onto the right combination. A restriction that has already
// expired doesn't count as restricted.
function matchesRegistrationFilter(item, filter) {
  if (!filter) return true;

  const until = item.accountRestrictedUntil?.toDate
    ? item.accountRestrictedUntil.toDate()
    : (item.accountRestrictedUntil ? new Date(item.accountRestrictedUntil) : null);
  const isRestricted = !!(until && until.getTime() > Date.now());
  const isRemoved = !!item.removed;

  switch (filter) {
    case "verified":   return !!item.idVerified;
    case "unverified": return !item.idVerified;
    case "restricted": return isRestricted;
    case "removed":    return isRemoved;
    case "active":     return !isRestricted && !isRemoved;
    default:           return true;
  }
}

async function loadRegistrations() {
  regList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "registrations"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { regList.innerHTML = `<p style="color:var(--moss-600);">No registrations yet.</p>`; return; }

    const statusFilter = document.getElementById("registration-status-filter")?.value || "";
    const searchTerm = (document.getElementById("registration-search")?.value || "").trim().toLowerCase();
    let total = 0;
    let shown = 0;

    regList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      registrationsCache[d.id] = item;
      total++;

      if (!matchesRegistrationFilter(item, statusFilter)) return;

      if (searchTerm) {
        const haystack = [item.fullName, item.email, item.studentIdNumber]
          .map(v => String(v || "").toLowerCase()).join(" ");
        if (!haystack.includes(searchTerm)) return;
      }
      shown++;

      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div style="display:flex;gap:.8rem;align-items:flex-start;">
          <img src="${esc(item.avatarUrl) || (item.gender === 'female' ? 'assets/avatar-female.svg' : 'assets/avatar-male.svg')}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:50%;flex-shrink:0;">
          ${item.studentIdUrl ? `<a href="${esc(item.studentIdUrl)}" target="_blank" rel="noopener"><img src="${esc(item.studentIdUrl)}" alt="ID" style="width:60px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0;"></a>` : `<div style="width:60px;height:60px;background:var(--paper-100);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:.7rem;color:var(--moss-600);flex-shrink:0;">No ID photo</div>`}
          <div>
            <strong>${esc(item.fullName)}</strong>
            <div style="font-size:.8rem;color:var(--moss-600);">${esc(item.gender) || "—"}</div>
            <div style="font-size:.78rem;color:var(--moss-600);margin-top:.2rem;">✉️ ${esc(item.email) || "—"}</div>
            ${item.studentIdNumber ? `<div style="font-size:.78rem;color:var(--moss-600);">ID #: ${esc(item.studentIdNumber)}</div>` : ""}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;">
          <span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(63,91,61,.10);color:var(--moss-700);font-size:.78rem;font-weight:600;">✅ OTP Verified · Auto-approved</span>
          ${item.idVerified
            ? `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:linear-gradient(135deg,rgba(107,155,94,.22),rgba(63,91,61,.18));color:var(--leaf-500);font-size:.78rem;font-weight:700;">🟢 ID Verified</span>`
            : `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(214,171,74,.15);color:var(--wheat-400);font-size:.78rem;font-weight:600;">🕓 ID Not Verified</span>`}
          ${(() => {
            const now = Date.now();
            const accessUntilMs = item.accessUntil?.toDate?.()?.getTime?.() || 0;
            const restrictedUntilMs = item.restrictedUntil?.toDate?.()?.getTime?.() || 0;
            if (item.restricted && restrictedUntilMs > now) {
              return `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(196,90,63,.12);color:var(--terracotta-500);font-size:.78rem;font-weight:600;">🚫 Uploads Restricted until ${esc(formatMessageDateTime(item.restrictedUntil))}</span>`;
            }
            if (accessUntilMs > now) {
              return `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(107,155,94,.15);color:var(--leaf-500);font-size:.78rem;font-weight:600;">🔓 Resource Access until ${esc(formatMessageDateTime(item.accessUntil))}</span>`;
            }
            if (item.lastAccessSyncAt) {
              return `<span style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(214,171,74,.15);color:var(--wheat-400);font-size:.78rem;font-weight:600;">🔒 No Active Access</span>`;
            }
            return "";
          })()}
          ${item.accountRestrictedUntil ? `<span class="account-restriction-badge" style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(196,90,63,.12);color:var(--terracotta-500);font-size:.78rem;font-weight:600;">⛔ Restricted until ${esc(fmtAdminDate(item.accountRestrictedUntil))}</span>` : ""}
          ${item.removed ? `<span class="user-removed-badge" style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(196,90,63,.14);color:var(--terracotta-500);font-size:.78rem;font-weight:700;">🚫 Removed${item.removedAt ? ` · ${esc(fmtAdminDate(item.removedAt))}` : ""}</span>` : ""}
          <div class="credits-info-row" data-credits-for="${esc(d.id)}" style="font-size:.76rem;color:var(--moss-600);"></div>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" class="credits-info-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">💳 Credits</button>
            <button type="button" class="edit-btn" data-schema="registrations" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✏️ Edit</button>
            ${item.idVerified
              ? `<button type="button" class="unverify-id-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--line);color:var(--moss-600);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">↩️ Unverify</button>`
              : `<button type="button" class="verify-id-btn" data-id="${esc(d.id)}" style="background:var(--leaf-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🟢 Mark Verified</button>`}
            ${item.accountRestrictedUntil
              ? `<button type="button" class="unrestrict-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" style="background:none;border:1px solid var(--leaf-500);color:var(--leaf-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✅ Lift Restriction</button>`
              : `<button type="button" class="restrict-week-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">⛔ Restrict 7d</button>
                 <button type="button" class="restrict-custom-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">⛔ Custom…</button>`}
            ${item.removed
              ? `<button type="button" class="restore-user-btn" data-id="${esc(d.id)}" data-name="${esc(item.fullName || "")}" style="background:var(--leaf-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600;">↩️ Restore User</button>
                 <button type="button" class="erase-user-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" data-name="${esc(item.fullName || "")}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.72rem;">🗑️ Erase Permanently</button>`
              : `<button type="button" class="remove-user-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" data-name="${esc(item.fullName || "")}" style="background:var(--terracotta-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600;">🗑️ Remove User</button>`}
          </div>
        </div>`;
      regList.appendChild(row);
    });

    setFilterCount("registration-filter-count", shown, total, "user");

    if (shown === 0) {
      regList.innerHTML = `<div class="admin-empty-state">No registered users match this filter. Try widening it above.</div>`;
      return;
    }

    // Shows the earned/used/available credit balance for one student, for
    // all users — computed via the same single canonical formula in
    // js/credits.js used on their own profile page, so the number an
    // admin sees here is always the same one the student sees. Fetched
    // lazily per row (not for the whole list at once) since it's several
    // extra queries per student.
    regList.querySelectorAll(".credits-info-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { id, email } = btn.dataset;
        const target = regList.querySelector(`.credits-info-row[data-credits-for="${CSS.escape(id)}"]`);
        if (!target) return;
        btn.disabled = true;
        target.textContent = "Loading credits…";
        try {
          const { earned, used, available } = await computeCreditsBalance(email);
          target.innerHTML = `💰 Earned <strong>${earned}</strong> − Used <strong>${used}</strong> = <strong style="color:var(--leaf-500);">${available} available</strong>`;
        } catch (err) {
          console.error("[AgriAdmin] failed to load credits:", err);
          target.textContent = "Could not load credits.";
        } finally {
          btn.disabled = false;
        }
      });
    });

    regList.querySelectorAll(".remove-user-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { id, name, email } = btn.dataset;
        if (!confirm(
          `Remove ${name || email || "this user"}'s account? They'll no longer be able to log in, ` +
          `but everything they've submitted (uploads, terms, blog posts, classroom codes, messages) is kept, ` +
          `and you can restore this account any time from this same list.`
        )) return;

        btn.disabled = true;
        btn.textContent = "Removing…";
        try {
          await removeUserAccount(id);
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] failed to remove user:", err);
          alert("Something went wrong removing this user: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
          btn.textContent = "🗑️ Remove User";
        }
      });
    });

    regList.querySelectorAll(".restore-user-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { id, name } = btn.dataset;
        if (!confirm(`Restore ${name || "this user"}'s account? They'll be able to log in again immediately.`)) return;
        btn.disabled = true;
        btn.textContent = "Restoring…";
        try {
          await restoreUserAccount(id);
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] failed to restore user:", err);
          alert("Something went wrong restoring this user: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
          btn.textContent = "↩️ Restore User";
        }
      });
    });

    regList.querySelectorAll(".erase-user-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const { id, email, name } = btn.dataset;
        const typed = prompt(
          `This PERMANENTLY deletes ${name || email || "this user"}'s account and everything they submitted ` +
          `(uploads, terms, blog posts, classroom codes, messages). Unlike "Remove User", this cannot be undone.\n\n` +
          `Type ERASE to confirm.`
        );
        if (typed !== "ERASE") return;

        btn.disabled = true;
        btn.textContent = "Erasing…";
        try {
          await deleteUserFully(id, email);
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] failed to erase user:", err);
          alert("Something went wrong erasing this user: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
          btn.textContent = "🗑️ Erase Permanently";
        }
      });
    });

    regList.querySelectorAll(".edit-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = registrationsCache[btn.dataset.id];
        if (item) openEditModal("registrations", btn.dataset.id, item);
      });
    });

    regList.querySelectorAll(".verify-id-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Verifying…";
        try {
          await updateDoc(doc(db, "registrations", btn.dataset.id), {
            idVerified: true,
            idVerifiedAt: new Date()
          });
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] ID verify failed:", err);
          alert("Something went wrong marking this profile verified: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
          btn.textContent = "🟢 Mark Verified";
        }
      });
    });

    regList.querySelectorAll(".unverify-id-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Remove the verified badge from this profile?")) return;
        btn.disabled = true;
        try {
          await updateDoc(doc(db, "registrations", btn.dataset.id), {
            idVerified: false,
            idVerifiedAt: null
          });
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] ID unverify failed:", err);
          alert("Something went wrong: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });

    async function applyAccountRestriction(id, days, reason, email) {
      try {
        await restrictAccountById(id, days, reason, email);
        loadRegistrations();
      } catch (err) {
        console.error("[AgriAdmin] account restriction failed:", err);
        alert("Something went wrong applying the restriction: " + (err && err.message ? err.message : "please try again."));
      }
    }

    regList.querySelectorAll(".restrict-week-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!confirm("Restrict this account for 7 days? They'll see a freeze screen, all of their unlocked files will be locked again, and their credit balance will be wiped.")) return;
        applyAccountRestriction(btn.dataset.id, 7, "Restricted for 7 days by admin", btn.dataset.email);
      });
    });

    regList.querySelectorAll(".restrict-custom-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const daysStr = prompt("Restrict this account for how many days?", "14");
        if (!daysStr) return;
        const days = Number(daysStr);
        if (!Number.isFinite(days) || days <= 0) { alert("Please enter a valid number of days."); return; }
        const reason = prompt("Reason to show the user (optional):", "") || "";
        applyAccountRestriction(btn.dataset.id, days, reason, btn.dataset.email);
      });
    });

    regList.querySelectorAll(".unrestrict-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Lift this account's restriction now? This is a fresh start, not a restore: their credit balance stays at zero and every file they had unlocked stays locked. They keep full access to the site again and can start earning/unlocking from scratch.")) return;
        btn.disabled = true;
        try {
          // Re-run both penalties on lift too (not just at restrict time)
          // so this button is always the final word on "fresh start" —
          // covers the account-wide restrict path already having done
          // this, and also any classroom-codes/manual-unlocks admin.js
          // granted straight through the restriction window.
          await Promise.all([
            deductFullCreditBalance(btn.dataset.id, btn.dataset.email),
            revokeAllUnlocksForEmail(btn.dataset.email)
          ]);
          await updateDoc(doc(db, "registrations", btn.dataset.id), {
            accountRestrictedUntil: null,
            accountRestrictedReason: "",
            accountRestrictedAt: null
          });
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] lift restriction failed:", err);
          alert("Something went wrong lifting the restriction: " + (err && err.message ? err.message : "please try again."));
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    showLoadError(regList, "registrations", err);
  }
}

// ============================================
// MESSAGES (Ask For Help submissions)
// ============================================
async function loadMessages() {
  msgList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "messages"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { msgList.innerHTML = `<p style="color:var(--moss-600);">No messages yet.</p>`; return; }

    msgList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div>
          <strong>${esc(item.name)}</strong> <span style="font-size:.8rem;color:var(--moss-600);">(${esc(item.email)})</span>
          <div style="font-size:.78rem;color:var(--moss-500);margin-top:.15rem;">🕒 ${esc(formatMessageDateTime(item.submittedAt))}</div>
          <div style="font-size:.85rem;color:var(--moss-700);margin-top:.3rem;max-width:480px;">${esc(item.message)}</div>
        </div>`;
      msgList.appendChild(row);
    });
  } catch (err) {
    showLoadError(msgList, "messages", err);
  }
}

// ============================================
// NOTIFY USER — search a student, send them a message, and track
// whether they've read it (js/inbox.js). One-way admin -> student
// channel: shows up in the student's Profile -> Inbox.
// ============================================
let nuAllUsers = null;      // cached { id, ...data } list of registrations, loaded lazily
let nuSelected = null;      // { id, data } of the currently selected recipient

async function loadAllRegistrationsForSearch() {
  if (nuAllUsers) return nuAllUsers;
  const snap = await getDocs(query(collection(db, "registrations"), orderBy("submittedAt", "desc")));
  nuAllUsers = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  return nuAllUsers;
}

function nuRenderSearchResults(matches) {
  const box = document.getElementById("nu-search-results");
  if (!matches.length) {
    box.innerHTML = `<div style="padding:.7rem .9rem;font-size:.85rem;color:var(--moss-600);">No matching students.</div>`;
    box.classList.remove("hidden");
    return;
  }
  box.innerHTML = matches.slice(0, 8).map(({ id, data }) => `
    <button type="button" class="nu-result-item" data-id="${esc(id)}"
      style="display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;padding:.6rem .9rem;background:none;border:none;border-bottom:1px solid var(--line);cursor:pointer;">
      <img src="${esc(data.avatarUrl) || (data.gender === 'female' ? 'assets/avatar-female.svg' : 'assets/avatar-male.svg')}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">
      <span style="min-width:0;">
        <span style="display:block;font-weight:600;font-size:.85rem;">${esc(data.fullName) || "—"}</span>
        <span style="display:block;font-size:.75rem;color:var(--moss-600);">${esc(data.email) || "—"}${data.studentIdNumber ? " · ID: " + esc(data.studentIdNumber) : ""}</span>
      </span>
    </button>`).join("");
  box.classList.remove("hidden");

  box.querySelectorAll(".nu-result-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const match = matches.find(m => m.id === btn.dataset.id);
      if (match) nuSelectUser(match.id, match.data);
      box.classList.add("hidden");
      document.getElementById("nu-search-input").value = "";
    });
  });
}

function nuSelectUser(id, data) {
  nuSelected = { id, data };
  document.getElementById("nu-selected-user").classList.remove("hidden");
  document.getElementById("nu-selected-avatar").src = data.avatarUrl || (data.gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg");
  document.getElementById("nu-selected-name").textContent = data.fullName || "—";
  document.getElementById("nu-selected-meta").textContent = `${data.email || "—"}${data.studentIdNumber ? " · ID: " + data.studentIdNumber : ""}`;
}

function nuClearSelection() {
  nuSelected = null;
  document.getElementById("nu-selected-user").classList.add("hidden");
}

function nuStatus(msg, isError = false) {
  const el = document.getElementById("nu-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
}

function nuRenderSentList(messages) {
  const listEl = document.getElementById("nu-sent-list");
  if (!listEl) return;
  if (!messages.length) {
    listEl.innerHTML = `<p style="color:var(--moss-600);">No messages sent yet.</p>`;
    return;
  }
  listEl.innerHTML = messages.map(item => {
    const readBadge = item.read
      ? `<span style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .6rem;border-radius:999px;background:rgba(107,155,94,.15);color:var(--leaf-500);font-size:.75rem;font-weight:700;">✅ Read${item.readAt ? " · " + esc(formatMessageDateTime(item.readAt)) : ""}</span>`
      : `<span style="display:inline-flex;align-items:center;gap:.3rem;padding:.25rem .6rem;border-radius:999px;background:rgba(214,171,74,.18);color:var(--wheat-400);font-size:.75rem;font-weight:700;">📬 Unread</span>`;
    return `
      <div class="resource-row">
        <div style="min-width:0;">
          <div style="font-size:.85rem;color:var(--moss-600);">To: <strong style="color:var(--moss-900);">${esc(item.toName) || "—"}</strong> (${esc(item.toEmail) || "—"})</div>
          <div style="font-size:.78rem;color:var(--moss-500);margin-top:.15rem;">🕒 Sent ${esc(formatMessageDateTime(item.sentAt))}${item.sentBy ? " · by " + esc(item.sentBy) : ""}</div>
          <p style="font-size:.85rem;color:var(--moss-900);margin:.5rem 0 0;max-width:480px;">${esc(item.body)}</p>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.4rem;">
          ${readBadge}
        </div>
      </div>`;
  }).join("");
}

async function loadNotifyUser() {
  const sentList = document.getElementById("nu-sent-list");
  if (sentList) sentList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const messages = await fetchAllSentMessages();
    nuRenderSentList(messages);
  } catch (err) {
    if (sentList) showLoadError(sentList, "sent messages", err);
  }
}

function initNotifyUser() {
  const searchInput = document.getElementById("nu-search-input");
  const resultsBox = document.getElementById("nu-search-results");
  const clearBtn = document.getElementById("nu-selected-clear");
  const form = document.getElementById("nu-compose-form");
  if (!searchInput || !form) return;

  let debounceTimer;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const term = searchInput.value.trim().toLowerCase();
    if (!term) { resultsBox.classList.add("hidden"); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const all = await loadAllRegistrationsForSearch();
        const matches = all.filter(({ data }) => {
          const haystack = [data.fullName, data.email, data.studentIdNumber].map(v => String(v || "").toLowerCase()).join(" ");
          return haystack.includes(term);
        });
        nuRenderSearchResults(matches);
      } catch (err) {
        console.error("[AgriAdmin] user search failed:", err);
        resultsBox.innerHTML = `<div style="padding:.7rem .9rem;font-size:.85rem;color:var(--terracotta-500);">Search failed. Please try again.</div>`;
        resultsBox.classList.remove("hidden");
      }
    }, 200);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".notify-user-search-wrap")) resultsBox.classList.add("hidden");
  });

  clearBtn?.addEventListener("click", nuClearSelection);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!nuSelected) {
      nuStatus("Please search for and select a student first.", true);
      return;
    }
    const body = document.getElementById("nu-body").value;
    const sendBtn = document.getElementById("nu-send-btn");

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    nuStatus("Sending…");

    try {
      await sendMessageToUser({
        toRegId: nuSelected.id,
        toEmail: nuSelected.data.email,
        toName: nuSelected.data.fullName,
        body,
        sentBy: currentAdminEmail
      });
      nuStatus(`✅ Message sent to ${nuSelected.data.fullName || nuSelected.data.email}.`);
      form.reset();
      nuClearSelection();
      loadNotifyUser();
    } catch (err) {
      console.error("[AgriAdmin] failed to send message:", err);
      nuStatus(err.message || "Something went wrong sending this message.", true);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "✉️ Send Message";
    }
  });
}

initNotifyUser();

// ============================================
// CLASSROOM CODES ("Send Us Classroom Code" submissions, resources.html)
// ============================================
// ============================================
// FACULTY — Teacher Recommendation directory
// ============================================
const TAG_LABELS = {
  clear_explanations: "💡 Clear Explanations",
  fair_grading: "⚖️ Fair Grading",
  approachable: "🙂 Approachable",
  encourages_questions: "🙋 Encourages Questions",
  well_organized: "🗂️ Well Organized",
  inspiring: "✨ Inspiring",
  punctual: "⏰ Punctual & Reliable",
  helpful_feedback: "📝 Helpful Feedback"
};

let facultyFormWired = false;
let facultyCache = {};

function parseCourseCodes(raw) {
  return String(raw || "")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

async function loadFaculty() {
  if (!facultyList) return;
  wireFacultyForm();
  facultyList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "faculty"), orderBy("name")));
    if (snap.empty) { facultyList.innerHTML = `<p style="color:var(--moss-600);">No faculty added yet — use the form above.</p>`; return; }

    facultyCache = {};
    facultyList.innerHTML = "";
    snap.forEach(d => {
      const f = d.data();
      facultyCache[d.id] = f;
      const stats = f.stats || {};
      const ratingCount = stats.ratingCount || 0;
      const avgRating = ratingCount > 0 ? (stats.ratingSum / ratingCount).toFixed(1) : "—";
      const isPending = f.status === "pending";
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:.8rem;min-width:0;">
          ${f.photoUrl ? `<img src="${esc(f.photoUrl)}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;">` : `<div style="width:44px;height:44px;border-radius:50%;background:var(--leaf-400);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">${esc((f.name||"?").slice(0,1).toUpperCase())}</div>`}
          <div style="min-width:0;">
            <strong>${esc(f.name)}</strong> ${isPending ? `<span style="display:inline-block;margin-left:.35rem;padding:.15rem .45rem;border-radius:999px;background:rgba(212,162,76,.16);color:var(--wheat-500,var(--wheat-400));font-size:.68rem;font-weight:700;">PENDING</span>` : ""}
            <div style="font-size:.8rem;color:var(--moss-600);">${esc(f.department||"")}${f.designation ? " · " + esc(f.designation) : ""}</div>
            <div style="font-size:.76rem;color:var(--moss-500);margin-top:.15rem;">${(f.courseCodes||[]).map(esc).join(", ") || "No courses linked"} · ⭐ ${avgRating} (${stats.reviewCount||0} reviews) · 👍 ${stats.recommendCount||0} recommend</div>
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;justify-content:flex-end;">
          ${isPending ? `<button type="button" class="faculty-approve-btn" data-id="${d.id}" style="background:var(--leaf-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✅ Approve</button>` : ""}
          <button type="button" class="faculty-edit-btn" data-id="${d.id}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✏️ Edit</button>
          <button type="button" class="btn-danger faculty-delete-btn" data-id="${d.id}" style="padding:.35rem .7rem;font-size:.78rem;">🗑 Delete</button>
        </div>`;
      facultyList.appendChild(row);
    });

    facultyList.querySelectorAll(".faculty-approve-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Approving…";
        try {
          await updateDoc(doc(db, "faculty", btn.dataset.id), { status: "approved" });
          loadFaculty();
        } catch (err) {
          console.error(err);
          alert("Could not approve faculty: " + err.message);
          btn.disabled = false;
          btn.textContent = "✅ Approve";
        }
      });
    });

    facultyList.querySelectorAll(".faculty-edit-btn").forEach(btn => {
      btn.addEventListener("click", () => startEditFaculty(btn.dataset.id));
    });
    facultyList.querySelectorAll(".faculty-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this faculty profile? Their existing reviews will remain but will no longer show on a profile page.")) return;
        btn.disabled = true;
        try { await deleteDoc(doc(db, "faculty", btn.dataset.id)); loadFaculty(); }
        catch (err) { console.error(err); alert("Could not delete: " + err.message); btn.disabled = false; }
      });
    });
  } catch (err) {
    console.error("[AgriAdmin] loadFaculty failed:", err);
    facultyList.innerHTML = `<p style="color:var(--terracotta-500);">Could not load faculty: ${esc(err.message)}</p>`;
  }
}

function startEditFaculty(id) {
  const f = facultyCache[id];
  if (!f) return;
  document.getElementById("faculty-form-editing-id").value = id;
  document.getElementById("faculty-name").value = f.name || "";
  document.getElementById("faculty-department").value = f.department || "";
  document.getElementById("faculty-designation").value = f.designation || "";
  document.getElementById("faculty-courses").value = (f.courseCodes || []).join(", ");
  document.getElementById("faculty-form-submit").textContent = "💾 Save Changes";
  document.getElementById("faculty-form-cancel").classList.remove("hidden");
  document.getElementById("faculty-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetFacultyForm() {
  document.getElementById("faculty-form").reset();
  document.getElementById("faculty-form-editing-id").value = "";
  document.getElementById("faculty-form-submit").textContent = "➕ Add Faculty";
  document.getElementById("faculty-form-cancel").classList.add("hidden");
}

function wireFacultyForm() {
  if (facultyFormWired) return;
  facultyFormWired = true;
  const form = document.getElementById("faculty-form");
  const statusEl = document.getElementById("faculty-form-status");
  document.getElementById("faculty-form-cancel").addEventListener("click", resetFacultyForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const editingId = document.getElementById("faculty-form-editing-id").value.trim();
    const name = document.getElementById("faculty-name").value.trim();
    const department = document.getElementById("faculty-department").value.trim();
    const designation = document.getElementById("faculty-designation").value.trim();
    const courseCodes = parseCourseCodes(document.getElementById("faculty-courses").value);
    const photoFile = document.getElementById("faculty-photo").files[0];

    if (!name || !department || courseCodes.length === 0) {
      statusEl.textContent = "Please fill in name, department, and at least one course code.";
      statusEl.style.color = "var(--terracotta-500)";
      return;
    }

    const submitBtn = document.getElementById("faculty-form-submit");
    submitBtn.disabled = true;
    statusEl.style.color = "var(--moss-600)";
    statusEl.textContent = photoFile ? "Uploading photo…" : "Saving…";

    try {
      let photoUrl = editingId ? (facultyCache[editingId] && facultyCache[editingId].photoUrl) || "" : "";
      if (photoFile) {
        photoUrl = await uploadFileToCloudinary(photoFile, pct => { statusEl.textContent = `Uploading photo ${pct}%…`; });
      }
      statusEl.textContent = "Saving…";

      if (editingId) {
        await updateDoc(doc(db, "faculty", editingId), { name, department, designation, courseCodes, photoUrl });
      } else {
        await addDoc(collection(db, "faculty"), {
          name, department, designation, courseCodes, photoUrl, status: "approved",
          stats: { reviewCount: 0, recommendCount: 0, ratingSum: 0, ratingCount: 0, tagCounts: {} },
          createdAt: serverTimestamp()
        });
      }
      statusEl.textContent = "✅ Saved.";
      resetFacultyForm();
      loadFaculty();
    } catch (err) {
      console.error("[AgriAdmin] faculty save failed:", err);
      statusEl.style.color = "var(--terracotta-500)";
      statusEl.textContent = "Could not save: " + err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ============================================
// FACULTY REVIEWS — moderation queue
// ============================================
async function loadFacultyReviews() {
  if (!facultyReviewsList) return;
  const statusFilter = document.getElementById("faculty-review-status-filter")?.value || "pending";
  facultyReviewsList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const clauses = [orderBy("submittedAt", "desc")];
    if (statusFilter) clauses.unshift(where("status", "==", statusFilter));
    const snap = await getDocs(query(collection(db, "facultyReviews"), ...clauses));
    if (snap.empty) { facultyReviewsList.innerHTML = `<p style="color:var(--moss-600);">Nothing here right now.</p>`; return; }

    facultyReviewsList.innerHTML = "";
    snap.forEach(d => {
      const r = d.data();
      const isPending = r.status === "pending";
      const tagsHtml = (r.tags || []).map(t => `<span style="display:inline-block;background:var(--paper-100,#f2eee2);border-radius:999px;padding:.15rem .55rem;font-size:.72rem;margin:.1rem .25rem .1rem 0;">${esc(TAG_LABELS[t] || t)}</span>`).join("");
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div>
          <strong>${esc(r.facultyName || r.facultyId)}</strong>
          <span style="margin-left:.5rem;font-size:.75rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;${isPending ? "background:#FDF3D9;color:#8A6A1A;" : "background:#E4F2E7;color:var(--leaf-600,#2D4A35);"}">${isPending ? "Pending review" : "Approved"}</span>
          ${r.isAnonymous ? `<span style="margin-left:.4rem;font-size:.75rem;color:var(--moss-600);">🙈 Anonymous</span>` : ""}
          <div style="font-size:.83rem;color:var(--moss-700);margin-top:.35rem;">
            ${"⭐".repeat(r.rating || 0)}${"☆".repeat(5 - (r.rating || 0))} · ${r.recommended ? "👍 Recommended" : "🙅 Not recommended"}${r.courseCode ? " · " + esc(r.courseCode) : ""}
          </div>
          <div style="margin-top:.35rem;">${tagsHtml}</div>
          ${r.comment ? `<p style="font-size:.84rem;color:var(--moss-700);margin:.5rem 0 0;background:var(--paper-100,#f2eee2);padding:.5rem .7rem;border-radius:8px;">${esc(r.comment)}</p>` : ""}
          <div style="font-size:.74rem;color:var(--moss-500);margin-top:.4rem;">By ${esc(r.reviewerName || "unknown")} (reg: ${esc(r.reviewerRegId || "—")}) · 🕒 ${esc(formatMessageDateTime(r.submittedAt))}</div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          ${isPending ? `<button type="button" class="faculty-review-approve-btn" data-id="${d.id}" style="background:var(--leaf-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✅ Approve</button>` : ""}
          <button type="button" class="btn-danger faculty-review-delete-btn" data-id="${d.id}" data-pending="${isPending ? "1" : "0"}" style="padding:.35rem .7rem;font-size:.78rem;">🗑 ${isPending ? "Reject" : "Delete"}</button>
        </div>`;
      facultyReviewsList.appendChild(row);
    });

    // Approving a pending (anonymous) review is the moment its rating,
    // recommendation and tags actually start counting toward the
    // faculty's PUBLIC numbers — see js/faculty.js, which does this same
    // increment immediately for signed reviews instead.
    facultyReviewsList.querySelectorAll(".faculty-review-approve-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const reviewRef = doc(db, "facultyReviews", btn.dataset.id);
        try {
          const snap = await getDoc(reviewRef);
          if (!snap.exists()) return;
          const r = snap.data();
          await updateDoc(reviewRef, { status: "approved", approvedAt: serverTimestamp(), approvedBy: getCurrentUserEmail() });
          const statsUpdate = {
            "stats.reviewCount": increment(1),
            "stats.recommendCount": increment(r.recommended ? 1 : 0),
            "stats.ratingSum": increment(r.rating || 0),
            "stats.ratingCount": increment(1)
          };
          (r.tags || []).forEach(t => { statsUpdate[`stats.tagCounts.${t}`] = increment(1); });
          await updateDoc(doc(db, "faculty", r.facultyId), statsUpdate);
          loadFacultyReviews();
        } catch (err) {
          console.error("[AgriAdmin] approve review failed:", err);
          alert("Could not approve: " + err.message);
          btn.disabled = false;
        }
      });
    });
    // Rejecting a still-pending review just deletes it — it never
    // touched the public stats, so nothing to undo there. Deleting an
    // already-approved review (spam cleanup) also does NOT roll back
    // the counters it already contributed; re-run loadFaculty's numbers
    // manually if that ever matters for a specific faculty.
    facultyReviewsList.querySelectorAll(".faculty-review-delete-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm(btn.dataset.pending === "1" ? "Reject and delete this pending review?" : "Delete this approved review? Its counted stats won't be subtracted automatically.")) return;
        btn.disabled = true;
        try { await deleteDoc(doc(db, "facultyReviews", btn.dataset.id)); loadFacultyReviews(); }
        catch (err) { console.error(err); alert("Could not delete: " + err.message); btn.disabled = false; }
      });
    });
  } catch (err) {
    console.error("[AgriAdmin] loadFacultyReviews failed:", err);
    facultyReviewsList.innerHTML = `<p style="color:var(--terracotta-500);">Could not load reviews: ${esc(err.message)}</p>`;
  }
}

async function loadClassroomCodes() {
  classroomCodesList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "classroomCodes"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { classroomCodesList.innerHTML = `<p style="color:var(--moss-600);">No classroom codes submitted yet.</p>`; return; }

    classroomCodesList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      const isApproved = item.status === "approved";
      const isLocked = item.status === "locked";
      const isContacted = item.status === "contacted";
      // "materials_request" = the general "Send Us Your Classroom Code" box
      // (resources.html) — a request to source course materials, NOT an
      // unlock request. It carries no targetFileId and js/access.js is
      // hard-coded to never grant it access, no matter its status here.
      const isMaterialsRequest = item.purpose === "materials_request";
      const statusLabel = isApproved
        ? (isMaterialsRequest ? "Reviewed" : "Approved & Unlocked")
        : isLocked ? "Locked by Admin"
        : isContacted ? "Contacted" : "New";
      const statusStyle = isApproved
        ? "background:#E4F2E7;color:var(--leaf-600,#2D4A35);"
        : isContacted
          ? "background:#EAEAEA;color:#555;"
          : "background:#FDF3D9;color:#8A6A1A;";
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div>
          <span style="display:inline-block;font-family:monospace;font-size:1.05rem;font-weight:700;background:var(--leaf-50,#eef5ee);border:1px solid var(--line);border-radius:6px;padding:.2rem .6rem;">${esc(item.classroomCode)}</span>
          <span style="margin-left:.5rem;font-size:.75rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;${statusStyle}">${statusLabel}</span>
          <div style="font-size:.85rem;color:var(--moss-700);margin-top:.35rem;">
            ${item.fromName ? esc(item.fromName) : "Anonymous"}${item.fromEmail ? ` — ${esc(item.fromEmail)}` : ""}
            <div style="font-size:.76rem;color:var(--moss-500);margin-top:.1rem;">🕒 Submitted ${esc(formatMessageDateTime(item.submittedAt))}${item.approvedAt ? " · approved " + esc(formatMessageDateTime(item.approvedAt)) : ""}</div>
            ${isMaterialsRequest
              ? `<div style="font-size:.78rem;color:#8A6A1A;margin-top:.15rem;">📋 General code for sourcing materials — does not unlock any file</div>`
              : item.targetFileId
                ? `<div style="font-size:.78rem;color:var(--moss-500,#7a8f7d);margin-top:.15rem;">Unlocking one specific file</div>`
                : `<div style="font-size:.78rem;color:var(--moss-500,#7a8f7d);margin-top:.15rem;">⚠️ No specific file — unlocks every file for this student</div>`}
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          ${isApproved && !isMaterialsRequest ? `<button type="button" class="lock-classroom-code-btn" data-id="${d.id}" style="background:var(--terracotta-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🔒 Lock Again</button>` : ""}
          ${isLocked && !isMaterialsRequest ? `<button type="button" class="unlock-classroom-code-btn" data-id="${d.id}" style="background:var(--leaf-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🔓 Unlock Again</button>` : ""}
          ${isApproved || isLocked ? "" : `<button type="button" class="confirm-classroom-code-btn" data-id="${d.id}" data-materials="${isMaterialsRequest ? "1" : "0"}" style="background:var(--leaf-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">${isMaterialsRequest ? "✅ Mark Reviewed" : "✅ Confirm &amp; Unlock"}</button>`}
          ${isApproved || isContacted ? "" : `<button type="button" class="mark-contacted-btn" data-id="${d.id}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">Mark Contacted</button>`}
          <button type="button" class="btn-danger delete-classroom-code-btn" data-id="${d.id}" style="padding:.35rem .7rem;font-size:.78rem;">🗑 Delete</button>
        </div>`;
      classroomCodesList.appendChild(row);
    });

    // Reviewing and confirming a code is what actually unlocks its target
    // file for the student — see js/access.js, which only grants a
    // classroom-code submission access once status is "approved".
    classroomCodesList.querySelectorAll(".confirm-classroom-code-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const isMaterialsRequest = btn.dataset.materials === "1";
        btn.disabled = true;
        try {
          await updateDoc(doc(db, "classroomCodes", btn.dataset.id), { status: "approved", approvedAt: serverTimestamp(), approvedBy:getCurrentUserEmail(), ...(isMaterialsRequest ? {} : { creditsGranted: 10 }) });
          loadClassroomCodes();
        } catch (err) {
          console.error("[AgriAdmin] Failed to confirm classroom code:", err);
          alert("Could not update this classroom code: " + err.message);
          btn.disabled = false;
        }
      });
    });
    classroomCodesList.querySelectorAll(".lock-classroom-code-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Lock this classroom-code access again? The selected file access will become locked for this student.")) return;
        btn.disabled = true;
        try { await updateDoc(doc(db,"classroomCodes",btn.dataset.id),{status:"locked",lockedAt:serverTimestamp(),lockedBy:getCurrentUserEmail()}); loadClassroomCodes(); } catch(err){ console.error(err); alert("Could not lock this code: " + err.message); btn.disabled=false; }
      });
    });
    classroomCodesList.querySelectorAll(".unlock-classroom-code-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { await updateDoc(doc(db,"classroomCodes",btn.dataset.id),{status:"approved",approvedAt:serverTimestamp(),approvedBy:getCurrentUserEmail(),creditsGranted:10}); loadClassroomCodes(); } catch(err){ console.error(err); alert("Could not unlock this code: " + err.message); btn.disabled=false; }
      });
    });
    classroomCodesList.querySelectorAll(".mark-contacted-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await updateDoc(doc(db, "classroomCodes", btn.dataset.id), { status: "contacted" });
          loadClassroomCodes();
        } catch (err) {
          console.error("[AgriAdmin] Failed to update classroom code:", err);
          alert("Could not mark this contacted: " + err.message);
          btn.disabled = false;
        }
      });
    });
    classroomCodesList.querySelectorAll(".delete-classroom-code-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this classroom code submission?")) return;
        btn.disabled = true;
        try {
          await deleteDoc(doc(db, "classroomCodes", btn.dataset.id));
          loadClassroomCodes();
        } catch (err) {
          console.error("[AgriAdmin] Failed to delete classroom code:", err);
          alert("Could not delete this submission: " + err.message);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    showLoadError(classroomCodesList, "classroom codes", err);
  }
}

// ============================================
// AD UNLOCKS ("Unlock by Watching an Ad" submissions, slides-notes.html)
// ============================================
// These already granted 6h access to their targetFileId the instant they
// were created (see js/access.js's `kind === "ad"` branch) — there is no
// approve/reject step here, only visibility for abuse monitoring and a
// delete button to revoke a specific grant early if needed.
async function loadAdUnlocks() {
  if (!adUnlocksList) return;
  adUnlocksList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "adUnlocks"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { adUnlocksList.innerHTML = `<p style="color:var(--moss-600);">No ad unlocks yet.</p>`; return; }

    adUnlocksList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      const when = item.submittedAt?.toDate?.() ? item.submittedAt.toDate().toLocaleString() : "—";
      const row = document.createElement("div");
      row.className = "resource-row";
      row.innerHTML = `
        <div>
          <span style="display:inline-block;font-size:.75rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;background:#E4F2E7;color:var(--leaf-600,#2D4A35);">🎬 Unlocked instantly</span>
          <div style="font-size:.85rem;color:var(--moss-700);margin-top:.35rem;">
            ${item.fromName ? esc(item.fromName) : "Anonymous"}${item.fromEmail ? ` — ${esc(item.fromEmail)}` : ""}
            <div style="font-size:.78rem;color:var(--moss-500,#7a8f7d);margin-top:.15rem;">Watched ${esc(String(item.watchedSeconds ?? "?"))}s · ${esc(when)} · file: <code>${esc(item.targetFileId || "—")}</code></div>
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          <button type="button" class="btn-danger delete-ad-unlock-btn" data-id="${d.id}" style="padding:.35rem .7rem;font-size:.78rem;">🗑 Revoke / Delete</button>
        </div>`;
      adUnlocksList.appendChild(row);
    });

    adUnlocksList.querySelectorAll(".delete-ad-unlock-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this ad-unlock record? This revokes the access it granted.")) return;
        btn.disabled = true;
        try {
          await deleteDoc(doc(db, "adUnlocks", btn.dataset.id));
          loadAdUnlocks();
        } catch (err) {
          console.error("[AgriAdmin] Failed to delete ad unlock:", err);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    showLoadError(adUnlocksList, "ad unlocks", err);
  }
}

// ============================================
// DANGER ZONE — bulk delete (clear test data)
// ============================================
const dangerResult = document.getElementById("danger-result");

async function deleteAllDocsInCollection(collectionName) {
  const snap = await getDocs(collection(db, collectionName));
  if (snap.empty) return 0;
  const docs = snap.docs;
  const CHUNK = 450; // stay under Firestore's 500-write batch limit
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = writeBatch(db);
    docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

document.querySelectorAll(".danger-delete-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const collectionName = btn.dataset.collection;
    const label = btn.dataset.label;

    const typed = prompt(`This will permanently delete ALL documents in "${label}".\nType DELETE (in capitals) to confirm.`);
    if (typed !== "DELETE") {
      dangerResult.textContent = "Cancelled — nothing was deleted.";
      dangerResult.style.color = "var(--moss-600)";
      dangerResult.classList.remove("hidden");
      return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Deleting…";

    try {
      const count = await deleteAllDocsInCollection(collectionName);
      dangerResult.textContent = `✅ Deleted ${count} document(s) from "${label}".`;
      dangerResult.style.color = "var(--leaf-500)";
      dangerResult.classList.remove("hidden");

      // Refresh whichever tab shows this data, if it's currently loaded
      if (collectionName === "resources") loadResources();
      if (collectionName === "terms") loadTerms();
      if (collectionName === "registrations") loadRegistrations();
      if (collectionName === "timeline") loadTimeline();
      if (collectionName === "messages") loadMessages();
      if (collectionName === "classroomCodes") loadClassroomCodes();
      if (collectionName === "blogPosts") loadBlogPosts();
    } catch (err) {
      console.error("[AgriAdmin] bulk delete failed:", err);
      dangerResult.textContent = `❌ Something went wrong deleting "${label}": ${err && err.message ? err.message : "please try again."}`;
      dangerResult.style.color = "var(--terracotta-500)";
      dangerResult.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
});

// ============================================
// GENERIC "EDIT ANY CONTENT" MODAL
// ============================================
// Each schema describes which fields can be edited for that collection,
// how to render an input for them, and how to read the value back out.
const EDIT_SCHEMAS = {
  resources: {
    collection: "resources",
    title: "Edit Resource",
    reload: loadResources,
    cache: resourcesCache,
    // Every field here mirrors a field the upload forms in js/resources.js
    // actually write to the doc, so admin can correct anything a student
    // submitted — not just a fixed subset.
    fields: [
      { key: "courseCode", label: "Course Code", type: "text" },
      { key: "courseName", label: "Course Name", type: "text" },
      { key: "facultyName", label: "Faculty Name", type: "text" },
      { key: "examType", label: "Exam Type", type: "text" },
      { key: "fileType", label: "File Type", type: "select", options: { pdf: "PDF", image: "Image", ppt: "PPT" } },
      { key: "noteType", label: "Note Type", type: "select", options: { hand_notes: "Hand Notes", class_slide: "Class Slide", others: "Others" } },
      { key: "uploaderEmail", label: "Uploader Email", type: "text" },
      { key: "uploaderStudentId", label: "Uploader Student ID", type: "text" }
    ]
  },
  terms: {
    collection: "terms",
    title: "Edit Term",
    reload: loadTerms,
    cache: termsCache,
    fields: [
      { key: "name", label: "Term Name", type: "text" },
      { key: "description", label: "Description", type: "textarea" },
      { key: "imageUrl", label: "Image URL", type: "text" },
      { key: "uploaderEmail", label: "Uploader Email", type: "text" }
    ]
  },
  timeline: {
    collection: "timeline",
    title: "Edit Timeline Event",
    reload: loadTimeline,
    cache: timelineCache,
    fields: [
      { key: "title", label: "Title", type: "text" },
      { key: "date", label: "Start Date", type: "date" },
      { key: "endDate", label: "End Date (optional)", type: "date" },
      { key: "type", label: "Type", type: "select", options: TYPE_LABELS }
    ]
  },
  registrations: {
    collection: "registrations",
    title: "Edit Registration",
    reload: loadRegistrations,
    cache: registrationsCache,
    fields: [
      { key: "fullName", label: "Full Name", type: "text" },
      { key: "email", label: "Email", type: "text" },
      { key: "gender", label: "Gender", type: "select", options: { male: "Male", female: "Female" } },
      { key: "studentIdNumber", label: "Student ID Number", type: "text" }
    ]
  }
};

const editModal = document.getElementById("edit-modal");
const editModalTitle = document.getElementById("edit-modal-title");
const editModalFields = document.getElementById("edit-modal-fields");
const editModalForm = document.getElementById("edit-modal-form");
const editModalError = document.getElementById("edit-modal-error");
const editModalSave = document.getElementById("edit-modal-save");

let currentEditSchemaKey = null;
let currentEditDocId = null;

function tsToDateInputValue(val) {
  if (!val) return "";
  const dateObj = val?.toDate ? val.toDate() : new Date(val);
  if (isNaN(dateObj.getTime())) return "";
  return dateObj.toISOString().slice(0, 10);
}

function openEditModal(schemaKey, docId, item) {
  const schema = EDIT_SCHEMAS[schemaKey];
  if (!schema) return;
  currentEditSchemaKey = schemaKey;
  currentEditDocId = docId;
  editModalTitle.textContent = schema.title;
  editModalError.classList.add("hidden");

  editModalFields.innerHTML = schema.fields.map(f => {
    const fieldId = `edit-field-${f.key}`;
    if (f.type === "textarea") {
      return `<div class="form-field"><label for="${fieldId}">${esc(f.label)}</label>
        <textarea id="${fieldId}" data-key="${esc(f.key)}">${esc(item[f.key] || "")}</textarea></div>`;
    }
    if (f.type === "date") {
      return `<div class="form-field"><label for="${fieldId}">${esc(f.label)}</label>
        <input type="date" id="${fieldId}" data-key="${esc(f.key)}" value="${esc(tsToDateInputValue(item[f.key]))}"></div>`;
    }
    if (f.type === "select") {
      const opts = Object.entries(f.options).map(([val, label]) =>
        `<option value="${esc(val)}" ${item[f.key] === val ? "selected" : ""}>${esc(label)}</option>`).join("");
      return `<div class="form-field"><label for="${fieldId}">${esc(f.label)}</label>
        <select id="${fieldId}" data-key="${esc(f.key)}">${opts}</select></div>`;
    }
    return `<div class="form-field"><label for="${fieldId}">${esc(f.label)}</label>
      <input type="text" id="${fieldId}" data-key="${esc(f.key)}" value="${esc(item[f.key] || "")}"></div>`;
  }).join("");

  editModal.classList.remove("hidden");
}

function closeEditModal() {
  editModal.classList.add("hidden");
  currentEditSchemaKey = null;
  currentEditDocId = null;
}

document.getElementById("edit-modal-close").addEventListener("click", closeEditModal);
document.getElementById("edit-modal-cancel").addEventListener("click", closeEditModal);
editModal.addEventListener("click", (e) => { if (e.target === editModal) closeEditModal(); });

editModalForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentEditSchemaKey || !currentEditDocId) return;
  const schema = EDIT_SCHEMAS[currentEditSchemaKey];

  const updateData = {};
  schema.fields.forEach(f => {
    const input = editModalFields.querySelector(`[data-key="${f.key}"]`);
    if (!input) return;
    if (f.type === "date") {
      updateData[f.key] = input.value ? Timestamp.fromDate(new Date(input.value + "T00:00:00")) : null;
    } else if (f.key === "email" || f.key === "uploaderEmail") {
      updateData[f.key] = normalizeEmail(input.value);
    } else if (f.key === "studentIdNumber" || f.key === "uploaderStudentId") {
      updateData[f.key] = normalizeStudentId(input.value);
    } else {
      updateData[f.key] = input.value.trim();
    }
  });
  updateData.editedAt = new Date();

  editModalSave.disabled = true;
  editModalSave.textContent = "Saving…";
  editModalError.classList.add("hidden");

  try {
    await updateDoc(doc(db, schema.collection, currentEditDocId), updateData);
    closeEditModal();
    schema.reload();
  } catch (err) {
    console.error("[AgriAdmin] edit save failed:", err);
    editModalError.textContent = "Couldn't save changes. Please try again.";
    editModalError.classList.remove("hidden");
  } finally {
    editModalSave.disabled = false;
    editModalSave.textContent = "💾 Save Changes";
  }
});

// ============================================
// BULK UPLOAD TERMS
// ------------------------------------------------------------------
// Two ways in, both ending at the same confirm-then-publish preview:
//
//   1. "From a Sheet"  — a .csv/.xlsx/.xls with one term per row. The
//      image column may hold either a direct link or the filename of an
//      image picked in the second file input, which is matched by name.
//   2. "From Images"   — the original flow: pick images, each becomes one
//      term seeded with a name derived from its filename.
//
// Nothing is written to Firestore until the admin reviews the preview and
// presses Upload, so a bad sheet costs nothing.
// ============================================
const bulkTermImagesInput   = document.getElementById("bulk-term-images");
const bulkTermSheetInput    = document.getElementById("bulk-term-sheet");
const bulkTermSheetImages   = document.getElementById("bulk-term-sheet-images");
const bulkTermRows          = document.getElementById("bulk-term-rows");
const bulkTermPreviewWrap   = document.getElementById("bulk-term-preview-wrap");
const bulkTermUploadBtn     = document.getElementById("bulk-term-upload-btn");
const bulkTermClearBtn      = document.getElementById("bulk-term-clear-btn");
const bulkTermStatus        = document.getElementById("bulk-term-status");
const bulkSheetSummary      = document.getElementById("bulk-sheet-summary");
const bulkTermTemplateBtn   = document.getElementById("bulk-term-template-btn");

// One entry per previewed term:
//   { name, description, file, imageUrl, thumb, error }
// `file` is a local File (upload the bytes), `imageUrl` is a remote link
// (hand the URL to Cloudinary instead) — exactly one of the two is set.
let bulkTermEntries = [];
// Object URLs created for local-file thumbnails, revoked on clear so a big
// sheet run doesn't leak them.
let bulkObjectUrls = [];

function filenameToTitle(name) {
  return String(name || "").replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------
// CLOUDINARY
// ------------------------------------------------------------------
function uploadFileToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = 300000; // 5 min — was 2 min, too short for large files on slower mobile connections
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText).secure_url);
      } else {
        reject(new Error(`Image upload failed (server said: ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error("Upload took too long. Try again."));
    const data = new FormData();
    data.append("file", file);
    data.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    xhr.send(data);
  });
}

// Cloudinary can fetch a remote image itself when "file" is a URL string —
// the download happens on their servers, so the browser never touches the
// other site and CORS never comes into it. If their fetch fails (dead link,
// hotlink protection), we fall back to saving the original URL as-is.
async function uploadRemoteUrlToCloudinary(url) {
  const sourceUrl = normalizeImageUrl(url);
  const data = new FormData();
  data.append("file", sourceUrl);
  data.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  const res = await fetch(CLOUDINARY_UPLOAD_URL, { method: "POST", body: data });
  if (!res.ok) throw new Error(`Couldn't fetch that image link (${res.status})`);
  const json = await res.json();
  if (!json.secure_url) throw new Error("Image link returned no usable image.");
  return json.secure_url;
}

// ------------------------------------------------------------------
// MODE TABS
// ------------------------------------------------------------------
document.querySelectorAll(".bulk-mode-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const mode = tab.dataset.bulkMode;
    document.querySelectorAll(".bulk-mode-tab").forEach(t => t.classList.toggle("is-active", t === tab));
    document.getElementById("bulk-mode-sheet").classList.toggle("hidden", mode !== "sheet");
    document.getElementById("bulk-mode-images").classList.toggle("hidden", mode !== "images");
    clearBulkTerms();
  });
});

function clearBulkTerms() {
  bulkObjectUrls.forEach(u => URL.revokeObjectURL(u));
  bulkObjectUrls = [];
  bulkTermEntries = [];
  bulkTermRows.innerHTML = "";
  bulkTermPreviewWrap.classList.add("hidden");
  bulkTermUploadBtn.classList.add("hidden");
  bulkTermClearBtn.classList.add("hidden");
  bulkSheetSummary.classList.add("hidden");
  bulkSheetSummary.innerHTML = "";
  bulkTermStatus.textContent = "";
  if (bulkTermSheetInput) bulkTermSheetInput.value = "";
  if (bulkTermSheetImages) bulkTermSheetImages.value = "";
  if (bulkTermImagesInput) bulkTermImagesInput.value = "";
}

bulkTermClearBtn?.addEventListener("click", clearBulkTerms);

// ------------------------------------------------------------------
// BLANK TEMPLATE
// ------------------------------------------------------------------
bulkTermTemplateBtn?.addEventListener("click", () => {
  const csv = [
    "name,description,image",
    '"Rhizobium","Nitrogen-fixing bacteria that form nodules on legume roots.","https://example.com/rhizobium.jpg"',
    '"Photosynthesis","How green plants turn light energy into chemical energy.","photosynthesis.jpg"',
    '"Loam Soil","A balanced mix of sand, silt and clay — ideal for most crops.",""'
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "agri-terms-template.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ------------------------------------------------------------------
// SHEET PARSING
// ------------------------------------------------------------------
// Header matching is deliberately forgiving: case, spaces, underscores and
// dashes are all stripped before comparing, so "Image URL", "image_url" and
// "imageurl" are the same column.
const COLUMN_ALIASES = {
  name:        ["name", "term", "title", "word", "keyword"],
  description: ["description", "desc", "definition", "meaning", "details", "detail", "about"],
  image:       ["image", "imageurl", "imagelink", "img", "photo", "picture", "pic", "url", "link"]
};

function normalizeHeader(h) {
  return String(h || "").toLowerCase().replace(/[\s_\-.]+/g, "");
}

function mapColumns(headerRow) {
  const map = { name: -1, description: -1, image: -1 };
  headerRow.forEach((raw, i) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (map[field] === -1 && aliases.includes(h)) { map[field] = i; return; }
    }
  });
  return map;
}

function isHttpUrl(val) {
  return /^https?:\/\//i.test(String(val || "").trim());
}

// Google Drive sharing links are HTML viewer pages, not image files. Convert
// the common Drive URL forms to Google's image thumbnail endpoint so previews
// and the final Knowledge Hub image both receive actual image bytes.
function googleDriveFileId(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const isDriveHost = /(^|\.)drive\.google\.com$/.test(host) || /(^|\.)docs\.google\.com$/.test(host) || /(^|\.)driveusercontent\.google\.com$/.test(host);
    if (!isDriveHost) return "";
    const byQuery = u.searchParams.get("id");
    if (byQuery) return byQuery.trim();
    const m = u.pathname.match(/\/(?:file\/d|uc|thumbnail)\/([^/]+)/i);
    if (m) return m[1].trim();
    const m2 = u.pathname.match(/\/d\/([^/]+)/i);
    if (m2) return m2[1].trim();
  } catch (_) {}
  return "";
}

function normalizeImageUrl(url) {
  const raw = String(url || "").trim();
  const id = googleDriveFileId(raw);
  // `uc?export=view` is the most broadly compatible public Drive image URL;
  // the thumbnail endpoint remains the preview fallback when Drive returns a
  // thumbnail instead of the original image bytes.
  return id ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(id)}` : raw;
}

function googleDriveThumbnailUrl(url) {
  const id = googleDriveFileId(url);
  return id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1600` : String(url || "").trim();
}

// Local images are looked up by full filename and by filename-without-
// extension, so a sheet saying "rhizobium" still matches "rhizobium.jpg".
function buildLocalImageIndex(files) {
  const index = new Map();
  files.forEach(f => {
    const full = f.name.toLowerCase();
    index.set(full, f);
    const stem = full.replace(/\.[^/.]+$/, "");
    if (!index.has(stem)) index.set(stem, f);
  });
  return index;
}

async function readSheetRows(file) {
  if (typeof XLSX === "undefined") {
    throw new Error("The spreadsheet reader didn't load. Check your connection and refresh the page.");
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("That file has no sheets in it.");
  // header:1 gives raw rows so we can find the header ourselves rather than
  // trusting SheetJS's own key inference.
  return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: "" });
}

async function handleSheetSelected() {
  const sheetFile = bulkTermSheetInput?.files?.[0];
  if (!sheetFile) return;

  bulkTermStatus.textContent = "";
  bulkSheetSummary.classList.remove("hidden");
  bulkSheetSummary.innerHTML = "Reading your sheet…";

  try {
    const rows = await readSheetRows(sheetFile);
    if (rows.length < 2) throw new Error("That sheet needs a header row plus at least one term.");

    const cols = mapColumns(rows[0]);
    if (cols.name === -1) {
      throw new Error("Couldn't find a name column. Add a header called \"name\" (or \"term\" / \"title\") to the first row.");
    }

    const localFiles = Array.from(bulkTermSheetImages?.files || []);
    const localIndex = buildLocalImageIndex(localFiles);

    bulkObjectUrls.forEach(u => URL.revokeObjectURL(u));
    bulkObjectUrls = [];
    bulkTermEntries = [];

    let skippedBlank = 0;
    let missingImages = 0;
    let matchedLocal = 0;
    let linkedRemote = 0;

    rows.slice(1).forEach(row => {
      const name = String(row[cols.name] ?? "").trim();
      if (!name) { skippedBlank++; return; }

      const description = cols.description === -1 ? "" : String(row[cols.description] ?? "").trim();
      const imageRef = cols.image === -1 ? "" : String(row[cols.image] ?? "").trim();

      const entry = { name, description, file: null, imageUrl: "", thumb: "", error: "" };

      if (!imageRef) {
        entry.error = "No image given";
        missingImages++;
      } else if (isHttpUrl(imageRef)) {
        entry.imageUrl = normalizeImageUrl(imageRef);
        entry.thumb = googleDriveThumbnailUrl(imageRef);
        linkedRemote++;
      } else {
        const match = localIndex.get(imageRef.toLowerCase())
          || localIndex.get(imageRef.toLowerCase().replace(/\.[^/.]+$/, ""));
        if (match) {
          entry.file = match;
          entry.thumb = URL.createObjectURL(match);
          bulkObjectUrls.push(entry.thumb);
          matchedLocal++;
        } else {
          entry.error = `No image file named "${imageRef}"`;
          missingImages++;
        }
      }

      bulkTermEntries.push(entry);
    });

    if (!bulkTermEntries.length) throw new Error("No usable rows — every row was missing a name.");

    const bits = [`<strong>${bulkTermEntries.length}</strong> term${bulkTermEntries.length === 1 ? "" : "s"} read from <em>${esc(sheetFile.name)}</em>.`];
    if (linkedRemote)  bits.push(`${linkedRemote} image link${linkedRemote === 1 ? "" : "s"} to fetch.`);
    if (matchedLocal)  bits.push(`${matchedLocal} image${matchedLocal === 1 ? "" : "s"} matched to files you picked.`);
    if (skippedBlank)  bits.push(`${skippedBlank} blank row${skippedBlank === 1 ? "" : "s"} skipped.`);
    if (missingImages) bits.push(`<span class="bulk-warn">${missingImages} row${missingImages === 1 ? "" : "s"} still need an image — fix below or they'll be skipped.</span>`);
    if (cols.description === -1) bits.push(`No description column found — descriptions left blank.`);
    bulkSheetSummary.innerHTML = bits.join(" ");

    renderBulkPreview();
  } catch (err) {
    console.error("[AgriAdmin] sheet parse failed:", err);
    bulkSheetSummary.innerHTML = `<span class="bulk-warn">⚠️ ${esc(err.message || "Couldn't read that file.")}</span>`;
    bulkTermEntries = [];
    bulkTermRows.innerHTML = "";
    bulkTermPreviewWrap.classList.add("hidden");
    bulkTermUploadBtn.classList.add("hidden");
  }
}

bulkTermSheetInput?.addEventListener("change", handleSheetSelected);
// Re-running the parse after images are picked lets filename matching catch
// up without making the admin re-select the sheet.
bulkTermSheetImages?.addEventListener("change", () => {
  if (bulkTermSheetInput?.files?.length) handleSheetSelected();
});

// ------------------------------------------------------------------
// IMAGES-ONLY MODE
// ------------------------------------------------------------------
bulkTermImagesInput?.addEventListener("change", () => {
  const files = Array.from(bulkTermImagesInput.files || []);
  bulkObjectUrls.forEach(u => URL.revokeObjectURL(u));
  bulkObjectUrls = [];
  bulkTermStatus.textContent = "";

  bulkTermEntries = files.map(file => {
    const thumb = URL.createObjectURL(file);
    bulkObjectUrls.push(thumb);
    return { name: filenameToTitle(file.name), description: "", file, imageUrl: "", thumb, error: "" };
  });

  if (!bulkTermEntries.length) {
    bulkTermPreviewWrap.classList.add("hidden");
    bulkTermUploadBtn.classList.add("hidden");
    bulkTermClearBtn.classList.add("hidden");
    return;
  }
  renderBulkPreview();
});

// ------------------------------------------------------------------
// PREVIEW
// ------------------------------------------------------------------
function renderBulkPreview() {
  bulkTermRows.innerHTML = bulkTermEntries.map((entry, idx) => {
    const thumb = entry.thumb
      ? `<img src="${esc(entry.thumb)}" alt="" onerror="this.outerHTML='&lt;div class=&quot;bulk-term-thumb-missing&quot;&gt;link broken&lt;/div&gt;'">`
      : `<div class="bulk-term-thumb-missing">no image</div>`;

    const source = entry.file
      ? `📎 ${esc(entry.file.name)}`
      : entry.imageUrl
        ? `🔗 image link`
        : `<span style="color:var(--terracotta-500);">${esc(entry.error || "No image")}</span>`;

    return `
      <div class="bulk-term-row${entry.error ? " has-error" : ""}" data-index="${idx}">
        <span class="bulk-term-index">${idx + 1}</span>
        ${thumb}
        <div class="bulk-term-fields">
          <input type="text" class="bulk-term-name" placeholder="Term name" value="${esc(entry.name)}">
          <textarea class="bulk-term-desc" placeholder="Short description (optional)" rows="2">${esc(entry.description)}</textarea>
          <input type="text" class="bulk-term-image" placeholder="Paste an image link for this term" value="${esc(entry.file ? "" : entry.imageUrl)}"${entry.file ? " disabled" : ""}>
          <small style="font-size:.72rem;color:var(--moss-600);">${source}</small>
        </div>
        <div style="display:flex;flex-direction:column;gap:.4rem;align-items:flex-end;">
          <span class="bulk-term-status">${entry.error ? "⚠️ Needs image" : "Ready"}</span>
          <button type="button" class="bulk-term-remove" data-index="${idx}" title="Drop this row" style="background:none;border:none;color:var(--terracotta-500);cursor:pointer;font-size:.9rem;">✕</button>
        </div>
      </div>`;
  }).join("");

  // Typing into a row updates the entry straight away, so edits survive a
  // re-render and are what actually gets published.
  bulkTermRows.querySelectorAll(".bulk-term-row").forEach(row => {
    const idx = Number(row.dataset.index);
    row.querySelector(".bulk-term-name")?.addEventListener("input", e => {
      bulkTermEntries[idx].name = e.target.value;
    });
    row.querySelector(".bulk-term-desc")?.addEventListener("input", e => {
      bulkTermEntries[idx].description = e.target.value;
    });
    row.querySelector(".bulk-term-image")?.addEventListener("input", e => {
      const val = e.target.value.trim();
      bulkTermEntries[idx].imageUrl = val;
      bulkTermEntries[idx].error = val ? "" : "No image given";
      row.classList.toggle("has-error", !val);
      const statusEl = row.querySelector(".bulk-term-status");
      if (statusEl) statusEl.textContent = val ? "Ready" : "⚠️ Needs image";
    });
  });

  bulkTermRows.querySelectorAll(".bulk-term-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      bulkTermEntries.splice(Number(btn.dataset.index), 1);
      if (!bulkTermEntries.length) { clearBulkTerms(); return; }
      renderBulkPreview();
    });
  });

  bulkTermPreviewWrap.classList.remove("hidden");
  bulkTermUploadBtn.classList.remove("hidden");
  bulkTermClearBtn.classList.remove("hidden");
}

// ------------------------------------------------------------------
// PUBLISH
// ------------------------------------------------------------------
bulkTermUploadBtn?.addEventListener("click", async () => {
  if (!bulkTermEntries.length) return;

  const ready = bulkTermEntries.filter(e => e.name.trim() && (e.file || e.imageUrl));
  if (!ready.length) {
    bulkTermStatus.textContent = "Nothing to publish — every row is missing a name or an image.";
    bulkTermStatus.style.color = "var(--terracotta-500)";
    return;
  }

  const skipped = bulkTermEntries.length - ready.length;
  if (!confirm(
    `Publish ${ready.length} term${ready.length === 1 ? "" : "s"} to the Knowledge Hub as approved?` +
    (skipped ? `\n\n${skipped} row${skipped === 1 ? "" : "s"} will be skipped (missing a name or image).` : "")
  )) return;

  bulkTermUploadBtn.disabled = true;
  bulkTermClearBtn.disabled = true;
  bulkTermUploadBtn.textContent = "Uploading…";
  bulkTermStatus.textContent = "";

  let successCount = 0;
  let failCount = 0;

  const rowEls = Array.from(bulkTermRows.querySelectorAll(".bulk-term-row"));

  for (let i = 0; i < bulkTermEntries.length; i++) {
    const entry = bulkTermEntries[i];
    const rowEl = rowEls[i];
    const statusEl = rowEl?.querySelector(".bulk-term-status");
    const setStatus = (text, color) => {
      if (!statusEl) return;
      statusEl.textContent = text;
      statusEl.style.color = color;
    };

    const name = entry.name.trim();
    if (!name || (!entry.file && !entry.imageUrl)) {
      setStatus("⏭️ Skipped", "var(--moss-600)");
      continue;
    }

    setStatus("Uploading…", "var(--moss-600)");
    rowEl?.querySelectorAll("input, textarea").forEach(el => { el.disabled = true; });

    try {
      let imageUrl;
      if (entry.file) {
        imageUrl = await uploadFileToCloudinary(entry.file, pct => setStatus(`Uploading ${pct}%`, "var(--moss-600)"));
      } else {
        setStatus("Fetching link…", "var(--moss-600)");
        try {
          imageUrl = await uploadRemoteUrlToCloudinary(entry.imageUrl);
        } catch (fetchErr) {
          // Cloudinary couldn't pull it in — keep the original link so the
          // term still publishes rather than failing outright.
          console.warn("[AgriAdmin] remote image fetch failed, keeping original link:", fetchErr);
          imageUrl = entry.imageUrl;
        }
      }

      await addDoc(collection(db, "terms"), {
        name,
        description: entry.description.trim(),
        imageUrl,
        uploaderEmail: currentAdminEmail || "admin",
        status: "approved",
        possibleDuplicate: false,
        submittedAt: serverTimestamp(),
        reviewedAt: new Date()
      });

      setStatus("✅ Published", "var(--leaf-500)");
      successCount++;
    } catch (err) {
      console.error("[AgriAdmin] bulk term upload failed:", err);
      setStatus("❌ Failed", "var(--terracotta-500)");
      failCount++;
      rowEl?.querySelectorAll("input, textarea").forEach(el => { el.disabled = false; });
    }
  }

  const parts = [`${successCount} published`];
  if (failCount) parts.push(`${failCount} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  bulkTermStatus.textContent = `Done — ${parts.join(", ")}.`;
  bulkTermStatus.style.color = failCount ? "var(--terracotta-500)" : "var(--leaf-500)";

  bulkTermUploadBtn.disabled = false;
  bulkTermClearBtn.disabled = false;
  bulkTermUploadBtn.textContent = "⬆️ Upload All";

  if (successCount > 0) loadTerms();
});
