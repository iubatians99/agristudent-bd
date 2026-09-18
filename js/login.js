import { db } from "./firebase-config.js";
import { collection, query, where, getDocs, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { getSession, saveSession } from "./session.js";
import { hashPassword, isPasswordValid } from "./password.js";
import { initEmailNotifications, sendOtpEmail } from "./email-config.js";
import { startOtp, verifyOtp, resendCooldownRemaining, clearOtp } from "./otp.js";

initEmailNotifications();

// Supports an optional ?return=page.html so flows like the Hand Notes
// unlock gate can send the person to log in and land right back where
// they started, instead of always bouncing to the profile page.
const returnTo = new URLSearchParams(window.location.search).get("return");
function destinationAfterLogin() {
  if (returnTo && !returnTo.includes("://")) return returnTo;
  return "profile.html";
}

// Already logged in? Skip the form and go straight to the destination.
if (getSession()) {
  window.location.replace(destinationAfterLogin());
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!domain) return email || "";
  const visible = name.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

async function findRegistrationByStudentId(studentId) {
  const q = query(collection(db, "registrations"), where("studentIdNumber", "==", studentId));
  const snap = await getDocs(q);
  const active = snap.docs.find(d => !d.data().removed) || snap.docs[0] || null;
  return active;
}

async function findRegistrationByEmail(email) {
  const q = query(collection(db, "registrations"), where("email", "==", email));
  const snap = await getDocs(q);
  const active = snap.docs.find(d => !d.data().removed) || snap.docs[0] || null;
  return active;
}

/** Looks an account up by whatever the student typed — a Student ID or
 * an email address, decided by whether it looks like an email. Shared by
 * the "forgot password" lookup step below. */
async function findRegistrationByIdOrEmail(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.includes("@")) {
    return findRegistrationByEmail(normalizeEmail(value));
  }
  return findRegistrationByStudentId(normalizeStudentId(value));
}

function loginToSession(regId, reg) {
  saveSession({
    regId,
    fullName: reg.fullName,
    email: reg.email,
    studentIdNumber: reg.studentIdNumber,
    gender: reg.gender,
    avatarUrl: reg.avatarUrl,
    status: reg.status || "unverified"
  });
}

// ============================================
// STEP VISIBILITY
// ============================================
const steps = {
  id: document.getElementById("id-step"),
  email: document.getElementById("email-step"),
  password: document.getElementById("password-step"),
  resetRequest: document.getElementById("reset-request-step"),
  resetOtp: document.getElementById("reset-otp-step"),
  resetPassword: document.getElementById("reset-password-step"),
  resetDone: document.getElementById("reset-done-step")
};
function showStep(name) {
  Object.entries(steps).forEach(([key, el]) => el.classList.toggle("hidden", key !== name));
}

// The looked-up account for the Student ID currently in play, shared by
// every step below (email login, password login, forgot password).
let current = null; // { id, reg }

// ============================================
// STEP 1 — Student ID lookup
// ============================================
const idForm = document.getElementById("id-form");
const idSubmit = document.getElementById("id-submit");
const idStatus = document.getElementById("id-status");

function showIdStatus(msg, isError = false) {
  idStatus.textContent = msg;
  idStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  idStatus.classList.remove("hidden");
}

idForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const studentId = normalizeStudentId(document.getElementById("id-studentId").value);
  if (!studentId) {
    showIdStatus("Please enter your Student ID.", true);
    return;
  }

  idSubmit.disabled = true;
  idSubmit.textContent = "Checking…";
  showIdStatus("Looking up your account…");

  try {
    const match = await findRegistrationByStudentId(studentId);
    if (!match) {
      showIdStatus("❌ No account found for that Student ID. Please register first.", true);
      return;
    }
    const reg = match.data();
    if (reg.removed) {
      showIdStatus("❌ This account has been removed by an admin. If you believe this is a mistake, please contact us via the Help page.", true);
      return;
    }

    current = { id: match.id, reg };

    if (reg.passwordHash) {
      document.getElementById("password-step-id").textContent = reg.studentIdNumber;
      document.getElementById("login-password").value = "";
      document.getElementById("password-login-status").classList.add("hidden");
      showStep("password");
      document.getElementById("login-password").focus();
    } else {
      document.getElementById("email-step-id").textContent = reg.studentIdNumber;
      document.getElementById("login-email").value = "";
      document.getElementById("email-status").classList.add("hidden");
      showStep("email");
      document.getElementById("login-email").focus();
    }
  } catch (err) {
    console.error("[Login] lookup failed:", err);
    showIdStatus("Something went wrong: " + (err && err.message ? err.message : "please try again."), true);
  } finally {
    idSubmit.disabled = false;
    idSubmit.textContent = "Continue";
  }
});

document.getElementById("email-step-back").addEventListener("click", (e) => { e.preventDefault(); showStep("id"); });
document.getElementById("password-step-back").addEventListener("click", (e) => { e.preventDefault(); showStep("id"); });

// ============================================
// STEP 2A — email login (original method, accounts with no password yet)
// ============================================
const emailForm = document.getElementById("email-form");
const emailSubmit = document.getElementById("email-submit");
const emailStatus = document.getElementById("email-status");

function showEmailStatus(msg, isError = false) {
  emailStatus.textContent = msg;
  emailStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  emailStatus.classList.remove("hidden");
}

emailForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current) { showStep("id"); return; }

  const email = normalizeEmail(document.getElementById("login-email").value);
  if (!email) {
    showEmailStatus("Please enter a valid email address.", true);
    return;
  }

  if (email !== normalizeEmail(current.reg.email)) {
    showEmailStatus("❌ That email doesn't match this Student ID.", true);
    return;
  }

  emailSubmit.disabled = true;
  emailSubmit.textContent = "Logging in…";
  loginToSession(current.id, current.reg);
  showEmailStatus("✅ Logged in! Redirecting…");
  setTimeout(() => { window.location.href = destinationAfterLogin(); }, 400);
});

// ============================================
// STEP 2B — password login (accounts that set one up from Profile)
// ============================================
const passwordForm = document.getElementById("password-form");
const passwordSubmit = document.getElementById("password-submit");
const passwordLoginStatus = document.getElementById("password-login-status");

function showPasswordLoginStatus(msg, isError = false) {
  passwordLoginStatus.textContent = msg;
  passwordLoginStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  passwordLoginStatus.classList.remove("hidden");
}

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!current) { showStep("id"); return; }

  const password = document.getElementById("login-password").value;
  if (!password) {
    showPasswordLoginStatus("Please enter your password.", true);
    return;
  }

  passwordSubmit.disabled = true;
  passwordSubmit.textContent = "Checking…";
  showPasswordLoginStatus("Checking…");

  try {
    const enteredHash = await hashPassword(password, current.reg.email);
    if (enteredHash !== current.reg.passwordHash) {
      showPasswordLoginStatus("❌ Incorrect password.", true);
      return;
    }
    loginToSession(current.id, current.reg);
    showPasswordLoginStatus("✅ Logged in! Redirecting…");
    setTimeout(() => { window.location.href = destinationAfterLogin(); }, 400);
  } catch (err) {
    console.error("[Login] password check failed:", err);
    showPasswordLoginStatus("Something went wrong: " + (err && err.message ? err.message : "please try again."), true);
  } finally {
    passwordSubmit.disabled = false;
    passwordSubmit.textContent = "Log In";
  }
});

// ============================================
// FORGOT PASSWORD — reset flow (Student ID OR email → email OTP → new
// password). Reachable for EVERY account, from either the very first
// step (Student ID not even looked up yet) or the password step
// (account already resolved) — and works whether or not the account
// has a password set yet, since resetting one accomplishes the same
// thing as setting one up from Profile.
// ============================================
const resetLookupInput = document.getElementById("reset-lookup-input");

function openResetRequestStep() {
  showResetRequestStatus("");
  showStep("resetRequest");
  resetLookupInput.focus();
}

document.getElementById("id-step-forgot-link").addEventListener("click", (e) => {
  e.preventDefault();
  current = null;
  resetLookupInput.value = "";
  openResetRequestStep();
});

document.getElementById("forgot-password-link").addEventListener("click", (e) => {
  e.preventDefault();
  // Convenience only — the account may already be resolved from the ID
  // step, so pre-fill it, but the lookup step still re-verifies it (and
  // the student is free to change it to a different ID/email here).
  resetLookupInput.value = current ? current.reg.studentIdNumber : "";
  openResetRequestStep();
});
document.getElementById("reset-back-to-login").addEventListener("click", (e) => {
  e.preventDefault();
  showStep(current && current.reg.passwordHash ? "password" : "id");
});
document.getElementById("reset-otp-back").addEventListener("click", (e) => {
  e.preventDefault();
  showStep("resetRequest");
});

const resetRequestBtn = document.getElementById("reset-request-btn");
const resetRequestStatus = document.getElementById("reset-request-status");
function showResetRequestStatus(msg, isError = false) {
  resetRequestStatus.textContent = msg;
  resetRequestStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
}

resetRequestBtn.addEventListener("click", async () => {
  const lookupValue = resetLookupInput.value.trim();
  if (!lookupValue) {
    showResetRequestStatus("Please enter your Student ID or email.", true);
    return;
  }

  resetRequestBtn.disabled = true;
  resetRequestBtn.textContent = "Looking up…";
  showResetRequestStatus("Looking up your account…");

  try {
    const match = await findRegistrationByIdOrEmail(lookupValue);
    if (!match) {
      showResetRequestStatus("❌ No account found for that Student ID or email. Please register first.", true);
      return;
    }
    const reg = match.data();
    if (reg.removed) {
      showResetRequestStatus("❌ This account has been removed by an admin. If you believe this is a mistake, please contact us via the Help page.", true);
      return;
    }
    current = { id: match.id, reg };

    resetRequestBtn.textContent = "Sending code…";
    showResetRequestStatus("Sending a verification code…");

    const { code } = startOtp(reg.email);
    await sendOtpEmail({ toEmail: reg.email, toName: reg.fullName, otpCode: code });

    document.getElementById("reset-otp-sent-to").textContent =
      `We sent a 6-digit code to ${maskEmail(reg.email)}. It expires in 10 minutes.`;
    document.getElementById("reset-otp-code").value = "";
    showResetOtpStatus("");
    showStep("resetOtp");
  } catch (err) {
    console.error(err);
    showResetRequestStatus("Couldn't send the verification code. (" + err.message + ")", true);
  } finally {
    resetRequestBtn.disabled = false;
    resetRequestBtn.textContent = "Send Code";
  }
});

const resetOtpInput = document.getElementById("reset-otp-code");
const resetOtpVerifyBtn = document.getElementById("reset-otp-verify-btn");
const resetOtpStatus = document.getElementById("reset-otp-status");
const resetOtpResendBtn = document.getElementById("reset-otp-resend-btn");

function showResetOtpStatus(msg, isError = false) {
  resetOtpStatus.textContent = msg;
  resetOtpStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
}

resetOtpInput.addEventListener("input", () => {
  resetOtpInput.value = resetOtpInput.value.replace(/\D/g, "").slice(0, 6);
});
resetOtpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); resetOtpVerifyBtn.click(); }
});

resetOtpVerifyBtn.addEventListener("click", () => {
  if (!current) { showStep("id"); return; }
  const code = resetOtpInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showResetOtpStatus("Enter the 6-digit code from your email.", true);
    return;
  }
  const result = verifyOtp(current.reg.email, code);
  if (!result.ok) {
    if (result.reason === "expired") showResetOtpStatus("That code expired. Please request a new one.", true);
    else if (result.reason === "locked") showResetOtpStatus("Too many incorrect attempts. Please request a new code.", true);
    else if (result.reason === "mismatch") showResetOtpStatus(`Incorrect code. ${result.attemptsLeft} attempt(s) left.`, true);
    else showResetOtpStatus("Please request a new code.", true);
    return;
  }
  clearOtp();
  document.getElementById("reset-new-password").value = "";
  document.getElementById("reset-new-password-confirm").value = "";
  showResetPasswordStatus("");
  showStep("resetPassword");
});

resetOtpResendBtn.addEventListener("click", async () => {
  if (!current) return;
  const remaining = resendCooldownRemaining(current.reg.email);
  if (remaining > 0) {
    showResetOtpStatus(`Please wait ${Math.ceil(remaining / 1000)}s before resending.`, true);
    return;
  }
  resetOtpResendBtn.disabled = true;
  showResetOtpStatus("Resending code…");
  try {
    const { code } = startOtp(current.reg.email);
    await sendOtpEmail({ toEmail: current.reg.email, toName: current.reg.fullName, otpCode: code });
    showResetOtpStatus("A new code has been sent.");
  } catch (err) {
    console.error(err);
    showResetOtpStatus("Couldn't resend the code. (" + err.message + ")", true);
  } finally {
    resetOtpResendBtn.disabled = false;
  }
});

const resetPasswordSubmitBtn = document.getElementById("reset-password-submit-btn");
const resetPasswordStatus = document.getElementById("reset-password-status");
function showResetPasswordStatus(msg, isError = false) {
  resetPasswordStatus.textContent = msg;
  resetPasswordStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
}

resetPasswordSubmitBtn.addEventListener("click", async () => {
  if (!current) { showStep("id"); return; }

  const password = document.getElementById("reset-new-password").value;
  const confirm = document.getElementById("reset-new-password-confirm").value;

  if (!isPasswordValid(password)) {
    showResetPasswordStatus("Password must be at least 6 characters.", true);
    return;
  }
  if (password !== confirm) {
    showResetPasswordStatus("Passwords don't match.", true);
    return;
  }

  resetPasswordSubmitBtn.disabled = true;
  resetPasswordSubmitBtn.textContent = "Saving…";
  showResetPasswordStatus("Saving your new password…");

  try {
    const { id, reg } = current;
    const passwordHash = await hashPassword(password, reg.email);
    await updateDoc(doc(db, "registrations", id), { passwordHash });
    reg.passwordHash = passwordHash;

    loginToSession(id, reg);

    document.getElementById("reset-done-id").textContent = reg.studentIdNumber;
    document.getElementById("reset-done-pass").textContent = password;
    showStep("resetDone");

    setTimeout(() => { window.location.href = destinationAfterLogin(); }, 4000);
  } catch (err) {
    console.error(err);
    showResetPasswordStatus("Something went wrong saving your password. (" + err.message + ")", true);
  } finally {
    resetPasswordSubmitBtn.disabled = false;
    resetPasswordSubmitBtn.textContent = "Save Password & Log In";
  }
});
