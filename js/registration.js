// ============================================
// AGRI CORE — REGISTRATION (rebuilt)
//
// Flow: validate the form → server-verified email OTP (js/otp.js calls
// functions/index.js; the code never touches the browser) → on
// success, create the Firebase Auth identity → reserve the Student ID
// → save the registration → sign the student in.
//
// The account created here (Firebase Auth user + a `registrations`
// Firestore document, joined by `authUid`) uses the exact same schema
// the previous registration code wrote, and the exact same schema
// js/login.js reads — so this rebuild doesn't require any data
// migration, and it doesn't change how already-registered students log
// in.
// ============================================
import { db, auth, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import { collection, addDoc, serverTimestamp, setDoc, doc, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { initEmailNotifications } from "./email-config.js";
import { startOtp, verifyOtp, resendCooldownRemaining, clearOtp } from "./otp.js";
import { saveSession } from "./session.js";
import { createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// The form never collects a password (see register.html). Every new
// account signs up with a random, throwaway password nobody —
// including this code, once this call returns — ever needs to know.
// The student sets their REAL password right after, either from the
// site-wide popup (js/session.js) or the "set your password" email
// sent below; both call Firebase's updatePassword() on the live
// session, so this throwaway value never matters again.
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
// "verify code" — nothing is written to Firestore/Cloudinary, and no
// Firebase Auth account is created, until the email is confirmed.
let pending = null;

function setProgress(pct) {
  const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
  progressBar.style.strokeDashoffset = offset;
  progressText.textContent = pct + "%";
}

function showError(message) {
  progressWrap.classList.add("hidden");
  statusBox.textContent = message;
  statusBox.style.color = "var(--terracotta-500)";
  statusBox.classList.remove("hidden");
}

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
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText).secure_url);
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

function readForm() {
  const fullName = document.getElementById("fullName").value.trim();
  const email = normalizeEmail(document.getElementById("email").value);
  const genderInput = document.querySelector('input[name="gender"]:checked');
  const gender = genderInput ? genderInput.value : "";
  const studentIdNumber = normalizeStudentId(document.getElementById("studentIdNumber").value);
  return { fullName, email, gender, studentIdNumber };
}

function validate({ fullName, email, gender, studentIdNumber }) {
  if (!fullName) return "Please enter your full name.";
  if (!email) return "Please enter a valid email address.";
  if (!gender) return "Please select your gender.";
  if (!studentIdNumber) return "Student ID number is required.";
  return null;
}

// ============================================
// STEP 1 — validate details, request the server-side OTP
// ============================================
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const details = readForm();
  const error = validate(details);
  if (error) { showError(error); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = "Sending code…";
  showStatus("Sending a verification code to your email…");

  try {
    // Firebase Authentication is the authoritative uniqueness check for
    // email (see the OTP-verified createUserWithEmailAndPassword call
    // below); Student-ID uniqueness is enforced by the
    // studentIdLocks/{lockId} document after the code is verified.
    await startOtp(details.email, details.fullName);
    pending = details;
    showOtpStep(details.email);
  } catch (err) {
    console.error(err);
    showStatus("Couldn't send the verification code. (" + err.message + ")", true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Register";
  }
});


// ============================================
// GOOGLE REGISTRATION
// Google supplies the verified email and display name. The remaining
// profile details are completed from My Profile, so Google signup never
// forces the student through the old registration/ID-card flow.
// ============================================
import { GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const googleRegisterBtn = document.getElementById("google-register-btn");
const googleRegisterStatus = document.getElementById("google-register-status");

function googleStatus(msg, error = false) {
  if (!googleRegisterStatus) return;
  googleRegisterStatus.textContent = msg;
  googleRegisterStatus.style.color = error ? "var(--terracotta-500)" : "var(--moss-600)";
  googleRegisterStatus.classList.remove("hidden");
}

googleRegisterBtn?.addEventListener("click", async () => {
  googleRegisterBtn.disabled = true;
  googleRegisterBtn.textContent = "Connecting to Google…";
  googleStatus("Opening Google sign-in…");
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const result = await signInWithPopup(auth, provider);
    const user = result.user;
    const email = normalizeEmail(user.email);
    if (!email) throw new Error("Google did not return an email address.");

    const existing = await getDocs(query(collection(db, "registrations"), where("authUid", "==", user.uid)));
    if (!existing.empty) {
      const d = existing.docs[0];
      const reg = d.data();
      saveSession({
        regId: d.id, fullName: reg.fullName, email: reg.email,
        studentIdNumber: reg.studentIdNumber || "", gender: reg.gender || "",
        avatarUrl: reg.avatarUrl || user.photoURL || "", status: reg.status || "incomplete"
      });
      window.location.href = "profile.html";
      return;
    }

    // A Google account is already verified by Firebase/Google, so no email
    // OTP or ID-card verification is needed here.
    const docData = {
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
    };
    const docRef = await addDoc(collection(db, "registrations"), docData);
    saveSession({
      regId: docRef.id, fullName: docData.fullName, email,
      studentIdNumber: "", gender: "", avatarUrl: docData.avatarUrl,
      status: "incomplete", profileComplete: false, profileCompletionPercent: docData.profileCompletionPercent
    });
    window.location.href = "profile.html";
  } catch (err) {
    console.error("[Registration] Google signup failed:", err);
    googleStatus(
      err?.code === "auth/popup-closed-by-user"
        ? "Google sign-in was cancelled."
        : "Google registration failed. Please try again.",
      true
    );
  } finally {
    googleRegisterBtn.disabled = false;
    googleRegisterBtn.textContent = "Continue with Google";
  }
});

otpInput.addEventListener("input", () => {
  otpInput.value = otpInput.value.replace(/\D/g, "").slice(0, 6);
});
otpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); otpVerifyBtn.click(); }
});

// ============================================
// STEP 2 — verify the code, then create the account + auto-login
// ============================================
otpVerifyBtn.addEventListener("click", async () => {
  if (!pending) { showFormStep(); return; }

  const code = otpInput.value.trim();
  if (!/^\d{6}$/.test(code)) { showOtpStatus("Enter the 6-digit code from your email.", true); return; }

  const result = await verifyOtp(pending.email, code);
  if (!result.ok) {
    const messages = {
      expired: "That code expired. Please request a new one.",
      locked: "Too many incorrect attempts. Please request a new code.",
      mismatch: `Incorrect code. ${result.attemptsLeft} attempt(s) left.`
    };
    showOtpStatus(messages[result.reason] || "Please request a new code.", true);
    return;
  }

  otpVerifyBtn.disabled = true;
  otpVerifyBtn.textContent = "Creating account…";
  showOtpStatus("Verified! Creating your account…");

  try {
    const { fullName, email, gender, studentIdNumber } = pending;

    // Establish a real Firebase Authentication identity before any
    // protected Firestore write, using a throwaway password the
    // student never sees or needs.
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

    const lockId = studentIdNumber.replace(/[^A-Za-z0-9_-]/g, "_");
    try {
      await setDoc(doc(db, "studentIdLocks", lockId), { studentIdNumber, email, authUid: credential.user.uid, createdAt: serverTimestamp() });
    } catch (lockErr) {
      await credential.user.delete().catch(() => {});
      if (lockErr?.code === "permission-denied" || /already exists/i.test(lockErr?.message || "")) {
        throw new Error("An account already exists for this Student ID. Please use Login instead.");
      }
      throw lockErr;
    }

    showOtpStatus("Saving your registration…");

    const docData = {
      fullName,
      email,
      gender,
      avatarUrl: gender === "female" ? "assets/avatar-female.svg" : "assets/avatar-male.svg",
      studentIdNumber,
      status: "incomplete",
      profileComplete: true,
      profileCompletionPercent: 100,
      emailVerified: false,
      authUid: credential.user.uid,
      // No password is collected at signup — js/session.js's site-wide
      // popup (and js/profile.js's own setup card) prompt the student to
      // choose a real one on their next page load, flipping this true
      // the moment they do.
      passwordSet: false,
      studentIdLockId: lockId,
      registrationCredits: 5,
      submittedAt: serverTimestamp()
    };

    const docRef = await addDoc(collection(db, "registrations"), docData);
    clearOtp();

    // Local session for the existing UI. Protected Firestore access
    // stays limited to this account's own doc until the Firebase
    // verification link is completed.
    saveSession({
      regId: docRef.id,
      fullName,
      email,
      studentIdNumber,
      gender,
      avatarUrl: docData.avatarUrl,
      status: docData.status,
      profileComplete: true,
      profileCompletionPercent: 100
    });

    // Fire-and-forget "set your password" link, as a backup way to
    // finish setup if the student closes the tab before the in-app
    // popup catches them. Never blocks account creation on failure.
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

otpBackBtn.addEventListener("click", showFormStep);

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
