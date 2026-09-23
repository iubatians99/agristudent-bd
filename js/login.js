import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail } from "./identity.js";
import { getSession, saveSession } from "./session.js";
import {
  signInWithEmailAndPassword,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  getAdditionalUserInfo,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const returnTo = new URLSearchParams(window.location.search).get("return");
function destinationAfterLogin() { return returnTo && !returnTo.includes("://") ? returnTo : "profile.html"; }

const LINK_EMAIL_KEY = "agri_login_link_email";

// ============================================
// ACCOUNT LOOKUP (post sign-in only — see the note further down about
// why this can never run before the visitor is authenticated).
// ============================================
async function loadOwnRegistration(email) {
  const snap = await getDocs(query(collection(db, "registrations"), where("email", "==", email)));
  if (snap.empty) throw new Error("Your account profile could not be found.");
  const match = snap.docs.find(d => d.data().authUid === auth.currentUser?.uid) || snap.docs[0];
  return { id: match.id, reg: match.data() };
}

function loginToSession(id, reg) {
  saveSession({ regId: id, fullName: reg.fullName, email: reg.email, studentIdNumber: reg.studentIdNumber, gender: reg.gender, avatarUrl: reg.avatarUrl, status: reg.status });
}

const steps = {
  id: document.getElementById("id-step"),
  password: document.getElementById("password-step"),
  linkSent: document.getElementById("link-sent-step"),
  linkConfirm: document.getElementById("link-confirm-step")
};
function showStep(name) { Object.entries(steps).forEach(([k, el]) => el?.classList.toggle("hidden", k !== name)); }

const idForm = document.getElementById("id-form");
const idInput = document.getElementById("id-studentId");
const idStatus = document.getElementById("id-status");
const idSubmit = document.getElementById("id-submit");
const passwordForm = document.getElementById("password-form");
const passwordInput = document.getElementById("login-password");
const passwordStatus = document.getElementById("password-login-status");
const passwordSubmit = document.getElementById("password-submit");
const emailStepId = document.getElementById("password-step-id");
const linkSentTo = document.getElementById("link-sent-to");
const linkSentStatus = document.getElementById("link-sent-status");
const linkConfirmForm = document.getElementById("link-confirm-form");
const linkConfirmInput = document.getElementById("link-confirm-email");
const linkConfirmStatus = document.getElementById("link-confirm-status");

function status(el, msg, error = false) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = error ? "var(--terracotta-500)" : "var(--moss-600)";
  el.classList.remove("hidden");
}

function buildLinkUrl() {
  const url = new URL(window.location.origin + window.location.pathname);
  if (returnTo) url.searchParams.set("return", returnTo);
  return url.toString();
}

// Sends the passwordless sign-in link and shows the "check your email" step.
// Used both by "never set a password yet" and "forgot my password" — either
// way, clicking the emailed link signs the student straight in with no
// password needed. (We never reveal whether the address is registered —
// same non-enumeration approach the old reset flow used.)
async function sendLoginLink(email, triggerBtn) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    return false;
  }
  const oldText = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Sending…"; }
  try {
    await sendSignInLinkToEmail(auth, normalized, { url: buildLinkUrl(), handleCodeInApp: true });
    try { window.localStorage.setItem(LINK_EMAIL_KEY, normalized); } catch { /* storage unavailable — link-confirm step covers this */ }
    linkSentTo.textContent = `If an Agri Core account exists for ${normalized}, we've sent a secure sign-in link to that inbox.`;
    status(linkSentStatus, "It's valid for about an hour and signs you straight in — no password needed. You can set one up right after.");
    showStep("linkSent");
    return true;
  } catch (err) {
    console.error("[Login] sendSignInLinkToEmail failed:", err);
    status(linkSentStatus, "Couldn't send the link right now. Please try again in a moment.", true);
    showStep("linkSent");
    return false;
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = oldText; }
  }
}

// ============================================
// STEP 1 — email address, then straight to the password step.
//
// NOTE ON WHY THIS DOESN'T TRY TO DETECT "has this account set a
// password yet?" BEFORE SIGN-IN:
// firestore.rules only lets a visitor read/list a `registrations` doc
// once they're already signed in as that account, so an anonymous
// pre-login lookup either fails outright or would require loosening the
// rules to leak account data to anyone who types an email — not a trade
// worth making. Instead the password step offers BOTH paths up front:
// type a password if you have one, or tap "email me a sign-in link" if
// you don't (or forgot it) — no guessing required.
// ============================================
idForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = normalizeEmail(idInput.value);
  if (!email || !email.includes("@")) { status(idStatus, "Please enter the email address used for your account.", true); return; }
  idSubmit.disabled = true; idSubmit.textContent = "Continue…";
  status(idStatus, "");
  idStatus.classList.add("hidden");
  emailStepId.textContent = email;
  passwordForm.dataset.email = email;
  showStep("password");
  passwordInput.focus();
  idSubmit.disabled = false; idSubmit.textContent = "Continue";
});

document.getElementById("password-step-back")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });
document.getElementById("link-sent-back")?.addEventListener("click", e => { e.preventDefault(); showStep(passwordForm.dataset.email ? "password" : "id"); });
document.getElementById("link-confirm-back")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });

// ============================================
// STEP 2 — password login (for accounts that have set one)
// ============================================
// Firestore rules only let an account move to status "verified" once
// request.auth.token.email_verified is true, so this force-refreshes the
// ID token right before writing — otherwise a token cached from before a
// just-completed verification could still read as unverified and the
// Firestore write below would fail with permission-denied.
async function completePostSignIn(email, { markPasswordSet } = {}) {
  await auth.currentUser.getIdToken(true);
  const { id, reg } = await loadOwnRegistration(email);
  const patch = { authUid: auth.currentUser.uid, status: "verified", emailVerified: true };
  if (markPasswordSet) patch.passwordSet = true;
  await updateDoc(doc(db, "registrations", id), patch);
  loginToSession(id, { ...reg, ...patch });
}

passwordForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = normalizeEmail(passwordForm.dataset.email || "");
  const password = passwordInput.value;
  if (!email || !password) { status(passwordStatus, "Enter your email and password.", true); return; }
  passwordSubmit.disabled = true; passwordSubmit.textContent = "Signing in…"; status(passwordStatus, "Checking…");
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    if (!credential.user.emailVerified) {
      await sendPasswordResetEmail(auth, email).catch(() => {});
      status(passwordStatus, "Please verify your email first. We sent account instructions to your inbox.", true);
      await signOut(auth);
      return;
    }
    // Signing in with a password here — whichever password that is — is
    // proof the student now knows a real one, whether they set it at
    // registration or earlier. Recording that closes the loop with
    // js/session.js's "Set Up a Password" popup, which should never
    // re-nag someone who already has a working password.
    await completePostSignIn(email, { markPasswordSet: true });
    status(passwordStatus, "✅ Signed in. Redirecting…");
    setTimeout(() => window.location.replace(destinationAfterLogin()), 300);
  } catch (err) {
    console.error("[Login]", err);
    if (err?.code === "auth/invalid-credential" || err?.code === "auth/wrong-password" || err?.code === "auth/user-not-found") {
      status(passwordStatus, "Wrong email or password — or you haven't set a password yet. Try \"Email me a login link\" below.", true);
    } else {
      status(passwordStatus, "Unable to sign in. Check your email/password, or use \"Email me a login link\" below.", true);
    }
  } finally { passwordSubmit.disabled = false; passwordSubmit.textContent = "Log In"; }
});

document.getElementById("id-step-forgot-link")?.addEventListener("click", async e => {
  e.preventDefault();
  const email = idInput.value;
  if (!normalizeEmail(email).includes("@")) { status(idStatus, "Enter your email address above first.", true); return; }
  passwordForm.dataset.email = normalizeEmail(email);
  await sendLoginLink(email, e.currentTarget);
});

document.getElementById("forgot-password-link")?.addEventListener("click", async e => {
  e.preventDefault();
  const email = passwordForm.dataset.email || "";
  if (!normalizeEmail(email).includes("@")) { status(passwordStatus, "Enter your email address first.", true); return; }
  await sendLoginLink(email, e.currentTarget);
});

// ============================================
// STEP — confirm email + finish an email-link sign-in
// (only needed if the link is opened somewhere localStorage doesn't
// carry over from, e.g. a different browser/device than it was
// requested on)
// ============================================
linkConfirmForm?.addEventListener("submit", async e => {
  e.preventDefault();
  const email = normalizeEmail(linkConfirmInput.value);
  if (!email || !email.includes("@")) { status(linkConfirmStatus, "Enter the email address you used to request the link.", true); return; }
  await finishEmailLinkSignIn(email, linkConfirmStatus);
});

// ============================================
// COMPLETE AN EMAIL-LINK (PASSWORDLESS) SIGN-IN
// Handles both "already have a password but forgot it" and "never set
// one yet" accounts — either way, clicking the link is enough to get
// in. js/session.js's site-wide popup then offers to set a password.
// ============================================
async function finishEmailLinkSignIn(email, statusEl) {
  if (statusEl) status(statusEl, "Signing you in…");
  try {
    const credential = await signInWithEmailLink(auth, email, window.location.href);
    const info = getAdditionalUserInfo(credential);
    if (info?.isNewUser) {
      // No Firebase Auth account existed for this email before this
      // click — every real registered/migrated student already has
      // one, so this means the email was mistyped or was never
      // registered. Undo the account Firebase just auto-created so we
      // don't leave an orphaned login behind.
      await credential.user.delete().catch(() => {});
      await signOut(auth).catch(() => {});
      try { window.localStorage.removeItem(LINK_EMAIL_KEY); } catch { /* non-fatal */ }
      cleanUrl();
      showStep("linkConfirm");
      status(linkConfirmStatus, "No Agri Core account found for that email. Please double-check it, or register.", true);
      return;
    }

    await completePostSignIn(email, { markPasswordSet: false });
    try { window.localStorage.removeItem(LINK_EMAIL_KEY); } catch { /* non-fatal */ }
    cleanUrl();
    if (statusEl) status(statusEl, "✅ Signed in. Redirecting…");
    setTimeout(() => window.location.replace(destinationAfterLogin()), 300);
  } catch (err) {
    console.error("[Login] email-link sign-in failed:", err);
    const msg = err?.code === "auth/invalid-action-code"
      ? "This link has expired or was already used. Request a new one below."
      : "Something went wrong signing you in with that link. Please try again.";
    showStep("linkConfirm");
    status(linkConfirmStatus, msg, true);
  }
}

function cleanUrl() {
  try { window.history.replaceState({}, document.title, window.location.pathname + (returnTo ? `?return=${encodeURIComponent(returnTo)}` : "")); } catch { /* non-fatal */ }
}

// ============================================
// BOOT
// ============================================
async function boot() {
  if (isSignInWithEmailLink(auth, window.location.href)) {
    let storedEmail = null;
    try { storedEmail = window.localStorage.getItem(LINK_EMAIL_KEY); } catch { /* non-fatal */ }
    if (storedEmail) {
      showStep("linkSent");
      status(linkSentStatus, "Signing you in…");
      await finishEmailLinkSignIn(storedEmail, linkSentStatus);
    } else {
      showStep("linkConfirm");
    }
    return;
  }

  if (getSession() && auth.currentUser) { window.location.replace(destinationAfterLogin()); return; }
  showStep("id");
}

boot();
