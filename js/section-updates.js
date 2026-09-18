// ============================================
// AGRI CORE — section-updates.js (homepage only)
//
// Makes a homepage section card blink slowly when that section has content
// the visitor hasn't seen yet: a new/approved term (Knowledge Hub), a new or
// edited event (Academic Timeline), a newly approved resource (Resources),
// or a new/edited post (Blog).
//
// How it decides:
//   • newest update time per section  (computed below from Firestore)
//   • vs. when THIS browser last opened that section (js/main.js keeps that in
//     localStorage as `agri_section_seen_v1`)
//   • newer content than last visit  →  card gets `.has-update` (blinks)
//   • opening the section (card click or any other route to the page) clears it
//
// First-ever visit starts a baseline at "now", so a new visitor isn't greeted
// by four blinking cards for content that was already there.
//
// Static sections (Calculators, Ask For Help) have no Firestore data. To make
// one of those blink after you change it, put the date on its card in
// index.html, e.g.  <a ... data-section="calculators" data-updated="2026-10-01">
// ============================================
import { db } from "./firebase-config.js";
import {
  collection, query, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getApprovedTermsSnap, getApprovedResourcesSnap } from "./stats.js";
import { getSession } from "./session.js";
import { normalizeEmail } from "./identity.js";

const cards = Array.from(document.querySelectorAll(".seed-card[data-section]"));
const seenStore = window.AgriSectionSeen;

// Which timestamp fields count as "this section changed" for each collection.
// (Blog deliberately ignores reviewedAt: an admin approving a post that was
// already visible as "Not verified" isn't new content for readers.)
const FIELDS = {
  knowledge: ["reviewedAt", "editedAt", "submittedAt", "createdAt"],
  resources: ["reviewedAt", "editedAt", "submittedAt", "uploadedAt"],
  timeline: ["createdAt", "editedAt"],
  blog: ["createdAt", "editedAt"]
};

function toMillis(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();   // Firestore Timestamp
  if (typeof val.toDate === "function") return val.toDate().getTime();
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number") return val;
  const parsed = Date.parse(val);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newestIn(docs, fields, skip) {
  let newest = 0;
  docs.forEach((d) => {
    const data = d.data();
    if (skip && skip(data)) return;
    fields.forEach((f) => { newest = Math.max(newest, toMillis(data[f])); });
  });
  return newest;
}

// One entry per section. Each resolves to a millisecond timestamp (0 = nothing
// known). A failed lookup resolves to 0, so a Firestore hiccup can never make
// a card blink by mistake — and never breaks the rest of the page.
const LOOKUPS = {
  knowledge: async () => newestIn((await getApprovedTermsSnap()).docs, FIELDS.knowledge),

  resources: async () => newestIn((await getApprovedResourcesSnap()).docs, FIELDS.resources),

  timeline: async () => {
    const snap = await getDocs(collection(db, "timeline"));
    return newestIn(snap.docs, FIELDS.timeline);
  },

  blog: async () => {
    // Newest 20 posts is plenty to spot "something new" and keeps reads tiny.
    const snap = await getDocs(query(collection(db, "blogPosts"), orderBy("createdAt", "desc"), limit(20)));
    const me = normalizeEmail(getSession()?.email);
    return newestIn(snap.docs, FIELDS.blog, (post) =>
      post.status === "rejected" ||                                   // hidden from the public feed
      (me && normalizeEmail(post.authorEmail) === me)                 // your own post isn't "news" to you
    );
  }
};

function manualUpdateStamp(card) {
  const raw = card.getAttribute("data-updated");
  return raw ? toMillis(raw) : 0;
}

async function init() {
  if (!cards.length || !seenStore) return;

  const seen = seenStore.ensureBaseline(cards.map((c) => c.dataset.section));
  const latest = {};

  await Promise.all(cards.map(async (card) => {
    const key = card.dataset.section;
    let newest = manualUpdateStamp(card);
    if (LOOKUPS[key]) {
      try {
        newest = Math.max(newest, await LOOKUPS[key]());
      } catch (err) {
        console.warn(`[section-updates] could not check "${key}" for updates:`, err);
      }
    }
    latest[key] = newest;
    if (newest > (seen[key] || 0)) markUpdated(card);
  }));

  // Opening a section from its card clears the blink straight away (the page
  // itself also records the visit, this just covers new-tab / fast-back cases).
  cards.forEach((card) => {
    const clear = () => {
      seenStore.mark(card.dataset.section, latest[card.dataset.section]);
      card.classList.remove("has-update");
    };
    card.addEventListener("click", clear);
    card.addEventListener("auxclick", clear);
  });
}

function markUpdated(card) {
  card.classList.add("has-update");
  // Screen-reader equivalent of the visual blink.
  const heading = card.querySelector("h3");
  if (heading && !heading.querySelector(".visually-hidden")) {
    const note = document.createElement("span");
    note.className = "visually-hidden";
    note.textContent = " — updated since your last visit";
    heading.appendChild(note);
  }
}

init().catch((err) => console.warn("[section-updates] failed:", err));
