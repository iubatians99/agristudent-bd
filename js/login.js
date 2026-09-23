// ============================================
// AGRI CORE — LOGIN (rebuilt)
//
// Identity model: Firebase Authentication is the sole source of truth
// for "who is this". A student can get in two ways:
//   1) email + password, checked entirely server-side by
//      signInWithEmailAndPassword (nothing password-related is ever
//      read from or written to Firestore in plaintext or hashed form)
//   2) a one-time sign-in link emailed via sendSignInLinkToEmail, for
//      anyone who hasn't set a password yet or has forgotten it
// Either path, once Firebase confirms the identity, this file looks up
// the matching `registrations` Firestore document (created at sign-up
// — see js/registration.js) and starts the local session from it.
//
// This file was rewritten from scratch, but the identity system and
// Firestore schema it talks to are unchanged, so every account created
// by the previous login/registration code (or migrated in by
// tools/migrate-existing-users.mjs) logs in here exactly as before —
// no re-registration, no password reset, no data migration needed.
// ============================================
import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, updateDoc, doc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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

const LINK_EMAIL_KEY = "agri_login_link_email";
const returnTo = new URLSearchParams(window.location.search).get("return");

function destinationAfterLogin() {
  return returnTo && !returnTo.includes("://") ? returnTo : "profile.html";
}

// ---- DOM ----
const steps = {
  id: document.getElementById("id-step"),
  password: document.getElementById("password-step"),
  linkSent: document.getElementById("link-sent-step"),
  linkConfirm: document.getElementById("link-confirm-step")
};
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

function showStep(name) {
  Object.entries(steps).forEach(([key, el]) => el?.classList.toggle("hidden", key !== name));
}

function status(el, msg, isError = false) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  el.classList.remove("hidden");
}

function setBusy(btn, busyText) {
  if (!btn) return () => {};
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  return () => { btn.disabled = false; btn.textContent = original; };
}

function buildLinkUrl() {
  const url = new URL(window.location.origin + window.location.pathname);
  if (returnTo) url.searchParams.set("return", returnTo);
  return url.toString();
}

function cleanUrl() {
  try {
    window.history.replaceState({}, document.title, window.location.pathname + (returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""));
  } catch { /* non-fatal */ }
}

// ============================================
// Firestore lookup — only ever runs AFTER Firebase Auth has confirmed
// who the visitor is. firestore.rules requires an authenticated
// session to read a `registrations` doc at all (see the "REGISTRATIONS"
// section of firestore.rules), so there's no pre-login way to check
// "does this email exist" without leaking account data — the UI below
// is designed around that: it never tries to guess in advance.
// ============================================
async function findOwnRegistration(email) {
  const snap = await getDocs(query(collection(db, "registrations"), where("email", "==", email)));
  if (snap.empty) throw new Error("Your account profile could not be found.");
  const match = snap.docs.find(d => d.data().authUid === auth.currentUser?.uid) || snap.docs[0];
  return { id: match.id, reg: match.data() };
}

function startSessionFrom(id, reg) {
  saveSession({
    regId: id,
    fullName: reg.fullName,
    email: reg.email,
    studentIdNumber: reg.studentIdNumber,
    gender: reg.gender,
    avatarUrl: reg.avatarUrl,
    status: reg.status
  });
}

// Firestore rules only allow flipping a registration to "verified" once
// the Firebase ID token itself reports email_verified — force a fresh
// token here so a verification that just happened isn't read from a
// stale cached token and rejected by the write below.
async function finishSignIn(email, { markPasswordSet }) {
  await auth.currentUser.getIdToken(true);
  const { id, reg } = await findOwnRegistration(email);
  const patch = { authUid: auth.currentUser.uid, emailVerified: true };
  if (markPasswordSet) patch.passwordSet = true;
  await updateDoc(doc(db, "registrations", id), patch);
  startSessionFrom(id, { ...reg, ...patch });
}


// ============================================
// GOOGLE LOGIN
// ============================================
const googleLoginBtn = document.getElementById("google-login-btn");
const googleLoginStatus = document.getElementById("google-login-status");

function googleLoginStatusMsg(msg, error = false) {
  if (!googleLoginStatus) return;
  googleLoginStatus.textContent = msg;
  googleLoginStatus.style.color = error ? "var(--terracotta-500)" : "var(--moss-600)";
  googleLoginStatus.classList.remove("hidden");
}

googleLoginBtn?.addEventListener("click", async () => {
  googleLoginBtn.disabled = true;
  googleLoginBtn.textContent = "Signing in…";
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    const snap = await getDocs(query(collection(db, "registrations"), where("authUid", "==", user.uid)));
    if (snap.empty) {
      // Google login can also finish an account that was created elsewhere
      // with the same Firebase UID but has no registration record yet.
      const email = normalizeEmail(user.email);
      if (!email) throw new Error("Google did not return an email address.");
      const docRef = await addDoc(collection(db, "registrations"), {
        fullName: user.displayName?.trim() || "",
        email,
        gender: "",
        avatarUrl: user.photoURL || "",
        status: "incomplete",
        profileComplete: false,
        profileCompletionPercent: user.displayName?.trim() ? 50 : 25,
        emailVerified: !!user.emailVerified,
        authUid: user.uid,
        passwordSet: false,
        registrationCredits: 5,
        submittedAt: serverTimestamp(),
        authProvider: "google"
      });
      saveSession({ regId: docRef.id, fullName: user.displayName || "", email, studentIdNumber: "", gender: "", avatarUrl: user.photoURL || "", status: "incomplete" });
      window.location.href = destinationAfterLogin();
      return;
    }
    const d = snap.docs[0];
    const reg = d.data();
    await updateDoc(doc(db, "registrations", d.id), {
      authUid: user.uid,
      emailVerified: !!user.emailVerified,
      avatarUrl: reg.avatarUrl || user.photoURL || ""
    });
    startSessionFrom(d.id, { ...reg, emailVerified: !!user.emailVerified, avatarUrl: reg.avatarUrl || user.photoURL || "" });
    window.location.href = destinationAfterLogin();
  } catch (err) {
    console.error("[Login] Google sign-in failed:", err);
    googleLoginStatusMsg(
      err?.code === "auth/popup-closed-by-user" ? "Google sign-in was cancelled." : "Google login failed. Please try again.",
      true
    );
  } finally {
    googleLoginBtn.disabled = false;
    googleLoginBtn.textContent = "Continue with Google";
  }
});

// ============================================
// Email-link (passwordless) sign-in — used both for "never set a
// password" and "forgot my password". We never reveal whether the
// address is registered; the same message shows either way.
// ============================================
async function sendLoginLink(email, triggerBtn) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return false;

  const restore = setBusy(triggerBtn, "Sending…");
  try {
    await sendSignInLinkToEmail(auth, normalized, { url: buildLinkUrl(), handleCodeInApp: true });
    try { window.localStorage.setItem(LINK_EMAIL_KEY, normalized); } catch { /* link-confirm step covers this */ }
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
    restore();
  }
}

async function finishEmailLinkSignIn(email, statusEl) {
  if (statusEl) status(statusEl, "Signing you in…");
  try {
    const credential = await signInWithEmailLink(auth, email, window.location.href);
    const info = getAdditionalUserInfo(credential);

    if (info?.isNewUser) {
      // No Firebase Auth account existed for this email before this
      // click — every genuinely registered/migrated student already
      // has one, so this means the email was mistyped or was never
      // registered. Undo the account Firebase just auto-created so we
      // don't leave an orphan behind.
      await credential.user.delete().catch(() => {});
      await signOut(auth).catch(() => {});
      try { window.localStorage.removeItem(LINK_EMAIL_KEY); } catch { /* non-fatal */ }
      cleanUrl();
      showStep("linkConfirm");
      status(linkConfirmStatus, "No Agri Core account found for that email. Please double-check it, or register.", true);
      return;
    }

    await finishSignIn(email, { markPasswordSet: false });
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

// ============================================
// STEP 1 — enter the account email, move to the password step
// ============================================
idForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = normalizeEmail(idInput.value);
  if (!email || !email.includes("@")) {
    status(idStatus, "Please enter the email address used for your account.", true);
    return;
  }
  idStatus.classList.add("hidden");
  emailStepId.textContent = email;
  passwordForm.dataset.email = email;
  showStep("password");
  passwordInput.focus();
});

document.getElementById("password-step-back")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });
document.getElementById("link-sent-back")?.addEventListener("click", e => { e.preventDefault(); showStep(passwordForm.dataset.email ? "password" : "id"); });
document.getElementById("link-confirm-back")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });

// ============================================
// STEP 2 — password sign-in
// ============================================
passwordForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = normalizeEmail(passwordForm.dataset.email || "");
  const password = passwordInput.value;
  if (!email || !password) { status(passwordStatus, "Enter your email and password.", true); return; }

  const restore = setBusy(passwordSubmit, "Signing in…");
  status(passwordStatus, "Checking…");
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    if (!credential.user.emailVerified) {
      await sendPasswordResetEmail(auth, email).catch(() => {});
      status(passwordStatus, "Please verify your email first. We sent account instructions to your inbox.", true);
      await signOut(auth);
      return;
    }
    // A successful password sign-in — whichever password that is — is
    // proof the student now knows a real one, so this closes the loop
    // with js/session.js's "Set Up a Password" popup.
    await finishSignIn(email, { markPasswordSet: true });
    status(passwordStatus, "✅ Signed in. Redirecting…");
    setTimeout(() => window.location.replace(destinationAfterLogin()), 300);
  } catch (err) {
    console.error("[Login]", err);
    if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(err?.code)) {
      status(passwordStatus, "Wrong email or password — or you haven't set a password yet. Try \"Email me a login link\" below.", true);
    } else {
      status(passwordStatus, "Unable to sign in. Check your email/password, or use \"Email me a login link\" below.", true);
    }
  } finally {
    restore();
  }
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

linkConfirmForm?.addEventListener("submit", async e => {
  e.preventDefault();
  const email = normalizeEmail(linkConfirmInput.value);
  if (!email || !email.includes("@")) { status(linkConfirmStatus, "Enter the email address you used to request the link.", true); return; }
  await finishEmailLinkSignIn(email, linkConfirmStatus);
});

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

  if (getSession() && auth.currentUser) {
    window.location.replace(destinationAfterLogin());
    return;
  }
  showStep("id");
}

boot();
