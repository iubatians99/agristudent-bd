// ============================================
// UNIVERSAL SEARCH — homepage search bar
// Queries terms, resources (slides + previous questions),
// and timeline events live from Firestore, and shows a
// grouped results dropdown. Also handles the navbar search
// icon jumping here from any page.
// ============================================
import { db } from "./firebase-config.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.querySelector(".search-bar");
if (form) {
  const input = form.querySelector("input");
  const resultsBox = document.createElement("div");
  resultsBox.id = "search-results";
  resultsBox.className = "search-results hidden";
  form.appendChild(resultsBox);
  form.style.position = "relative";

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let cache = null; // { terms, slides, pq, timeline }
  let loading = null;

  async function loadData() {
    if (cache) return cache;
    if (loading) return loading;
    loading = (async () => {
      const [termsSnap, resourcesSnap, timelineSnap] = await Promise.all([
        getDocs(query(collection(db, "terms"), where("status", "==", "approved"))),
        getDocs(query(collection(db, "resources"), where("status", "==", "approved"))),
        getDocs(collection(db, "timeline"))
      ]);
      const terms = termsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const resources = resourcesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const timeline = timelineSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      cache = {
        terms,
        slides: resources.filter(r => r.resourceType === "slides_notes"),
        pq: resources.filter(r => r.resourceType === "previous_questions"),
        timeline
      };
      return cache;
    })();
    return loading;
  }

  function matches(text, needle) {
    return (text || "").toLowerCase().includes(needle);
  }

  function renderResults(data, q) {
    const needle = q.toLowerCase();
    const termHits = data.terms.filter(t => matches(t.name, needle)).slice(0, 5);
    const slideHits = data.slides.filter(r => matches(r.courseCode, needle) || matches(r.courseName, needle)).slice(0, 5);
    const pqHits = data.pq.filter(r => matches(r.courseCode, needle) || matches(r.courseName, needle)).slice(0, 5);
    const timelineHits = data.timeline.filter(e => matches(e.title, needle)).slice(0, 5);

    const total = termHits.length + slideHits.length + pqHits.length + timelineHits.length;

    if (!q) {
      resultsBox.classList.add("hidden");
      resultsBox.innerHTML = "";
      return;
    }

    if (total === 0) {
      resultsBox.innerHTML = `<div class="search-empty">No matches for "${esc(q)}" — try a different term or course code.</div>`;
      resultsBox.classList.remove("hidden");
      return;
    }

    let html = "";
    if (termHits.length) {
      html += `<div class="search-group-label">📖 Knowledge Hub</div>`;
      html += termHits.map(t => `<a class="search-result-item" href="knowledge-hub.html#term=${esc(t.id)}"><span>${esc(t.name)}</span></a>`).join("");
    }
    if (slideHits.length) {
      html += `<div class="search-group-label">📚 Slides & Notes</div>`;
      html += slideHits.map(r => `<a class="search-result-item" href="slides-notes.html?course=${esc(r.courseCode)}"><span>${esc(r.courseCode)}</span><small>${esc(r.courseName || "")}</small></a>`).join("");
    }
    if (pqHits.length) {
      html += `<div class="search-group-label">📝 Previous Questions</div>`;
      html += pqHits.map(r => `<a class="search-result-item" href="previous-questions.html?course=${esc(r.courseCode)}"><span>${esc(r.courseCode)}</span><small>${esc(r.courseName || "")}</small></a>`).join("");
    }
    if (timelineHits.length) {
      // Academic Timeline no longer has its own page — its content now
      // lives only on the homepage, so search results jump straight to
      // that embedded section instead of a separate timeline.html.
      html += `<div class="search-group-label">📅 Timeline</div>`;
      html += timelineHits.map(e => `<a class="search-result-item" href="#academic-timeline"><span>${esc(e.title)}</span></a>`).join("");
    }

    resultsBox.innerHTML = html;
    resultsBox.classList.remove("hidden");
  }

  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    debounceTimer = setTimeout(async () => {
      if (!q) { resultsBox.classList.add("hidden"); return; }
      resultsBox.innerHTML = `<div class="search-empty">Searching…</div>`;
      resultsBox.classList.remove("hidden");
      try {
        const data = await loadData();
        renderResults(data, q);
      } catch (err) {
        console.error("[Search] failed:", err);
        resultsBox.innerHTML = `<div class="search-empty">Search is unavailable right now. Please try again.</div>`;
      }
    }, 250);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Enter/submit just keeps the dropdown open with current results.
  });

  document.addEventListener("click", (e) => {
    if (!form.contains(e.target)) resultsBox.classList.add("hidden");
  });

  // If arriving with #search in the URL (from navbar icon, on any page —
  // including when already on the homepage), focus the box so the person
  // can type immediately.
  function focusIfSearchHash() {
    if (location.hash === "#search") {
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
    }
  }
  focusIfSearchHash();
  window.addEventListener("hashchange", focusIfSearchHash);
}
