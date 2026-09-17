import { db, auth, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, getDocs, doc, updateDoc, deleteDoc, addDoc, orderBy, query, where, Timestamp, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initEmailNotifications, sendReviewEmail } from "./email-config.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { computeResourceAccessStatus } from "./access.js";
import { initAdminNotifications, stopAdminNotifications, initAdminNotifyBell, clearAdminNotifyBadge } from "./admin-notify.js";

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
      query(collection(db, "registrations"), where("emailNormalized", "==", normalizedEmail))
    );
    
    if (regSnap.empty) return;

    const regDoc = regSnap.docs[0];
    const regId = regDoc.id;

    const resourcesSnap = await getDocs(
      query(collection(db, "resources"), where("uploaderEmail", "==", normalizedEmail))
    );
    
    const classroomSnap = await getDocs(
      query(collection(db, "terms"), where("uploaderEmail", "==", normalizedEmail), where("kind", "==", "classroom"))
    );

    const resourceDocs = resourcesSnap.docs.map(d => ({ id: d.id, kind: "resource", ...d.data() }));
    const classroomDocs = classroomSnap.docs.map(d => ({ 
      id: d.id, 
      kind: "classroom", 
      status: "approved",
      ...d.data() 
    }));

    const access = computeResourceAccessStatus([...resourceDocs, ...classroomDocs]);

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
// ACCOUNT RESTRICTION — shared helpers (used from both the Registrations
// tab and, one click away, right from a Resources review row).
// ============================================
async function restrictAccountById(id, days, reason) {
  const until = Date.now() + days * 24 * 60 * 60 * 1000;
  await updateDoc(doc(db, "registrations", id), {
    accountRestrictedUntil: until,
    accountRestrictedReason: reason || "",
    accountRestrictedAt: new Date()
  });
}

async function restrictAccountByEmail(email, days, reason) {
  const normalized = normalizeEmail(email || "");
  if (!normalized) throw new Error("This submission has no uploader email to restrict.");
  const snap = await getDocs(query(collection(db, "registrations"), where("email", "==", normalized)));
  if (snap.empty) throw new Error(`No registered account found for ${email}.`);
  await restrictAccountById(snap.docs[0].id, days, reason);
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

onAuthStateChanged(auth, (user) => {
  if (user) {
    currentAdminEmail = user.email || "";
    loginBox.classList.add("hidden");
    adminPanel.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    if (adminUserChip) adminUserChip.textContent = currentAdminEmail;
    loadResources();
    // Alerts the admin (in this browser, while the panel tab is open) the
    // moment a new registration, term, resource, or classroom code comes
    // in — see js/admin-notify.js for how and its limitations.
    initAdminNotifications();
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
const blogList = document.getElementById("admin-blog-list");

// Caches of last-loaded docs, keyed by id — used to populate the "Edit any content" modal
// without a second round-trip to Firestore.
const resourcesCache = {};
const termsCache = {};
const timelineCache = {};
const registrationsCache = {};
const blogCache = {};

const tabs = {
  approvals: { btn: document.getElementById("tab-approvals"), panel: document.getElementById("approvals-panel"), load: loadApprovals },
  arrange: { btn: document.getElementById("tab-arrange"), panel: document.getElementById("arrange-panel"), load: loadArrangeFiles },
  manualUnlock: { btn: document.getElementById("tab-manual-unlock"), panel: document.getElementById("manual-unlock-panel"), load: initManualUnlock },
  resources: { btn: document.getElementById("tab-resources"), panel: document.getElementById("resources-panel"), load: loadResources },
  blog: { btn: document.getElementById("tab-blog"), panel: document.getElementById("blog-panel"), load: loadBlogPosts },
  terms: { btn: document.getElementById("tab-terms"), panel: document.getElementById("terms-panel"), load: loadTerms },
  timeline: { btn: document.getElementById("tab-timeline"), panel: document.getElementById("timeline-panel"), load: loadTimeline },
  messages: { btn: document.getElementById("tab-messages"), panel: document.getElementById("messages-panel"), load: loadMessages },
  classroomCodes: { btn: document.getElementById("tab-classroom-codes"), panel: document.getElementById("classroom-codes-panel"), load: loadClassroomCodes },
  adUnlocks: { btn: document.getElementById("tab-ad-unlocks"), panel: document.getElementById("ad-unlocks-panel"), load: loadAdUnlocks },
  danger: { btn: document.getElementById("tab-danger"), panel: document.getElementById("danger-panel"), load: () => {} }
};

const adminPageTitle = document.getElementById("admin-page-title");

Object.entries(tabs).forEach(([key, tab]) => {
  tab.btn.addEventListener("click", () => {
    Object.values(tabs).forEach(t => {
      t.btn.classList.remove("is-active");
      t.panel.classList.add("hidden");
    });
    tab.btn.classList.add("is-active");
    tab.panel.classList.remove("hidden");
    if (adminPageTitle) adminPageTitle.textContent = tab.btn.dataset.label || key;
    tab.load();
  });
});

// Activate the first tab by default so the sidebar/topbar reflect the initial panel shown.
tabs.approvals.btn.classList.add("is-active");
if (adminPageTitle) adminPageTitle.textContent = tabs.approvals.btn.dataset.label || "Approvals";

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
    const db = getFirestore();
    
    // Find user by email
    const usersSnap = await getDocs(
      query(collection(db, "users"), where("emailNormalized", "==", email))
    );

    if (usersSnap.empty) {
      alert("❌ User not found. Make sure email is registered.");
      return;
    }

    const userId = usersSnap.docs[0].id;
    const userData = usersSnap.docs[0].data();

    // Calculate expiry
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);

    // Store unlock record
    const unlocksRef = collection(db, "manualUnlocks");
    await addDoc(unlocksRef, {
      userId: userId,
      userEmail: email,
      studentName: userData.studentName || "Unknown",
      unlockType: unlockType,
      days: days,
      reason: reason,
      grantedAt: serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiryDate),
      grantedBy: getCurrentUserEmail()
    });

    // Update student access
    if (unlockType === "all_resources") {
      // Grant access to all resources
      const resourcesSnap = await getDocs(
        query(collection(db, "resources"), where("status", "==", "approved"))
      );

      for (const resourceDoc of resourcesSnap.docs) {
        const accessId = `${userId}_${resourceDoc.id}`;
        await setDoc(doc(db, "studentAccess", accessId), {
          userId: userId,
          resourceId: resourceDoc.id,
          unlockType: "manual_all",
          unlockedAt: serverTimestamp(),
          expiresAt: Timestamp.fromDate(expiryDate)
        });
      }
    } else {
      // Grant access to specific type
      const resourcesSnap = await getDocs(
        query(collection(db, "resources"), where("status", "==", "approved"))
      );

      for (const resourceDoc of resourcesSnap.docs) {
        const data = resourceDoc.data();
        
        // Check if resource matches unlock type
        if (unlockType === "hand_notes" && data.noteType !== "hand_notes") continue;
        if (unlockType === "class_slides" && data.noteType !== "class_slide") continue;
        if (unlockType === "images" && data.fileType !== "image") continue;

        const accessId = `${userId}_${resourceDoc.id}`;
        await setDoc(doc(db, "studentAccess", accessId), {
          userId: userId,
          resourceId: resourceDoc.id,
          unlockType: `manual_${unlockType}`,
          unlockedAt: serverTimestamp(),
          expiresAt: Timestamp.fromDate(expiryDate)
        });
      }
    }

    alert(`✅ Access granted to ${userData.studentName} (${email}) for ${days} days!`);
    
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
    const db = getFirestore();
    
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

    unlocksSnap.docs.forEach(doc => {
      const data = doc.data();
      const granted = fmtAdminDate(data.grantedAt);
      const expires = fmtAdminDate(data.expiresAt);
      const typeEmoji = data.unlockType === "all_resources" ? "🔓" : data.unlockType === "hand_notes" ? "📝" : data.unlockType === "class_slides" ? "🖥️" : "🖼️";

      html += `
        <div style='padding:.8rem;border-bottom:1px solid var(--line);'>
          <p style='margin:0 0 .3rem;font-weight:600;'>${typeEmoji} ${data.studentName}</p>
          <p style='margin:0 0 .2rem;font-size:.85rem;color:var(--moss-600);'>${data.userEmail}</p>
          <p style='margin:0 0 .2rem;font-size:.85rem;color:var(--moss-600);'>${data.days} days | Expires: ${expires}</p>
          <p style='margin:0;font-size:.8rem;color:var(--moss-500);'>Reason: ${data.reason}</p>
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
// ARRANGE FILES — Categorize Existing Resources
// ============================================
async function loadArrangeFiles() {
  const listEl = document.getElementById("admin-arrange-list");
  const filterEl = document.getElementById("arrange-filter");
  if (!listEl || !filterEl) return;

  listEl.innerHTML = "<p style='text-align:center;color:var(--moss-600);padding:2rem;'>Loading uncategorized files…</p>";

  try {
    // Fetch all approved resources that don't have noteType or need categorization
    const resSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        orderBy("uploadedAt", "desc")
      )
    );

    // Filter out resources that already have proper categorization
    const uncategorized = resSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => !r.noteType || r.noteType === "others" || r.noteType === "");

    if (uncategorized.length === 0) {
      listEl.innerHTML = "<p style='text-align:center;color:var(--moss-600);padding:2rem;'>✅ All files are properly categorized!</p>";
      return;
    }

    // Setup filter listener
    filterEl.addEventListener("change", () => {
      const filter = filterEl.value;
      renderArrangeTable(uncategorized, filter, listEl);
    });

    renderArrangeTable(uncategorized, "", listEl);
  } catch (err) {
    console.error("[Admin] Error loading arrange files:", err);
    listEl.innerHTML = `<p style='color:var(--terracotta-500);'>Error loading files: ${err.message}</p>`;
  }
}

function renderArrangeTable(items, filter, container) {
  let filtered = items;
  if (filter) {
    filtered = items.filter(item => item.fileType === filter);
  }

  if (filtered.length === 0) {
    container.innerHTML = "<p style='text-align:center;color:var(--moss-600);padding:2rem;'>No files need categorization</p>";
    return;
  }

  let html = "<div style='display:flex;flex-direction:column;gap:1rem;'>";

  filtered.forEach(item => {
    const fileIcon = item.fileType === "pdf" ? "📄" : item.fileType === "image" ? "🖼️" : "📊";
    const currentType = item.noteType || "—";

    html += `
      <div style='border:1px solid var(--line);padding:1rem;border-radius:8px;background:#fff;'>
        <div style='display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:.8rem;flex-wrap:wrap;'>
          <div>
            <p style='margin:0;font-weight:600;'>${fileIcon} ${esc(item.courseCode)} — ${esc(item.courseName)}</p>
            <p style='margin:.3rem 0 0;font-size:.85rem;color:var(--moss-600);'>${esc(item.facultyName)}</p>
            <p style='margin:.2rem 0 0;font-size:.8rem;color:var(--moss-500);'>Uploaded: ${fmtAdminDate(item.uploadedAt)}</p>
          </div>
          <div style='background:var(--leaf-50);border:1px solid var(--leaf-300);border-radius:6px;padding:.4rem .6rem;font-size:.8rem;color:var(--moss-700);font-weight:600;'>
            Current: ${currentType}
          </div>
        </div>

        <div style='display:grid;grid-template-columns:1fr 1fr;gap:.8rem;'>
          <div>
            <label style='display:block;font-size:.8rem;font-weight:600;margin-bottom:.3rem;'>Assign to Folder:</label>
            <select id='noteType-${item.id}' style='padding:.5rem .6rem;border:1px solid var(--line);border-radius:6px;width:100%;'>
              <option value=''>— Select Folder —</option>
              <option value='hand_notes'>📝 Hand Notes</option>
              <option value='class_slide'>🖥️ Class Lecture Slides</option>
              <option value='image'>🖼️ Images</option>
            </select>
          </div>
          <div>
            <label style='display:block;font-size:.8rem;font-weight:600;margin-bottom:.3rem;'>File Type:</label>
            <select id='fileType-${item.id}' style='padding:.5rem .6rem;border:1px solid var(--line);border-radius:6px;width:100%;'>
              <option value='${item.fileType}' selected>${item.fileType}</option>
              <option value='pdf'>📄 PDF</option>
              <option value='image'>🖼️ Image</option>
              <option value='ppt'>📊 PPT</option>
            </select>
          </div>
        </div>

        <button class='save-arrange-btn' data-id='${item.id}' style='background:var(--leaf-500);color:white;border:none;padding:.6rem 1rem;border-radius:6px;cursor:pointer;font-weight:600;margin-top:.8rem;width:100%;'>💾 Save Categorization</button>
      </div>
    `;
  });

  html += "</div>";
  container.innerHTML = html;

  // Add event listeners
  container.querySelectorAll(".save-arrange-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const noteType = document.getElementById(`noteType-${id}`).value;
      const fileType = document.getElementById(`fileType-${id}`).value;

      if (!noteType) {
        alert("Please select a folder type");
        return;
      }

      await saveArrangement(id, noteType, fileType, container, filter);
    });
  });
}

async function saveArrangement(id, noteType, fileType, container, filter) {
  try {
    await updateDoc(doc(db, "resources", id), {
      noteType: noteType,
      fileType: fileType,
      arrangedAt: serverTimestamp()
    });

    alert("✅ File categorized successfully!");
    loadArrangeFiles();
  } catch (err) {
    alert(`Error saving categorization: ${err.message}`);
  }
}

// ============================================
// UNIFIED APPROVALS
// ============================================
async function loadApprovals() {
  const listEl = document.getElementById("admin-approvals-list");
  const filterEl = document.getElementById("approval-filter");
  if (!listEl || !filterEl) return;

  listEl.innerHTML = "<p style='text-align:center;color:var(--moss-600);padding:2rem;'>Loading approvals…</p>";

  try {
    // Load pending registrations
    const regSnap = await getDocs(
      query(collection(db, "registrations"), where("status", "==", "unverified"), orderBy("createdAt", "desc"))
    );

    // Load pending resources
    const resSnap = await getDocs(
      query(collection(db, "resources"), where("status", "==", "pending"), orderBy("uploadedAt", "desc"))
    );

    // Load pending blog posts
    const blogSnap = await getDocs(
      query(collection(db, "blogPosts"), where("status", "==", "unverified"), orderBy("submittedAt", "desc"))
    );

    const registrations = regSnap.docs.map(d => ({ id: d.id, type: "registration", ...d.data() }));
    const resources = resSnap.docs.map(d => ({ id: d.id, type: "resource", ...d.data() }));
    const blogs = blogSnap.docs.map(d => ({ id: d.id, type: "blog", ...d.data() }));

    const allApprovals = [...registrations, ...resources, ...blogs];

    // Setup filter listener
    filterEl.addEventListener("change", () => {
      const filter = filterEl.value;
      renderApprovalsTable(allApprovals, filter, listEl);
    });

    renderApprovalsTable(allApprovals, "", listEl);
  } catch (err) {
    console.error("[Admin] Error loading approvals:", err);
    listEl.innerHTML = `<p style='color:var(--terracotta-500);'>Error loading approvals: ${err.message}</p>`;
  }
}

function renderApprovalsTable(items, filter, container) {
  let filtered = items;
  if (filter) {
    filtered = items.filter(item => item.type === filter);
  }

  if (filtered.length === 0) {
    container.innerHTML = "<p style='text-align:center;color:var(--moss-600);padding:2rem;'>No pending items to review</p>";
    return;
  }

  let html = "<table style='width:100%;border-collapse:collapse;font-size:.9rem;'>";
  html += "<thead style='background:var(--leaf-50);border-bottom:2px solid var(--line);'>";
  html += "<tr>";
  html += "<th style='padding:.8rem;text-align:left;font-weight:600;'>Type</th>";
  html += "<th style='padding:.8rem;text-align:left;font-weight:600;'>Details</th>";
  html += "<th style='padding:.8rem;text-align:left;font-weight:600;'>Submitted</th>";
  html += "<th style='padding:.8rem;text-align:center;font-weight:600;'>Actions</th>";
  html += "</tr></thead><tbody>";

  filtered.forEach(item => {
    const rowId = `approval-${item.type}-${item.id}`;
    let typeEmoji = item.type === "registration" ? "📝" : item.type === "resource" ? "📚" : "✍️";
    let details = "";

    if (item.type === "registration") {
      details = `<strong>${esc(item.studentName || "")}</strong> (${esc(item.emailNormalized || "")})<br/><small>${esc(item.studentId || "")}</small>`;
    } else if (item.type === "resource") {
      details = `<strong>${esc(item.courseCode || "")}</strong> - ${esc(item.courseName || "")}<br/><small>${esc(item.facultyName || "")}</small>`;
    } else if (item.type === "blog") {
      details = `<strong>${esc(item.title || "")}</strong><br/><small>by ${esc(item.authorEmail || "")}</small>`;
    }

    const submitted = fmtAdminDate(item.createdAt || item.uploadedAt || item.submittedAt);

    html += `<tr id='${rowId}' style='border-bottom:1px solid var(--line);'>`;
    html += `<td style='padding:.8rem;'>${typeEmoji} ${item.type}</td>`;
    html += `<td style='padding:.8rem;'>${details}</td>`;
    html += `<td style='padding:.8rem;'>${submitted}</td>`;
    html += `<td style='padding:.8rem;text-align:center;'>`;
    html += `<button class='approve-btn' data-type='${item.type}' data-id='${item.id}' style='background:var(--leaf-500);color:white;border:none;padding:.4rem .6rem;border-radius:4px;cursor:pointer;font-size:.8rem;margin-right:.3rem;'>✅ Approve</button>`;
    html += `<button class='reject-btn' data-type='${item.type}' data-id='${item.id}' style='background:var(--terracotta-500);color:white;border:none;padding:.4rem .6rem;border-radius:4px;cursor:pointer;font-size:.8rem;'>❌ Reject</button>`;
    html += `</td></tr>`;
  });

  html += "</tbody></table>";
  container.innerHTML = html;

  // Add event listeners
  container.querySelectorAll(".approve-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      await approveItem(type, id, container, filter);
    });
  });

  container.querySelectorAll(".reject-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      await rejectItem(type, id, container, filter);
    });
  });
}

async function approveItem(type, id, container, filter) {
  try {
    if (type === "registration") {
      await updateDoc(doc(db, "registrations", id), { status: "verified" });
    } else if (type === "resource") {
      await updateDoc(doc(db, "resources", id), { status: "approved" });
      const doc_data = (await getDocs(query(collection(db, "resources"), where("__name__", "==", id)))).docs[0].data();
      await syncStudentAccessStatus(db, doc_data.uploaderEmail);
    } else if (type === "blog") {
      await updateDoc(doc(db, "blogPosts", id), { status: "verified" });
    }
    loadApprovals();
  } catch (err) {
    alert(`Error approving ${type}: ${err.message}`);
  }
}

async function rejectItem(type, id, container, filter) {
  const reason = prompt(`Enter reason for rejecting this ${type}:`);
  if (reason === null) return;

  try {
    if (type === "registration") {
      await deleteDoc(doc(db, "registrations", id));
    } else if (type === "resource") {
      await updateDoc(doc(db, "resources", id), { status: "rejected", rejectionReason: reason });
    } else if (type === "blog") {
      await updateDoc(doc(db, "blogPosts", id), { status: "rejected", rejectionReason: reason });
    }
    loadApprovals();
  } catch (err) {
    alert(`Error rejecting ${type}: ${err.message}`);
  }
}

// ============================================
// RESOURCES
// ============================================
// ============================================
// HELPER FUNCTIONS
// ============================================
function getCurrentUserEmail() {
  const auth = getAuth();
  return auth.currentUser?.email || "admin@system";
}

function fmtAdminDate(timestamp) {
  if (!timestamp) return "N/A";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

// Decide which bucket a whole resource entry belongs in, based on the
// file types it contains. If it has a PDF, it's grouped under PDFs;
// else if it has an image, under Images; otherwise Other.
function getResourceCategory(item) {
  const files = item.fileUrls || [];
  const exts = files.map(f => getFileExt(f.name || f.url));
  if (exts.some(e => e === "pdf")) return "pdf";
  if (exts.some(e => IMAGE_EXTS.includes(e))) return "image";
  return "other";
}

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

    const buckets = { pdf: [], image: [], other: [] };
    snap.forEach(d => {
      const item = d.data();
      resourcesCache[d.id] = item;
      buckets[getResourceCategory(item)].push({ id: d.id, item });
    });

    list.innerHTML = [
      buildResourceSectionHTML("PDF Documents", "📄", buckets.pdf),
      buildResourceSectionHTML("Images", "🖼️", buckets.image),
      buildResourceSectionHTML("Other Files", "📁", buckets.other)
    ].join("");

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
          alert("Something went wrong deleting this resource. Please try again.");
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
          alert("Something went wrong deleting this file. Please try again.");
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
          alert("Something went wrong publishing this resource. Please try again.");
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
              ? { rejectedAt: new Date(), restrictedUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }
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
          }
        } catch (err) {
            await syncStudentAccessStatus(db, item.uploaderEmail);
          console.error("[AgriAdmin] resource status update failed:", err);
          alert("Something went wrong updating the status. Please try again.");
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

// ============================================
// RESET ALL BLOG REACTIONS
// ------------------------------------------------------------------
// A past bug let an "unlike" fire for a like a student never actually
// made (deleting nothing, but still decrementing likesCount), which
// could leave counts wrong — including negative — for posts that were
// affected before the underlying bug was fixed. There's no way to tell,
// after the fact, which of the existing blogLikes docs are genuine and
// which are left over from that bug, so the only clean way to guarantee
// every count is trustworthy again is a full one-time wipe: delete
// every blogLikes doc and zero out likesCount on every post. Going
// forward, real reactions build the count back up correctly.
// ============================================
const resetReactionsBtn = document.getElementById("reset-blog-reactions-btn");
const resetReactionsStatus = document.getElementById("reset-blog-reactions-status");

resetReactionsBtn?.addEventListener("click", async () => {
  if (!confirm("This deletes EVERY like on EVERY blog post and resets all like counts to 0. This cannot be undone. Continue?")) return;
  resetReactionsBtn.disabled = true;
  resetReactionsStatus.textContent = "Resetting…";
  try {
    const [likesSnap, postsSnap] = await Promise.all([
      getDocs(collection(db, "blogLikes")),
      getDocs(collection(db, "blogPosts"))
    ]);

    // Firestore batches cap out at 500 writes, so chunk both deletes and
    // the likesCount resets into batches of 400 to stay well under that.
    const allRefs = [
      ...likesSnap.docs.map(d => ({ ref: d.ref, type: "delete" })),
      ...postsSnap.docs
        .filter(d => (d.data().likesCount || 0) !== 0)
        .map(d => ({ ref: d.ref, type: "zero" }))
    ];

    for (let i = 0; i < allRefs.length; i += 400) {
      const batch = writeBatch(db);
      allRefs.slice(i, i + 400).forEach(({ ref, type }) => {
        if (type === "delete") batch.delete(ref);
        else batch.update(ref, { likesCount: 0 });
      });
      await batch.commit();
    }

    resetReactionsStatus.textContent = `Done — cleared ${likesSnap.size} like${likesSnap.size === 1 ? "" : "s"} across ${postsSnap.size} post${postsSnap.size === 1 ? "" : "s"}.`;
    loadBlogPosts();
  } catch (err) {
    console.error("[AgriAdmin] reset all reactions failed:", err);
    resetReactionsStatus.textContent = "Something went wrong — please try again.";
  } finally {
    resetReactionsBtn.disabled = false;
  }
});

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
    const buckets = { pending: [], pending_edit: [], approved: [], rejected: [] };
    snap.forEach(d => {
      const item = d.data();
      blogCache[d.id] = item;
      (buckets[item.status] || buckets.pending).push({ id: d.id, item });
    });

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
          alert("Something went wrong updating the status. Please try again.");
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
          alert("Something went wrong deleting this post. Please try again.");
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

    termList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      termsCache[d.id] = item;
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
          alert("Something went wrong deleting this term. Please try again.");
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
          alert("Something went wrong updating the status. Please try again.");
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
    alert("Something went wrong adding this event. Please try again.");
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
          alert("Something went wrong deleting this event. Please try again.");
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
async function loadRegistrations() {
  regList.innerHTML = `<p style="color:var(--moss-600);">Loading…</p>`;
  try {
    const q = query(collection(db, "registrations"), orderBy("submittedAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) { regList.innerHTML = `<p style="color:var(--moss-600);">No registrations yet.</p>`; return; }

    regList.innerHTML = "";
    snap.forEach(d => {
      const item = d.data();
      registrationsCache[d.id] = item;
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
          ${item.accountRestrictedUntil ? `<span class="account-restriction-badge" style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(196,90,63,.12);color:var(--terracotta-500);font-size:.78rem;font-weight:600;">⛔ Restricted until ${esc(fmtAdminDate(item.accountRestrictedUntil))}</span>` : ""}
          ${item.removed ? `<span class="user-removed-badge" style="display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;border-radius:999px;background:rgba(196,90,63,.14);color:var(--terracotta-500);font-size:.78rem;font-weight:700;">🚫 Removed${item.removedAt ? ` · ${esc(fmtAdminDate(item.removedAt))}` : ""}</span>` : ""}
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" class="edit-btn" data-schema="registrations" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--line);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✏️ Edit</button>
            ${item.idVerified
              ? `<button type="button" class="unverify-id-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--line);color:var(--moss-600);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">↩️ Unverify</button>`
              : `<button type="button" class="verify-id-btn" data-id="${esc(d.id)}" style="background:var(--leaf-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">🟢 Mark Verified</button>`}
            ${item.accountRestrictedUntil
              ? `<button type="button" class="unrestrict-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--leaf-500);color:var(--leaf-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">✅ Lift Restriction</button>`
              : `<button type="button" class="restrict-week-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">⛔ Restrict 7d</button>
                 <button type="button" class="restrict-custom-btn" data-id="${esc(d.id)}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">⛔ Custom…</button>`}
            ${item.removed
              ? `<button type="button" class="restore-user-btn" data-id="${esc(d.id)}" data-name="${esc(item.fullName || "")}" style="background:var(--leaf-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600;">↩️ Restore User</button>
                 <button type="button" class="erase-user-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" data-name="${esc(item.fullName || "")}" style="background:none;border:1px solid var(--terracotta-500);color:var(--terracotta-500);padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.72rem;">🗑️ Erase Permanently</button>`
              : `<button type="button" class="remove-user-btn" data-id="${esc(d.id)}" data-email="${esc(item.email || "")}" data-name="${esc(item.fullName || "")}" style="background:var(--terracotta-500);border:none;color:#fff;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;font-weight:600;">🗑️ Remove User</button>`}
          </div>
        </div>`;
      regList.appendChild(row);
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
          alert("Something went wrong removing this user. Please try again.");
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
          alert("Something went wrong restoring this user. Please try again.");
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
          alert("Something went wrong erasing this user. Please try again.");
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
          alert("Something went wrong marking this profile verified. Please try again.");
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
          alert("Something went wrong. Please try again.");
          btn.disabled = false;
        }
      });
    });

    async function applyAccountRestriction(id, days, reason) {
      try {
        await restrictAccountById(id, days, reason);
        loadRegistrations();
      } catch (err) {
        console.error("[AgriAdmin] account restriction failed:", err);
        alert("Something went wrong applying the restriction. Please try again.");
      }
    }

    regList.querySelectorAll(".restrict-week-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (!confirm("Restrict this account for 7 days? They'll see a freeze screen until then.")) return;
        applyAccountRestriction(btn.dataset.id, 7, "Restricted for 7 days by admin");
      });
    });

    regList.querySelectorAll(".restrict-custom-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const daysStr = prompt("Restrict this account for how many days?", "14");
        if (!daysStr) return;
        const days = Number(daysStr);
        if (!Number.isFinite(days) || days <= 0) { alert("Please enter a valid number of days."); return; }
        const reason = prompt("Reason to show the user (optional):", "") || "";
        applyAccountRestriction(btn.dataset.id, days, reason);
      });
    });

    regList.querySelectorAll(".unrestrict-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Lift this account's restriction now?")) return;
        try {
          await updateDoc(doc(db, "registrations", btn.dataset.id), {
            accountRestrictedUntil: null,
            accountRestrictedReason: "",
            accountRestrictedAt: null
          });
          loadRegistrations();
        } catch (err) {
          console.error("[AgriAdmin] lift restriction failed:", err);
          alert("Something went wrong lifting the restriction. Please try again.");
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
          <div style="font-size:.85rem;color:var(--moss-700);margin-top:.3rem;max-width:480px;">${esc(item.message)}</div>
        </div>`;
      msgList.appendChild(row);
    });
  } catch (err) {
    showLoadError(msgList, "messages", err);
  }
}

// ============================================
// CLASSROOM CODES ("Send Us Classroom Code" submissions, resources.html)
// ============================================
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
      const isContacted = item.status === "contacted";
      // "materials_request" = the general "Send Us Your Classroom Code" box
      // (resources.html) — a request to source course materials, NOT an
      // unlock request. It carries no targetFileId and js/access.js is
      // hard-coded to never grant it access, no matter its status here.
      const isMaterialsRequest = item.purpose === "materials_request";
      const statusLabel = isApproved
        ? (isMaterialsRequest ? "Reviewed" : "Approved & Unlocked")
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
            ${isMaterialsRequest
              ? `<div style="font-size:.78rem;color:#8A6A1A;margin-top:.15rem;">📋 General code for sourcing materials — does not unlock any file</div>`
              : item.targetFileId
                ? `<div style="font-size:.78rem;color:var(--moss-500,#7a8f7d);margin-top:.15rem;">Unlocking one specific file</div>`
                : `<div style="font-size:.78rem;color:var(--moss-500,#7a8f7d);margin-top:.15rem;">⚠️ No specific file — unlocks every file for this student</div>`}
          </div>
        </div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
          ${isApproved ? "" : `<button type="button" class="confirm-classroom-code-btn" data-id="${d.id}" style="background:var(--leaf-500);color:#fff;border:none;padding:.35rem .7rem;border-radius:6px;cursor:pointer;font-size:.78rem;">${isMaterialsRequest ? "✅ Mark Reviewed" : "✅ Confirm &amp; Unlock"}</button>`}
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
        btn.disabled = true;
        try {
          await updateDoc(doc(db, "classroomCodes", btn.dataset.id), { status: "approved", approvedAt: serverTimestamp() });
          loadClassroomCodes();
        } catch (err) {
          console.error("[AgriAdmin] Failed to confirm classroom code:", err);
          btn.disabled = false;
        }
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
      dangerResult.textContent = `❌ Something went wrong deleting "${label}". Please try again.`;
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
// ============================================
const bulkTermImagesInput = document.getElementById("bulk-term-images");
const bulkTermRows = document.getElementById("bulk-term-rows");
const bulkTermUploadBtn = document.getElementById("bulk-term-upload-btn");
const bulkTermStatus = document.getElementById("bulk-term-status");

let bulkTermFiles = [];

function filenameToTitle(name) {
  return name.replace(/\.[^/.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function uploadFileToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = 120000;
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

bulkTermImagesInput.addEventListener("change", () => {
  bulkTermFiles = Array.from(bulkTermImagesInput.files || []);
  bulkTermRows.innerHTML = "";
  bulkTermStatus.textContent = "";

  if (!bulkTermFiles.length) {
    bulkTermUploadBtn.classList.add("hidden");
    return;
  }

  bulkTermFiles.forEach((file, idx) => {
    const row = document.createElement("div");
    row.className = "bulk-term-row";
    row.dataset.index = String(idx);
    const objectUrl = URL.createObjectURL(file);
    row.innerHTML = `
      <img src="${objectUrl}" alt="">
      <div class="bulk-term-fields">
        <input type="text" class="bulk-term-name" placeholder="Term name" value="${esc(filenameToTitle(file.name))}">
        <textarea class="bulk-term-desc" placeholder="Short description (optional)" rows="2"></textarea>
      </div>
      <span class="bulk-term-status">Ready</span>`;
    bulkTermRows.appendChild(row);
  });

  bulkTermUploadBtn.classList.remove("hidden");
});

bulkTermUploadBtn.addEventListener("click", async () => {
  const rows = Array.from(bulkTermRows.querySelectorAll(".bulk-term-row"));
  if (!rows.length) return;

  bulkTermUploadBtn.disabled = true;
  bulkTermUploadBtn.textContent = "Uploading…";
  bulkTermStatus.textContent = "";

  let successCount = 0;
  let failCount = 0;

  for (const row of rows) {
    const idx = Number(row.dataset.index);
    const file = bulkTermFiles[idx];
    const nameInput = row.querySelector(".bulk-term-name");
    const descInput = row.querySelector(".bulk-term-desc");
    const statusEl = row.querySelector(".bulk-term-status");
    const name = nameInput.value.trim();

    if (!name) {
      statusEl.textContent = "⚠️ Name required";
      statusEl.style.color = "var(--terracotta-500)";
      failCount++;
      continue;
    }

    statusEl.textContent = "Uploading…";
    statusEl.style.color = "var(--moss-600)";
    nameInput.disabled = true;
    descInput.disabled = true;

    try {
      const imageUrl = await uploadFileToCloudinary(file, (pct) => {
        statusEl.textContent = `Uploading ${pct}%`;
      });
      await addDoc(collection(db, "terms"), {
        name,
        description: descInput.value.trim(),
        imageUrl,
        uploaderEmail: currentAdminEmail || "admin",
        status: "approved",
        possibleDuplicate: false,
        submittedAt: serverTimestamp(),
        reviewedAt: new Date()
      });
      statusEl.textContent = "✅ Published";
      statusEl.style.color = "var(--leaf-500)";
      successCount++;
    } catch (err) {
      console.error("[AgriAdmin] bulk term upload failed:", err);
      statusEl.textContent = "❌ Failed";
      statusEl.style.color = "var(--terracotta-500)";
      failCount++;
      nameInput.disabled = false;
      descInput.disabled = false;
    }
  }

  bulkTermStatus.textContent = `Done — ${successCount} published, ${failCount} failed.`;
  bulkTermStatus.style.color = failCount ? "var(--terracotta-500)" : "var(--leaf-500)";
  bulkTermUploadBtn.disabled = false;
  bulkTermUploadBtn.textContent = "⬆️ Upload All";

  if (successCount > 0) loadTerms();
});
