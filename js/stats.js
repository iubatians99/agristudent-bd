// ============================================
// AGRI CORE — stats.js
// Pulls REAL, live counts from Firestore for the
// homepage stats strip (no more hardcoded numbers).
// ============================================
import { db } from "./firebase-config.js";
import {
  collection, query, where, getCountFromServer, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Map of element id -> function that returns a Firestore count query
const STAT_SOURCES = {
  "stat-users": () =>
    getCountFromServer(collection(db, "registrations")),

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

  "stat-pending": () =>
    getCountFromServer(query(collection(db, "resources"), where("status", "==", "pending"))),

  // NOTE: getCountFromServer() was unreliable here the same way it was for
  // "resources" above (see that comment) — it would silently fail and leave
  // the homepage stat stuck on "—". Switched to a plain getDocs() count,
  // matching the working "stat-resources" pattern.
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
