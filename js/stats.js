// ============================================
// AGRI CORE — stats.js
// Pulls REAL, live counts from Firestore for the
// homepage stats strip (no more hardcoded numbers).
// ============================================
import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// "stat-users" and "stat-pending" need a full scan of collections that
// are (correctly) locked down to admin-only reads in firestore.rules —
// registrations and facultyReviews both hold private student data, so
// the browser can never be allowed to query them directly. Instead,
// scripts/update-public-stats.mjs runs server-side with the Admin SDK
// (bypassing rules) and writes ONLY the two resulting counts to the
// public, read-only publicStats/counts document — no individual
// record is ever exposed to the client. Both stats below share that
// one lightweight read instead of two.
let publicStatsPromise = null;
function loadPublicStats() {
  if (!publicStatsPromise) {
    publicStatsPromise = getDoc(doc(db, "publicStats", "counts"))
      .then(snap => (snap.exists() ? snap.data() : {}))
      .catch(() => ({}));
  }
  return publicStatsPromise;
}

// Map of element id -> function that returns a Firestore count query
//
// NOTE: stat-resources and stat-terms use a plain getDocs() count
// instead of getCountFromServer(). The aggregation call
// (getCountFromServer) turned out to be unreliable for this project —
// it would intermittently/silently fail and leave a homepage stat
// stuck on its "—" placeholder even though the exact same query works
// fine with getDocs() (as already proven by js/knowledge-hub.js for
// terms). stat-users/stat-pending instead read the pre-aggregated
// publicStats/counts document described above.
const STAT_SOURCES = {
  "stat-users": async () => {
    const stats = await loadPublicStats();
    return { data: () => ({ count: stats.registeredUsers || 0 }) };
  },

  "stat-resources": async () => {
    // Count actual approved files (not submission/folder documents).
    // PDFs, PPT/PPTX and uploaded images all contribute one count per file.
    const docsSnap = await getDocs(
      query(collection(db, "resources"), where("status", "==", "approved"))
    );
    const imageExts = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)$/i;
    const docExts = /\.(pdf|ppt|pptx)$/i;
    let total = 0;
    docsSnap.forEach(d => {
      const item = d.data();
      const files = Array.isArray(item.fileUrls) ? item.fileUrls : [];
      const type = String(item.fileType || "").toLowerCase();
      total += files.filter(f => {
        const name = String(f?.name || "");
        return type === "pdf" || type === "ppt" || type === "image" || docExts.test(name) || imageExts.test(name);
      }).length;
    });
    return { data: () => ({ count: total }) };
  },

  "stat-pending": async () => {
    const stats = await loadPublicStats();
    return { data: () => ({ count: stats.pendingReviews || 0 }) };
  },

  "stat-terms": async () => {
    const docsSnap = await getDocs(
      query(collection(db, "terms"), where("status", "==", "approved"))
    );
    return { data: () => ({ count: docsSnap.size }) };
  }
};

function animateCount(el, target) {
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced || target <= 0) {
    el.textContent = target.toLocaleString() + "+";
    return;
  }
  let current = 0;
  const duration = 1200;
  const stepTime = 16;
  const steps = duration / stepTime;
  const increment = target / steps;
  const timer = setInterval(() => {
    current += increment;
    if (current >= target) {
      el.textContent = target.toLocaleString() + "+";
      clearInterval(timer);
    } else {
      el.textContent = Math.floor(current).toLocaleString() + "+";
    }
  }, stepTime);
}

document.addEventListener("DOMContentLoaded", async () => {
  await Promise.all(
    Object.entries(STAT_SOURCES).map(async ([id, getCount]) => {
      const el = document.getElementById(id);
      if (!el) return;
      try {
        const snap = await getCount();
        animateCount(el, snap.data().count);
      } catch (err) {
        console.error(`Failed to load live stat for #${id}:`, err);
        el.textContent = "—";
      }
    })
  );
});
