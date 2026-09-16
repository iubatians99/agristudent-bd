import { db, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, addDoc, serverTimestamp, query, where, getDocs, setDoc, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { getSession } from "./session.js";
import { initEmailNotifications } from "./email-config.js";
import { computeResourceAccessStatus, computeFileAccessStatus, formatDate, formatRemaining, normalizeClassroomCode, isAuthenticClassroomCode } from "./access.js";

initEmailNotifications();

const MAX_FILES = 20;
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

// Global moderation guard used by every resource-upload form.
// A rejected submission blocks new uploads for 30 days.
window.__checkResourceRestriction = async function(userEmail) {
  const email = normalizeEmail(userEmail);
  if (!email) return 0;
  try {
    const q = query(
      collection(db, "resources"),
      where("uploaderEmail", "==", email),
      where("resourceType", "==", "slides_notes")
    );
    const snap = await getDocs(q);
    let until = 0;
    snap.forEach(d => {
      const item = d.data();
      if (item.status !== "rejected") return;
      const explicit = item.restrictedUntil?.toDate?.()?.getTime?.() || Number(item.restrictedUntil) || 0;
      const rejectedAt = item.rejectedAt?.toDate?.()?.getTime?.() || Number(item.rejectedAt) || 0;
      const submittedAt = item.submittedAt?.toDate?.()?.getTime?.() || 0;
      until = Math.max(until, explicit || ((rejectedAt || submittedAt || Date.now()) + 30 * 24 * 60 * 60 * 1000));
    });
    return until > Date.now() ? until : 0;
  } catch (err) {
    console.error("[Resource restriction check] failed:", err);
    // Fail closed: do not allow a new upload when moderation state cannot be checked.
    return -1;
  }
};


function uploadFileToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = 120000;
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const json = JSON.parse(xhr.responseText);
        resolve({ url: json.secure_url, name: file.name });
      } else {
        reject(new Error(`Upload failed for ${file.name} (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error uploading " + file.name + "."));
    xhr.ontimeout = () => reject(new Error(file.name + " timed out. Try again."));
    const data = new FormData();
    data.append("file", file);
    data.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    xhr.send(data);
  });
}

// ============================================
// AUTO-RENAME DUPLICATE FILENAMES
// ============================================
async function autoRenameIfDuplicate(fileName, courseCode, facultyName) {
  // Check if this filename already exists for this course/faculty
  const q = query(
    collection(db, "resources"),
    where("courseCode", "==", courseCode),
    where("fac", "==", facultyName),
    where("status", "==", "approved")
  );
  
  const docs = await getDocs(q);
  const existingNames = [];
  docs.forEach(d => {
    (d.data().fileUrls || []).forEach(f => {
      existingNames.push(f.name);
    });
  });

  if (!existingNames.includes(fileName)) {
    return fileName; // No conflict
  }

  // Rename with counter: "file.pdf" -> "file (1).pdf", "file (2).pdf", etc.
  const parts = fileName.split(".");
  const ext = parts.length > 1 ? "." + parts[parts.length - 1] : "";
  const base = parts.slice(0, -1).join(".");
  
  let counter = 1;
  let newName = `${base} (${counter})${ext}`;
  
  while (existingNames.includes(newName)) {
    counter++;
    newName = `${base} (${counter})${ext}`;
  }
  
  return newName;
}

// ============================================
// NOTE TYPE (Hand Notes / Class Slide / Others)
// A student-chosen category, separate from the file format (fileType:
// pdf/image/ppt). Shown with low visual prominence next to the course
// code/name in the PDFs & Presentations lists. Defaults to "hand_notes"
// for any older docs that predate this field.
// ============================================
const NOTE_TYPE_LABELS = { hand_notes: "Hand Notes", class_slide: "Class Slide", others: "Others" };
function noteTypeLabel(item) {
  return NOTE_TYPE_LABELS[item.noteType] || NOTE_TYPE_LABELS.hand_notes;
}
function wireNoteTypeVisual(radioName) {
  document.querySelectorAll(`input[name="${radioName}"]`).forEach(r => {
    r.closest("label").style.borderColor = r.checked ? "var(--leaf-500)" : "var(--line)";
    r.closest("label").style.background = r.checked ? "rgba(107, 155, 94, 0.05)" : "transparent";
  });
}

// ============================================
// XSS ESCAPE HELPER
// ============================================
function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ============================================
// SELECTED FILES PREVIEW
// Once someone picks files, show the actual filenames chosen instead of
// leaving them guessing whether the picker worked — no need to also spell
// out max-count/size limits in the label, those only matter at submit time.
// ============================================
function wireSelectedFilesPreview(fileInput, previewEl) {
  if (!fileInput || !previewEl) return;
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    if (files.length === 0) {
      previewEl.innerHTML = "";
      previewEl.classList.add("hidden");
      return;
    }
    previewEl.classList.remove("hidden");
    previewEl.innerHTML = files.map(f => `<span class="selected-file-chip">📎 ${esc(f.name)}</span>`).join("");
  });
}

// ============================================
// PREFILL FROM SESSION
// If the student is logged in, prefill the uploader email (and name, if
// the field exists) so every upload is stamped with their canonical,
// already-normalized identity instead of a freshly-retyped one that
// could differ in case/whitespace and silently break credit tracking.
// ============================================
function prefillFromSession(emailInputId, nameInputId) {
  const session = getSession();
  if (!session) return;
  const emailInput = document.getElementById(emailInputId);
  if (emailInput) {
    emailInput.value = session.email;
    // BUG FIX — "unlocks after submit, locked again on reload": this field
    // was only ever *pre*filled, so it stayed a normal editable text input.
    // A student could retype it (typo, autocorrect, a different personal
    // email) and the upload would get stamped with THAT email — but every
    // later access check (hnRefreshAccess) always queries by session.email.
    // If the two don't match, the access-check query returns zero
    // documents and genuinely-active access renders as locked. Since we
    // just set the field from the session ourselves, lock it so it can
    // never drift from the identity that access checks actually use.
    emailInput.readOnly = true;
    emailInput.classList.add("field-locked-to-session");
    emailInput.title = "Locked to your account email so your access status stays in sync.";
  }
  if (nameInputId) {
    const nameInput = document.getElementById(nameInputId);
    if (nameInput && !nameInput.value && session.fullName) nameInput.value = session.fullName;
  }
}

// ============================================
// STUDENT ID LOOKUP (by registered email)
// Used to stamp every upload with the uploader's registered Student ID,
// so the viewer can show "who uploaded this" without asking the student
// to re-enter their ID on every upload form.
// ============================================
async function lookupStudentIdByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  try {
    const q = query(collection(db, "registrations"), where("email", "==", normalizedEmail));
    const snap = await getDocs(q);
    if (snap.empty) return null;
    const raw = snap.docs[0].data().studentIdNumber || null;
    return raw ? normalizeStudentId(raw) : null;
  } catch (err) {
    console.error("[Student ID Lookup] failed:", err);
    return null;
  }
}

// ============================================
// VIEW LINK BUILDER
// Centralizes the view.html query string so every resource card/list
// carries the same ownership + metadata params (see: ownership label &
// upload-count features).
// ============================================
function buildViewHref(file, item = {}) {
  let href = `view.html?url=${encodeURIComponent(file.url)}&name=${encodeURIComponent(file.name)}`;
  if (item.courseCode) href += `&code=${encodeURIComponent(item.courseCode)}`;
  if (file.title) href += `&title=${encodeURIComponent(file.title)}`;
  if (item.uploaderStudentId) href += `&owner=${encodeURIComponent(item.uploaderStudentId)}`;
  return href;
}

// ============================================
// UPLOAD FORM MODAL (resources.html)
// ============================================
const openUploadBtn = document.getElementById("open-upload-form");
const uploadModal = document.getElementById("upload-form-modal");
const uploadModalClose = document.getElementById("upload-form-close");

if (openUploadBtn) openUploadBtn.addEventListener("click", () => uploadModal?.classList.remove("hidden"));
if (uploadModalClose) uploadModalClose.addEventListener("click", () => uploadModal?.classList.add("hidden"));
if (uploadModal) {
  uploadModal.addEventListener("click", (e) => { if (e.target === uploadModal) uploadModal.classList.add("hidden"); });
  if (window.location.hash === "#upload") uploadModal.classList.remove("hidden");
}

// ============================================
// SEND US CLASSROOM CODE MODAL + FORM (resources.html)
// Lets a student share their Google Classroom code. On submit it's saved
// to the "classroomCodes" Firestore collection (no email/backend needed) —
// check the admin panel's "Classroom Codes" tab to see submissions — then
// the form flips to a "Thank You" panel.
// ============================================
const openClassroomCodeBtn = document.getElementById("open-classroom-code-form");
const classroomCodeModal = document.getElementById("classroom-code-modal");
const classroomCodeClose = document.getElementById("classroom-code-close");
const classroomCodeForm = document.getElementById("classroom-code-form");
const classroomCodeInput = document.getElementById("classroom-code-input");
const classroomCodeSubmit = document.getElementById("classroom-code-submit");
const classroomCodeSuccess = document.getElementById("classroom-code-success");
const classroomCodeError = document.getElementById("classroom-code-error");

if (openClassroomCodeBtn) {
  openClassroomCodeBtn.addEventListener("click", () => classroomCodeModal?.classList.remove("hidden"));
}
if (classroomCodeClose) {
  classroomCodeClose.addEventListener("click", () => classroomCodeModal?.classList.add("hidden"));
}
if (classroomCodeModal) {
  classroomCodeModal.addEventListener("click", (e) => {
    if (e.target === classroomCodeModal) classroomCodeModal.classList.add("hidden");
  });
}

if (classroomCodeForm) {
  classroomCodeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = classroomCodeInput.value.trim();
    if (!code) return;

    classroomCodeSubmit.disabled = true;
    classroomCodeSubmit.textContent = "Checking…";
    try {
      const normalized = normalizeClassroomCode(code);

      // Reject anything that isn't shaped like a genuine Google Classroom
      // code (wrong length/characters, or an obvious placeholder) before
      // it ever reaches Firestore or the admin panel.
      if (!isAuthenticClassroomCode(normalized)) {
        classroomCodeSubmit.disabled = false;
        classroomCodeSubmit.textContent = "Send";
        if (classroomCodeError) {
          classroomCodeError.textContent = "That doesn't look like a genuine Google Classroom code. Please enter the exact code your teacher shared (6-8 letters/numbers, e.g. a1b2c3d).";
          classroomCodeError.classList.remove("hidden");
        } else {
          alert("That doesn't look like a genuine Google Classroom code. Please enter the exact code your teacher shared (6-8 letters/numbers, e.g. a1b2c3d).");
        }
        return;
      }

      // A code can only ever unlock access once — reject a resubmission of
      // a code that's already on file and ask for a fresh one.
      const dupSnap = await getDocs(
        query(collection(db, "classroomCodes"), where("normalizedCode", "==", normalized))
      );
      if (!dupSnap.empty) {
        classroomCodeSubmit.disabled = false;
        classroomCodeSubmit.textContent = "Send";
        classroomCodeInput.setCustomValidity?.("");
        if (classroomCodeError) {
          classroomCodeError.textContent = "This classroom code has already been used. Please provide a new, unused code.";
          classroomCodeError.classList.remove("hidden");
        } else {
          alert("This classroom code has already been used. Please provide a new, unused code.");
        }
        return;
      }
      if (classroomCodeError) classroomCodeError.classList.add("hidden");

      classroomCodeSubmit.textContent = "Sending…";
      const session = getSession?.();
      await addDoc(collection(db, "classroomCodes"), {
        classroomCode: code,
        normalizedCode: normalized,
        fromName: session?.fullName || session?.email || "",
        fromEmail: session?.email || "",
        status: "new",
        submittedAt: serverTimestamp(),
        // This is the general "send us your code so we can pull in course
        // materials" box — it is NOT an unlock request and must never grant
        // resource access, even if an admin approves it. Without this flag
        // it would look identical (in Firestore) to a targetFileId-less
        // legacy unlock submission, which js/access.js grants toward every
        // file. See computeResourceAccessStatus()'s classroom branch.
        purpose: "materials_request"
      });
      classroomCodeForm.classList.add("hidden");
      classroomCodeSuccess.classList.remove("hidden");
    } catch (err) {
      console.error("[Resources] Failed to save classroom code:", err);
      alert("Something went wrong submitting your classroom code. Please try again.");
      classroomCodeSubmit.disabled = false;
      classroomCodeSubmit.textContent = "Send";
    }
  });
}

// ============================================
// UPLOAD FORM (resources.html)
// Same premium file-type-picker experience as "Upload Another File" on
// slides-notes.html: PDF/Image/PPT choice, course-name hint, faculty
// suggestions, per-image titles — plus this form's own Hand Notes vs.
// Suggestions resourceType + examType fields, unchanged.
// ============================================
const uploadForm = document.getElementById("upload-form");
if (uploadForm) {
  prefillFromSession("uploaderEmail");
  const fileInput = document.getElementById("files");
  const filesLabel = document.getElementById("files-label");
  const statusBox = document.getElementById("upload-status");
  const submitBtn = document.getElementById("upload-submit");
  const successBox = document.getElementById("upload-success");
  const courseCodeInput = document.getElementById("courseCode");
  const courseNameInput = document.getElementById("courseName");
  const courseNameHint = document.getElementById("courseName-hint");
  const facultyNameInput = document.getElementById("facultyName");
  const facultySuggestions = document.getElementById("upload-faculty-suggestions");
  const imageTitlesWrap = document.getElementById("upload-image-titles-wrap");
  const imageTitlesListEl = document.getElementById("upload-image-titles-list");
  const progressWrap = document.getElementById("upload-progress-wrap");
  const progressBar = document.getElementById("progress-ring-bar");
  const progressText = document.getElementById("progress-ring-text");
  const CIRCUMFERENCE = 226.19;

  const fileTypeAccepts = {
    pdf: ".pdf,application/pdf",
    image: "image/*,.jpg,.jpeg,.png,.gif,.webp",
    ppt: ".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };
  let currentFileType = "pdf";
  let currentNoteType = "hand_notes";
  let matchedCourse = null;

  document.querySelectorAll('input[name="noteType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      currentNoteType = radio.value;
      wireNoteTypeVisual("noteType");
    });
  });

  function cleanFileNameAsTitle(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }
  function renderImageTitleInputs() {
    if (!imageTitlesWrap || !imageTitlesListEl) return;
    if (currentFileType !== "image" || !fileInput.files || fileInput.files.length === 0) {
      imageTitlesWrap.classList.add("hidden");
      imageTitlesListEl.innerHTML = "";
      return;
    }
    imageTitlesListEl.innerHTML = Array.from(fileInput.files).map((f, i) => `
      <input type="text" class="upload-image-title-input" data-index="${i}"
             placeholder="Title for: ${esc(f.name)}" value="${esc(cleanFileNameAsTitle(f.name))}"
             style="width:100%;padding:.5rem .7rem;border:1px solid var(--line);border-radius:6px;font-size:.85rem;">
    `).join("");
    imageTitlesWrap.classList.remove("hidden");
  }
  fileInput.addEventListener("change", renderImageTitleInputs);
  wireSelectedFilesPreview(fileInput, document.getElementById("files-selected-preview"));

  document.querySelectorAll('input[name="fileType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      currentFileType = radio.value;
      fileInput.accept = fileTypeAccepts[currentFileType];
      const labels = {
        pdf: "PDF File(s) *",
        image: "Image File(s) * (JPG, PNG, GIF, WebP)",
        ppt: "Presentation File(s) * (PPT/PPTX)"
      };
      if (filesLabel) filesLabel.textContent = labels[currentFileType];
      document.querySelectorAll('input[name="fileType"]').forEach(r => {
        r.closest("label").style.borderColor = r.checked ? "var(--leaf-500)" : "var(--line)";
        r.closest("label").style.background = r.checked ? "rgba(107, 155, 94, 0.05)" : "transparent";
      });
      renderImageTitleInputs();
    });
  });

  courseCodeInput.addEventListener("blur", async () => {
    const code = courseCodeInput.value.trim().toUpperCase();
    if (courseNameHint) courseNameHint.classList.add("hidden");
    if (facultySuggestions) facultySuggestions.innerHTML = "";
    if (!code) { matchedCourse = null; courseNameInput.readOnly = false; courseNameInput.value = ""; return; }
    try {
      const courseSnap = await getDoc(doc(db, "courses", code));
      if (courseSnap.exists()) {
        matchedCourse = courseSnap.data();
        courseNameInput.value = matchedCourse.courseName;
        courseNameInput.readOnly = true;
        if (courseNameHint) {
          courseNameHint.innerHTML = `Suggested from an existing course: <strong>${esc(matchedCourse.courseName)}</strong>.`;
          courseNameHint.classList.remove("hidden");
        }
      } else {
        matchedCourse = null;
        courseNameInput.readOnly = false;
      }
      if (facultySuggestions) {
        const q = query(collection(db, "resources"), where("courseCode", "==", code));
        const snap = await getDocs(q);
        const faculties = [...new Set(snap.docs.map(d => d.data().facultyName).filter(Boolean))];
        facultySuggestions.innerHTML = faculties.map(f => `<option value="${esc(f)}"></option>`).join("");
      }
    } catch (err) { console.error("Error checking canonical course:", err); }
  });

  function setProgress(pct) {
    progressBar.style.strokeDashoffset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
    progressText.textContent = pct + "%";
  }
  function showError(msg) {
    progressWrap.classList.add("hidden");
    statusBox.textContent = msg;
    statusBox.style.color = "var(--terracotta-500)";
    statusBox.classList.remove("hidden");
  }
  function showStatus(msg, isError = false) {
    progressWrap.classList.remove("hidden");
    statusBox.textContent = msg;
    statusBox.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
    if (isError) progressBar.style.stroke = "var(--terracotta-500)";
  }

  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rawCourseCode = courseCodeInput.value.trim().toUpperCase();
    const rawCourseName = courseNameInput.value.trim();
    const facultyName = facultyNameInput.value.trim();
    const resourceType = "slides_notes";
    const uploaderEmail = normalizeEmail(document.getElementById("uploaderEmail").value);
    const files = Array.from(fileInput.files);

    if (files.length === 0) { showError(`Please choose at least one ${currentFileType.toUpperCase()} file.`); return; }
    if (files.length > MAX_FILES) { showError(`Maximum ${MAX_FILES} files allowed.`); return; }

    let validationError = false;
    if (currentFileType === "pdf") {
      validationError = files.some(f => !f.name.toLowerCase().endsWith(".pdf"));
    } else if (currentFileType === "image") {
      validationError = files.some(f => !["jpg","jpeg","png","gif","webp"].includes(f.name.toLowerCase().split(".").pop()));
    } else if (currentFileType === "ppt") {
      validationError = files.some(f => !["ppt","pptx"].includes(f.name.toLowerCase().split(".").pop()));
    }
    if (validationError) { showError(`Some files are not valid ${currentFileType.toUpperCase()} files.`); return; }

    const oversized = files.find(f => f.size > MAX_SIZE);
    if (oversized) { showError(`"${oversized.name}" is over 50MB.`); return; }

    const finalCourseCode = matchedCourse ? matchedCourse.courseCode : rawCourseCode;
    const finalCourseName = matchedCourse ? matchedCourse.courseName : rawCourseName;

    submitBtn.disabled = true;
    submitBtn.textContent = "Uploading…";
    setProgress(0);
    showStatus(`Uploading ${files.length} file(s) in parallel…`);

    try {
      const progressByFile = new Array(files.length).fill(0);
      const updateOverall = () => {
        const avg = Math.round(progressByFile.reduce((a, b) => a + b, 0) / files.length);
        setProgress(avg);
        showStatus(avg >= 100 ? "Processing on server…" : `Uploading ${files.length} file(s)…`);
      };
      const fileUrls = await Promise.all(
        files.map((file, i) => uploadFileToCloudinary(file, (pct) => { progressByFile[i] = pct; updateOverall(); }))
      );

      // Auto-rename duplicates
      for (let i = 0; i < fileUrls.length; i++) {
        const renamedName = await autoRenameIfDuplicate(fileUrls[i].name, finalCourseCode, facultyName);
        fileUrls[i].name = renamedName;
      }

      if (currentFileType === "image" && imageTitlesListEl) {
        const titleInputs = imageTitlesListEl.querySelectorAll(".upload-image-title-input");
        fileUrls.forEach((f, i) => {
          const t = titleInputs[i] ? titleInputs[i].value.trim() : "";
          f.title = t || cleanFileNameAsTitle(f.name);
        });
      }

      showStatus("Saving details…");
      setProgress(100);
      if (!matchedCourse) {
        await setDoc(doc(db, "courses", finalCourseCode), { courseCode: finalCourseCode, courseName: finalCourseName });
      }
      const docData = {
        courseCode: finalCourseCode, courseName: finalCourseName, facultyName,
        resourceType, uploaderEmail, fileUrls, fileType: currentFileType, noteType: currentNoteType,
        status: "pending", submittedAt: serverTimestamp(), uploadedAt: Date.now()
      };
      const uploaderStudentId = await lookupStudentIdByEmail(uploaderEmail);
      if (uploaderStudentId) docData.uploaderStudentId = uploaderStudentId;
      await addDoc(collection(db, "resources"), docData);
      uploadForm.reset();
      uploadForm.classList.add("hidden");
      statusBox.classList.add("hidden");
      successBox.classList.remove("hidden");
      matchedCourse = null;
      courseNameInput.readOnly = false;
      if (courseNameHint) courseNameHint.classList.add("hidden");
      if (imageTitlesWrap) imageTitlesWrap.classList.add("hidden");
    } catch (err) {
      console.error("[Upload] failed:", err);
      let userMessage = "Something went wrong. Please try again.";
      if (err.code === "permission-denied") {
        userMessage = "Upload was rejected. Please check the course code and file(s), then try again.";
      } else if (/network/i.test(err.message || "")) {
        userMessage = "Network error. Check your connection and try again.";
      } else if (/timed out/i.test(err.message || "")) {
        userMessage = "Upload took too long. Try again with a smaller file.";
      }
      showStatus(userMessage, true);
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit for Review";
    }
  });
}

// ============================================
// SLIDES & NOTES BROWSING (slides-notes.html)
// ============================================
const courseButtonsWrap = document.getElementById("course-buttons");
// Guard: only run on slides-notes.html where this element exists
if (courseButtonsWrap) {
  const slidesList = document.getElementById("slides-list");
  const slidesSearchInput = document.getElementById("slides-search");
  let allSlides = [];

  async function loadSlides() {
    try {
      // Two equality filters — still no composite index required.
      // status must be filtered in the query itself: the security rule
      // checks resource.data.status, so an unfiltered query is rejected
      // outright rather than silently returning fewer docs.
      const q = query(
        collection(db, "resources"),
        where("resourceType", "==", "slides_notes"),
        where("status", "==", "approved")
      );
      const snap = await getDocs(q);
      allSlides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderCourseButtons(allSlides);
    } catch (err) {
      console.error("[Slides] loadSlides failed:", err);
      courseButtonsWrap.innerHTML = `<p style="color:var(--terracotta-500);font-family:var(--font-mono);font-size:.85rem;">Could not load courses. Please refresh and try again.</p>`;
    }
  }

  function renderCourseButtons(items) {
    const codes = [...new Set(items.map(i => i.courseCode))].sort();
    if (codes.length === 0) {
      courseButtonsWrap.innerHTML = `<p style="color:var(--moss-600);font-family:var(--font-mono);font-size:.85rem;">No approved course materials yet — check back soon.</p>`;
      return;
    }
    courseButtonsWrap.innerHTML = codes.map(code => {
      const faculty = [...new Set(items.filter(i => i.courseCode === code).map(i => i.facultyName).filter(Boolean))].join(", ");
      return `
        <button class="course-btn" data-code="${esc(code)}">
          ${esc(code)}
          ${faculty ? `<div style="font-size:.7rem;font-weight:400;color:inherit;opacity:.75;margin-top:.2rem;">${esc(faculty)}</div>` : ""}
        </button>`;
    }).join("");
    courseButtonsWrap.querySelectorAll(".course-btn").forEach(btn => {
      btn.addEventListener("click", () => renderResourceList(btn.dataset.code));
    });
  }

  function renderResourceList(code) {
    const items = allSlides.filter(i => i.courseCode === code);
    if (!slidesList) return;
    slidesList.classList.remove("hidden");
    slidesList.innerHTML = `<h3 style="margin-bottom:1rem;">${esc(code)} — Lecture Materials</h3>` +
      items.map(item => `
        <div class="resource-row">
          <div>
            <strong>${esc(item.courseName || code)}</strong>
            <div style="font-size:.8rem;color:var(--moss-600);">${item.fileUrls.length} file(s)</div>
          </div>
          <div class="resource-row-files">
            ${item.fileUrls.map(f => `<a href="${buildViewHref(f, item)}" class="view-link">View: ${esc(f.name)}</a>`).join("")}
          </div>
        </div>`).join("");
  }

  if (slidesSearchInput) {
    slidesSearchInput.addEventListener("input", () => {
      const term = slidesSearchInput.value.trim().toUpperCase();
      const filtered = term ? allSlides.filter(i => i.courseCode.includes(term)) : allSlides;
      renderCourseButtons(filtered);
      if (slidesList) slidesList.classList.add("hidden");
    });
  }

  // Runs once access is granted (see shared access gate below) —
  // loads the course list and honors the ?course=CODE deep link.
  window.__onResourceAccessGranted = window.__onResourceAccessGranted || [];
  window.__onResourceAccessGranted.push(() => {
    loadSlides().then(() => {
      const courseParam = new URLSearchParams(location.search).get("course");
      if (courseParam) renderResourceList(courseParam.toUpperCase());
    });
  });
}

// ============================================
// RESOURCES PAGE (resources.html)
// ============================================
// The Resources hub itself is open to everyone, logged in or not — no
// gate. Registered/non-registered visitors can browse straight away.
// Real access control for the note FILES themselves happens on
// slides-notes.html's own Hand Notes unlock gate below, and login is
// only required at the point of unlocking or uploading.
(window.__onResourceAccessGranted || []).forEach(fn => fn());

// ============================================
// HAND NOTES UNLOCK GATE (slides-notes.html)
// ============================================
// Access is granted by uploading a file (PDF/Image/PPT).
// User keeps access while file is pending/approved.
// If rejected, they lose access and must upload new file.
const handNotesGate = document.getElementById("handnotes-gate");
const handNotesContent = document.getElementById("resource-content");
const accessStatusBar = document.getElementById("access-status-bar");

if (handNotesGate && handNotesContent) {
  prefillFromSession("hn-uploaderEmail");
  const HN_STORAGE_KEY = "agri_handnotes_user_email";
  const hnForm = document.getElementById("handnotes-unlock-form");
  const hnFiles = document.getElementById("hn-files");
  const hnSubmit = document.getElementById("hn-unlock-submit");
  const hnStatus = document.getElementById("hn-unlock-status");
  const hnProgressWrap = document.getElementById("hn-unlock-progress-wrap");
  const hnProgressBar = document.getElementById("hn-progress-ring-bar");
  const hnProgressText = document.getElementById("hn-progress-ring-text");
  const hnFilesLabel = document.getElementById("hn-files-label");
  const hnCourseCode = document.getElementById("hn-courseCode");
  const hnCourseName = document.getElementById("hn-courseName");
  const hnCourseNameHint = document.getElementById("hn-courseName-hint");
  const hnFacultyName = document.getElementById("hn-facultyName");
  const hnFacultySuggestions = document.getElementById("hn-faculty-suggestions");
  let hnMatchedCourse = null;
  const HN_CIRCUMFERENCE = 226.19;

  // These were being called (submit handler, classroom-unlock handler)
  // but never defined — the missing functions threw a silent
  // ReferenceError right after the button flipped to "Uploading…",
  // which is why the form looked stuck with no progress and no error.
  function hnSetProgress(pct) {
    if (hnProgressWrap) hnProgressWrap.classList.remove("hidden");
    if (hnProgressBar) hnProgressBar.style.strokeDashoffset = HN_CIRCUMFERENCE - (Math.max(0, Math.min(100, pct)) / 100) * HN_CIRCUMFERENCE;
    if (hnProgressText) hnProgressText.textContent = Math.round(pct) + "%";
  }
  function hnShowStatus(msg, isError = false) {
    if (!hnStatus) return;
    hnStatus.textContent = msg;
    hnStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  }

  // File type acceptances
  const fileTypeAccepts = {
    pdf: ".pdf,application/pdf",
    image: "image/*,.jpg,.jpeg,.png,.gif,.webp",
    ppt: ".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };

  let currentFileType = "pdf";
  let hnNoteType = "hand_notes";

  document.querySelectorAll('input[name="hn-noteType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      hnNoteType = radio.value;
      wireNoteTypeVisual("hn-noteType");
    });
  });

  // Suggest course name + faculty names once the course code matches an
  // existing one — the student can still edit the suggested course name or
  // type a completely different faculty/section; nothing is locked.
  if (hnCourseCode) {
    hnCourseCode.addEventListener("blur", async () => {
      const code = hnCourseCode.value.trim().toUpperCase();
      if (hnFacultySuggestions) hnFacultySuggestions.innerHTML = "";
      if (hnCourseNameHint) hnCourseNameHint.classList.add("hidden");
      if (!code) { hnMatchedCourse = null; return; }
      try {
        const courseSnap = await getDoc(doc(db, "courses", code));
        if (courseSnap.exists()) {
          hnMatchedCourse = courseSnap.data();
          if (!hnCourseName.value.trim()) hnCourseName.value = hnMatchedCourse.courseName;
          if (hnCourseNameHint) {
            hnCourseNameHint.innerHTML = `Suggested from an existing course: <strong>${esc(hnMatchedCourse.courseName)}</strong> — edit if this is different.`;
            hnCourseNameHint.classList.remove("hidden");
          }
        } else {
          hnMatchedCourse = null;
        }
        // Existing faculty names for this course code, offered as suggestions
        // (a datalist) — the student can still type any other faculty/section.
        if (hnFacultySuggestions) {
          const q = query(collection(db, "resources"), where("courseCode", "==", code));
          const snap = await getDocs(q);
          const faculties = [...new Set(snap.docs.map(d => d.data().facultyName).filter(Boolean))];
          hnFacultySuggestions.innerHTML = faculties.map(f => `<option value="${esc(f)}"></option>`).join("");
        }
      } catch (err) { console.error("[Hand Notes Unlock] course lookup failed:", err); }
    });
  }

  const hnGateBackBtn = document.getElementById("hn-gate-back");
  const hnStepLogin = document.getElementById("hn-gate-step-login");
  const hnStepChoice = document.getElementById("hn-gate-step-choice");
  const hnStepNotes = document.getElementById("hn-gate-step-notes");
  const hnStepClassroom = document.getElementById("hn-gate-step-classroom");
  const hnStepAd = document.getElementById("hn-gate-step-ad");
  const hnAllSteps = [hnStepLogin, hnStepChoice, hnStepNotes, hnStepClassroom, hnStepAd];

  function hnShowStep(step) {
    hnAllSteps.forEach(s => s?.classList.toggle("hidden", s !== step));
  }

  // When the unlock form is showing, hide the preview entirely (show only
  // the form). `dismissible` controls whether the back (✕) button appears —
  // it's hidden when access was forcibly revoked (rejected upload), since
  // the person must upload again to proceed.
  function hnEnterFormOnly(dismissible = true) {
    handNotesContent.classList.add("form-only");
    hnGateBackBtn?.classList.toggle("hidden", !dismissible);
  }

  function hnExitFormOnly() {
    handNotesGate.classList.add("hidden");
    handNotesContent.classList.remove("form-only");
  }

  // The id of the ONE file the gate is currently unlocking — set every
  // time a locked file's badge is clicked (see the file-row click
  // handlers below), and stamped onto whatever gets submitted (upload or
  // classroom code) as `targetFileId`. This is what makes unlocking one
  // file no longer unlock any other file: js/access.js only counts a
  // submission toward the file id it was stamped with.
  let hnGateTargetId = null;

  // BUG FIX — "unlocking one file unlocked ALL files": when a logged-out
  // student clicked "Unlock" on a specific file, hnGateTargetId was set
  // correctly in memory, but the login/register step then sent them to a
  // real login.html/register.html page load — which wipes all JS state,
  // including hnGateTargetId. The old return link was a hardcoded
  // "...#unlock" with no file id in it, so after logging back in,
  // hnOpenGate() re-ran with NO argument, hnGateTargetId became null, and
  // whatever they submitted next got `targetFileId: null` — which
  // access.js (by design, for pre-existing submissions made before
  // per-file unlocking existed) counts toward EVERY file. The fix: carry
  // the target file id through the redirect itself, in the return hash
  // (`#unlock=<fileId>`), and restore it below before reopening the gate.
  const hnLoginLink = document.getElementById("hn-gate-login-link");
  const hnRegisterLink = document.getElementById("hn-gate-register-link");

  window.hnOpenGate = function (fileId) {
    hnGateTargetId = fileId || null;
    const returnHash = hnGateTargetId ? `unlock=${encodeURIComponent(hnGateTargetId)}` : "unlock";
    if (hnLoginLink) hnLoginLink.href = `login.html?return=${encodeURIComponent(`slides-notes.html#${returnHash}`)}`;
    if (hnRegisterLink) hnRegisterLink.href = `register.html?return=${encodeURIComponent(`slides-notes.html#${returnHash}`)}`;
    handNotesGate.classList.remove("hidden");
    hnEnterFormOnly(true);
    hnShowStep(getSession() ? hnStepChoice : hnStepLogin);
    handNotesGate.scrollIntoView({ behavior: "smooth" });
  };

  // If we were sent back here after login/registration (?return=...#unlock
  // or ...#unlock=<fileId>), pick straight back up at the unlock flow
  // instead of making the person click "Unlock Access" again — and, if a
  // file id rode along in the hash, restore it so the submission they're
  // about to make only unlocks that one file.
  if (window.location.hash.startsWith("#unlock")) {
    const [, encodedFileId] = window.location.hash.split("=");
    window.hnOpenGate(encodedFileId ? decodeURIComponent(encodedFileId) : null);
  }

  hnGateBackBtn?.addEventListener("click", hnExitFormOnly);
  document.getElementById("hn-choose-notes")?.addEventListener("click", () => hnShowStep(hnStepNotes));
  document.getElementById("hn-choose-classroom")?.addEventListener("click", () => hnShowStep(hnStepClassroom));
  document.getElementById("hn-choose-ad")?.addEventListener("click", () => {
    const session = getSession();
    if (!session) { hnShowStep(hnStepLogin); return; }
    hnShowStep(hnStepAd);
    hnStartAdWatch();
  });
  document.getElementById("hn-notes-back")?.addEventListener("click", () => hnShowStep(hnStepChoice));
  document.getElementById("hn-classroom-back")?.addEventListener("click", () => hnShowStep(hnStepChoice));
  document.getElementById("hn-ad-back")?.addEventListener("click", () => { hnCancelAdWatch(); hnShowStep(hnStepChoice); });
  document.getElementById("hn-notes-success-close")?.addEventListener("click", hnExitFormOnly);
  document.getElementById("hn-classroom-success-close")?.addEventListener("click", hnExitFormOnly);
  document.getElementById("hn-ad-success-close")?.addEventListener("click", hnExitFormOnly);
  // ============================================
  // UNLOCK WITH GOOGLE CLASSROOM — same duplicate-code rule as the
  // resources.html "Send Us Classroom Code" form: a code already on file
  // can't be reused. Unlike an upload, a classroom code grants NO access
  // until an admin reviews and confirms it in the admin panel (see
  // js/access.js) — then it unlocks the ONE file this gate was opened
  // for, for 6 hours from the moment it's approved.
  // ============================================
  const hnClassroomForm = document.getElementById("hn-classroom-form");
  const hnClassroomInput = document.getElementById("hn-classroom-code-input");
  const hnClassroomSubmit = document.getElementById("hn-classroom-submit");
  const hnClassroomError = document.getElementById("hn-classroom-error");
  const hnClassroomSuccess = document.getElementById("hn-classroom-success");

  if (hnClassroomForm) {
    hnClassroomForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = hnClassroomInput.value.trim();
      if (!code) return;
      const session = getSession();
      if (!session) { hnShowStep(hnStepLogin); return; }

      hnClassroomSubmit.disabled = true;
      hnClassroomSubmit.textContent = "Checking…";
      hnClassroomError.classList.add("hidden");

      try {
        const normalized = normalizeClassroomCode(code);

        if (!isAuthenticClassroomCode(normalized)) {
          hnClassroomError.textContent = "That doesn't look like a genuine Google Classroom code. Please enter the exact code your teacher shared (6-8 letters/numbers, e.g. a1b2c3d).";
          hnClassroomError.classList.remove("hidden");
          hnClassroomSubmit.disabled = false;
          hnClassroomSubmit.textContent = "Send for Review";
          return;
        }

        const dupSnap = await getDocs(
          query(collection(db, "classroomCodes"), where("normalizedCode", "==", normalized))
        );
        if (!dupSnap.empty) {
          hnClassroomError.textContent = "This classroom code has already been used. Please provide a new, unused code.";
          hnClassroomError.classList.remove("hidden");
          hnClassroomSubmit.disabled = false;
          hnClassroomSubmit.textContent = "Send for Review";
          return;
        }

        hnClassroomSubmit.textContent = "Sending…";
        await addDoc(collection(db, "classroomCodes"), {
          classroomCode: code,
          normalizedCode: normalized,
          fromName: session.fullName || session.email || "",
          fromEmail: normalizeEmail(session.email || ""),
          targetFileId: hnGateTargetId,
          status: "new",
          submittedAt: serverTimestamp()
        });

        // No immediate access grant here — a classroom code only unlocks
        // its target file once an admin reviews and confirms it (see
        // js/access.js and the admin panel's Classroom Codes tab).
        hnClassroomForm.classList.add("hidden");
        hnClassroomSuccess.classList.remove("hidden");
        hnRefreshAccess(normalizeEmail(session.email));
      } catch (err) {
        console.error("[Hand Notes] classroom unlock failed:", err);
        hnClassroomError.textContent = "Something went wrong. Please try again.";
        hnClassroomError.classList.remove("hidden");
        hnClassroomSubmit.disabled = false;
        hnClassroomSubmit.textContent = "Send for Review";
      }
    });
  }

  // ============================================
  // UNLOCK BY WATCHING AN AD — instant, no admin review. The student
  // must keep a Google AdSense ad on screen for AD_WATCH_SECONDS; once
  // that timer completes we write a doc to the "adUnlocks" collection
  // (kind: "ad") scoped to the ONE file this gate was opened for, and
  // js/access.js grants that file 6h of access immediately (see its
  // `item?.kind === "ad"` branch) — same targetFileId scoping as the
  // classroom-code flow, just without waiting on an admin.
  //
  // TODO — go live: replace AD_CLIENT_ID and AD_SLOT_ID below with your
  // real Google AdSense publisher id and ad-unit slot id (and make sure
  // the <script> tag in slides-notes.html's <head> also has your real
  // ca-pub- client id). Until then this renders an empty placeholder box
  // instead of a real ad, but the unlock timer/logic below still works
  // end-to-end for testing.
  // ============================================
  const AD_CLIENT_ID = "ca-pub-XXXXXXXXXXXXXXXX"; // TODO: your AdSense publisher id
  const AD_SLOT_ID = "XXXXXXXXXX";                 // TODO: your AdSense ad-unit slot id
  const AD_WATCH_SECONDS = 15;

  const hnAdSlotWrap = document.getElementById("hn-ad-slot-wrap");
  const hnAdProgressBar = document.getElementById("hn-ad-progress-bar");
  const hnAdCountdown = document.getElementById("hn-ad-countdown");
  const hnAdSecondsTotal = document.getElementById("hn-ad-seconds-total");
  const hnAdClaimBtn = document.getElementById("hn-ad-claim");
  const hnAdError = document.getElementById("hn-ad-error");
  const hnAdSuccess = document.getElementById("hn-ad-success");
  if (hnAdSecondsTotal) hnAdSecondsTotal.textContent = String(AD_WATCH_SECONDS);

  let hnAdTimer = null;
  let hnAdSecondsLeft = AD_WATCH_SECONDS;

  function hnRenderAdUnit() {
    if (!hnAdSlotWrap) return;
    hnAdSlotWrap.innerHTML = "";
    // AdSense only ever fills a given <ins> once, so a fresh element is
    // created (and pushed) every time this step is opened, rather than
    // reusing one across multiple "watch an ad" attempts.
    const ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.cssText = "display:block;width:100%;min-height:250px;";
    ins.setAttribute("data-ad-client", AD_CLIENT_ID);
    ins.setAttribute("data-ad-slot", AD_SLOT_ID);
    ins.setAttribute("data-ad-format", "auto");
    ins.setAttribute("data-full-width-responsive", "true");
    hnAdSlotWrap.appendChild(ins);
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (err) {
      console.error("[Hand Notes] AdSense push failed:", err);
    }
  }

  function hnResetAdUi() {
    hnAdSecondsLeft = AD_WATCH_SECONDS;
    if (hnAdProgressBar) hnAdProgressBar.style.width = "0%";
    if (hnAdCountdown) hnAdCountdown.textContent = `${AD_WATCH_SECONDS}s left`;
    if (hnAdClaimBtn) {
      hnAdClaimBtn.disabled = true;
      hnAdClaimBtn.textContent = "Watching ad… please wait";
    }
    hnAdError?.classList.add("hidden");
    hnAdSuccess?.classList.add("hidden");
    document.getElementById("hn-ad-form-area")?.classList.remove("hidden");
  }

  function hnStartAdWatch() {
    hnCancelAdWatch();
    hnResetAdUi();
    hnRenderAdUnit();
    hnAdTimer = setInterval(() => {
      hnAdSecondsLeft--;
      const pct = Math.min(100, Math.round(((AD_WATCH_SECONDS - hnAdSecondsLeft) / AD_WATCH_SECONDS) * 100));
      if (hnAdProgressBar) hnAdProgressBar.style.width = pct + "%";
      if (hnAdCountdown) hnAdCountdown.textContent = hnAdSecondsLeft > 0 ? `${hnAdSecondsLeft}s left` : "Done!";
      if (hnAdSecondsLeft <= 0) {
        clearInterval(hnAdTimer);
        hnAdTimer = null;
        if (hnAdClaimBtn) {
          hnAdClaimBtn.disabled = false;
          hnAdClaimBtn.textContent = "✅ Unlock This File";
        }
      }
    }, 1000);
  }

  function hnCancelAdWatch() {
    if (hnAdTimer) { clearInterval(hnAdTimer); hnAdTimer = null; }
  }

  hnAdClaimBtn?.addEventListener("click", async () => {
    const session = getSession();
    if (!session) { hnShowStep(hnStepLogin); return; }

    hnAdClaimBtn.disabled = true;
    hnAdClaimBtn.textContent = "Unlocking…";
    hnAdError?.classList.add("hidden");

    try {
      await addDoc(collection(db, "adUnlocks"), {
        targetFileId: hnGateTargetId,
        fromName: session.fullName || session.email || "",
        fromEmail: normalizeEmail(session.email || ""),
        kind: "ad",
        watchedSeconds: AD_WATCH_SECONDS,
        submittedAt: serverTimestamp(),
        watchedAt: serverTimestamp()
      });

      document.getElementById("hn-ad-form-area")?.classList.add("hidden");
      hnAdSuccess?.classList.remove("hidden");
      hnRefreshAccess(normalizeEmail(session.email));
    } catch (err) {
      console.error("[Hand Notes] ad unlock failed:", err);
      if (hnAdError) {
        hnAdError.textContent = "Something went wrong unlocking this file. Please try again.";
        hnAdError.classList.remove("hidden");
      }
      hnAdClaimBtn.disabled = false;
      hnAdClaimBtn.textContent = "✅ Unlock This File";
    }
  });

  // Access is calculated from Firestore moderation records. Do not use a
  // browser-only countdown because it can be cleared or become stale.
  //
  // Every item here may carry its own `targetFileId` (the specific file
  // it unlocks). This function keeps the full, unfiltered list around on
  // window.__hnAccessItems so each file row can work out ITS OWN access
  // via computeFileAccessStatus() at render time — see
  // window.__hnIsFileUnlocked below — instead of one blanket flag for
  // every file. The aggregate `computeResourceAccessStatus` result
  // returned here is only used for account-wide concerns that really are
  // global: the 30-day upload restriction, and the summary banner.
  async function getResourceAccessState(userEmail) {
    const normalizedEmail = normalizeEmail(userEmail);
    if (!normalizedEmail) {
      window.__hnAccessItems = [];
      return computeResourceAccessStatus([]);
    }

    const [resourcesSnap, classroomSnap, adSnap] = await Promise.all([
      getDocs(query(
        collection(db, "resources"),
        where("uploaderEmail", "==", normalizedEmail),
        where("resourceType", "==", "slides_notes")
      )),
      getDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "adUnlocks"), where("fromEmail", "==", normalizedEmail)))
    ]);
    const docs = resourcesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Classroom codes keep their real status ("new"/"contacted"/"approved")
    // from Firestore — js/access.js only grants access once that status is
    // "approved" by an admin.
    const classroomDocs = classroomSnap.docs.map(d => ({ id: d.id, kind: "classroom", ...d.data() }));
    // Ad unlocks are already "kind: ad" in Firestore and grant access the
    // instant they're written — see js/access.js's `item?.kind === "ad"` branch.
    const adDocs = adSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const items = [...docs, ...classroomDocs, ...adDocs];
    window.__hnAccessItems = items;
    return computeResourceAccessStatus(items);
  }

  // Whether ONE specific file is currently unlocked for this student.
  // Returns null while the very first access check hasn't resolved yet
  // (see window.__hnAccessKnown), so callers can show a neutral
  // "checking…" state instead of a false 🔒.
  window.__hnIsFileUnlocked = function (fileId) {
    if (!window.__hnAccessKnown) return null;
    return computeFileAccessStatus(window.__hnAccessItems || [], fileId).active;
  };

  const unlockStrip = document.getElementById("resource-unlock-strip");

  // Refresh on load and periodically so a 12-hour pending timeout or an
  // admin approval/rejection takes effect without a page refresh.
  const cachedEmail = normalizeEmail(getSession()?.email || localStorage.getItem("agri_handnotes_user_email") || "");

  // ------------------------------------------------------------------
  // FIX — "I have active access but files still show locked":
  // window.__hnAccessActive starts out `undefined` (falsy) the instant
  // this script runs, and the very first file-list render (a few lines
  // below, `loadThreeCardLayout()`) used to fire BEFORE the Firestore
  // round trip that determines the real access state ever resolves. For
  // that whole window every file rendered with a 🔒 lock badge even when
  // the student's access was genuinely active — it just hadn't been
  // *checked* yet. window.__hnAccessKnown tracks whether a real check has
  // completed at least once, so the file lists can show a neutral
  // "checking access…" state instead of a false 🔒 until we actually know.
  // ------------------------------------------------------------------
  window.__hnAccessKnown = !cachedEmail; // nothing to check for a guest — treat as "known" (locked)

  function renderAccessState(state, userEmail) {
    window.__hnAccessKnown = true;

    // BUG FIX — "profile shows access active but resource files still show
    // locked": window.__hnAccessActive is the single source of truth the
    // PDF/Image/Slides file-list renderers check to decide 🔒 vs unlocked,
    // and it must reflect the REAL Firestore-computed state on every page
    // that lists resource files — including resources.html, which has no
    // #access-status-bar / #handnotes-gate / #resource-content elements of
    // its own (those only exist on slides-notes.html). The old code set
    // this flag AFTER an `if (!accessStatusBar) return false;` early exit,
    // so on resources.html the flag was never updated past its initial
    // `undefined` (falsy) value and every file rendered as permanently
    // locked no matter how much real access time the student had. The
    // flag is now always set first, from `state` alone, before any of the
    // optional status-bar/gate UI (which may not exist on this page) is
    // touched.
    window.__hnAccessActive = !state.restricted && !!state.active;

    if (!accessStatusBar) return window.__hnAccessActive;
    accessStatusBar.classList.remove("hidden", "approved", "pending", "rejected");

    const count = state.approvedFileCount + state.pendingActiveCount;
    const content = accessStatusBar.querySelector(".status-content");
    if (!content) return window.__hnAccessActive;

    if (state.restricted) {
      resourceUploadBlockedUntil = state.restrictedUntil;
      accessStatusBar.classList.add("rejected");
      handNotesContent.classList.add("locked");
      handNotesContent.classList.remove("form-only");
      handNotesGate.classList.add("hidden");
      unlockStrip?.classList.remove("hidden");
      document.getElementById("open-another-upload")?.classList.add("hidden");
      content.innerHTML = `
        <strong>⚠️ UPLOAD RESTRICTED FOR 30 DAYS</strong>
        <div class="file-info">Your access and uploads are restricted until <strong>${formatDate(state.restrictedUntil)}</strong>.</div>
        <div class="file-info">⚠️ <strong>Upload relevant files only.</strong> Please wait until the restriction ends before submitting another file.</div>
      `;
      loadThreeCardLayoutIfAvailable();
      return false;
    }

    resourceUploadBlockedUntil = 0;

    // Access is per-file now, so this banner no longer claims one blanket
    // "active" state for everything — it summarizes how many of the
    // student's own unlock submissions are currently active vs. still
    // waiting on admin review, for files that were unlocked individually.
    const items = window.__hnAccessItems || [];
    const byFile = new Map();
    for (const it of items) {
      const key = it.targetFileId || "__general__";
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(it);
    }
    let unlockedFileCount = 0;
    let pendingClassroomCount = 0;
    for (const group of byFile.values()) {
      if (computeResourceAccessStatus(group).active) unlockedFileCount++;
    }
    for (const it of items) {
      if (it.kind === "classroom" && it.status !== "approved") pendingClassroomCount++;
    }

    handNotesGate.classList.add("hidden");
    handNotesContent.classList.remove("locked", "form-only");
    unlockStrip?.classList.remove("hidden");
    document.getElementById("open-another-upload")?.classList.remove("hidden");

    if (unlockedFileCount > 0) {
      accessStatusBar.classList.add("approved");
      content.innerHTML = `
        <strong>🔓 ${unlockedFileCount} FILE${unlockedFileCount === 1 ? "" : "S"} UNLOCKED</strong>
        <div class="file-info">Each file you unlock (by uploading, or a classroom code once an admin confirms it) stays open on its own — it doesn't unlock any other file.</div>
        ${pendingClassroomCount > 0 ? `<div class="file-info">⏳ ${pendingClassroomCount} classroom code${pendingClassroomCount === 1 ? "" : "s"} awaiting admin review.</div>` : ""}
        <div class="file-info">Files counted: <strong>${count}</strong></div>
      `;
      // Don't also call loadThreeCardLayoutIfAvailable() here — the
      // caller (hnRefreshAccess) already replays window.__onResourceAccessGranted,
      // which includes loadThreeCardLayout, once for this exact transition.
      return true;
    }

    // Not active, not restricted: folders stay browsable (no forced gate/
    // form-only) — the gate only opens when the person clicks a locked
    // file.
    accessStatusBar.classList.add("pending");
    content.innerHTML = `
      <strong>🔒 NO FILES UNLOCKED YET</strong>
      <div class="file-info">Browse folders freely — click 🔒 Unlock on any file to unlock just that one.</div>
      <div class="file-info">Uploading a file gives that file <strong>24 hours</strong> of access right away. A classroom code gives that file <strong>6 hours</strong> — but only once an admin has reviewed and confirmed it.</div>
      ${pendingClassroomCount > 0 ? `<div class="file-info">⏳ ${pendingClassroomCount} classroom code${pendingClassroomCount === 1 ? "" : "s"} awaiting admin review.</div>` : ""}
    `;
    loadThreeCardLayoutIfAvailable();
    return false;
  }

  function loadThreeCardLayoutIfAvailable() {
    (window.__resourcesReloadLayout || (() => {}))();
  }

  // BUG FIX — "unlocks after submit, locked again on reload": if the
  // very FIRST access check on a fresh page load fails (a transient
  // network blip, a slow connection, etc.), window.__hnAccessActive has
  // never been set to anything yet, so it's falsy — and the old catch
  // block immediately marked the check "known" and moved on, which
  // rendered every file as 🔒 with no way to tell "genuinely no access"
  // apart from "we simply failed to check". That false lock looked
  // identical to real expiry. Now a failure on the first-ever check
  // retries a few times (with a visible, distinct status) before ever
  // falling back to a locked render — a real "no access" state is only
  // ever shown once we've actually heard back from Firestore.
  let hnAccessEverKnown = false;
  let hnCheckRetries = 0;
  const HN_MAX_CHECK_RETRIES = 3;

  async function hnRefreshAccess(userEmail) {
    try {
      const state = await getResourceAccessState(userEmail);
      hnAccessEverKnown = true;
      hnCheckRetries = 0;
      const active = renderAccessState(state, userEmail);
      if (active) {
        (window.__onResourceAccessGranted || []).forEach(fn => fn());
      }
      return state;
    } catch (err) {
      console.error("[Access Status Check] failed:", err);

      if (!hnAccessEverKnown && hnCheckRetries < HN_MAX_CHECK_RETRIES) {
        hnCheckRetries++;
        if (accessStatusBar) {
          accessStatusBar.classList.remove("hidden", "approved", "rejected");
          accessStatusBar.classList.add("pending");
          const content = accessStatusBar.querySelector(".status-content");
          if (content) {
            content.innerHTML = `
              <strong>⏳ Checking your access…</strong>
              <div class="file-info">Having trouble reaching the server — retrying (${hnCheckRetries}/${HN_MAX_CHECK_RETRIES})…</div>
            `;
          }
        }
        setTimeout(() => hnRefreshAccess(userEmail), 2500 * hnCheckRetries);
        return null;
      }

      // Either we've already had at least one successful check this visit
      // (so whatever __hnAccessActive currently holds is trustworthy), or
      // we've genuinely retried and it's still failing — in both cases the
      // file list must not be stuck on "checking…" forever, so unblock it.
      window.__hnAccessKnown = true;
      loadThreeCardLayoutIfAvailable();
      return null;
    }
  }

  if (cachedEmail) {
    hnRefreshAccess(cachedEmail);
    setInterval(() => hnRefreshAccess(cachedEmail), 15000);
  }

  // File type selector
  const fileTypeRadios = document.querySelectorAll('input[name="fileType"]');
  const imageTitlesWrap = document.getElementById("hn-image-titles-wrap");
  const imageTitlesList = document.getElementById("hn-image-titles-list");

  function cleanFileNameAsTitle(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }

  function renderImageTitleInputs() {
    if (currentFileType !== "image" || !hnFiles.files || hnFiles.files.length === 0) {
      imageTitlesWrap.classList.add("hidden");
      imageTitlesList.innerHTML = "";
      return;
    }
    imageTitlesList.innerHTML = Array.from(hnFiles.files).map((f, i) => `
      <input type="text" class="hn-image-title-input" data-index="${i}"
             placeholder="Title for: ${esc(f.name)}" value="${esc(cleanFileNameAsTitle(f.name))}"
             style="width:100%;padding:.5rem .7rem;border:1px solid var(--line);border-radius:6px;font-size:.85rem;">
    `).join("");
    imageTitlesWrap.classList.remove("hidden");
  }

  hnFiles.addEventListener("change", renderImageTitleInputs);
  wireSelectedFilesPreview(hnFiles, document.getElementById("hn-files-selected-preview"));

  fileTypeRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      currentFileType = radio.value;
      hnFiles.accept = fileTypeAccepts[currentFileType];
      
      // Update label
      const labels = {
        pdf: "PDF File(s) *",
        image: "Image File(s) * (JPG, PNG, GIF, WebP)",
        ppt: "Presentation File(s) * (PPT/PPTX)"
      };
      hnFilesLabel.textContent = labels[currentFileType];

      // Visual feedback
      document.querySelectorAll('input[name="fileType"]').forEach(r => {
        r.closest("label").style.borderColor = r.checked ? "var(--leaf-500)" : "var(--line)";
        r.closest("label").style.background = r.checked ? "rgba(107, 155, 94, 0.05)" : "transparent";
      });

      renderImageTitleInputs();
    });
  });

  if (hnForm) {
    hnForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const courseCode = document.getElementById("hn-courseCode").value.trim().toUpperCase();
      const courseName = document.getElementById("hn-courseName").value.trim();
      const facultyName = document.getElementById("hn-facultyName").value.trim();
      const uploaderEmail = normalizeEmail(document.getElementById("hn-uploaderEmail").value);
      const files = Array.from(hnFiles.files);

      const restriction = await window.__checkResourceRestriction(uploaderEmail);
      if (restriction !== 0) {
        const msg = restriction === -1
          ? "⚠️ We could not verify your upload status. Please try again."
          : `⚠️ Uploads are restricted for 30 days after a rejected file. Please wait until the restriction ends.`;
        hnShowStatus(msg, true);
        return;
      }

      if (files.length === 0) { 
        hnShowStatus(`Please choose at least one ${currentFileType.toUpperCase()} file.`, true); 
        return; 
      }
      if (files.length > MAX_FILES) { 
        hnShowStatus(`Maximum ${MAX_FILES} files allowed.`, true); 
        return; 
      }

      const oversized = files.find(f => f.size > MAX_SIZE);
      if (oversized) { 
        hnShowStatus(`"${oversized.name}" is over 50MB.`, true); 
        return; 
      }

      // Validate file types
      let validationError = false;
      if (currentFileType === "pdf") {
        validationError = files.some(f => !f.name.toLowerCase().endsWith(".pdf"));
      } else if (currentFileType === "image") {
        validationError = files.some(f => !["jpg","jpeg","png","gif","webp"].includes(f.name.toLowerCase().split(".").pop()));
      } else if (currentFileType === "ppt") {
        validationError = files.some(f => !["ppt","pptx"].includes(f.name.toLowerCase().split(".").pop()));
      }

      if (validationError) {
        hnShowStatus(`Some files are not valid ${currentFileType.toUpperCase()} files.`, true);
        return;
      }

      hnSubmit.disabled = true;
      hnSubmit.textContent = "Uploading…";
      hnSetProgress(0);
      hnShowStatus(`Uploading ${files.length} file(s)…`);

      try {
        const progressByFile = new Array(files.length).fill(0);
        const updateOverall = () => {
          const avg = Math.round(progressByFile.reduce((a, b) => a + b, 0) / files.length);
          hnSetProgress(avg);
          hnShowStatus(avg >= 100 ? "Processing on server…" : `Uploading ${files.length} file(s)…`);
        };
        
        const fileUrls = await Promise.all(
          files.map((file, i) => uploadFileToCloudinary(file, (pct) => { progressByFile[i] = pct; updateOverall(); }))
        );

        // Auto-rename duplicates
        for (let i = 0; i < fileUrls.length; i++) {
          const renamedName = await autoRenameIfDuplicate(fileUrls[i].name, courseCode, facultyName);
          fileUrls[i].name = renamedName;
        }

        // Attach the per-image title captured at upload time (if any),
        // so the gallery and viewer can display it under the image.
        if (currentFileType === "image") {
          const titleInputs = imageTitlesList.querySelectorAll(".hn-image-title-input");
          fileUrls.forEach((f, i) => {
            const t = titleInputs[i] ? titleInputs[i].value.trim() : "";
            f.title = t || cleanFileNameAsTitle(f.name);
          });
        }

        hnShowStatus("Saving details…");
        hnSetProgress(100);

        const courseSnap = await getDoc(doc(db, "courses", courseCode));
        const finalCourseName = courseSnap.exists() ? courseSnap.data().courseName : courseName;
        if (!courseSnap.exists()) {
          await setDoc(doc(db, "courses", courseCode), { courseCode, courseName: finalCourseName });
        }

        const hnDocData = {
          courseCode, courseName: finalCourseName, facultyName,
          resourceType: "slides_notes", uploaderEmail, fileUrls, fileType: currentFileType, noteType: hnNoteType,
          targetFileId: hnGateTargetId,
          status: "pending", submittedAt: serverTimestamp(), uploadedAt: Date.now()
        };
        const hnUploaderStudentId = await lookupStudentIdByEmail(uploaderEmail);
        if (hnUploaderStudentId) hnDocData.uploaderStudentId = hnUploaderStudentId;
        await addDoc(collection(db, "resources"), hnDocData);

        hnShowStatus("✅ Submitted! Unlocking Hand Notes…");
        setTimeout(() => {
          hnRefreshAccess(uploaderEmail);
          hnForm.classList.add("hidden");
          const successBoxEl = document.getElementById("hn-notes-success");
          const titleEl = document.getElementById("hn-notes-success-title");
          const detailEl = document.getElementById("hn-notes-success-detail");
          if (titleEl) titleEl.textContent = "You've got 24 hours of access to this file";
          if (detailEl) detailEl.textContent = "Access to this file started the moment you uploaded — no need to wait for admin review. Your file is still pending review in the background, and unlocking it doesn't unlock any other file.";
          successBoxEl?.classList.remove("hidden");
        }, 700);
      } catch (err) {
        console.error("[Hand Notes Unlock] failed:", err);
        let userMessage = "Something went wrong. Please try again.";
        if (err.code === "permission-denied") {
          userMessage = "Upload was rejected. Please check the details and try again.";
        } else if (/network/i.test(err.message || "")) {
          userMessage = "Network error. Check your connection and try again.";
        } else if (/timed out/i.test(err.message || "")) {
          userMessage = "Upload took too long. Try again with a smaller file.";
        }
        hnShowStatus(userMessage, true);
        hnSubmit.disabled = false;
        hnSubmit.textContent = "Upload & Unlock";
      }
    });
  }
}

// ============================================
// THREE-CARD PREMIUM LAYOUT (slides-notes.html)
// ============================================
const pdfList = document.getElementById("pdf-list");
const pdfSearch = document.getElementById("pdf-search");
const imageGrid = document.getElementById("image-grid");
const imageSearch = document.getElementById("image-search");

if (pdfList || imageGrid) {
  let allDocs = [];   // PDFs + Presentations, merged into one card
  let allImages = [];

  async function loadThreeCardLayout() {
    try {
      const q = query(
        collection(db, "resources"),
        where("resourceType", "==", "slides_notes"),
        where("status", "==", "approved")
      );
      const snap = await getDocs(q);
      const resources = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // PDFs and Presentations share one card now; images stay separate.
      allDocs = resources.filter(r => r.fileType === "pdf" || r.fileType === "ppt" || !r.fileType); // no fileType defaults to PDF for backward compatibility
      allImages = resources.filter(r => r.fileType === "image");

      renderPdfCard();
      renderImageCard();
    } catch (err) {
      console.error("[Three Card Layout] load failed:", err);
    }
  }

  function docIcon(item) {
    return item.fileType === "ppt" ? "📊" : "📄";
  }

  // A file's display label: its per-file title if the uploader gave one,
  // otherwise a cleaned-up version of the original filename — never a bare
  // "View 1 / View 2" placeholder.
  function fileDisplayName(file) {
    if (file.title) return file.title;
    return String(file.name || "File").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "File";
  }

  // Groups an array of submissions by a key function, returning a Map that
  // preserves first-seen insertion order.
  function groupDocs(items, keyFn) {
    const map = new Map();
    items.forEach(item => {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return map;
  }

  // ============================================
  // PDF/PRESENTATIONS FOLDER BROWSER
  // Renders a drill-down folder view into `container`, backed by `items`
  // (an array of submissions) and `state` (mutable {courseCode, faculty}).
  //   Level 1 — one folder per course code (e.g. "AGR 101: Agronomy")
  //   Level 2 — one folder per faculty name within that course
  //             (skipped automatically if the course only has one faculty)
  //   Level 3 — every individual file in that course/faculty, each with
  //             its own View button — no "View 1 / View 2" placeholders.
  // `opts.limitTopLevel` caps how many course folders are shown at level 1
  // (used for the compact card preview); `opts.onTopLevelCount(total, shown)`
  // reports the true vs. displayed folder count so callers can show/hide a
  // "View All" link.
  // ============================================
  function renderPdfFolder(container, items, state, opts = {}) {
    if (items.length === 0) {
      container.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;">No matching files found.</p>`;
      if (opts.onTopLevelCount) opts.onTopLevelCount(0, 0);
      return;
    }

    // LEVEL 1 — course code folders
    if (!state.courseCode) {
      const courses = groupDocs(items, i => i.courseCode || "Unknown");
      let rows = [...courses.entries()].map(([code, docs]) => ({
        code, name: docs[0].courseName || "",
        fileCount: docs.reduce((n, d) => n + (d.fileUrls || []).length, 0)
      })).sort((a, b) => a.code.localeCompare(b.code));

      const total = rows.length;
      if (opts.limitTopLevel) rows = rows.slice(0, opts.limitTopLevel);
      if (opts.onTopLevelCount) opts.onTopLevelCount(total, rows.length);

      container.innerHTML = rows.map(r => `
        <div class="file-item folder-row" data-course="${esc(r.code)}">
          <span class="file-status">📁</span>
          <span class="file-name">${esc(r.code)}${r.name ? `: ${esc(r.name)}` : ""}</span>
          <span class="folder-meta">${r.fileCount} file${r.fileCount !== 1 ? "s" : ""} <span class="folder-chevron">›</span></span>
        </div>`).join("");

      container.querySelectorAll("[data-course]").forEach(el => {
        el.addEventListener("click", () => {
          state.courseCode = el.dataset.course;
          state.faculty = null;
          renderPdfFolder(container, items, state, opts);
        });
      });
      return;
    }

    const courseItems = items.filter(i => (i.courseCode || "Unknown") === state.courseCode);
    const courseName = courseItems[0]?.courseName || "";
    const faculties = groupDocs(courseItems, i => i.facultyName || "");

    // LEVEL 2 — faculty folders (skipped when the course only has one faculty)
    if (state.faculty === null) {
      if (faculties.size <= 1) {
        state.faculty = [...faculties.keys()][0] ?? "";
        renderPdfFolder(container, items, state, opts);
        return;
      }

      const rows = [...faculties.entries()].map(([fac, docs]) => ({
        fac, fileCount: docs.reduce((n, d) => n + (d.fileUrls || []).length, 0)
      })).sort((a, b) => a.fac.localeCompare(b.fac));

      container.innerHTML =
        `<div class="file-item folder-row folder-back" data-back="1">
          <span class="file-status">←</span>
          <span class="file-name">${esc(state.courseCode)}${courseName ? `: ${esc(courseName)}` : ""}</span>
        </div>` +
        rows.map(r => `
          <div class="file-item folder-row" data-faculty="${esc(r.fac)}">
            <span class="file-status">👤</span>
            <span class="file-name">${r.fac ? esc(r.fac) : "Unspecified Faculty"}</span>
            <span class="folder-meta">${r.fileCount} file${r.fileCount !== 1 ? "s" : ""} <span class="folder-chevron">›</span></span>
          </div>`).join("");

      container.querySelector("[data-back]").addEventListener("click", () => {
        state.courseCode = null;
        state.faculty = null;
        renderPdfFolder(container, items, state, opts);
      });
      container.querySelectorAll("[data-faculty]").forEach(el => {
        el.addEventListener("click", () => {
          state.faculty = el.dataset.faculty;
          renderPdfFolder(container, items, state, opts);
        });
      });
      return;
    }

    // LEVEL 3 — individual files
    const facultyItems = courseItems.filter(i => (i.facultyName || "") === state.faculty);
    const backLabel = state.faculty
      ? `${esc(state.courseCode)} — ${esc(state.faculty)}`
      : `${esc(state.courseCode)}${courseName ? `: ${esc(courseName)}` : ""}`;

    // Still waiting on the very first access check to come back from
    // Firestore — show a neutral "checking" state instead of a false 🔒,
    // so a student with genuinely active access never sees files marked
    // locked just because the check hasn't finished yet.
    const checking = !window.__hnAccessKnown;
    const fileRows = [];
    facultyItems.forEach(item => {
      (item.fileUrls || []).forEach((file, idx) => {
        // Each file gets its OWN id (a submission doc can bundle several
        // files, so the doc id alone isn't unique per file) and is
        // unlocked independently of every other file — see hnOpenGate.
        const fileId = `${item.id}::${idx}`;
        const unlocked = checking ? false : (window.__hnIsFileUnlocked && window.__hnIsFileUnlocked(fileId));
        const locked = !checking && !unlocked;
        fileRows.push(`
          <div class="file-item${locked ? " file-locked" : ""}${checking ? " file-checking" : ""}" ${locked ? `data-locked-file="1" data-file-id="${esc(fileId)}"` : ""}>
            <span class="file-status">${docIcon(item)}</span>
            <span class="file-name">${esc(fileDisplayName(file))} <span class="note-type-tag">${esc(noteTypeLabel(item))}</span></span>
            ${checking
              ? `<span class="file-action file-lock-badge is-checking">⏳ Checking…</span>`
              : locked
                ? `<span class="file-action file-lock-badge">🔒 Unlock</span>`
                : `<a href="${buildViewHref(file, item)}" class="file-action" title="${esc(file.name)}">View</a>`}
          </div>`);
      });
    });

    container.innerHTML =
      `<div class="file-item folder-row folder-back" data-back="1">
        <span class="file-status">←</span>
        <span class="file-name">${backLabel}</span>
      </div>` +
      (fileRows.length ? fileRows.join("") : `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;">No files here.</p>`);

    container.querySelector("[data-back]").addEventListener("click", () => {
      // If the faculty level was auto-skipped (only one faculty), go
      // straight back to the course list rather than a dead-end faculty step.
      if (faculties.size <= 1) { state.courseCode = null; state.faculty = null; }
      else { state.faculty = null; }
      renderPdfFolder(container, items, state, opts);
    });

    container.querySelectorAll("[data-locked-file]").forEach(el => {
      el.addEventListener("click", () => window.hnOpenGate && window.hnOpenGate(el.dataset.fileId));
    });
  }

  let pdfSearchWired = false;
  let pdfLoadedOnce = false;
  const pdfCardState = { courseCode: null, faculty: null };

  function renderPdfCard() {
    const docCount = allDocs.length;
    document.getElementById("pdf-count").textContent = `(${docCount})`;

    if (docCount === 0) {
      pdfList.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;">No files yet.</p>`;
      if (pdfSearch) pdfSearch.style.display = "none";
      document.getElementById("pdf-view-all").style.display = "none";
      return;
    }

    // BUG FIX: loadThreeCardLayout() reruns in the background (the 15s
    // access poll, or right after an access-state change) purely to
    // refresh lock badges/counts — it isn't a fresh page visit. Only
    // reset the folder drill-down (and re-apply the search box's current
    // term) on the very FIRST render; later automatic reruns now keep the
    // student exactly where they were browsing instead of bouncing them
    // back to the top-level course list mid-navigation.
    const resetNav = !pdfLoadedOnce;
    pdfLoadedOnce = true;

    if (pdfSearch) {
      pdfSearch.style.display = "block";
      const term = pdfSearch.value.trim().toLowerCase();
      const filtered = term
        ? allDocs.filter(item =>
            (item.courseCode || "").toLowerCase().includes(term) ||
            (item.courseName || "").toLowerCase().includes(term)
          )
        : allDocs;
      renderPdfList(filtered, resetNav);

      if (!pdfSearchWired) {
        pdfSearchWired = true;
        pdfSearch.addEventListener("input", (e) => {
          const term = e.target.value.trim().toLowerCase();
          const filtered = term
            ? allDocs.filter(item =>
                (item.courseCode || "").toLowerCase().includes(term) ||
                (item.courseName || "").toLowerCase().includes(term)
              )
            : allDocs;
          // A new search term always starts back at the top level.
          renderPdfList(filtered, true);
        });
      }
    } else {
      renderPdfList(allDocs, resetNav);
    }
  }

  function renderPdfList(items, resetNav = true) {
    if (resetNav) {
      pdfCardState.courseCode = null;
      pdfCardState.faculty = null;
    }
    renderPdfFolder(pdfList, items, pdfCardState, {
      limitTopLevel: 6,
      onTopLevelCount: (total, shown) => {
        document.getElementById("pdf-view-all").style.display = total > shown ? "block" : "none";
      }
    });
  }

  let imageSearchWired = false;

  function renderImageCard() {
    const imageCount = allImages.length;
    document.getElementById("image-count").textContent = `(${imageCount})`;

    if (imageCount === 0) {
      imageGrid.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No images yet.</p>`;
      imageSearch.style.display = "none";
      document.getElementById("image-view-all").style.display = "none";
      return;
    }

    imageSearch.style.display = "block";
    const displayCount = Math.min(6, imageCount);

    // BUG FIX #1: this used to re-attach a brand-new "input" listener on
    // EVERY call — and this function reruns on every background access
    // check (every 15s, or on any access-state change), not just once —
    // so listeners piled up endlessly, each firing again on the next
    // keystroke.
    // BUG FIX #2: it also always rendered the default unfiltered first-6
    // images, so if a student was mid-search when a background refresh
    // fired, their search results got silently replaced. Both are fixed
    // by re-applying whatever's currently in the search box on every
    // call, and wiring the listener exactly once.
    const applyFilter = () => {
      const term = imageSearch.value.trim().toLowerCase();
      const filtered = term
        ? allImages.filter(img =>
            (img.courseName || "").toLowerCase().includes(term) ||
            (img.courseCode || "").toLowerCase().includes(term)
          )
        : allImages.slice(0, displayCount);
      renderImageGrid(filtered);
    };

    applyFilter();
    document.getElementById("image-view-all").style.display = imageCount > displayCount ? "block" : "none";

    if (!imageSearchWired) {
      imageSearchWired = true;
      imageSearch.addEventListener("input", applyFilter);
    }
  }

  function renderImageGrid(images) {
    if (images.length === 0) {
      imageGrid.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No matching images found.</p>`;
      return;
    }

    const checking = !window.__hnAccessKnown;
    imageGrid.innerHTML = images.map(img => {
      const file = img.fileUrls[0];
      const viewHref = buildViewHref(file, img);
      const unlocked = checking ? false : (window.__hnIsFileUnlocked && window.__hnIsFileUnlocked(img.id));
      const locked = !checking && !unlocked;
      const tag = locked ? "div" : "a";
      return `
      <${tag} class="image-item${locked ? " image-locked" : ""}${checking ? " image-checking" : ""}"${locked ? ` data-locked-image="1" data-file-id="${esc(img.id)}"` : ` href="${viewHref}"`} style="text-decoration:none;">
        <div class="image-item-thumb">
          <img src="${encodeURI(file.url)}" alt="${esc(file.title || img.courseName)}" loading="lazy">
          <div class="status-badge">✓</div>
          <div class="view-overlay">
            <button type="button">${checking ? "⏳" : locked ? "🔒" : "View"}</button>
          </div>
        </div>
        <div class="image-item-caption">
          <span class="image-item-code">${esc(img.courseCode)}</span>
          ${file.title ? `<span class="image-item-title">${esc(file.title)}</span>` : ""}
        </div>
      </${tag}>`;
    }).join("");

    imageGrid.querySelectorAll("[data-locked-image]").forEach(el => {
      el.addEventListener("click", () => window.hnOpenGate && window.hnOpenGate(el.dataset.fileId));
    });
  }

  window.__onResourceAccessGranted = window.__onResourceAccessGranted || [];
  window.__onResourceAccessGranted.push(loadThreeCardLayout);
  window.__resourcesReloadLayout = loadThreeCardLayout;

  // Load the preview immediately, regardless of unlock status — the
  // handnotes gate now shows a blurred/locked preview of real resources
  // rather than hiding them entirely, so this can't wait for access grant.
  loadThreeCardLayout();

  // ============================================
  // VIEW ALL MODALS
  // The small cards only ever preview up to 5/6 items. "View All" opens a
  // modal with the complete list — with a course-code search box, and (for
  // PDFs) a faculty filter that's populated from whatever the code search
  // currently matches.
  // ============================================
  function wireViewAllModal({ openBtnId, modalId, closeBtnId, searchId, facultyId, getItems, renderList, matchFn }) {
    const openBtn = document.getElementById(openBtnId);
    const modal = document.getElementById(modalId);
    if (!openBtn || !modal) return;
    const closeBtn = closeBtnId ? document.getElementById(closeBtnId) : null;
    const searchInput = searchId ? document.getElementById(searchId) : null;
    const facultySelect = facultyId ? document.getElementById(facultyId) : null;

    function apply() {
      const term = (searchInput?.value || "").trim();
      let items = getItems();
      if (term) items = items.filter(i => matchFn(i, term));

      if (facultySelect) {
        const faculties = [...new Set(items.map(i => i.facultyName).filter(Boolean))].sort();
        const current = facultySelect.value;
        facultySelect.innerHTML = `<option value="">All Faculties</option>` +
          faculties.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
        facultySelect.value = faculties.includes(current) ? current : "";
        if (facultySelect.value) items = items.filter(i => i.facultyName === facultySelect.value);
      }

      renderList(items);
    }

    openBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (searchInput) searchInput.value = "";
      if (facultySelect) facultySelect.value = "";
      modal.classList.remove("hidden");
      apply();
    });
    if (closeBtn) closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    if (searchInput) searchInput.addEventListener("input", apply);
    if (facultySelect) facultySelect.addEventListener("change", apply);
  }

  // VIEW ALL — PDFs & Presentations: same folder browser as the compact
  // card, just unlimited and backed by the full allDocs list. Search
  // filters by course code/name and resets navigation back to the top.
  // The old standalone faculty-filter dropdown is superseded by the
  // course → faculty drill-down, so it's hidden rather than wired up.
  (function wirePdfViewAllModal() {
    const openBtn = document.getElementById("pdf-view-all");
    const modal = document.getElementById("pdf-viewall-modal");
    if (!openBtn || !modal) return;
    const closeBtn = document.getElementById("pdf-viewall-close");
    const searchInput = document.getElementById("pdf-viewall-search");
    const facultySelect = document.getElementById("pdf-viewall-faculty");
    if (facultySelect) facultySelect.closest(".form-field")?.classList.add("hidden");
    const listEl = document.getElementById("pdf-viewall-list");
    const modalState = { courseCode: null, faculty: null };

    function apply() {
      const term = (searchInput?.value || "").trim().toLowerCase();
      const items = term
        ? allDocs.filter(i =>
            (i.courseCode || "").toLowerCase().includes(term) ||
            (i.courseName || "").toLowerCase().includes(term)
          )
        : allDocs;
      renderPdfFolder(listEl, items, modalState);
    }

    openBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (searchInput) searchInput.value = "";
      modalState.courseCode = null;
      modalState.faculty = null;
      modal.classList.remove("hidden");
      apply();
    });
    if (closeBtn) closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    if (searchInput) searchInput.addEventListener("input", () => {
      modalState.courseCode = null;
      modalState.faculty = null;
      apply();
    });
  })();

  wireViewAllModal({
    openBtnId: "image-view-all", modalId: "image-viewall-modal", closeBtnId: "image-viewall-close",
    searchId: "image-viewall-search", facultyId: null,
    getItems: () => allImages,
    matchFn: (i, term) => (i.courseCode || "").toLowerCase().includes(term.toLowerCase()) || (i.courseName || "").toLowerCase().includes(term.toLowerCase()),
    renderList: (items) => {
      const grid = document.getElementById("image-viewall-grid");
      if (!items.length) {
        grid.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No matching images found.</p>`;
        return;
      }
      const checking = !window.__hnAccessKnown;
      grid.innerHTML = items.map(img => {
        const file = img.fileUrls[0];
        const viewHref = buildViewHref(file, img);
        const unlocked = checking ? false : (window.__hnIsFileUnlocked && window.__hnIsFileUnlocked(img.id));
        const locked = !checking && !unlocked;
        const tag = locked ? "div" : "a";
        return `
        <${tag} class="image-item${locked ? " image-locked" : ""}${checking ? " image-checking" : ""}"${locked ? ` data-locked-image="1" data-file-id="${esc(img.id)}"` : ` href="${viewHref}"`} style="text-decoration:none;">
          <div class="image-item-thumb">
            <img src="${encodeURI(file.url)}" alt="${esc(file.title || img.courseName)}" loading="lazy">
            <div class="status-badge">✓</div>
            <div class="view-overlay"><button type="button">${checking ? "⏳" : locked ? "🔒" : "View"}</button></div>
          </div>
          <div class="image-item-caption">
            <span class="image-item-code">${esc(img.courseCode)}</span>
            ${file.title ? `<span class="image-item-title">${esc(file.title)}</span>` : ""}
          </div>
        </${tag}>`;
      }).join("");
      grid.querySelectorAll("[data-locked-image]").forEach(el => {
        el.addEventListener("click", () => window.hnOpenGate && window.hnOpenGate(el.dataset.fileId));
      });
    }
  });
}

// ============================================
// UPLOAD ANOTHER FILE (slides-notes.html)
// Same look-and-feel as the Hand Notes unlock upload above (file type
// picker, image titles, progress ring) instead of the plain PDF-only form.
// If the course code already exists, the course name and faculty name(s)
// are offered as suggestions — the student can still type a different
// faculty/section for the same course code.
// ============================================
const anotherUploadBtn = document.getElementById("open-another-upload");
const anotherUploadModal = document.getElementById("another-upload-modal");
if (anotherUploadBtn && anotherUploadModal) {
  prefillFromSession("au-uploaderEmail");
  const auClose = document.getElementById("another-upload-close");
  const auForm = document.getElementById("another-upload-form");
  const auCourseCode = document.getElementById("au-courseCode");
  const auCourseName = document.getElementById("au-courseName");
  const auCourseNameHint = document.getElementById("au-courseName-hint");
  const auFacultyName = document.getElementById("au-facultyName");
  const auFacultySuggestions = document.getElementById("au-faculty-suggestions");
  const auFiles = document.getElementById("au-files");
  const auFilesLabel = document.getElementById("au-files-label");
  const auFilesPreview = document.getElementById("au-files-selected-preview");
  const auSubmit = document.getElementById("au-submit");
  const auStatus = document.getElementById("au-status");
  const auProgressWrap = document.getElementById("au-progress-wrap");
  const auProgressBar = document.getElementById("au-progress-ring-bar");
  const auProgressText = document.getElementById("au-progress-ring-text");
  const auImageTitlesWrap = document.getElementById("au-image-titles-wrap");
  const auImageTitlesList = document.getElementById("au-image-titles-list");
  const auSuccess = document.getElementById("au-success");
  const AU_CIRCUMFERENCE = 226.19;
  let auFileType = "pdf";
  let auNoteType = "hand_notes";
  let auMatchedCourse = null;

  document.querySelectorAll('input[name="au-noteType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      auNoteType = radio.value;
      wireNoteTypeVisual("au-noteType");
    });
  });

  const auFileTypeAccepts = {
    pdf: ".pdf,application/pdf",
    image: "image/*,.jpg,.jpeg,.png,.gif,.webp",
    ppt: ".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation"
  };

  function auResetForm() {
    auForm.reset();
    auForm.classList.remove("hidden");
    auSuccess.classList.add("hidden");
    auProgressWrap.classList.add("hidden");
    auStatus.textContent = "";
    auCourseNameHint.classList.add("hidden");
    auFacultySuggestions.innerHTML = "";
    auImageTitlesWrap.classList.add("hidden");
    auImageTitlesList.innerHTML = "";
    auMatchedCourse = null;
    auFileType = "pdf";
    auFiles.accept = auFileTypeAccepts.pdf;
    auFilesLabel.textContent = "PDF File(s) *";
    auFilesPreview.innerHTML = "";
    auFilesPreview.classList.add("hidden");
    const pdfRadio = document.querySelector('input[name="au-fileType"][value="pdf"]');
    if (pdfRadio) pdfRadio.checked = true;
    document.querySelectorAll('input[name="au-fileType"]').forEach(r => {
      r.closest("label").style.borderColor = r.checked ? "var(--leaf-500)" : "var(--line)";
      r.closest("label").style.background = r.checked ? "rgba(107, 155, 94, 0.05)" : "transparent";
    });
    auNoteType = "hand_notes";
    const handNotesRadio = document.querySelector('input[name="au-noteType"][value="hand_notes"]');
    if (handNotesRadio) handNotesRadio.checked = true;
    wireNoteTypeVisual("au-noteType");
    auSubmit.disabled = false;
    auSubmit.textContent = "Submit for Review";
  }

  anotherUploadBtn.addEventListener("click", () => {
    auResetForm();
    anotherUploadModal.classList.remove("hidden");
  });
  if (auClose) auClose.addEventListener("click", () => anotherUploadModal.classList.add("hidden"));
  anotherUploadModal.addEventListener("click", (e) => { if (e.target === anotherUploadModal) anotherUploadModal.classList.add("hidden"); });

  // Suggest course name + faculty names once the course code matches an existing one.
  auCourseCode.addEventListener("blur", async () => {
    const code = auCourseCode.value.trim().toUpperCase();
    auFacultySuggestions.innerHTML = "";
    auCourseNameHint.classList.add("hidden");
    if (!code) { auMatchedCourse = null; return; }
    try {
      const courseSnap = await getDoc(doc(db, "courses", code));
      if (courseSnap.exists()) {
        auMatchedCourse = courseSnap.data();
        if (!auCourseName.value.trim()) auCourseName.value = auMatchedCourse.courseName;
        auCourseNameHint.innerHTML = `Suggested from an existing course: <strong>${esc(auMatchedCourse.courseName)}</strong> — edit if this is different.`;
        auCourseNameHint.classList.remove("hidden");
      } else {
        auMatchedCourse = null;
      }
      // Existing faculty names for this course code, offered as suggestions
      // (a datalist) — the student can still type any other faculty/section.
      const q = query(collection(db, "resources"), where("courseCode", "==", code));
      const snap = await getDocs(q);
      const faculties = [...new Set(snap.docs.map(d => d.data().facultyName).filter(Boolean))];
      auFacultySuggestions.innerHTML = faculties.map(f => `<option value="${esc(f)}"></option>`).join("");
    } catch (err) { console.error("[Another Upload] course lookup failed:", err); }
  });

  function auCleanFileNameAsTitle(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }
  function renderAuImageTitleInputs() {
    if (auFileType !== "image" || !auFiles.files || auFiles.files.length === 0) {
      auImageTitlesWrap.classList.add("hidden");
      auImageTitlesList.innerHTML = "";
      return;
    }
    auImageTitlesList.innerHTML = Array.from(auFiles.files).map((f, i) => `
      <input type="text" class="au-image-title-input" data-index="${i}"
             placeholder="Title for: ${esc(f.name)}" value="${esc(auCleanFileNameAsTitle(f.name))}"
             style="width:100%;padding:.5rem .7rem;border:1px solid var(--line);border-radius:6px;font-size:.85rem;">
    `).join("");
    auImageTitlesWrap.classList.remove("hidden");
  }
  auFiles.addEventListener("change", renderAuImageTitleInputs);
  wireSelectedFilesPreview(auFiles, auFilesPreview);

  document.querySelectorAll('input[name="au-fileType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      auFileType = radio.value;
      auFiles.accept = auFileTypeAccepts[auFileType];
      const labels = {
        pdf: "PDF File(s) *",
        image: "Image File(s) * (JPG, PNG, GIF, WebP)",
        ppt: "Presentation File(s) * (PPT/PPTX)"
      };
      auFilesLabel.textContent = labels[auFileType];
      document.querySelectorAll('input[name="au-fileType"]').forEach(r => {
        r.closest("label").style.borderColor = r.checked ? "var(--leaf-500)" : "var(--line)";
        r.closest("label").style.background = r.checked ? "rgba(107, 155, 94, 0.05)" : "transparent";
      });
      renderAuImageTitleInputs();
    });
  });

  function auSetProgress(pct) {
    auProgressBar.style.strokeDashoffset = AU_CIRCUMFERENCE - (pct / 100) * AU_CIRCUMFERENCE;
    auProgressText.textContent = pct + "%";
  }
  function auShowStatus(msg, isError = false) {
    auProgressWrap.classList.remove("hidden");
    auStatus.textContent = msg;
    auStatus.style.color = isError ? "var(--terracotta-500)" : "var(--moss-600)";
  }

  auForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const courseCode = auCourseCode.value.trim().toUpperCase();
    const rawCourseName = auCourseName.value.trim();
    const facultyName = auFacultyName.value.trim();
    const uploaderEmail = normalizeEmail(document.getElementById("au-uploaderEmail").value);
    const files = Array.from(auFiles.files);

    const restriction = await window.__checkResourceRestriction(uploaderEmail);
    if (restriction !== 0) {
      const msg = restriction === -1
        ? "⚠️ We could not verify your upload status. Please try again."
        : "⚠️ Uploads are restricted for 30 days after a rejected file. Please wait until the restriction ends.";
      auShowStatus(msg, true);
      return;
    }

    if (files.length === 0) { auShowStatus(`Please choose at least one ${auFileType.toUpperCase()} file.`, true); return; }
    if (files.length > MAX_FILES) { auShowStatus(`Maximum ${MAX_FILES} files allowed.`, true); return; }
    const oversized = files.find(f => f.size > MAX_SIZE);
    if (oversized) { auShowStatus(`"${oversized.name}" is over 50MB.`, true); return; }

    let validationError = false;
    if (auFileType === "pdf") validationError = files.some(f => !f.name.toLowerCase().endsWith(".pdf"));
    else if (auFileType === "image") validationError = files.some(f => !["jpg","jpeg","png","gif","webp"].includes(f.name.toLowerCase().split(".").pop()));
    else if (auFileType === "ppt") validationError = files.some(f => !["ppt","pptx"].includes(f.name.toLowerCase().split(".").pop()));
    if (validationError) { auShowStatus(`Some files are not valid ${auFileType.toUpperCase()} files.`, true); return; }

    auSubmit.disabled = true;
    auSubmit.textContent = "Uploading…";
    auSetProgress(0);
    auShowStatus(`Uploading ${files.length} file(s)…`);

    try {
      const progressByFile = new Array(files.length).fill(0);
      const updateOverall = () => {
        const avg = Math.round(progressByFile.reduce((a, b) => a + b, 0) / files.length);
        auSetProgress(avg);
        auShowStatus(avg >= 100 ? "Processing on server…" : `Uploading ${files.length} file(s)…`);
      };
      const fileUrls = await Promise.all(
        files.map((file, i) => uploadFileToCloudinary(file, (pct) => { progressByFile[i] = pct; updateOverall(); }))
      );

      // Auto-rename duplicates
      for (let i = 0; i < fileUrls.length; i++) {
        const renamedName = await autoRenameIfDuplicate(fileUrls[i].name, courseCode, facultyName);
        fileUrls[i].name = renamedName;
      }

      if (auFileType === "image") {
        const titleInputs = auImageTitlesList.querySelectorAll(".au-image-title-input");
        fileUrls.forEach((f, i) => {
          const t = titleInputs[i] ? titleInputs[i].value.trim() : "";
          f.title = t || auCleanFileNameAsTitle(f.name);
        });
      }

      auShowStatus("Saving details…");
      auSetProgress(100);

      const finalCourseName = rawCourseName || (auMatchedCourse ? auMatchedCourse.courseName : "");
      const courseSnap = await getDoc(doc(db, "courses", courseCode));
      if (!courseSnap.exists()) {
        await setDoc(doc(db, "courses", courseCode), { courseCode, courseName: finalCourseName });
      }

      const auDocData = {
        courseCode, courseName: finalCourseName, facultyName,
        resourceType: "slides_notes", uploaderEmail, fileUrls, fileType: auFileType, noteType: auNoteType,
        status: "pending", submittedAt: serverTimestamp(), uploadedAt: Date.now()
      };
      const auUploaderStudentId = await lookupStudentIdByEmail(uploaderEmail);
      if (auUploaderStudentId) auDocData.uploaderStudentId = auUploaderStudentId;
      await addDoc(collection(db, "resources"), auDocData);

      auForm.classList.add("hidden");
      auProgressWrap.classList.add("hidden");
      auSuccess.classList.remove("hidden");
      auMatchedCourse = null;

      // Refresh whatever's currently on screen (three-card lists, status bar).
      (window.__onResourceAccessGranted || []).forEach(fn => fn());
    } catch (err) {
      console.error("[Another Upload] failed:", err);
      let userMessage = "Something went wrong. Please try again.";
      if (err.code === "permission-denied") userMessage = "Upload was rejected. Please check the details and try again.";
      else if (/network/i.test(err.message || "")) userMessage = "Network error. Check your connection and try again.";
      else if (/timed out/i.test(err.message || "")) userMessage = "Upload took too long. Try again with a smaller file.";
      auShowStatus(userMessage, true);
      auSubmit.disabled = false;
      auSubmit.textContent = "Submit for Review";
    }
  });
}

// ============================================
// SUGGESTIONS BROWSING (previous-questions.html)
// ============================================
const pqList = document.getElementById("pq-list");
const pqSearchBtn = document.getElementById("pq-search-btn");

// Guard: only run on previous-questions.html
if (pqList) {
  async function loadPQ() {
    const facultyFilter = document.getElementById("pq-faculty")?.value.trim() || "";
    const courseFilter = (document.getElementById("pq-course")?.value.trim() || "").toUpperCase();
    const examFilter = document.getElementById("pq-exam")?.value || "";

    try {
      // Two equality filters — still no composite index required.
      // status must be filtered in the query itself (see loadSlides note above).
      const q = query(
        collection(db, "resources"),
        where("resourceType", "==", "previous_questions"),
        where("status", "==", "approved")
      );
      const snap = await getDocs(q);
      let items = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      if (facultyFilter) items = items.filter(i => (i.facultyName || "").toLowerCase().includes(facultyFilter.toLowerCase()));
      if (courseFilter) items = items.filter(i => i.courseCode.includes(courseFilter));
      if (examFilter) items = items.filter(i => i.examType === examFilter);

      if (items.length === 0) {
        pqList.innerHTML = `<p style="color:var(--moss-600);font-family:var(--font-mono);font-size:.85rem;">No matching previous questions found yet.</p>`;
        return;
      }
      pqList.innerHTML = items.map(item => `
        <div class="seed-card" style="cursor:default;">
          <div class="tag-strip"><span class="tag-dot"></span><span class="tag">${esc(item.examType || "Question")}</span></div>
          <div class="card-body">
            <h3>${esc(item.courseCode)}</h3>
            <p style="font-size:.85rem;color:var(--moss-600);margin-bottom:.7rem;">${esc(item.facultyName || "")}</p>
            ${item.fileUrls.map(f => `<a href="${buildViewHref(f, item)}" class="view-link">View Question</a>`).join("<br>")}
          </div>
        </div>`).join("");
    } catch (err) {
      console.error("[PQ] loadPQ failed:", err);
      pqList.innerHTML = `<p style="color:var(--terracotta-500);font-family:var(--font-mono);font-size:.85rem;">Could not load questions. Please refresh and try again.</p>`;
    }
  }

  if (pqSearchBtn) pqSearchBtn.addEventListener("click", loadPQ);

  // Deep link support: previous-questions.html?course=CODE (from homepage
  // search) — pre-fills the course filter for once access is granted.
  const pqCourseParam = new URLSearchParams(location.search).get("course");
  const pqCourseInput = document.getElementById("pq-course");
  if (pqCourseParam && pqCourseInput) pqCourseInput.value = pqCourseParam.toUpperCase();

  // Runs once access is granted (see shared access gate above)
  window.__onResourceAccessGranted = window.__onResourceAccessGranted || [];
  window.__onResourceAccessGranted.push(loadPQ);
}
