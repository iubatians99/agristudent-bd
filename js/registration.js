import { db, auth, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import { collection, addDoc, getDocs, query, where, serverTimestamp, setDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { initEmailNotifications } from "./email-config.js";
import { startOtp, verifyOtp, resendCooldownRemaining, clearOtp } from "./otp.js";
import { saveSession } from "./session.js";
import { createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Registration no longer collects a password on the form (see
// register.html — the "Account Password" field was removed). Every new
// account gets signed up with a random, throwaway password nobody
// (including this code, after this call returns) ever needs to know —
// exactly like tools/migrate-existing-users.mjs does for legacy
// accounts. The student sets their REAL password right after, either
// from the in-app popup (js/session.js) while already signed in, or via
// the "set your password" email sent below. Both paths end the same
// way: js/session.js and js/profile.js call Firebase's updatePassword()
// on the live session, so the throwaway value here never matters again.
function generateThrowawayPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const random = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return random + "Aa1!"; // guarantees upper/lower/digit/symbol regardless of policy
}

initEmailNotifications();

const form = document.getElementById("register-form");
const submitBtn = document.getElementById("submit-btn");
const statusBox = document.getElementById("form-status");
const successBox = document.getElementById("form-success");
const progressWrap = document.getElementById("upload-progress-wrap");
const progressBar = document.getElementById("progress-ring-bar");
const progressText = document.getElementById("progress-ring-text");
const CIRCUMFERENCE = 226.19; // 2 * π * r(36)

const otpPanel = document.getElementById("otp-panel");
const otpSentTo = document.getElementById("otp-sent-to");
const otpInput = document.getElementById("otp-code");
const otpVerifyBtn = document.getElementById("otp-verify-btn");
const otpStatus = document.getElementById("otp-status");
const otpBackBtn = document.getElementById("otp-back-btn");
const otpResendBtn = document.getElementById("otp-resend-btn");

// Holds the validated form data (and file) between "send code" and
// "verify code" — nothing is written to Firestore/Cloudinary until the
// email is confirmed.
let pending = null;

function setProgress(pct) {
  const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
  progressBar.style.strokeDashoffset = offset;
  progressText.textContent = pct + "%";
}

// Pre-submit validation errors — shown without the ring, nothing has started yet.
function showError(message) {
  progressWrap.classList.add("hidden");
  statusBox.textContent = message;
  statusBox.style.color = "var(--terracotta-500)";
  statusBox.classList.remove("hidden");
}

// In-progress / outcome messages — ring + label stay visible together,
// including on failure, so errors are actually seen.
function showStatus(message, isError = false) {
  progressWrap.classList.remove("hidden");
  statusBox.textContent = message;
  statusBox.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  if (isError) progressBar.style.stroke = "var(--terracotta-500)";
}

function showOtpStatus(message, isError = false) {
  otpStatus.textContent = message;
  otpStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
}

function uploadToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = 120000; // 2 min

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const json = JSON.parse(xhr.responseText);
        resolve(json.secure_url);
      } else {
        reject(new Error(`Cloudinary upload failed (server said: ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload. Check your connection and try again."));
    xhr.ontimeout = () => reject(new Error("Upload took too long. Try again, or check your connection."));

    const data = new FormData();
    data.append("file", file);
    data.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    xhr.send(data);
  });
}

function showFormStep() {
  otpPanel.classList.add("hidden");
  form.classList.remove("hidden");
  statusBox.classList.add("hidden");
  progressWrap.classList.add("hidden");
}

function showOtpStep(email) {
  form.classList.add("hidden");
  statusBox.classList.add("hidden");
  progressWrap.classList.add("hidden");
  otpPanel.classList.remove("hidden");
  otpSentTo.textContent = `We sent a 6-digit code to ${email}. It expires in 10 minutes.`;
  otpInput.value = "";
  showOtpStatus("");
  otpInput.focus();
}

// ============================================
// STEP 1 — validate details, send the OTP
// ============================================
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fullName = document.getElementById("fullName").value.trim();
  const email = normalizeEmail(document.getElementById("email").value);
  const genderInput = document.querySelector('input[name="gender"]:checked');
  const gender = genderInput ? genderInput.value : "";
  const studentIdNumber = normalizeStudentId(document.getElementById("studentIdNumber").value);
  const idFile = document.getElementById("studentIdPhoto")?.files?.[0] || null;

  // Validation
  if (!fullName) {
    showError("Please enter your full name.");
    return;
  }
  if (!email) {
    showError("Please enter a valid email address.");
    return;
  }
  if (!gender) {
    showError("Please select your gender.");
    return;
  }
  if (!studentIdNumber) {
    showError("Student ID number is required.");
    return;
  }

  // File size check (5MB max for ID photo)
  if (idFile && idFile.size > 5 * 1024 * 1024) {
    showError("Student ID photo must be under 5MB.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Checking…";
  showStatus("Checking this email…");

  // Firebase Authentication is the authoritative uniqueness check for email.
  // Student-ID uniqueness is enforced by the Firestore studentIdLocks document
  // after OTP verification, under an authenticated Firebase identity.
  submitBtn.textContent = "Sending code…";
  showStatus("Sending a verification code to your email…");

  try {
    // The code is generated and emailed server-side now (see js/otp.js /
    // functions/index.js) — it never passes through this browser.
    await startOtp(email, fullName);

    pending = { fullName, email, gender, studentIdNumber, idFile };
    showOtpStep(email);
  } catch (err) {
    console.error(err);
    showStatus("Couldn't send the verification code. (" + err.message + ")", true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Register";
  }
});

// ============================================
// STEP 2 — verify the code, then create the account + auto-login
// ============================================
otpInput.addEventListener("input", () => {
  otpInput.value = otpInput.value.replace(/\D/g, "").slice(0, 6);
});

otpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    otpVerifyBtn.click();
  }
});

otpVerifyBtn.addEventListener("click", async () => {
  if (!pending) { showFormStep(); return; }

  const code = otpInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showOtpStatus("Enter the 6-digit code from your email.", true);
    return;
  }

  const result = await verifyOtp(pending.email, code);
  if (!result.ok) {
    if (result.reason === "expired") {
      showOtpStatus("That code expired. Please request a new one.", true);
    } else if (result.reason === "locked") {
      showOtpStatus("Too many incorrect attempts. Please request a new code.", true);
    } else if (result.reason === "mismatch") {
      showOtpStatus(`Incorrect code. ${result.attemptsLeft} attempt(s) left.`, true);
    } else {
      showOtpStatus("Please request a new code.", true);
    }
    return;
  }

  otpVerifyBtn.disabled = true;
  otpVerifyBtn.textContent = "Creating account…";
  showOtpStatus("Verified! Creating your account…");

  try {
    const { fullName, email, gender, studentIdNumber, idFile } = pending;

    // Establish a real Firebase Authentication identity before any protected
    // Firestore write, using a throwaway password the student never sees or
    // needs — see generateThrowawayPassword() above.
    let credential;
    try {
      credential = await createUserWithEmailAndPassword(auth, email, generateThrowawayPassword());
    } catch (authErr) {
      if (authErr?.code === "auth/email-already-in-use") {
        throw new Error("An authentication account already exists for this email. Please use Login instead.");
      }
      throw authErr;
    }
    await sendEmailVerification(credential.user);

    const lockId = normalizeStudentId(studentIdNumber).replace(/[^A-Za-z0-9_-]/g, "_");
    try {
      await setDoc(doc(db, "studentIdLocks", lockId), { studentIdNumber, email, authUid: credential.user.uid, createdAt: serverTimestamp() });
    } catch (lockErr) {
      await credential.user.delete().catch(() => {});
      if (lockErr?.code === "permission-denied" || /already exists/i.test(lockErr?.message || "")) {
        throw new Error("An account already exists for this Student ID. Please use Login instead.");
      }
      throw lockErr;
    }

    let studentIdUrl = null;
    if (idFile) {
      showOtpStatus("Uploading Student ID photo…");
      studentIdUrl = await uploadToCloudinary(idFile, () => {});
    }
    showOtpStatus("Saving your registration…");

    const docData = {
      fullName,
      email,
      gender,
      avatarUrl: gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg",
      studentIdNumber,
      status: "pending",
      emailVerified: false,
      authUid: credential.user.uid,
      // No password was collected at signup (see generateThrowawayPassword()
      // above) — same as an account migrated in by
      // tools/migrate-existing-users.mjs. js/session.js's site-wide popup
      // (and js/profile.js's own setup card) prompt the student to choose
      // a real one on their next page load, and it flips true the moment
      // they do — see js/session.js and js/login.js.
      passwordSet: false,
      studentIdLockId: lockId,
      registrationCredits: 5,
      submittedAt: serverTimestamp()
    };
    if (studentIdUrl) docData.studentIdUrl = studentIdUrl;

    const docRef = await addDoc(collection(db, "registrations"), docData);
    clearOtp();

    // Keep the local session for the existing UI. Protected Firestore access
    // remains unavailable until the Firebase verification link is completed.
    saveSession({
      regId: docRef.id,
      fullName,
      email,
      studentIdNumber,
      gender,
      avatarUrl: docData.avatarUrl,
      status: docData.status
    });

    // Fire-and-forget "set your password" link, as a backup way to finish
    // setup if the student closes the tab before the in-app popup catches
    // them (see js/session.js). Never blocks account creation on failure.
    sendPasswordResetEmail(auth, email).catch(err => console.warn("[Registration] set-password email failed:", err));

    otpPanel.classList.add("hidden");
    successBox.classList.remove("hidden");
    document.getElementById("form-success-msg").textContent = "OTP verified — you're logged in! We've also emailed a link to set your password. Redirecting…";

    setTimeout(() => {
      const returnTo = new URLSearchParams(window.location.search).get("return");
      window.location.href = (returnTo && !returnTo.includes("://")) ? returnTo : "profile.html";
    }, 900);
  } catch (err) {
    console.error(err);
    showOtpStatus("Something went wrong creating your account. (" + err.message + ")", true);
  } finally {
    otpVerifyBtn.disabled = false;
    otpVerifyBtn.textContent = "Verify & Create Account";
  }
});

otpBackBtn.addEventListener("click", () => {
  showFormStep();
});

otpResendBtn.addEventListener("click", async () => {
  if (!pending) return;

  const remaining = resendCooldownRemaining();
  if (remaining > 0) {
    showOtpStatus(`Please wait ${Math.ceil(remaining / 1000)}s before resending.`, true);
    return;
  }

  otpResendBtn.disabled = true;
  showOtpStatus("Resending code…");
  try {
    await startOtp(pending.email, pending.fullName);
    showOtpStatus("A new code has been sent.");
  } catch (err) {
    console.error(err);
    showOtpStatus("Couldn't resend the code. (" + err.message + ")", true);
  } finally {
    otpResendBtn.disabled = false;
  }
});
