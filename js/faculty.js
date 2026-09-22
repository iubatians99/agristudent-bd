// ============================================
// TEACHER RECOMMENDATION — teacher-recommendation.html
//
// Positive-only faculty review system. Design intent (see product
// discussion in the admin README / commit history): students should be
// able to say what's GOOD about a teacher, never what's bad. There is
// no free-text negative rating anywhere in this file — only a 1–5 star
// rating, a Recommended/Not-recommended toggle, a fixed set of positive
// tags, and an optional comment that is auto-filtered to strip out
// negative language before it ever reaches Firestore.
//
// Two review paths:
//   - Signed (default): posted under the student's own profile name,
//     goes live immediately (status "approved").
//   - Anonymous: name is hidden from the public page, but the review
//     still goes to an admin moderation queue first (status "pending")
//     before it counts toward any public stat or shows in the comment
//     list — see js/admin.js loadFacultyReviews().
//
// One review per student per faculty is enforced by Firestore rules via
// a deterministic doc id (`${facultyId}_${reviewerRegId}`) — see the
// long comment on facultyReviews in firestore.rules.
// ============================================
import { db, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, getDocs, getDoc, doc, setDoc, updateDoc, addDoc, query, where, orderBy, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getSession } from "./session.js";

function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function requireSession() {
  const s = getSession();
  if (!s) {
    alert("Please log in first so we can attach your recommendation to your profile.");
    window.location.href = "login.html?return=teacher-recommendation.html";
  }
  return s;
}

async function getVerifiedRegistration(session) {
  if (!session?.regId) return null;
  const snap = await getDoc(doc(db, "registrations", session.regId));
  if (!snap.exists()) return null;
  const reg = snap.data() || {};
  if (reg.removed || reg.status !== "verified") return null;
  const sessionEmail = String(session.email || "").trim().toLowerCase();
  const regEmail = String(reg.email || "").trim().toLowerCase();
  if (!sessionEmail || !regEmail || sessionEmail !== regEmail) return null;
  return { id: snap.id, ...reg };
}

// ============================================
// POSITIVE TAGS — the only kind of tag that exists in this feature.
// ============================================
const DEFAULT_POSITIVE_TAGS = [
  { key: "clear_explanations",   label: "Clear Explanations",   emoji: "💡" },
  { key: "fair_grading",         label: "Fair Grading",         emoji: "⚖️" },
  { key: "approachable",         label: "Approachable",         emoji: "🙂" },
  { key: "encourages_questions", label: "Encourages Questions", emoji: "🙋" },
  { key: "well_organized",       label: "Well Organized",       emoji: "🗂️" },
  { key: "inspiring",            label: "Inspiring",            emoji: "✨" },
  { key: "punctual",             label: "Punctual & Reliable",  emoji: "⏰" },
  { key: "helpful_feedback",     label: "Helpful Feedback",     emoji: "📝" }
];
let POSITIVE_TAGS = [...DEFAULT_POSITIVE_TAGS];
let TAG_MAP = Object.fromEntries(POSITIVE_TAGS.map(t => [t.key, t]));

async function loadReviewTags() {
  try {
    const snap = await getDoc(doc(db, "settings", "facultyReviewTags"));
    const tags = snap.exists() ? snap.data().tags : null;
    if (Array.isArray(tags) && tags.length) {
      const cleaned = tags.map(t => ({
        key: String(t?.key || "").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
        label: String(t?.label || "").trim().slice(0, 80),
        emoji: String(t?.emoji || "✨").slice(0, 4)
      })).filter(t => t.key && t.label);
      if (cleaned.length) POSITIVE_TAGS = cleaned;
    }
  } catch (err) {
    console.warn("[Faculty] review tag settings unavailable; using defaults.", err);
  }
  TAG_MAP = Object.fromEntries(POSITIVE_TAGS.map(t => [t.key, t]));
}

// ============================================
// COMMENT FILTER — "we only want to hear the good things." Strips any
// sentence that contains negative language instead of rejecting the
// whole comment outright, so a mostly-positive note still gets through
// with just the negative clause removed. This is a client-side courtesy
// filter, not the real defense — the real defense is that every comment
// (anonymous or not) can be deleted by admin at any time, and anonymous
// ones never go public without admin sign-off in the first place.
// ============================================
const NEGATIVE_PATTERNS = [
  /\bbad\b/i, /\bworst\b/i, /\bhate[sd]?\b/i, /\bterrible\b/i, /\bawful\b/i, /\bhorrible\b/i,
  /\buseless\b/i, /\bwaste(d)? of time\b/i, /\brude\b/i, /\bunfair\b/i, /\bnightmare\b/i,
  /\bavoid (him|her|them|this)\b/i, /\bdon'?t take\b/i, /\bharsh\b/i, /\bboring\b/i,
  /\bstupid\b/i, /\bidiot\b/i, /\bpoor(ly)? (teach|explain)/i, /\bdislike[sd]?\b/i,
  /\bnot good\b/i, /\bnever attend\b/i, /\bfail(s|ed)? (us|students|everyone)\b/i
];

function sanitizeComment(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?\n])\s+/).map(s => s.trim()).filter(Boolean);
  const kept = sentences.filter(s => !NEGATIVE_PATTERNS.some(re => re.test(s)));
  return kept.join(" ").slice(0, 400).trim();
}

// ============================================
// SHARED DATA HELPERS
// ============================================
async function fetchAllFaculty() {
  // Keep the public directory limited to approved profiles. Legacy profiles
  // without a status are intentionally not treated as public here; the admin
  // panel can approve/migrate them explicitly so pending submissions never leak.
  const snap = await getDocs(query(collection(db, "faculty"), where("status", "==", "approved")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fetchApprovedReviewsForFaculty(facultyId) {
  const q = query(
    collection(db, "facultyReviews"),
    where("facultyId", "==", facultyId),
    where("status", "==", "approved")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

function facultyScore(f) {
  const s = f.stats || {};
  const ratingCount = s.ratingCount || 0;
  const avgRating = ratingCount > 0 ? (s.ratingSum || 0) / ratingCount : 0;
  const reviewCount = s.reviewCount || 0;
  const recommendPct = reviewCount > 0 ? Math.round(((s.recommendCount || 0) / reviewCount) * 100) : null;
  return { avgRating, ratingCount, reviewCount, recommendPct };
}

function starString(avg) {
  const rounded = Math.round(avg);
  return "★★★★★".slice(0, rounded) + "☆☆☆☆☆".slice(0, 5 - rounded);
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function avatarHtml(f) {
  if (f.photoUrl) return `<img src="${esc(f.photoUrl)}" alt="" class="fc-avatar-img">`;
  return `<div class="fc-avatar-fallback">${esc(initials(f.name))}</div>`;
}

function uploadFacultyPhoto(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", CLOUDINARY_UPLOAD_URL, true);
    xhr.upload.addEventListener("progress", e => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300 && data.secure_url) resolve(data.secure_url);
        else reject(new Error("Photo upload failed."));
      } catch { reject(new Error("Photo upload failed.")); }
    };
    xhr.onerror = () => reject(new Error("Photo upload failed."));
    const form = new FormData();
    form.append("file", file);
    form.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
    xhr.send(form);
  });
}

// ============================================
// PAGE BOOTSTRAP
// ============================================
document.addEventListener("DOMContentLoaded", init);

async function init() {
  const grid = document.getElementById("faculty-grid");
  const gridStatus = document.getElementById("faculty-grid-status");
  const searchInput = document.getElementById("faculty-search-input");
  const searchForm = document.getElementById("faculty-search-form");
  const searchResultLabel = document.getElementById("faculty-search-result-label");
  const searchMeta = document.getElementById("faculty-search-meta");
  const addBtn = document.getElementById("add-faculty-btn");
  const addOverlay = document.getElementById("add-faculty-overlay");
  const addForm = document.getElementById("add-faculty-form");
  const addClose = document.getElementById("add-faculty-close");
  const addStatus = document.getElementById("add-faculty-status");
  const addSubmit = document.getElementById("add-faculty-submit");
  const addPhotoInput = document.getElementById("new-faculty-photo");
  const searchReviewBtn = document.getElementById("search-faculty-review-btn");
  const collage = document.getElementById("faculty-photo-collage");

  if (!grid) return;

  let allFaculty = [];
  let allCourses = new Map(); // courseCode -> courseName

  try {
    const [facultyList, courseSnap] = await Promise.all([
      fetchAllFaculty(),
      getDocs(collection(db, "courses")),
      loadReviewTags()
    ]);
    allFaculty = facultyList;
    courseSnap.forEach(d => {
      const data = d.data();
      const code = String(data.courseCode || d.id).trim().toUpperCase().replace(/\s+/g, "");
      allCourses.set(code, data.courseName || d.id);
    });
  } catch (err) {
    console.error("[Faculty] load failed:", err);
    gridStatus.textContent = "Couldn't load faculty right now. Please refresh.";
    gridStatus.classList.remove("hidden");
    return;
  }

  function normalizeSearch(value) {
    return String(value || "").toLowerCase().replace(/[\s\-_./]+/g, "").trim();
  }

  function courseCodesForFaculty(f) {
    return (f.courseCodes || []).map(c => String(c || "").trim().toUpperCase().replace(/\s+/g, ""));
  }

  function facultySearchText(f) {
    const codes = courseCodesForFaculty(f);
    const names = codes.map(c => allCourses.get(c) || "");
    return [f.name, f.department, f.designation, codes.join(" "), names.join(" ")].filter(Boolean).join(" ").toLowerCase();
  }

  function recommendationSort(a, b) {
    const sa = facultyScore(a), sb = facultyScore(b);
    // Course searches are intentionally ranked by recommendation quality:
    // recommendation rate first, then average rating, then review volume.
    const ap = sa.recommendPct === null ? -1 : sa.recommendPct;
    const bp = sb.recommendPct === null ? -1 : sb.recommendPct;
    if (bp !== ap) return bp - ap;
    if (sb.avgRating !== sa.avgRating) return sb.avgRating - sa.avgRating;
    if (sb.reviewCount !== sa.reviewCount) return sb.reviewCount - sa.reviewCount;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  function generalSort(a, b) {
    const sa = facultyScore(a), sb = facultyScore(b);
    if (sb.reviewCount !== sa.reviewCount) return sb.reviewCount - sa.reviewCount;
    if (sb.avgRating !== sa.avgRating) return sb.avgRating - sa.avgRating;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  function renderHeroCollage(list) {
    if (!collage) return;
    const best10 = [...list].sort(recommendationSort).slice(0, 10);
    const tile = (f, i) => f.photoUrl
      ? `<div class="tr-photo-tile tr-photo-tile-${i + 1}"><img src="${esc(f.photoUrl)}" alt=""></div>`
      : `<div class="tr-photo-tile tr-photo-tile-${i + 1}"><div class="tr-photo-tile-fallback">${esc(initials(f.name))}</div></div>`;
    collage.innerHTML = `<div class="tr-photo-side tr-photo-side-left">${best10.slice(0,5).map(tile).join("")}</div><div class="tr-photo-side tr-photo-side-right">${best10.slice(5,10).map((f,i)=>tile(f,i+5)).join("")}</div>`;
  }

  function renderGrid(list, emptyMsg) {
    if (!list.length) {
      grid.innerHTML = "";
      gridStatus.textContent = emptyMsg || "No faculty found yet.";
      gridStatus.classList.remove("hidden");
      return;
    }
    gridStatus.classList.add("hidden");
    grid.innerHTML = list.map(f => {
      const { avgRating, ratingCount, recommendPct } = facultyScore(f);
      return `
      <button type="button" class="fc-card" data-id="${esc(f.id)}">
        <div class="fc-avatar">${avatarHtml(f)}</div>
        <div class="fc-name">${esc(f.name)}</div>
        <div class="fc-dept">${esc(f.department || "")}${f.designation ? " · " + esc(f.designation) : ""}</div>
        <div class="fc-stats">
          <span class="fc-stars" title="${ratingCount} rating(s)">${ratingCount ? starString(avgRating) : "Not yet rated"}</span>
          ${recommendPct !== null ? `<span class="fc-recommend">👍 ${recommendPct}% recommend</span>` : ""}
        </div>
      </button>`;
    }).join("");
    grid.querySelectorAll(".fc-card").forEach(card => {
      card.addEventListener("click", () => openFacultyProfile(card.dataset.id, allFaculty, allCourses));
    });
  }

  function showSearch(list, raw, mode, matchedCourses = []) {
    searchResultLabel.textContent = mode === "course"
      ? `Faculty matching ${matchedCourses.length === 1 ? matchedCourses[0].code : "course search"}`
      : `Results for "${raw}"`;
    searchResultLabel.classList.remove("hidden");
    if (searchMeta) {
      if (mode === "course") {
        const labels = matchedCourses.slice(0, 4).map(c => `${c.code}${c.name ? " — " + c.name : ""}`);
        searchMeta.innerHTML = `<span class="tr-search-chip">🏆 Ranked by recommendation rate → rating → review count</span>${labels.map(x => `<span class="tr-search-chip">${esc(x)}</span>`).join("")}`;
      } else {
        searchMeta.innerHTML = `<span class="tr-search-chip">🔎 Matches faculty and course details</span>`;
      }
      searchMeta.classList.remove("hidden");
    }
    renderGrid(list, `No faculty matched "${raw}".`);
  }

  function runSearch(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw) {
      searchResultLabel.classList.add("hidden");
      searchMeta?.classList.add("hidden");
      renderGrid([...allFaculty].sort(generalSort));
      return;
    }

    const needle = normalizeSearch(raw);
    const matchedCourses = [];
    for (const [code, name] of allCourses.entries()) {
      const codeMatch = normalizeSearch(code).includes(needle);
      const nameMatch = normalizeSearch(name).includes(needle);
      if (codeMatch || nameMatch) matchedCourses.push({ code, name, codeMatch });
    }

    // Also allow partial course-code searches even when a course document
    // hasn't been created yet, using the faculty's linked courseCodes.
    const linkedCodes = new Set(allFaculty.flatMap(courseCodesForFaculty));
    linkedCodes.forEach(code => {
      if (normalizeSearch(code).includes(needle) && !matchedCourses.some(c => c.code === code)) {
        matchedCourses.push({ code, name: allCourses.get(code) || "", codeMatch: true });
      }
    });

    if (matchedCourses.length) {
      const matchedCodeSet = new Set(matchedCourses.map(c => c.code));
      const list = allFaculty.filter(f => courseCodesForFaculty(f).some(c => matchedCodeSet.has(c))).sort(recommendationSort);
      showSearch(list, raw, "course", matchedCourses);
      return;
    }

    const list = allFaculty.filter(f => normalizeSearch(facultySearchText(f)).includes(needle)).sort(generalSort);
    showSearch(list, raw, "general");
  }

  renderHeroCollage(allFaculty);
  renderGrid([...allFaculty].sort(generalSort));

  searchForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(searchInput?.value || "");
  });
  searchInput?.addEventListener("input", () => runSearch(searchInput.value));

  function closeAddFaculty() {
    addOverlay?.classList.add("hidden");
    document.body.style.overflow = "";
    if (addStatus) addStatus.textContent = "";
  }

  addBtn?.addEventListener("click", () => {
    if (!getSession()) {
      alert("🔒 Please log in as a registered user to add a faculty member.");
      window.location.href = "login.html?return=teacher-recommendation.html";
      return;
    }
    addOverlay?.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    document.getElementById("new-faculty-name")?.focus();
  });
  addClose?.addEventListener("click", closeAddFaculty);
  addOverlay?.addEventListener("click", e => { if (e.target === addOverlay) closeAddFaculty(); });
  searchReviewBtn?.addEventListener("click", () => {
    searchInput?.focus();
    document.querySelector(".tr-search-wrap")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  addForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const session = requireSession();
    if (!session) return;
    let registration;
    try {
      registration = await getVerifiedRegistration(session);
    } catch (err) {
      console.error("[Faculty] registration check failed:", err);
      addStatus.textContent = "Could not verify your account. Please refresh and log in again.";
      addStatus.style.color = "var(--terracotta-500)";
      return;
    }
    if (!registration) {
      addStatus.textContent = "Only a registered and verified account can submit a faculty suggestion.";
      addStatus.style.color = "var(--terracotta-500)";
      return;
    }
    const name = document.getElementById("new-faculty-name")?.value.trim() || "";
    const department = document.getElementById("new-faculty-department")?.value.trim() || "";
    const designation = document.getElementById("new-faculty-designation")?.value.trim() || "";
    const courseCodes = [...new Set((document.getElementById("new-faculty-courses")?.value || "")
      .split(/[,,\s]+/).map(c => c.trim().toUpperCase()).filter(Boolean))];
    const photoFile = addPhotoInput?.files?.[0] || null;
    if (photoFile && (!photoFile.type.startsWith("image/") || photoFile.size > 5 * 1024 * 1024)) {
      addStatus.textContent = "Please choose an image up to 5 MB.";
      addStatus.style.color = "var(--terracotta-500)";
      return;
    }

    if (!name || !department || !courseCodes.length) {
      addStatus.textContent = "Please enter the faculty name, department, and at least one course code.";
      addStatus.style.color = "var(--terracotta-500)";
      return;
    }

    const duplicate = allFaculty.some(f => normalizeSearch(f.name) === normalizeSearch(name));
    if (duplicate) {
      addStatus.textContent = "This faculty member is already in the directory.";
      addStatus.style.color = "var(--terracotta-500)";
      return;
    }

    addSubmit.disabled = true;
    addStatus.textContent = "Submitting…";
    addStatus.style.color = "var(--moss-600)";
    try {
      let photoUrl = "";
      if (photoFile) {
        addStatus.textContent = "Uploading photo…";
        photoUrl = await uploadFacultyPhoto(photoFile, pct => { addStatus.textContent = `Uploading photo ${pct}%…`; });
      }
      await addDoc(collection(db, "faculty"), {
        name,
        department,
        designation,
        courseCodes,
        status: "pending",
        photoUrl,
        submittedByRegId: registration.id,
        submittedByEmail: String(registration.email || "").trim().toLowerCase(),
        submittedByName: String(registration.fullName || session.fullName || "").trim().slice(0, 160),
        submittedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        stats: { reviewCount: 0, recommendCount: 0, ratingSum: 0, ratingCount: 0, tagCounts: {} }
      });
      addStatus.textContent = "✅ Faculty submitted successfully. Admin will review and publish it.";
      addForm.reset();
      setTimeout(closeAddFaculty, 1700);
    } catch (err) {
      console.error("[Faculty] add faculty failed:", err);
      addStatus.textContent = "Could not submit right now. Please try again.";
      addStatus.style.color = "var(--terracotta-500)";
    } finally {
      addSubmit.disabled = false;
    }
  });
}

// ============================================
// FACULTY PROFILE MODAL
// ============================================
async function openFacultyProfile(facultyId, allFaculty, allCourses) {
  const session = getSession();
  if (!session) {
    alert("🔒 Please log in to see faculty details and reviews.");
    window.location.href = "login.html?return=teacher-recommendation.html";
    return;
  }
  const faculty = allFaculty.find(f => f.id === facultyId);
  if (!faculty) return;

  const overlay = document.getElementById("faculty-profile-overlay");
  const body = document.getElementById("faculty-profile-body");
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  body.innerHTML = `<p style="text-align:center;color:var(--moss-600);padding:2rem 0;">Loading profile…</p>`;

  let reviews = [];
  try {
    reviews = await fetchApprovedReviewsForFaculty(facultyId);
  } catch (err) {
    console.error("[Faculty] profile load failed:", err);
  }

  const tagCounts = (faculty.stats && faculty.stats.tagCounts) || {};
  const topTags = Object.entries(tagCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const courseCodes = (faculty.courseCodes || []).map(c => String(c).trim().toUpperCase().replace(/\s+/g, ""));
  const courseChips = courseCodes
    .map(code => `<span class="fp-chip">${esc(code)}${allCourses.has(code) ? " — " + esc(allCourses.get(code)) : ""}</span>`)
    .join("") || `<span class="fp-chip fp-chip-muted">No courses linked yet</span>`;

  const statsFor = (list) => {
    const reviewCount = list.length;
    const ratingCount = list.filter(r => Number.isFinite(Number(r.rating)) && Number(r.rating) > 0).length;
    const ratingSum = list.reduce((sum, r) => sum + (Number(r.rating) || 0), 0);
    const recommendCount = list.filter(r => r.recommended === true).length;
    return {
      reviewCount,
      ratingCount,
      avgRating: ratingCount ? ratingSum / ratingCount : 0,
      recommendPct: reviewCount ? Math.round((recommendCount / reviewCount) * 100) : null
    };
  };

  const courseOptions = courseCodes.map(code => `<option value="${esc(code)}">${esc(code)}${allCourses.has(code) ? " — " + esc(allCourses.get(code)) : ""}</option>`).join("");

  body.innerHTML = `
    <div class="fp-header">
      <div class="fp-avatar">${avatarHtml(faculty)}</div>
      <div>
        <h3 class="fp-name">${esc(faculty.name)}</h3>
        <div class="fp-dept">${esc(faculty.department || "")}${faculty.designation ? " · " + esc(faculty.designation) : ""}</div>
      </div>
    </div>

    <div class="fp-stat-row" id="fp-stat-row"></div>

    <h4 class="fp-subhead">Courses</h4>
    <div class="fp-chip-row">${courseChips}</div>

    ${courseOptions ? `
      <div class="fp-filter-row">
        <label for="fp-course-filter">Filter reviews by course</label>
        <select id="fp-course-filter"><option value="__all__">All courses</option>${courseOptions}</select>
      </div>
      <p class="fp-filter-note">Course-specific rating, recommendation rate, and reviews update with the selected course.</p>
    ` : ""}

    ${topTags.length ? `
      <h4 class="fp-subhead">Most mentioned</h4>
      <div class="fp-chip-row">${topTags.map(([key, n]) => `<span class="fp-chip fp-chip-tag">${esc((TAG_MAP[key] && TAG_MAP[key].emoji) || "✅")} ${esc((TAG_MAP[key] && TAG_MAP[key].label) || key)} · ${n}</span>`).join("")}</div>
    ` : ""}

    <h4 class="fp-subhead">What students say</h4>
    <div class="fp-comments" id="fp-comments"></div>
    <button type="button" class="btn-primary" id="fp-write-review-btn" style="width:100%;margin-top:1.4rem;">✍️ Write a Recommendation</button>
  `;

  const statRow = body.querySelector("#fp-stat-row");
  const commentsEl = body.querySelector("#fp-comments");

  function renderCourseReviews(filter) {
    const selected = filter === "__all__" ? reviews : reviews.filter(r => String(r.courseCode || "").toUpperCase().replace(/\s+/g, "") === filter);
    const stats = statsFor(selected);
    statRow.innerHTML = `
      <div class="fp-stat"><div class="fp-stat-num">${stats.ratingCount ? stats.avgRating.toFixed(1) : "—"}</div><div class="fp-stat-label">${stats.ratingCount ? starString(stats.avgRating) : "Not yet rated"}</div></div>
      <div class="fp-stat"><div class="fp-stat-num">${stats.recommendPct !== null ? stats.recommendPct + "%" : "—"}</div><div class="fp-stat-label">Recommend</div></div>
      <div class="fp-stat"><div class="fp-stat-num">${stats.reviewCount}</div><div class="fp-stat-label">Review${stats.reviewCount === 1 ? "" : "s"}</div></div>`;

    const comments = selected.filter(r => r.comment).slice(0, 20);
    commentsEl.innerHTML = comments.map(r => `
      <div class="fp-comment">
        <div class="fp-comment-head">
          <span class="fp-comment-author">${r.isAnonymous ? "🙈 Anonymous student" : "🎓 " + esc(r.reviewerName || "A student")}</span>
          <span class="fp-comment-stars">${starString(r.rating || 0)}</span>
        </div>
        ${r.courseCode ? `<div style="font-size:.7rem;color:var(--moss-500);margin-bottom:.25rem;">${esc(r.courseCode)}${allCourses.has(String(r.courseCode).toUpperCase().replace(/\s+/g, "")) ? " · " + esc(allCourses.get(String(r.courseCode).toUpperCase().replace(/\s+/g, ""))) : ""}</div>` : ""}
        <p class="fp-comment-text">${esc(r.comment)}</p>
      </div>
    `).join("") || `<p style="color:var(--moss-600);font-size:.88rem;">${filter === "__all__" ? "No written recommendations yet — be the first!" : "No written recommendations for this course yet."}</p>`;
  }

  renderCourseReviews("__all__");
  body.querySelector("#fp-course-filter")?.addEventListener("change", e => renderCourseReviews(e.target.value));
  document.getElementById("fp-write-review-btn").addEventListener("click", () => {
    openReviewModal(faculty, allCourses);
  });
}

document.getElementById("faculty-profile-close")?.addEventListener("click", closeFacultyProfile);
document.getElementById("faculty-profile-overlay")?.addEventListener("click", (e) => {
  if (e.target.id === "faculty-profile-overlay") closeFacultyProfile();
});
function closeFacultyProfile() {
  document.getElementById("faculty-profile-overlay")?.classList.add("hidden");
  document.body.style.overflow = "";
}

// ============================================
// REVIEW SUBMISSION MODAL
// ============================================
function openReviewModal(faculty, allCourses) {
  const session = requireSession();
  if (!session) return;

  const overlay = document.getElementById("review-modal-overlay");
  const body = document.getElementById("review-modal-body");
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  const courseOptions = (faculty.courseCodes || [])
    .map(code => `<option value="${esc(code)}">${esc(code)}${allCourses.has(code) ? " — " + esc(allCourses.get(code)) : ""}</option>`)
    .join("");

  body.innerHTML = `
    <h3>✍️ Recommend ${esc(faculty.name)}</h3>
    <p class="modal-desc" style="max-height:none;">We only want to know the good things — this space is for positive, encouraging feedback that helps other students. There's no way to leave a written negative comment here.</p>
    <form id="review-form">
      <div class="form-field">
        <label>Your rating</label>
        <div class="rv-stars" id="rv-stars" data-value="0">
          ${[1,2,3,4,5].map(n => `<span class="rv-star" data-star="${n}">☆</span>`).join("")}
        </div>
      </div>

      <div class="form-field">
        <label>Would you recommend this teacher?</label>
        <div class="rv-toggle">
          <button type="button" class="rv-toggle-btn" data-rec="yes">👍 Recommended</button>
          <button type="button" class="rv-toggle-btn" data-rec="no">🙅 Not recommended</button>
        </div>
      </div>

      ${courseOptions ? `
      <div class="form-field">
        <label for="rv-course">Which course was this for?</label>
        <select id="rv-course">${courseOptions}</select>
      </div>` : ""}

      <div class="form-field">
        <label>What stood out? (choose at least one)</label>
        <div class="rv-tags">
          ${POSITIVE_TAGS.map(t => `<label class="rv-tag"><input type="checkbox" value="${t.key}"> ${t.emoji} ${esc(t.label)}</label>`).join("")}
        </div>
      </div>

      <div class="form-field">
        <label for="rv-comment">Write something that can help to get better score.</label>
        <textarea id="rv-comment" maxlength="400" placeholder="Write a helpful, positive note for future students…"></textarea>
        <p id="rv-draft-status" style="font-size:.72rem;color:var(--moss-500);margin:.3rem 0 0;">Draft autosaves while you write.</p>
      </div>

      <div class="form-field" style="margin-bottom:.4rem;">
        <label style="display:flex;align-items:center;gap:.5rem;font-weight:500;">
          <input type="checkbox" id="rv-anonymous" style="width:auto;">
          Post this anonymously
        </label>
        <p style="font-size:.78rem;color:var(--moss-600);margin:.3rem 0 0;">Anonymous recommendations are reviewed by admin before they appear publicly. Signed ones (with your name) go live right away.</p>
      </div>

      <p id="review-status" style="font-size:.85rem;min-height:1.2em;"></p>
      <button type="submit" class="btn-primary" id="review-submit-btn" style="width:100%;">Submit Recommendation</button>
    </form>
  `;

  let starValue = 0;
  let recValue = null;
  const starsEl = body.querySelector("#rv-stars");
  starsEl.querySelectorAll(".rv-star").forEach(star => {
    star.addEventListener("click", () => {
      starValue = Number(star.dataset.star);
      starsEl.querySelectorAll(".rv-star").forEach(s => {
        s.textContent = Number(s.dataset.star) <= starValue ? "★" : "☆";
        s.classList.toggle("is-active", Number(s.dataset.star) <= starValue);
      });
    });
  });
  body.querySelectorAll(".rv-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      recValue = btn.dataset.rec === "yes";
      body.querySelectorAll(".rv-toggle-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });

  const statusEl = body.querySelector("#review-status");
  function showStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.style.color = isError ? "var(--terracotta-500)" : "var(--leaf-500)";
  }

  const draftKey = `agri_faculty_review_draft_${faculty.id}_${session.regId}`;
  const commentEl = body.querySelector("#rv-comment");
  try {
    const savedDraft = localStorage.getItem(draftKey);
    if (savedDraft && commentEl) commentEl.value = savedDraft;
  } catch {}
  let draftTimer;
  commentEl?.addEventListener("input", () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { localStorage.setItem(draftKey, commentEl.value.slice(0, 400)); } catch {}
      const ds = body.querySelector("#rv-draft-status");
      if (ds) ds.textContent = "✓ Draft saved";
    }, 250);
  });

  body.querySelector("#review-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (starValue < 1) { showStatus("Please choose a star rating.", true); return; }
    if (recValue === null) { showStatus("Please choose Recommended or Not recommended.", true); return; }
    const tags = [...body.querySelectorAll(".rv-tags input:checked")].map(i => i.value);
    if (tags.length < 1) { showStatus("Please choose at least one positive tag.", true); return; }

    const courseSelect = body.querySelector("#rv-course");
    const courseCode = courseSelect ? courseSelect.value : "";
    const isAnonymous = body.querySelector("#rv-anonymous").checked;
    const comment = sanitizeComment(body.querySelector("#rv-comment").value);

    const submitBtn = body.querySelector("#review-submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting…";
    showStatus("Submitting your recommendation…");

    const reviewId = `${faculty.id}_${session.regId}`;
    const docData = {
      facultyId: faculty.id,
      facultyName: faculty.name,
      courseCode: courseCode || "",
      reviewerRegId: session.regId,
      reviewerName: session.fullName || "",
      reviewerAvatarUrl: session.avatarUrl || "",
      rating: starValue,
      recommended: recValue,
      tags,
      comment,
      isAnonymous,
      status: isAnonymous ? "pending" : "approved",
      submittedAt: serverTimestamp()
    };

    try {
      await setDoc(doc(db, "facultyReviews", reviewId), docData);

      // Signed reviews are live immediately, so bump the faculty's public
      // aggregate right now. Anonymous ones only count once admin
      // approves them (js/admin.js loadFacultyReviews does the same
      // increment at that point) — otherwise a pending, unreviewed
      // comment could still move the public numbers.
      if (!isAnonymous) {
        const statsUpdate = {
          "stats.reviewCount": increment(1),
          "stats.recommendCount": increment(recValue ? 1 : 0),
          "stats.ratingSum": increment(starValue),
          "stats.ratingCount": increment(1)
        };
        tags.forEach(t => { statsUpdate[`stats.tagCounts.${t}`] = increment(1); });
        await updateDoc(doc(db, "faculty", faculty.id), statsUpdate);
      }

      try { localStorage.removeItem(draftKey); } catch {}
      showStatus(isAnonymous
        ? "✅ Submitted! Anonymous recommendations are reviewed by admin before they go public."
        : "✅ Thank you! Your recommendation is live.");
      setTimeout(() => {
        closeReviewModal();
        closeFacultyProfile();
        window.location.reload();
      }, 1300);
    } catch (err) {
      console.error("[Faculty] review submit failed:", err);
      // A permission-denied here almost always means this student already
      // has a review on file for this faculty (see the doc-id trick above).
      if (String(err && err.code) === "permission-denied") {
        showStatus("It looks like you've already recommended this teacher — one recommendation per student per faculty.", true);
      } else {
        showStatus("Something went wrong: " + (err && err.message ? err.message : "please try again."), true);
      }
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Recommendation";
    }
  });
}

document.getElementById("review-modal-close")?.addEventListener("click", closeReviewModal);
document.getElementById("review-modal-overlay")?.addEventListener("click", (e) => {
  if (e.target.id === "review-modal-overlay") closeReviewModal();
});
function closeReviewModal() {
  document.getElementById("review-modal-overlay")?.classList.add("hidden");
  document.body.style.overflow = "";
}
