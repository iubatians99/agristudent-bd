import { db, auth } from "./firebase-config.js";
import { collection, query, where, getDocs, updateDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail } from "./identity.js";
import { getSession, saveSession } from "./session.js";
import { signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const returnTo = new URLSearchParams(window.location.search).get("return");
function destinationAfterLogin() { return returnTo && !returnTo.includes("://") ? returnTo : "profile.html"; }
if (getSession() && auth.currentUser) window.location.replace(destinationAfterLogin());

const steps = {
  id: document.getElementById("id-step"),
  password: document.getElementById("password-step"),
  resetRequest: document.getElementById("reset-request-step"),
  resetOtp: document.getElementById("reset-otp-step"),
  resetPassword: document.getElementById("reset-password-step"),
  resetDone: document.getElementById("reset-done-step")
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

function status(el, msg, error = false) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = error ? "var(--terracotta-500)" : "var(--moss-600)";
  el.classList.remove("hidden");
}

async function loadOwnRegistration(email) {
  const snap = await getDocs(query(collection(db, "registrations"), where("email", "==", email)));
  if (snap.empty) throw new Error("Your account profile could not be found.");
  const match = snap.docs.find(d => d.data().authUid === auth.currentUser?.uid) || snap.docs[0];
  return { id: match.id, reg: match.data() };
}

function loginToSession(id, reg) {
  saveSession({ regId: id, fullName: reg.fullName, email: reg.email, studentIdNumber: reg.studentIdNumber, gender: reg.gender, avatarUrl: reg.avatarUrl, status: reg.status });
}

// NOTE ON THE ACCOUNT LOOKUP THAT USED TO LIVE HERE:
// This used to try to look up the typed email in Firestore first, to
// decide whether to show a password field or an old "email only, no
// password yet" screen. That lookup can't be done safely before sign-in:
// firestore.rules only lets a visitor read/list a `registrations` doc
// once they're already signed in as that account (see the `allow get` /
// `allow list` rules), so an anonymous pre-login lookup either fails
// outright or would require loosening the rules to leak account data to
// anyone who types an email — not a trade worth making for a cosmetic
// branch. Every account (freshly registered, or migrated by
// tools/migrate-existing-users.mjs) already has a real Firebase Auth
// password — freshly-registered students chose theirs at signup;
// migrated students were given a random one nobody knows. So this
// screen always asks for a password next, and "Forgot / never set a
// password?" below is the one path for both "I forgot it" and "I never
// knew it" — it hands out a secure reset link, which is the only safe
// way to get a migrated account its first real, known password.
idForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = normalizeEmail(idInput.value);
  if (!email || !email.includes("@")) { status(idStatus, "Please enter the email address used for your account.", true); return; }
  idSubmit.disabled = true; idSubmit.textContent = "Continue…";
  status(idStatus, "Enter your password to continue.");
  emailStepId.textContent = email;
  passwordForm.dataset.email = email;
  if (resetInput) resetInput.value = email;
  showStep("password");
  passwordInput.focus();
  idSubmit.disabled = false; idSubmit.textContent = "Continue";
});

document.getElementById("password-step-back")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });

document.getElementById("id-step-forgot-link")?.addEventListener("click", e => {
  e.preventDefault();
  if (resetInput) resetInput.value = normalizeEmail(idInput.value);
  showStep("resetRequest");
});
document.getElementById("forgot-password-link")?.addEventListener("click", e => {
  e.preventDefault();
  if (resetInput) resetInput.value = passwordForm.dataset.email || "";
  showStep("resetRequest");
});

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
    const { id, reg } = await loadOwnRegistration(email);
    // Signing in with a password here — whichever password that is — is
    // proof the student now knows a real one, whether they set it at
    // registration or just finished a password-reset link for a migrated
    // account. Recording that closes the loop with js/session.js's
    // "Set Up a Password" popup, which should never re-nag someone who
    // just successfully did exactly that.
    await updateDoc(doc(db, "registrations", id), { authUid: credential.user.uid, status: "verified", emailVerified: true, passwordSet: true });
    loginToSession(id, { ...reg, authUid: credential.user.uid, status: "verified", emailVerified: true, passwordSet: true });
    status(passwordStatus, "✅ Signed in. Redirecting…");
    setTimeout(() => window.location.replace(destinationAfterLogin()), 300);
  } catch (err) {
    console.error("[Login]", err);
    status(passwordStatus, "Unable to sign in. Check your email/password or use Forgot password.", true);
  } finally { passwordSubmit.disabled = false; passwordSubmit.textContent = "Log In"; }
});

const resetInput = document.getElementById("reset-lookup-input");
const resetBtn = document.getElementById("reset-request-btn");
const resetStatus = document.getElementById("reset-request-status");
resetBtn?.addEventListener("click", async () => {
  const email = normalizeEmail(resetInput.value);
  if (!email || !email.includes("@")) { status(resetStatus, "Enter the email address on your account.", true); return; }
  resetBtn.disabled = true; resetBtn.textContent = "Sending…";
  try {
    await sendPasswordResetEmail(auth, email);
    status(resetStatus, "If an account exists for that email, a secure password-reset link has been sent.");
  } catch (err) {
    // Deliberately generic: do not disclose whether an email is registered.
    status(resetStatus, "If an account exists for that email, a secure password-reset link has been sent.");
  } finally { resetBtn.disabled = false; resetBtn.textContent = "Send Reset Link"; }
});

document.getElementById("reset-back-to-login")?.addEventListener("click", e => { e.preventDefault(); showStep("id"); });
document.getElementById("reset-otp-back")?.addEventListener("click", e => { e.preventDefault(); showStep("resetRequest"); });

// Keep the existing password-reset markup hidden; Firebase Auth now owns the reset flow.
showStep("id");
