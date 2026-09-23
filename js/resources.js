import { db, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, addDoc, serverTimestamp, query, where, getDocs, setDoc, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail, normalizeStudentId } from "./identity.js";
import { getSession } from "./session.js";
import { initEmailNotifications } from "./email-config.js";
import { computeResourceAccessStatus, computeFileAccessStatus, formatDate, formatRemaining, normalizeClassroomCode, isAuthenticClassroomCode, fileCount } from "./access.js";
import { computeCreditWallet } from "./credits.js";

initEmailNotifications();

const MAX_FILES = 20;
const MAX_SIZE = 50 * 1024 * 1024; // 50MB


function detectFileType(file) {
  const name = String(file?.name || "").toLowerCase();
  const mime = String(file?.type || "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name)) return "image";
  if (mime === "application/vnd.ms-powerpoint" || mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || /\.(ppt|pptx)$/i.test(name)) return "ppt";
  return "unknown";
}

function uploadFileToCloudinary(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.timeout = 300000; // 5 min — was 2 min, too short for large files on slower mobile connections
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
  // BUG FIX: this queried where("fac", "==", facultyName) — "fac" is not a
  // real field on any resource document (it's written as "facultyName"
  // everywhere else in this file). The typo meant this query always
  // matched zero documents, so auto-rename silently never triggered even
  // when a same-named file already existed for the course/faculty.
  const q = query(
    collection(db, "resources"),
    where("courseCode", "==", courseCode),
    where("facultyName", "==", facultyName),
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
    return { name: fileName, renamed: false }; // No conflict
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
  
  // Renamed (not just deduped) — the caller shows the user a "file already
  // exists" notice naming the original and the new name, instead of
  // silently swapping the filename with no explanation.
  return { name: newName, renamed: true, originalName: fileName };
}

// ============================================
// NOTE TYPE (Hand Notes / Class Slide / Others)
// A student-chosen category, separate from the file format (fileType:
// pdf/image/ppt). Shown with low visual prominence next to the course
// code/name in the document lists. Defaults to "class_slide" for any
// older docs that predate this field.
// ============================================
const NOTE_TYPE_LABELS = { hand_notes: "Hand Notes", class_slide: "Class Slide", others: "Others" };
function noteTypeLabel(item) {
  return NOTE_TYPE_LABELS[item.noteType] || NOTE_TYPE_LABELS.class_slide;
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

  let currentFileType = "auto";
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
    if (!fileInput.files || fileInput.files.length === 0 || !Array.from(fileInput.files).some(f => detectFileType(f) === "image")) {
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

  fileInput.accept = ".pdf,.ppt,.pptx,image/*";

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

    if (files.length === 0) { showError("Please choose at least one PDF, image, or presentation file."); return; }
    if (files.length > MAX_FILES) { showError(`Maximum ${MAX_FILES} files allowed.`); return; }
    const detectedTypes = files.map(detectFileType);
    if (detectedTypes.some(t => t === "unknown")) { showError("One or more files have an unsupported type. Please use PDF, PPT/PPTX, JPG, PNG, GIF, WebP, or another standard image file."); return; }
    if (new Set(detectedTypes).size > 1) { showError("Please select files of a single type only — all PDF, all images, or all presentations, not a mix."); return; }
    currentFileType = detectedTypes[0];

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
      fileUrls.forEach((f, i) => { f.fileType = detectedTypes[i]; });

      // Auto-rename duplicates — and tell the user it happened, instead of
      // silently swapping in a different filename than what they picked.
      const duplicateNotices = [];
      for (let i = 0; i < fileUrls.length; i++) {
        const renameResult = await autoRenameIfDuplicate(fileUrls[i].name, finalCourseCode, facultyName);
        if (renameResult.renamed) {
          duplicateNotices.push(`"${renameResult.originalName}" already exists for this course — saved as "${renameResult.name}".`);
        }
        fileUrls[i].name = renameResult.name;
      }

      if (detectedTypes.some(t => t === "image") && imageTitlesListEl) {
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
      const dupNoticeEl = document.getElementById("upload-duplicate-notice");
      if (dupNoticeEl) {
        if (duplicateNotices.length) {
          dupNoticeEl.textContent = "⚠️ " + duplicateNotices.join(" ");
          dupNoticeEl.classList.remove("hidden");
        } else {
          dupNoticeEl.classList.add("hidden");
        }
      }
      successBox.classList.remove("hidden");
      matchedCourse = null;
      courseNameInput.readOnly = false;
      if (courseNameHint) courseNameHint.classList.add("hidden");
      if (imageTitlesWrap) imageTitlesWrap.classList.add("hidden");
    } catch (err) {
      console.error("[Upload] failed:", err);
      let userMessage = "Something went wrong: " + (err && err.message ? err.message : "please try again.");
      if (err.code === "permission-denied") {
        userMessage = "Upload was rejected (" + (err.message || "permission denied") + "). Please check the course code and file(s), then try again.";
      } else if (/network/i.test(err.message || "")) {
        userMessage = "Network error: " + err.message + ". Check your connection and try again.";
      } else if (/timed out/i.test(err.message || "")) {
        userMessage = err.message + " Try again with a smaller file.";
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

  async function createFileCreditUnlock({ email, name, targetFileId, sourceResourceId, category, durationMs, source = "credit" }) {
    if (!targetFileId) throw new Error("A specific file must be selected before unlocking.");
    return addDoc(collection(db, "fileUnlocks"), {
      kind: "file_unlock",
      fromEmail: normalizeEmail(email),
      fromName: name || "",
      targetFileId,
      sourceResourceId: sourceResourceId || source,
      category: category || "hand_notes",
      durationMs: Number(durationMs) || (6 * 60 * 60 * 1000),
      source,
      unlockedAt: serverTimestamp(),
      submittedAt: serverTimestamp(),
      revoked: false
    });
  }

  window.__tryUseResourceCredit = async function(fileId, category = "hand_notes") {
    const session = getSession();
    if (!session || !fileId) return false;
    const email = normalizeEmail(session.email);
    window.__resourceCreditUnlockError = null;
    try {
      // Never spend a credit on the student's own file. Ownership is permanent.
      const ownerEmail = window.__hnFileOwners?.[fileId];
      if (ownerEmail && ownerEmail === email) return true;

      const remaining = await hnGetRemainingCredits();
      if (remaining < 1) return false;

      // BUG FIX — "can't re-unlock a file once it relocks": this used to
      // check for ANY non-revoked file_unlock record ever made for this
      // file, even one whose 36h window had already run out. That meant
      // once a student unlocked a file, clicking "Unlock" again after it
      // relocked found that old expired record, returned true (as if it
      // were still open) and never created a new grant or spent a fresh
      // credit — so the file stayed locked forever after its first use.
      // Now we only skip re-unlocking when an existing grant for this file
      // is STILL active; once it has expired, the flow below runs again
      // exactly like the first time, spending a new credit for a new
      // window.
      const items = window.__hnAccessItems || [];
      const stillActive = computeFileAccessStatus(items, fileId, Date.now(), category, window.__hnGlobalLockAt || 0)
        .breakdown.some(b => b.kind === "file_unlock" && b.active && b.item?.targetFileId === fileId);
      if (stillActive) return true;

      const created = await createFileCreditUnlock({
        email, name: session.fullName, targetFileId: fileId,
        sourceResourceId: "credit-wallet", category,
        durationMs: 36 * 60 * 60 * 1000, source: "credit"
      });
      if (!created?.id) return false;
      window.__resourceCreditRemaining = Math.max(0, remaining - 1);
      await hnRefreshAccess(email);
      const unlocked = computeFileAccessStatus(window.__hnAccessItems || [], fileId, Date.now(), category, window.__hnGlobalLockAt || 0).active;
      return !!unlocked;
    } catch (err) {
      console.error("[Resource Credit] credit unlock failed:", err);
      window.__resourceCreditUnlockError = err;
      return false;
    }
  };

  window.__tryUseHandNoteCredit = window.__tryUseResourceCredit;

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
  let currentFileType = "auto";
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
  const hnStepCoffee = document.getElementById("hn-gate-step-coffee");
  const hnAllSteps = [hnStepLogin, hnStepChoice, hnStepNotes, hnStepClassroom, hnStepCoffee, hnStepAd];

  function hnShowStep(step) {
    hnAllSteps.forEach(s => s?.classList.toggle("hidden", s !== step));
    // Notes/Classroom/Coffee each carry their own inline "back to choice"
    // button (#hn-notes-back etc.) inside the step itself. The top-right
    // hnGateBackBtn is a DIFFERENT action — it exits the whole gate back to
    // the blurred file preview — but visually they're both circular ✕
    // buttons in the same corner, so showing both at once renders as a
    // confusing double-✕ overlap. Hide the top-right one for exactly the
    // steps that already have their own back control.
    const stepHasOwnBackBtn = step === hnStepNotes || step === hnStepClassroom || step === hnStepCoffee;
    hnGateBackBtn?.classList.toggle("hidden", stepHasOwnBackBtn);
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

  // Calculate the live credit balance used by the per-file unlock chooser.
  // Registration credits are an entitlement, so older registration documents
  // without registrationCredits still receive the original 5 free credits.
  async function hnGetRemainingCredits() {
    const session = getSession();
    if (!session) return 0;
    const email = normalizeEmail(session.email);
    try {
      const items = window.__hnAccessItems || [];
      let registrationCredits = 5;
      // creditDebt is the legacy one-off penalty (kept for accounts
      // restricted before creditsResetAt existed); creditsResetAt is the
      // current restriction penalty — being restricted even once resets
      // the whole wallet, so every earn/spend item dated at or before
      // that stamp gets excluded down in computeCreditWallet.
      // accountRestrictedAt is a further fallback for an
      // already-restricted account that predates creditsResetAt
      // entirely. js/credits.js decides which one actually applies.
      let creditDebt = 0;
      let creditsResetAt = null;
      let accountRestrictedAt = null;
      try {
        const regSnap = await getDocs(query(collection(db, "registrations"), where("email", "==", email)));
        if (!regSnap.empty) {
          registrationCredits = Math.max(5, Number(regSnap.docs[0].data().registrationCredits || 0));
          creditDebt = Number(regSnap.docs[0].data().creditDebt || 0);
          creditsResetAt = regSnap.docs[0].data().creditsResetAt || null;
          accountRestrictedAt = regSnap.docs[0].data().accountRestrictedAt || null;
        } else {
          const legacy = await getDocs(query(collection(db, "registrations"), where("emailNormalized", "==", email)));
          if (!legacy.empty) {
            registrationCredits = Math.max(5, Number(legacy.docs[0].data().registrationCredits || 0));
            creditDebt = Number(legacy.docs[0].data().creditDebt || 0);
            creditsResetAt = legacy.docs[0].data().creditsResetAt || null;
            accountRestrictedAt = legacy.docs[0].data().accountRestrictedAt || null;
          }
        }
      } catch (_) { /* retain the guaranteed 5-credit entitlement */ }
      // Resource docs (Hand Notes / Class Slides / Images uploads) are never
      // tagged kind:"resource" in this in-memory list (see
      // getResourceAccessState() below — they come straight off the
      // "resources" collection), so a real resource doc is identified by
      // its resourceType field instead, not by i.kind.
      //
      // The actual earn/spend math now lives in one place — js/credits.js
      // computeCreditWallet() — shared with js/profile.js and js/admin.js,
      // so this page can never again show a different balance than the
      // profile page does. This function's own job is just to classify
      // the already-fetched, already-cached items into the shapes that
      // shared formula expects.
      const resourceItems = items.filter(i => !i.kind && i.resourceType && normalizeEmail(i.uploaderEmail) === email);
      const classroomItems = items.filter(i => i.kind === "classroom");
      const manualItems = items.filter(i => i.kind === "manual");
      const fileUnlockItems = items.filter(i => i.kind === "file_unlock");
      const wallet = computeCreditWallet({
        resourceItems, classroomItems, manualItems, fileUnlockItems,
        registrationCredits, creditDebt, creditsResetAt, accountRestrictedAt
      });
      return wallet.creditsRemaining;
    } catch (err) {
      console.warn("[Resource Credit] balance check failed:", err);
      return 0;
    }
  }

  async function hnRefreshCreditChoice() {
    const countEl = document.getElementById("hn-choice-credit-count");
    const btn = document.getElementById("hn-use-credit-btn");
    const copy = document.getElementById("hn-choice-credit-copy");
    const earnTitle = document.getElementById("hn-earn-credit-title");
    if (!countEl || !btn) return 0;
    countEl.textContent = "…";
    btn.disabled = true;
    const remaining = await hnGetRemainingCredits();
    window.__resourceCreditRemaining = remaining;
    countEl.textContent = String(remaining);
    btn.disabled = remaining < 1 || !hnGateTargetId;
    copy && (copy.textContent = remaining > 0 ? "1 credit unlocks this file instantly. Your balance will decrease by 1." : "You have no credits available right now. Earn a new credit below to unlock this file.");
    btn.textContent = remaining > 0 ? `⚡ Unlock with remaining credit · ${remaining} available` : "⚡ No credits available";
    if (earnTitle) earnTitle.textContent = remaining > 0 ? "Earn more credit to unlock" : "Earn new credit to unlock";
    return remaining;
  }

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

  window.hnOpenGate = function (fileId, folderKey = null, category = "hand_notes") {
    // BUG FIX — "Unlock tapped from See All shows nothing until the ✕ is
    // tapped": the gate section is inline (position:static) in the page,
    // but "See All" (pdf-viewall-modal / image-viewall-modal) is a
    // fullscreen fixed overlay on top of it. Opening the gate while one of
    // those overlays is still open just un-hides it behind that overlay —
    // closing the overlay is what makes it visible. Close both "See All"
    // overlays here so the gate is visible immediately, from any entry point.
    document.getElementById("pdf-viewall-modal")?.classList.add("hidden");
    document.getElementById("image-viewall-modal")?.classList.add("hidden");

    hnGateTargetId = fileId || null;
    // Folder-wide unlocks are intentionally retired from the user-facing
    // resource flow. Every click targets exactly one file.
    window.__hnGateFolderKey = null;
    window.__hnGateCategory = category || "hand_notes";
    const returnHash = hnGateTargetId ? `unlock=${encodeURIComponent(hnGateTargetId)}&category=${encodeURIComponent(window.__hnGateCategory)}` : "unlock";
    if (hnLoginLink) hnLoginLink.href = `login.html?return=${encodeURIComponent(`slides-notes.html#${returnHash}`)}`;
    if (hnRegisterLink) hnRegisterLink.href = `register.html?return=${encodeURIComponent(`slides-notes.html#${returnHash}`)}`;
    handNotesGate.classList.remove("hidden");
    hnEnterFormOnly(true);
    hnShowStep(getSession() ? hnStepChoice : hnStepLogin);
    if (getSession()) hnRefreshCreditChoice();
    handNotesGate.scrollIntoView({ behavior: "smooth" });
  };

  // If we were sent back here after login/registration (?return=...#unlock
  // or ...#unlock=<fileId>), pick straight back up at the unlock flow
  // instead of making the person click "Unlock Access" again — and, if a
  // file id rode along in the hash, restore it so the submission they're
  // about to make only unlocks that one file.
  if (window.location.hash.startsWith("#unlock")) {
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.hnOpenGate(params.get("unlock"), params.get("folder"), params.get("category") || "hand_notes");
  }

  hnGateBackBtn?.addEventListener("click", hnExitFormOnly);
  document.getElementById("hn-use-credit-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("hn-use-credit-btn");
    const countEl = document.getElementById("hn-choice-credit-count");
    if (!hnGateTargetId || btn?.disabled) return;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    try {
      const used = await window.__tryUseResourceCredit?.(hnGateTargetId, window.__hnGateCategory || "hand_notes");
      if (used) {
        const remaining = Number(window.__resourceCreditRemaining ?? 0);
        if (countEl) countEl.textContent = String(remaining);
        btn.textContent = `✓ Unlocked · ${remaining} credit${remaining === 1 ? "" : "s"} left`;
        btn.classList.add("credit-unlock-success");
        setTimeout(() => {
          btn.classList.remove("credit-unlock-success");
          hnExitFormOnly();
          hnRefreshAccess(normalizeEmail(getSession()?.email || ""));
        }, 700);
        return;
      }
      await hnRefreshCreditChoice();
    } catch (err) {
      console.error("[Resource Credit] chooser unlock failed:", err);
      await hnRefreshCreditChoice();
    }
  });
  document.getElementById("hn-choose-notes")?.addEventListener("click", () => hnShowStep(hnStepNotes));
  document.getElementById("hn-choose-classroom")?.addEventListener("click", () => hnShowStep(hnStepClassroom));
  document.getElementById("hn-choose-coffee")?.addEventListener("click", () => {
    const session = getSession();
    if (!session) { hnShowStep(hnStepLogin); return; }
    hnCoffeeForm?.classList.remove("hidden");
    hnCoffeeSuccess?.classList.add("hidden");
    hnCoffeeForm?.reset();
    hnShowStep(hnStepCoffee);
  });
  document.getElementById("hn-coffee-back")?.addEventListener("click", () => hnShowStep(hnStepChoice));
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
  // BUY ME A COFFEE — payment proof request
  // ============================================
  document.getElementById("hn-coffee-copy")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText("01753486065");
      const old = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1600);
    } catch (_) {
      alert("bKash number: 01753486065");
    }
  });

  const hnCoffeeForm = document.getElementById("hn-coffee-form");
  const hnCoffeeSuccess = document.getElementById("hn-coffee-success");
  const hnCoffeeSuccessClose = document.getElementById("hn-coffee-success-close");
  hnCoffeeForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const session = getSession(); if (!session) { hnShowStep(hnStepLogin); return; }
    const senderNumber = document.getElementById("hn-coffee-sender")?.value.trim();
    const transactionId = document.getElementById("hn-coffee-txid")?.value.trim();
    const amount = Number(document.getElementById("hn-coffee-amount")?.value);
    const errEl = document.getElementById("hn-coffee-error"); const btn=document.getElementById("hn-coffee-submit");
    if (!senderNumber || !transactionId || !Number.isFinite(amount) || amount <= 0) { errEl.textContent="Please enter your bKash number, transaction ID and amount."; errEl.classList.remove("hidden"); return; }
    btn.disabled=true; btn.textContent="Submitting…"; errEl.classList.add("hidden");
    try {
      await addDoc(collection(db,"coffeeRequests"), { fromEmail:normalizeEmail(session.email), fromName:session.fullName || "", senderNumber, transactionId, amount, targetFileId:window.__hnGateFolderKey || hnGateTargetId || "", category:window.__hnGateCategory || "hand_notes", status:"pending", submittedAt:serverTimestamp() });
      // Show a real confirmation screen (matching the Classroom/Ad flows)
      // instead of just flipping the submit button's own label, which was
      // easy to miss and looked like nothing had happened.
      hnCoffeeForm.classList.add("hidden");
      hnCoffeeSuccess?.classList.remove("hidden");
      btn.disabled=false; btn.textContent="☕ Submit Coffee Support";
    } catch(err) { errEl.textContent="Could not submit your request. Please try again."; errEl.classList.remove("hidden"); btn.disabled=false; btn.textContent="☕ Submit Coffee Support"; }
  });
  hnCoffeeSuccessClose?.addEventListener("click", () => { window.location.href = "blog.html"; });

  // ============================================
  // UNLOCK WITH GOOGLE CLASSROOM — same duplicate-code rule as the
  // resources.html "Send Us Classroom Code" form: a code already on file
  // can't be reused. Unlike an upload, a classroom code grants NO access
  // until an admin reviews and confirms it in the admin panel (see
  // js/access.js) — then it unlocks the ONE file this gate was opened
  // for, for 36 hours from the moment it's approved.
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
          category: window.__hnGateCategory || "hand_notes",
          unlockScope: "file",
          courseCode: "",
          facultyName: "",
          status: "new",
          creditsGranted: 0,
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
  // js/access.js grants that file 36h of access immediately (see its
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

    const [resourcesSnap, classroomSnap, adSnap, manualSnap, fileUnlockSnap, folderUnlockSnap, lockSnap] = await Promise.all([
      getDocs(query(collection(db, "resources"), where("uploaderEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "adUnlocks"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "manualUnlocks"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "fileUnlocks"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "folderUnlocks"), where("fromEmail", "==", normalizedEmail))),
      getDocs(query(collection(db, "resourceLocks"), where("__name__", "==", "global"))).catch(() => ({ docs: [] }))
    ]);
    window.__hnGlobalLockAt = lockSnap.docs[0]?.data()?.lockedAt?.toDate?.()?.getTime?.() || Number(lockSnap.docs[0]?.data()?.lockedAt) || 0;
    const docs = resourcesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Classroom codes keep their real status ("new"/"contacted"/"approved")
    // from Firestore — js/access.js only grants access once that status is
    // "approved" by an admin.
    const classroomDocs = classroomSnap.docs.map(d => ({ id: d.id, kind: "classroom", ...d.data() }));
    // Ad unlocks are already "kind: ad" in Firestore and grant access the
    // instant they're written — see js/access.js's `item?.kind === "ad"` branch.
    const adDocs = adSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Manual grants from the admin panel — see js/access.js's `item?.kind === "manual"` branch.
    const manualDocs = manualSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const fileUnlockDocs = fileUnlockSnap.docs.map(d => ({ id:d.id, ...d.data() }));
    const folderUnlockDocs = folderUnlockSnap.docs.map(d => ({ id:d.id, ...d.data() }));
    const items = [...docs, ...classroomDocs, ...adDocs, ...manualDocs, ...fileUnlockDocs, ...folderUnlockDocs];
    window.__hnAccessItems = items;
    return computeResourceAccessStatus(items);
  }

  // Whether ONE specific file is currently unlocked for this student.
  // Returns null while the very first access check hasn't resolved yet
  // (see window.__hnAccessKnown), so callers can show a neutral
  // "checking…" state instead of a false 🔒. `category` — one of
  // "hand_notes" | "class_slides" | "images" — lets a category-scoped
  // Manual Unlock grant apply to only that section; omit it and any
  // grant (scoped or not) counts.
  window.__hnIsFileUnlocked = function (fileId, category, ownerEmail = "") {
    if (!window.__hnAccessKnown) return null;
    const sessionEmail = normalizeEmail(getSession()?.email || "");
    if (ownerEmail && sessionEmail && normalizeEmail(ownerEmail) === sessionEmail) return true;
    return computeFileAccessStatus(window.__hnAccessItems || [], fileId, Date.now(), category, window.__hnGlobalLockAt || 0).active;
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
  // completed at least once, so the file lists can keep the file state silent until the access check completes.
  // ------------------------------------------------------------------
  window.__hnAccessKnown = false;

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
        <strong>🔓 ${unlockedFileCount} UNLOCK${unlockedFileCount === 1 ? "" : "S"} ACTIVE</strong>
        <div class="file-info">Each Hand Note you unlock (by uploading, or a classroom code once an admin confirms it) stays open on its own. Class Lecture Slides work by course instead — unlocking any one slide unlocks every slide in that course's folder.</div>
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
      <div class="file-info">Browse folders freely — for Hand Notes, click 🔒 Unlock on any file to unlock just that one. For Class Lecture Slides, unlocking any one slide unlocks that whole course's folder.</div>
      <div class="file-info">Uploading a file gives that file <strong>36 hours</strong> of access right away. A classroom code gives that file <strong>36 hours</strong> — but only once an admin has reviewed and confirmed it.</div>
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
      // Never expose an internal connectivity state in the file rows. The
      // list simply remains in its last known state and the next refresh
      // retries silently in the background.
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
  const imageTitlesWrap = document.getElementById("hn-images-titles-wrap");
  const imageTitlesList = document.getElementById("hn-images-titles-list");

  function cleanFileNameAsTitle(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  }

  function renderImageTitleInputs() {
    if (!imageTitlesWrap || !imageTitlesList) return;
    if (!hnFiles.files || hnFiles.files.length === 0 || !Array.from(hnFiles.files).some(f => detectFileType(f) === "image")) {
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

  hnFiles.accept = ".pdf,.ppt,.pptx,image/*";

  if (hnForm) {
    hnForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const courseCode = document.getElementById("hn-courseCode").value.trim().toUpperCase();
      const courseName = document.getElementById("hn-courseName").value.trim();
      const facultyName = document.getElementById("hn-facultyName").value.trim();
      const uploaderEmail = normalizeEmail(document.getElementById("hn-uploaderEmail").value);
      const files = Array.from(hnFiles.files);

      if (files.length === 0) { 
        hnShowStatus("Please choose at least one PDF, image, or presentation file.", true); 
        return; 
      }
      if (files.length > MAX_FILES) { 
        hnShowStatus(`Maximum ${MAX_FILES} files allowed.`, true); 
        return; 
      }
      const detectedTypes = files.map(detectFileType);
      if (detectedTypes.some(t => t === "unknown")) {
        hnShowStatus("One or more files have an unsupported type. Please use PDF, PPT/PPTX, JPG, PNG, GIF, or WebP.", true);
        return;
      }
      if (new Set(detectedTypes).size > 1) {
        hnShowStatus("Please select files of a single type only — all PDF, all images, or all presentations, not a mix.", true);
        return;
      }
      currentFileType = detectedTypes[0];

      const oversized = files.find(f => f.size > MAX_SIZE);
      if (oversized) { 
        hnShowStatus(`"${oversized.name}" is over 50MB.`, true); 
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

        // Auto-rename duplicates — and tell the user it happened.
        const hnDuplicateNotices = [];
        for (let i = 0; i < fileUrls.length; i++) {
          const renameResult = await autoRenameIfDuplicate(fileUrls[i].name, courseCode, facultyName);
          if (renameResult.renamed) {
            hnDuplicateNotices.push(`"${renameResult.originalName}" already exists for this course — saved as "${renameResult.name}".`);
          }
          fileUrls[i].name = renameResult.name;
        }
        fileUrls.forEach((f, i) => { f.fileType = detectedTypes[i]; });

        // Attach the per-image title captured at upload time (if any),
        // so the gallery and viewer can display it under the image.
        if (detectedTypes.some(t => t === "image") && imageTitlesList) {
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
          status: "pending", submittedAt: serverTimestamp(), uploadedAt: Date.now(),
          unlockMode: hnNoteType === "hand_notes" ? "file_credit" : "folder_lifetime"
        };
        const hnUploaderStudentId = await lookupStudentIdByEmail(uploaderEmail);
        if (hnUploaderStudentId) hnDocData.uploaderStudentId = hnUploaderStudentId;
        const resourceRef = await addDoc(collection(db, "resources"), hnDocData);
        const uploadedFileIds = fileUrls.map((_, i) => `hand_notes::${courseCode}::${facultyName}::${resourceRef.id}::${i}`);
        const isHandNotes = hnNoteType === "hand_notes";
        const category = isHandNotes ? "hand_notes" : (currentFileType === "image" ? "images" : "class_slides");
        // The contributor owns every file they uploaded permanently. If this
        // upload was made from an Unlock gate, it also grants the selected
        // other-user file 6 hours of access; no folder-wide unlock is created.
        if (hnGateTargetId) {
          await createFileCreditUnlock({
            email:uploaderEmail, name:getSession()?.fullName, targetFileId:hnGateTargetId,
            sourceResourceId:resourceRef.id, category: window.__hnGateCategory || category, durationMs:6*60*60*1000, source:"notes_earn"
          });
        }

        hnShowStatus("✅ Submitted! Unlocking…");
        setTimeout(() => {
          hnRefreshAccess(uploaderEmail);
          hnForm.classList.add("hidden");
          const successBoxEl = document.getElementById("hn-notes-success");
          const titleEl = document.getElementById("hn-notes-success-title");
          const detailEl = document.getElementById("hn-notes-success-detail");
          if (titleEl) titleEl.textContent = hnGateTargetId ? "🔓 Selected file unlocked for 6 hours" : "✅ Upload received — credits added";
          if (detailEl) detailEl.textContent = hnNoteType === "hand_notes"
            ? (files.length > 1 ? `The selected file is available for 6 hours. Your ${files.length} uploaded file${files.length === 1 ? "" : "s"} also added ${files.length} credit${files.length === 1 ? "" : "s"} to your wallet.` : "The selected file is available for 6 hours. Each uploaded file also adds 1 credit to your wallet.")
            : `Each uploaded file added 1 credit. Your own uploaded files are permanently available to you.`;
          const hnDupNoticeEl = document.getElementById("hn-duplicate-notice");
          if (hnDupNoticeEl) {
            if (hnDuplicateNotices.length) {
              hnDupNoticeEl.textContent = "⚠️ " + hnDuplicateNotices.join(" ");
              hnDupNoticeEl.classList.remove("hidden");
            } else {
              hnDupNoticeEl.classList.add("hidden");
            }
          }
          if (successBoxEl && hnNoteType === "hand_notes" && files.length > 1) {
            let credits = successBoxEl.querySelector("#hn-extra-credit-list");
            if (!credits) { credits = document.createElement("div"); credits.id="hn-extra-credit-list"; credits.style.cssText="margin-top:1rem;display:grid;gap:.5rem;"; successBoxEl.appendChild(credits); }
            credits.innerHTML = files.slice(1).map((f, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.55rem .7rem;border:1px solid var(--line);border-radius:9px;background:#fff;"><span style="font-size:.82rem;">Unlock credit ${i+2}</span><span style="font-size:.75rem;color:var(--moss-600);">Ready — click a locked file to use</span></div>`).join("");
          }
          successBoxEl?.classList.remove("hidden");
        }, 700);
      } catch (err) {
        console.error("[Hand Notes Unlock] failed:", err);
        let userMessage = "Something went wrong: " + (err && err.message ? err.message : "please try again.");
        if (err.code === "permission-denied") {
          userMessage = "Upload was rejected (" + (err.message || "permission denied") + "). Please check the details and try again.";
        } else if (/network/i.test(err.message || "")) {
          userMessage = "Network error: " + err.message + ". Check your connection and try again.";
        } else if (/timed out/i.test(err.message || "")) {
          userMessage = err.message + " Try again with a smaller file.";
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
// Cards: 📝 Hand Notes | 🖥️ Class Lecture Slides | 🖼️ Images
// The two document cards share one folder browser and one "View All"
// modal; they differ only in which slice of the resources they show:
//   noteType === "hand_notes"  → Hand Notes
//   anything else (incl. old files with no noteType) → Class Lecture Slides
// ============================================
const handnotesList = document.getElementById("handnotes-list");
const handnotesSearch = document.getElementById("handnotes-search");
const slidesList = document.getElementById("slides-list");
const slidesSearch = document.getElementById("slides-search");
const imageGrid = document.getElementById("image-grid");
const imageSearch = document.getElementById("image-search");

if (handnotesList || slidesList || imageGrid) {
  let allHandNotes = [];  // 📝 hand notes (PDF/PPT)
  let allSlides = [];     // 🖥️ class lecture slides (PDF/PPT)
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

      // Classify by each file when available. This also supports a batch
      // containing more than one format without needing a manual file-type
      // selector. Older records continue to use their document-level type.
      const hasType = (r, type) => r.fileType === type || (Array.isArray(r.fileUrls) && r.fileUrls.some(f => (f.fileType || detectFileType({name:f.name || ""})) === type));
      const docs = resources.filter(r => hasType(r, "pdf") || hasType(r, "ppt") || (!r.fileType && !hasType(r, "image")));
      allHandNotes = docs.filter(r => r.noteType === "hand_notes");
      allSlides = docs.filter(r => r.noteType !== "hand_notes");
      allImages = resources.filter(r => hasType(r, "image"));

      handNotesCard.render();
      slidesCard.render();
      renderImageCard();
    } catch (err) {
      console.error("[Three Card Layout] load failed:", err);
    }
  }

  function docIcon(item, file = null) {
    const type = file?.fileType || item.fileType || detectFileType({ name: file?.name || "" });
    return type === "ppt" ? "📊" : type === "image" ? "🖼️" : "📄";
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
  // DOCUMENT FOLDER BROWSER
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
  //
  // `opts.lockScope` controls how a locked file's unlock-check key is
  // built at level 3:
  //   "file"   (default, used by Hand Notes) — every file gets its own
  //            id (`${item.id}::${idx}`), so unlocking one file never
  //            unlocks any other file in that course.
  //   "folder" (used by Class Lecture Slides) — every file in the SAME
  //            course code shares one key (`course::<courseCode>`), so
  //            unlocking (uploading/classroom code/ad) against ANY slide
  //            in that course unlocks every slide in that course's
  //            folder at once, and stays unlocked as one unit.
  // ============================================
  function renderPdfFolder(container, items, state, opts = {}) {
    if (!container) return;
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
    const fileRows = [];
    const lockScope = "file";
    window.__hnFileOwners = window.__hnFileOwners || {};
    facultyItems.forEach(item => {
      (item.fileUrls || []).forEach((file, idx) => {
        const detected = file.fileType || item.fileType || detectFileType({name:file.name || ""});
        if (opts.category === "hand_notes" || opts.category === "class_slides") {
          if (detected === "image") return;
        }
        // Each file normally gets its OWN id (a submission doc can bundle
        // several files, so the doc id alone isn't unique per file) and is
        // unlocked independently of every other file — see hnOpenGate.
        // Every file uses its own key, including Class Lecture Slides and Images.
        // Unlocking one file never unlocks another file.
        const fileId = `hand_notes::${state.courseCode}::${state.faculty || ""}::${item.id}::${idx}`;
        window.__hnFileOwners[fileId] = normalizeEmail(item.uploaderEmail || "");
        const unlocked = !!(window.__hnIsFileUnlocked && window.__hnIsFileUnlocked(fileId, opts.category, item.uploaderEmail));
        const locked = !unlocked;
        fileRows.push(`
          <div class="file-item${locked ? " file-locked" : ""}" ${locked ? `data-locked-file="1" data-file-id="${esc(fileId)}" data-folder-key="${esc(fileId)}" data-category="${esc(opts.category || "hand_notes")}"` : ""}>
            <span class="file-status">${docIcon(item, file)}</span>
            <span class="file-name">${esc(fileDisplayName(file))} <span class="note-type-tag">${esc(noteTypeLabel(item))}</span></span>
            ${locked
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
      el.addEventListener("click", async () => {
        if (el.dataset.unlockBusy === "1") return;
        const category = el.dataset.category || "hand_notes";
        const fileId = el.dataset.fileId;
        el.dataset.unlockBusy = "1";

        // Opening Unlock always shows the chooser first. The user decides
        // whether to spend one credit or use one of the three earning methods.
        window.hnOpenGate && window.hnOpenGate(fileId, el.dataset.folderKey, category);
        el.dataset.unlockBusy = "0";
        return;

      });
    });
  }

  // ============================================
  // DOCUMENT CARD (used twice: Hand Notes + Class Lecture Slides)
  // Each card keeps its OWN drill-down state, its own search box and its
  // own "View All" link, but they share renderPdfFolder above.
  // ============================================
  function createDocCard({ listEl, searchEl, countId, viewAllId, getItems, lockScope, category }) {
    const state = { courseCode: null, faculty: null };
    let searchWired = false;
    let loadedOnce = false;

    function filtered() {
      const items = getItems();
      const term = (searchEl?.value || "").trim().toLowerCase();
      if (!term) return items;
      return items.filter(i =>
        (i.courseCode || "").toLowerCase().includes(term) ||
        (i.courseName || "").toLowerCase().includes(term)
      );
    }

    function renderList(items, resetNav) {
      if (resetNav) { state.courseCode = null; state.faculty = null; }
      renderPdfFolder(listEl, items, state, {
        limitTopLevel: 6,
        lockScope,
        category,
        onTopLevelCount: (total, shown) => {
          const link = document.getElementById(viewAllId);
          if (link) link.style.display = total > shown ? "block" : "none";
        }
      });
    }

    function render() {
      const items = getItems();
      const countEl = document.getElementById(countId);
      if (countEl) countEl.textContent = `(${items.length})`;
      if (!listEl) return;

      const viewAllLink = document.getElementById(viewAllId);
      if (items.length === 0) {
        listEl.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;">No files yet.</p>`;
        if (searchEl) searchEl.style.display = "none";
        if (viewAllLink) viewAllLink.style.display = "none";
        return;
      }

      // loadThreeCardLayout() reruns in the background (the 15s access
      // poll, or right after an access-state change) purely to refresh
      // lock badges/counts — it isn't a fresh page visit. Only reset the
      // folder drill-down on the very FIRST render, so later automatic
      // reruns keep the student exactly where they were browsing.
      const resetNav = !loadedOnce;
      loadedOnce = true;

      if (searchEl) {
        searchEl.style.display = "block";
        if (!searchWired) {
          searchWired = true;
          // A new search term always starts back at the top level.
          searchEl.addEventListener("input", () => renderList(filtered(), true));
        }
      }
      renderList(filtered(), resetNav);
    }

    return { render };
  }

  const handNotesCard = createDocCard({
    listEl: handnotesList, searchEl: handnotesSearch,
    countId: "handnotes-count", viewAllId: "handnotes-view-all",
    getItems: () => allHandNotes,
    category: "hand_notes"
  });

  const slidesCard = createDocCard({
    listEl: slidesList, searchEl: slidesSearch,
    countId: "slides-count", viewAllId: "slides-view-all",
    getItems: () => allSlides,
    lockScope: "file",
    category: "class_slides"
  });

  let imageSearchWired = false;
  let imageCardLoadedOnce = false;
  const imageCardState = { courseCode: null };

  // Every file inside a single image SUBMISSION's fileUrls is its own
  // photo — a student uploading 5 images at once is contributing 5
  // separate pictures, not 1 picture with 4 hidden duplicates. This
  // returns one entry per actual image file so every photo gets its own
  // tile (and its own individual lock/unlock state, keyed by its index,
  // same as before). Falls back to every file in the submission if none
  // of them detected as an "image" type, so a submission is never
  // silently dropped entirely.
  function imageFilesOf(img) {
    const files = Array.isArray(img.fileUrls) ? img.fileUrls : [];
    const onlyImages = files
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => (f.fileType || detectFileType({ name: f.name || "" })) === "image");
    return onlyImages.length ? onlyImages : files.map((f, i) => ({ f, i }));
  }

  // A single image tile's markup — one entry per PHOTO (not per
  // submission; see imageFilesOf above). Shared by the compact card, its
  // "View All" modal, and the search results in both, so lock/unlock
  // behaviour never drifts between them.
  function imageTileHtml(img, file, imageIndex) {
    const viewHref = buildViewHref(file, img);
    const imageFileId = `hand_notes::${img.courseCode}::${img.facultyName || ""}::${img.id}::${Math.max(0,imageIndex)}`;
    window.__hnFileOwners = window.__hnFileOwners || {};
    window.__hnFileOwners[imageFileId] = normalizeEmail(img.uploaderEmail || "");
    const unlocked = !!(window.__hnIsFileUnlocked && window.__hnIsFileUnlocked(imageFileId, "images", img.uploaderEmail));
    const locked = !unlocked;
    const tag = locked ? "div" : "a";
    return `
    <${tag} class="image-item${locked ? " image-locked" : ""}"${locked ? ` data-locked-image="1" data-file-id="${esc(imageFileId)}" data-folder-key="${esc(imageFileId)}" data-category="images"` : ` href="${viewHref}"`} style="text-decoration:none;">
      <div class="image-item-thumb">
        <img src="${encodeURI(file.url)}" alt="${esc(file.title || img.courseName)}" loading="lazy">
        <div class="status-badge">✓</div>
        <div class="view-overlay">
          <button type="button">${locked ? "🔒" : "View"}</button>
        </div>
      </div>
      <div class="image-item-caption">
        <span class="image-item-code">${esc(img.courseCode)}</span>
        ${file.title ? `<span class="image-item-title">${esc(file.title)}</span>` : ""}
      </div>
    </${tag}>`;
  }

  // Expands a list of image-submission docs into one tile per photo.
  function imageTilesHtml(imgs) {
    return imgs.flatMap(img => imageFilesOf(img).map(({ f, i }) => imageTileHtml(img, f, i))).join("");
  }

  function wireImageLockClicks(container) {
    container.querySelectorAll("[data-locked-image]").forEach(el => {
      el.addEventListener("click", () => window.hnOpenGate && window.hnOpenGate(el.dataset.fileId, el.dataset.folderKey, el.dataset.category));
    });
  }

  // ============================================
  // IMAGE FOLDER BROWSER
  // Mirrors renderPdfFolder's course-code drill-down: Level 1 is one
  // folder per course code, Level 2 is every image submitted under that
  // course. Because every image (and hand note, and slide) is grouped by
  // its `courseCode` field, the FIRST image uploaded for a course (e.g.
  // AGR 351) creates that folder, and every image uploaded after it for
  // the same course code lands in that same "AGR 351" folder automatically
  // — no manual filing needed.
  // ============================================
  function renderImageFolder(container, items, state, opts = {}) {
    if (!container) return;
    if (items.length === 0) {
      container.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No images yet.</p>`;
      if (opts.onTopLevelCount) opts.onTopLevelCount(0, 0);
      return;
    }

    // LEVEL 1 — course code folders
    if (!state.courseCode) {
      const courses = groupDocs(items, i => i.courseCode || "Unknown");
      let rows = [...courses.entries()].map(([code, docs]) => ({
        code, name: docs[0].courseName || "",
        imageCount: docs.reduce((n, d) => n + (d.fileUrls || []).length, 0)
      })).sort((a, b) => a.code.localeCompare(b.code));

      const total = rows.length;
      if (opts.limitTopLevel) rows = rows.slice(0, opts.limitTopLevel);
      if (opts.onTopLevelCount) opts.onTopLevelCount(total, rows.length);

      container.innerHTML = rows.map(r => `
        <div class="file-item folder-row" data-course="${esc(r.code)}" style="grid-column:1/-1;">
          <span class="file-status">📁</span>
          <span class="file-name">${esc(r.code)}${r.name ? `: ${esc(r.name)}` : ""}</span>
          <span class="folder-meta">${r.imageCount} image${r.imageCount !== 1 ? "s" : ""} <span class="folder-chevron">›</span></span>
        </div>`).join("");

      container.querySelectorAll("[data-course]").forEach(el => {
        el.addEventListener("click", () => {
          state.courseCode = el.dataset.course;
          renderImageFolder(container, items, state, opts);
        });
      });
      return;
    }

    // LEVEL 2 — every image submitted under this course code
    const courseItems = items.filter(i => (i.courseCode || "Unknown") === state.courseCode);
    const courseName = courseItems[0]?.courseName || "";
    
    container.innerHTML =
      `<div class="file-item folder-row folder-back" data-back="1" style="grid-column:1/-1;">
        <span class="file-status">←</span>
        <span class="file-name">${esc(state.courseCode)}${courseName ? `: ${esc(courseName)}` : ""}</span>
      </div>` +
      (courseItems.length
        ? imageTilesHtml(courseItems)
        : `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No images here.</p>`);

    container.querySelector("[data-back]").addEventListener("click", () => {
      state.courseCode = null;
      renderImageFolder(container, items, state, opts);
    });
    wireImageLockClicks(container);
  }

  function renderImageCard() {
    const imageCount = allImages.length;
    const countEl = document.getElementById("image-count");
    if (countEl) countEl.textContent = `(${imageCount})`;
    if (!imageGrid) return;

    const viewAllLink = document.getElementById("image-view-all");

    if (imageCount === 0) {
      imageGrid.innerHTML = `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No images yet.</p>`;
      if (imageSearch) imageSearch.style.display = "none";
      if (viewAllLink) viewAllLink.style.display = "none";
      return;
    }

    if (imageSearch) imageSearch.style.display = "block";

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
    //
    // A search term bypasses the folder browser entirely (flat matches,
    // capped to a compact preview); an empty box shows the normal
    // course-folder drill-down, reset to the top level only on the very
    // first render so later background refreshes don't kick the student
    // back out of a folder they're browsing.
    const applyFilter = (resetNav) => {
      if (resetNav) imageCardState.courseCode = null;
      const term = (imageSearch?.value || "").trim().toLowerCase();
      if (term) {
        const filtered = allImages.filter(img =>
          (img.courseName || "").toLowerCase().includes(term) ||
          (img.courseCode || "").toLowerCase().includes(term)
        ).slice(0, 6);
                imageGrid.innerHTML = filtered.length
          ? imageTilesHtml(filtered)
          : `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No matching images found.</p>`;
        wireImageLockClicks(imageGrid);
        if (viewAllLink) viewAllLink.style.display = "block";
      } else {
        renderImageFolder(imageGrid, allImages, imageCardState, {
          limitTopLevel: 6,
          onTopLevelCount: (total, shown) => {
            if (viewAllLink) viewAllLink.style.display = total > shown ? "block" : "none";
          }
        });
      }
    };

    const resetNav = !imageCardLoadedOnce;
    imageCardLoadedOnce = true;
    applyFilter(resetNav);

    if (imageSearch && !imageSearchWired) {
      imageSearchWired = true;
      imageSearch.addEventListener("input", () => applyFilter(true));
    }
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
  // modal with the complete list — with a course-code search box.
  // ============================================
  // VIEW ALL — documents: one shared modal serving BOTH folder cards. The
  // card that opened it decides the heading and which list is shown; the
  // same folder browser as the compact card, just unlimited. Search filters
  // by course code/name and resets navigation back to the top. The old
  // standalone faculty-filter dropdown is superseded by the
  // course → faculty drill-down, so it's hidden rather than wired up.
  (function wireDocViewAllModal() {
    const modal = document.getElementById("pdf-viewall-modal");
    if (!modal) return;
    const closeBtn = document.getElementById("pdf-viewall-close");
    const searchInput = document.getElementById("pdf-viewall-search");
    const facultySelect = document.getElementById("pdf-viewall-faculty");
    if (facultySelect) facultySelect.closest(".form-field")?.classList.add("hidden");
    const listEl = document.getElementById("pdf-viewall-list");
    const titleEl = document.getElementById("pdf-viewall-title");
    const modalState = { courseCode: null, faculty: null };
    let source = () => [];
    let currentLockScope = "file";
    let currentCategory = "hand_notes";

    function apply() {
      const term = (searchInput?.value || "").trim().toLowerCase();
      const items = term
        ? source().filter(i =>
            (i.courseCode || "").toLowerCase().includes(term) ||
            (i.courseName || "").toLowerCase().includes(term)
          )
        : source();
      renderPdfFolder(listEl, items, modalState, { lockScope: currentLockScope, category: currentCategory });
    }

    [
      { btnId: "handnotes-view-all", heading: "📝 All Hand Notes", getItems: () => allHandNotes, lockScope: "file", category: "hand_notes" },
      { btnId: "slides-view-all", heading: "🖥️ All Class Lecture Slides", getItems: () => allSlides, lockScope: "file", category: "class_slides" }
    ].forEach(({ btnId, heading, getItems, lockScope, category }) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        source = getItems;
        currentLockScope = lockScope;
        currentCategory = category;
        if (titleEl) titleEl.textContent = heading;
        if (searchInput) searchInput.value = "";
        modalState.courseCode = null;
        modalState.faculty = null;
        modal.classList.remove("hidden");
        apply();
      });
    });

    if (closeBtn) closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    if (searchInput) searchInput.addEventListener("input", () => {
      modalState.courseCode = null;
      modalState.faculty = null;
      apply();
    });
  })();

  // VIEW ALL — images: same course-folder browser as the compact card,
  // just unlimited. A search term flattens to matches across every
  // course (as before); clearing it goes back to folder browsing, reset
  // to the top level.
  (function wireImageViewAllModal() {
    const openBtn = document.getElementById("image-view-all");
    const modal = document.getElementById("image-viewall-modal");
    if (!openBtn || !modal) return;
    const closeBtn = document.getElementById("image-viewall-close");
    const searchInput = document.getElementById("image-viewall-search");
    const grid = document.getElementById("image-viewall-grid");
    const modalState = { courseCode: null };

    function apply(resetNav) {
      if (resetNav) modalState.courseCode = null;
      const term = (searchInput?.value || "").trim().toLowerCase();
      if (term) {
        const filtered = allImages.filter(img =>
          (img.courseCode || "").toLowerCase().includes(term) ||
          (img.courseName || "").toLowerCase().includes(term)
        );
                grid.innerHTML = filtered.length
          ? imageTilesHtml(filtered)
          : `<p style="color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;grid-column:1/-1;">No matching images found.</p>`;
        wireImageLockClicks(grid);
      } else {
        renderImageFolder(grid, allImages, modalState, {});
      }
    }

    openBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (searchInput) searchInput.value = "";
      modal.classList.remove("hidden");
      apply(true);
    });
    closeBtn?.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });
    searchInput?.addEventListener("input", () => apply(true));
  })();
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
  const auImageTitlesWrap = document.getElementById("au-images-titles-wrap");
  const auImageTitlesList = document.getElementById("au-images-titles-list");
  const auSuccess = document.getElementById("au-success");
  const AU_CIRCUMFERENCE = 226.19;
  let auFileType = "auto";
  let auNoteType = "hand_notes";
  let auMatchedCourse = null;

  document.querySelectorAll('input[name="au-noteType"]').forEach(radio => {
    radio.addEventListener("change", () => {
      auNoteType = radio.value;
      wireNoteTypeVisual("au-noteType");
    });
  });



  function auResetForm() {
    auForm.reset();
    auForm.classList.remove("hidden");
    auSuccess.classList.add("hidden");
    auProgressWrap.classList.add("hidden");
    auStatus.textContent = "";
    auCourseNameHint.classList.add("hidden");
    auFacultySuggestions.innerHTML = "";
    if (auImageTitlesWrap) auImageTitlesWrap.classList.add("hidden");
    if (auImageTitlesList) auImageTitlesList.innerHTML = "";
    auMatchedCourse = null;
    auFileType = "auto";
    auFiles.accept = ".pdf,.ppt,.pptx,image/*";
    auFilesLabel.textContent = "PDF, Image or Presentation File(s) *";
    auFilesPreview.innerHTML = "";
    auFilesPreview.classList.add("hidden");
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
    if (!auImageTitlesWrap || !auImageTitlesList) return;
    if (!auFiles.files || auFiles.files.length === 0 || !Array.from(auFiles.files).some(f => detectFileType(f) === "image")) {
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

  auFiles.accept = ".pdf,.ppt,.pptx,image/*";

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

    if (files.length === 0) { auShowStatus("Please choose at least one PDF, image, or presentation file.", true); return; }
    if (files.length > MAX_FILES) { auShowStatus(`Maximum ${MAX_FILES} files allowed.`, true); return; }
    const detectedTypes = files.map(detectFileType);
    if (detectedTypes.some(t => t === "unknown")) { auShowStatus("One or more files have an unsupported type. Please use PDF, PPT/PPTX, JPG, PNG, GIF, or WebP.", true); return; }
    if (new Set(detectedTypes).size > 1) { auShowStatus("Please select files of a single type only — all PDF, all images, or all presentations, not a mix.", true); return; }
    auFileType = detectedTypes[0];
    const oversized = files.find(f => f.size > MAX_SIZE);
    if (oversized) { auShowStatus(`"${oversized.name}" is over 50MB.`, true); return; }

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

      // Auto-rename duplicates — and tell the user it happened.
      const auDuplicateNotices = [];
      for (let i = 0; i < fileUrls.length; i++) {
        const renameResult = await autoRenameIfDuplicate(fileUrls[i].name, courseCode, facultyName);
        if (renameResult.renamed) {
          auDuplicateNotices.push(`"${renameResult.originalName}" already exists for this course — saved as "${renameResult.name}".`);
        }
        fileUrls[i].name = renameResult.name;
      }
      fileUrls.forEach((f, i) => { f.fileType = detectedTypes[i]; });

      if (detectedTypes.some(t => t === "image") && auImageTitlesList) {
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
      const auDupNoticeEl = document.getElementById("au-duplicate-notice");
      if (auDupNoticeEl) {
        if (auDuplicateNotices.length) {
          auDupNoticeEl.textContent = "⚠️ " + auDuplicateNotices.join(" ");
          auDupNoticeEl.classList.remove("hidden");
        } else {
          auDupNoticeEl.classList.add("hidden");
        }
      }
      auSuccess.classList.remove("hidden");
      auMatchedCourse = null;

      // Refresh whatever's currently on screen (three-card lists, status bar).
      (window.__onResourceAccessGranted || []).forEach(fn => fn());
    } catch (err) {
      console.error("[Another Upload] failed:", err);
      let userMessage = "Something went wrong: " + (err && err.message ? err.message : "please try again.");
      if (err.code === "permission-denied") userMessage = "Upload was rejected (" + (err.message || "permission denied") + "). Please check the details and try again.";
      else if (/network/i.test(err.message || "")) userMessage = "Network error: " + err.message + ". Check your connection and try again.";
      else if (/timed out/i.test(err.message || "")) userMessage = err.message + " Try again with a smaller file.";
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
