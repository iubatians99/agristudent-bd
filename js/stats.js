// ============================================
// AGRI CORE — stats.js
// Pulls REAL, live counts from Firestore for the
// homepage stats strip (no more hardcoded numbers).
// ============================================
import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Shared, memoised snapshots of the two big collections. js/section-updates.js
// (the homepage "this section has new content" blink) needs the same docs, so
// both files share ONE read instead of each paying for its own.
let approvedTermsSnapPromise = null;
let approvedResourcesSnapPromise = null;

export function getApprovedTermsSnap() {
  if (!approvedTermsSnapPromise) {
    approvedTermsSnapPromise = getDocs(
      query(collection(db, "terms"), where("status", "==", "approved"))
    );
  }
  return approvedTermsSnapPromise;
}

export function getApprovedResourcesSnap() {
  if (!approvedResourcesSnapPromise) {
    approvedResourcesSnapPromise = getDocs(
      query(collection(db, "resources"), where("status", "==", "approved"))
    );
  }
  return approvedResourcesSnapPromise;
}

// Map of element id -> function that returns a Firestore count query
//
// NOTE: every stat here now uses a plain getDocs() count instead of
// getCountFromServer(). The aggregation call (getCountFromServer) turned out
// to be unreliable for this project — it would intermittently/silently fail
// and leave a homepage stat stuck on its "—" placeholder even though the
// exact same query works fine with getDocs() (as already proven by
// js/knowledge-hub.js for terms, and by the pre-existing "stat-resources"
// count below). Standardizing all four stats on getDocs() avoids that
// failure mode across the board.
const STAT_SOURCES = {
  "stat-users": async () => {
    const docsSnap = await getDocs(collection(db, "registrations"));
    return { data: () => ({ count: docsSnap.size }) };
  },

  "stat-resources": async () => {
    // Count actual approved files (not submission/folder documents).
    // PDFs, PPT/PPTX and uploaded images all contribute one count per file.
    const docsSnap = await getApprovedResourcesSnap();
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
    const docsSnap = await getDocs(
      query(collection(db, "resources"), where("status", "==", "pending"))
    );
    return { data: () => ({ count: docsSnap.size }) };
  },

  "stat-terms": async () => {
    const docsSnap = await getApprovedTermsSnap();
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
