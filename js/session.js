// ============================================
// STUDENT SESSION (login/logout)
//
// ⚠️ Same trust model as the rest of the site (see js/auth-guard.js and
// firestore.rules): students never had a password-based account here,
// only a registration record. This session is a convenience layer on
// top of that record — it remembers WHICH registration you are, so you
// don't have to retype your Student ID / email on every page. It is
// NOT a security boundary; real access control is Firestore Security
// Rules, unchanged by this file.
//
// Session is stored in localStorage (persists across tabs/visits) as a
// single JSON blob under SESSION_KEY.
// ============================================
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { db } from "./firebase-config.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { hashPassword, isPasswordValid } from "./password.js";
import { fetchMessagesForUser } from "./inbox.js";

const SESSION_KEY = "agri_session_v1";

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.email || !parsed.regId) return null;
    return parsed;
  } catch (err) {
    console.warn("[Session] corrupt session data, clearing.", err);
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function saveSession({ regId, fullName, email, studentIdNumber, gender, avatarUrl, status }) {
  const session = {
    regId,
    fullName: fullName || "",
    email: normalizeEmail(email),
    studentIdNumber: normalizeStudentId(studentIdNumber),
    gender: gender || "",
    avatarUrl: avatarUrl || (gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg"),
    status: status || "unverified"
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));

  // Keep the pre-existing resource-gate caches in sync so resources.html /
  // slides-notes.html / previous-questions.html immediately recognize this
  // student without asking them to re-enter anything (also fixes stale
  // mismatched values left over from before login existed).
  try {
    sessionStorage.setItem("agri_student_id", session.studentIdNumber);
    localStorage.setItem("agri_handnotes_user_email", session.email);
  } catch (err) { /* storage unavailable — non-fatal */ }

  return session;
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  try {
    sessionStorage.removeItem("agri_student_id");
    localStorage.removeItem("agri_handnotes_user_email");
  } catch (err) { /* storage unavailable — non-fatal */ }
}

// ============================================
// NAVBAR AUTH SLOT
// Renders "👤 Name" + Logout when logged in, or a Login link when not.
// Runs once the shared navbar has actually been injected into the page
// (navbar-loader.js calls whenNavbarReady's queued callbacks) so this
// never races the fetch("navbar.html") injection.
// ============================================
function renderAuthSlot() {
  const slot = document.getElementById("navbar-auth-slot");
  if (!slot) return;
  const session = getSession();

  // "My Profile" in the side/mobile drawer menu — see .nav-profile-mobile-item
  // in css/style.css (hidden on the desktop nav, shown only in the
  // slide-in drawer, where the avatar+name link in .navbar-auth-slot
  // isn't visible).
  const navLinksList = document.querySelector("#nav-links ul");
  let profileMobileLi = document.getElementById("nav-profile-mobile-item");

  if (!session) {
    slot.innerHTML = `<a href="login.html" class="navbar-auth-login">Login</a>`;
    profileMobileLi?.remove();
    return;
  }

  if (navLinksList && !profileMobileLi) {
    profileMobileLi = document.createElement("li");
    profileMobileLi.id = "nav-profile-mobile-item";
    profileMobileLi.className = "nav-profile-mobile-item";
    profileMobileLi.innerHTML = `<a href="profile.html"><span class="nav-link-icon">👤</span><span>My Profile</span></a>`;
    navLinksList.insertBefore(profileMobileLi, navLinksList.firstChild);
  }
  if (profileMobileLi) {
    const current = location.pathname.split("/").pop() || "index.html";
    profileMobileLi.querySelector("a")?.classList.toggle("active", current === "profile.html");
  }

  const displayName = (session.fullName || session.email).split(" ")[0];
  slot.innerHTML = `
    <a href="profile.html#inbox" class="navbar-auth-profile" title="${session.fullName || session.email}">
      <span class="navbar-auth-avatar-wrap">
        <img src="${session.avatarUrl}" alt="" class="navbar-auth-avatar">
        <span id="navbar-inbox-dot" class="navbar-inbox-dot hidden" title="You have unread messages"></span>
      </span>
      <span>${displayName}</span>
    </a>
    <button type="button" class="navbar-auth-logout" id="navbar-logout-btn">Logout</button>
  `;

  const logoutBtn = document.getElementById("navbar-logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearSession();
      window.location.href = "index.html";
    });
  }

  // Best-effort — a failed/slow inbox check should never block the navbar.
  fetchMessagesForUser(session.regId)
    .then((messages) => {
      const unread = messages.filter(m => !m.read).length;
      const dot = document.getElementById("navbar-inbox-dot");
      if (dot) dot.classList.toggle("hidden", unread === 0);
    })
    .catch((err) => console.warn("[Session] inbox badge check failed:", err));
}

function whenNavbarReady(fn) {
  if (window.__navbarLoaded) fn();
  else (window.__onNavbarReady = window.__onNavbarReady || []).push(fn);
}

whenNavbarReady(renderAuthSlot);

// ============================================
// ACCOUNT RESTRICTION — SITE-WIDE FREEZE SCREEN
// Admin can restrict a misbehaving account for a set number of days
// (registrations/{regId}.accountRestrictedUntil + accountRestrictedReason).
// Every page that imports session.js checks this on load and, if active,
// covers the page with a freeze overlay instead of the normal content.
// The admin panel itself (admin.html) is exempt so admins can still work.
// ============================================
function formatRestrictionDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}`;
}

function showAccountFreezeScreen(untilMs, reason) {
  if (document.getElementById("account-freeze-overlay")) return;
  const daysLeft = Math.max(1, Math.ceil((untilMs - Date.now()) / (24 * 60 * 60 * 1000)));
  const overlay = document.createElement("div");
  overlay.id = "account-freeze-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(31,46,34,.96);display:flex;align-items:center;justify-content:center;padding:1.5rem;text-align:center;";
  overlay.innerHTML = `
    <div style="max-width:420px;background:#fff;border-radius:18px;padding:2rem 1.6rem;">
      <div style="font-size:2.2rem;margin-bottom:.6rem;">🚫</div>
      <h2 style="font-family:var(--font-display, serif);font-size:1.3rem;margin-bottom:.6rem;">You are restricted for ${daysLeft} day${daysLeft === 1 ? "" : "s"}</h2>
      <p style="color:var(--moss-600,#5b6f57);font-size:.9rem;margin-bottom:.4rem;">Restriction ends on <strong>${formatRestrictionDate(untilMs)}</strong>.</p>
      ${reason ? `<p style="color:var(--moss-600,#5b6f57);font-size:.85rem;margin-bottom:1rem;">Reason: ${reason}</p>` : `<div style="margin-bottom:1rem;"></div>`}
      <p style="color:var(--moss-600,#5b6f57);font-size:.85rem;margin-bottom:1.2rem;">If you believe this is a mistake, please contact admin.</p>
      <a href="help.html" style="display:inline-block;background:var(--leaf-500,#6b9b5e);color:#fff;font-weight:700;padding:.75rem 1.4rem;border-radius:999px;text-decoration:none;">💬 Contact Admin / Help</a>
    </div>`;
  document.documentElement.appendChild(overlay);
  document.body.style.overflow = "hidden";
}

// ============================================
// ACCOUNT REMOVAL — SITE-WIDE OVERLAY
// Admin can remove an account (js/admin.js "Remove User") without
// deleting any of the student's data — it's reversible any time from
// the same admin panel via "Restore User". If a removed student is
// still logged in elsewhere, this covers the page and clears their
// local session so they can't keep browsing as that account until
// they're restored.
// ============================================
function showAccountRemovedScreen(reason) {
  if (document.getElementById("account-freeze-overlay")) return;
  clearSession();
  const overlay = document.createElement("div");
  overlay.id = "account-freeze-overlay";
  overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(31,46,34,.96);display:flex;align-items:center;justify-content:center;padding:1.5rem;text-align:center;";
  overlay.innerHTML = `
    <div style="max-width:420px;background:#fff;border-radius:18px;padding:2rem 1.6rem;">
      <div style="font-size:2.2rem;margin-bottom:.6rem;">🚫</div>
      <h2 style="font-family:var(--font-display, serif);font-size:1.3rem;margin-bottom:.6rem;">This account has been removed</h2>
      <p style="color:var(--moss-600,#5b6f57);font-size:.9rem;margin-bottom:.4rem;">An admin has removed this account. You've been logged out.</p>
      ${reason ? `<p style="color:var(--moss-600,#5b6f57);font-size:.85rem;margin-bottom:1rem;">Reason: ${reason}</p>` : `<div style="margin-bottom:1rem;"></div>`}
      <p style="color:var(--moss-600,#5b6f57);font-size:.85rem;margin-bottom:1.2rem;">If you believe this is a mistake, please contact admin — removals can be reversed.</p>
      <a href="help.html" style="display:inline-block;background:var(--leaf-500,#6b9b5e);color:#fff;font-weight:700;padding:.75rem 1.4rem;border-radius:999px;text-decoration:none;">💬 Contact Admin / Help</a>
    </div>`;
  document.documentElement.appendChild(overlay);
  document.body.style.overflow = "hidden";
}

async function checkAccountRestriction() {
  // Admins reviewing/managing the site must never be locked out by this.
  if (/\/?admin\.html/.test(window.location.pathname)) return;
  const session = getSession();
  if (!session || !session.regId) return;
  try {
    const snap = await getDoc(doc(db, "registrations", session.regId));
    if (!snap.exists()) return;
    const reg = snap.data();

    if (reg.removed) {
      showAccountRemovedScreen(reg.removedReason || "");
      return;
    }

    const until = reg.accountRestrictedUntil?.toDate?.()?.getTime?.() || Number(reg.accountRestrictedUntil) || 0;
    if (until && until > Date.now()) {
      showAccountFreezeScreen(until, reg.accountRestrictedReason || "");
      return;
    }

    maybeShowPasswordSetupPopup(session.regId, reg);
  } catch (err) {
    console.error("[Session] account restriction check failed:", err);
  }
}

// ============================================
// PASSWORD SETUP POPUP — shown site-wide, the very first thing a
// logged-in student sees on any page, for as long as their account has
// no passwordHash yet (a fresh registration, or a legacy account that
// logged in the old email-only way). Replaces the old flow where a
// password was optional and buried in Profile settings; setting one
// here NEVER emails the plaintext password anywhere (js/login.js and
// js/profile.js don't either — see their password-save handlers).
// A "Maybe later" dismissal only lasts for this browser tab/session —
// it reappears next time they open the site until a password is set.
// ============================================
function pwdPopupDismissKey(regId) {
  return `agri_pwd_popup_dismissed_${regId}`;
}

function maybeShowPasswordSetupPopup(regId, reg) {
  if (!regId || reg.passwordHash) return;
  if (document.getElementById("pwd-setup-overlay")) return;
  // BUG FIX — "duplicate password-setup popup": profile.html has its own
  // dedicated first-time password card/modal (#profile-password-modal,
  // see js/profile.js renderPasswordSection). If this site-wide popup also
  // fired there, a passwordless student landing on Profile could end up
  // looking at two separate "set your password" prompts stacked on top
  // of each other. Profile's own UI already covers this case, so skip
  // the site-wide popup specifically on that page.
  if (document.getElementById("profile-password-modal")) return;
  try {
    if (sessionStorage.getItem(pwdPopupDismissKey(regId))) return;
  } catch { /* storage unavailable — just show it */ }

  const overlay = document.createElement("div");
  overlay.id = "pwd-setup-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:420px;">
      <div class="modal-body">
        <h3>🔐 Set Up a Password</h3>
        <p class="modal-desc" style="max-height:none;">
          Secure your account with a password so you can log in faster next time — just your
          Student ID and this password, no email step needed.
        </p>
        <form id="pwd-setup-form" style="margin-top:1rem;">
          <div class="form-field">
            <label for="pwd-setup-new">New password (min. 6 characters)</label>
            <input type="password" id="pwd-setup-new" autocomplete="new-password" minlength="6" required>
          </div>
          <div class="form-field" style="margin-bottom:.6rem;">
            <label for="pwd-setup-confirm">Confirm password</label>
            <input type="password" id="pwd-setup-confirm" autocomplete="new-password" minlength="6" required>
          </div>
          <button type="submit" class="btn-primary" id="pwd-setup-submit" style="width:100%;">Set Password</button>
          <button type="button" id="pwd-setup-later" style="width:100%;background:none;border:none;color:var(--moss-600);padding:.7rem 0 0;cursor:pointer;font-size:.85rem;text-decoration:underline;">Maybe later</button>
          <p id="pwd-setup-status" style="margin-top:.6rem;font-size:.85rem;min-height:1.2em;"></p>
        </form>
      </div>
    </div>`;
  document.documentElement.appendChild(overlay);

  const statusEl = overlay.querySelector("#pwd-setup-status");
  function showStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? "var(--terracotta-500, #C1704D)" : "var(--moss-600, #5b6f57)";
  }

  overlay.querySelector("#pwd-setup-later").addEventListener("click", () => {
    try { sessionStorage.setItem(pwdPopupDismissKey(regId), "1"); } catch { /* ignore */ }
    overlay.remove();
  });

  overlay.querySelector("#pwd-setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = overlay.querySelector("#pwd-setup-new").value;
    const confirm = overlay.querySelector("#pwd-setup-confirm").value;

    if (!isPasswordValid(password)) {
      showStatus("Password must be at least 6 characters.", true);
      return;
    }
    if (password !== confirm) {
      showStatus("Passwords don't match.", true);
      return;
    }

    const submitBtn = overlay.querySelector("#pwd-setup-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    showStatus("Saving your password…");

    try {
      const passwordHash = await hashPassword(password, reg.email);
      await updateDoc(doc(db, "registrations", regId), { passwordHash });
      showStatus("✅ Password saved!");
      setTimeout(() => overlay.remove(), 900);
    } catch (err) {
      console.error("[Session] password setup failed:", err);
      showStatus("Something went wrong saving your password. Please try again.", true);
      submitBtn.disabled = false;
      submitBtn.textContent = "Set Password";
    }
  });
}

checkAccountRestriction();
