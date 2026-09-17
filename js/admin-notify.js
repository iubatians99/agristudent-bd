// ============================================
// ADMIN DEVICE NOTIFICATIONS
// ============================================
// Uses the browser's Notification API (no backend, no Cloud Functions,
// works on the free Firebase plan) to alert the admin the moment a new
// registration, term, or resource is submitted — as long as admin.html
// is open somewhere in their browser (it does NOT need to be the focused
// tab; the OS still shows the notification).
//
// LIMITATION: if the admin panel tab/browser is fully closed, nothing
// fires — that requires real push (Firebase Cloud Messaging + a Cloud
// Function on the paid Blaze plan), which this project does not have.
//
// Each watched collection gets its own Firestore onSnapshot listener.
// The first snapshot after the listener attaches just records which
// doc ids already exist (so re-opening the panel doesn't re-notify for
// old submissions); every doc added AFTER that fires a notification.
// ============================================
import { db } from "./firebase-config.js";
import { collection, query, orderBy, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const WATCHED = [
  { collection: "registrations", label: "Registration", icon: "📝",
    text: (d) => d.fullName || d.email || "New student registration" },
  { collection: "terms", label: "Term", icon: "📖",
    text: (d) => d.name || "New term submitted" },
  { collection: "resources", label: "Resource", icon: "📚",
    text: (d) => `${d.courseName || d.courseCode || "New resource"}${d.facultyName ? " — " + d.facultyName : ""}` },
  { collection: "classroomCodes", label: "Classroom Code", icon: "🔑",
    text: (d) => d.purpose === "materials_request" ? `Code for course materials: ${d.classroomCode || ""}` : `Unlock request: ${d.classroomCode || ""}` },
  { collection: "coffeeRequests", label: "Coffee Support", icon: "☕",
    text: (d) => `${d.fromName || d.fromEmail || "Student"} — Txn ${d.transactionId || ""}` }
];

let unreadCount = 0;
let started = false;
const baseTitle = document.title;
const unsubscribers = [];

function bumpTitle() {
  document.title = unreadCount > 0 ? `(${unreadCount}) ${baseTitle}` : baseTitle;
}

function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch { /* ignore — chime is a nice-to-have, never block on it */ }
}

function showToast(icon, label, body) {
  let wrap = document.getElementById("admin-notify-toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "admin-notify-toasts";
    wrap.style.cssText = "position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:.6rem;max-width:320px;";
    document.body.appendChild(wrap);
  }
  const toast = document.createElement("div");
  toast.style.cssText = "background:#fff;border:1px solid var(--line,#ddd);border-left:4px solid var(--leaf-500,#3F5B3D);border-radius:8px;padding:.7rem .9rem;box-shadow:0 8px 24px rgba(0,0,0,.12);font-size:.85rem;color:#222;animation:adminNotifyIn .2s ease-out;";
  toast.innerHTML = `<strong>${icon} New ${label}</strong><div style="margin-top:.2rem;color:#555;">${body}</div>`;
  wrap.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity .3s"; setTimeout(() => toast.remove(), 300); }, 8000);
}

function notify({ icon, label, body }) {
  unreadCount++;
  bumpTitle();
  playChime();
  showToast(icon, label, body);

  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const n = new Notification(`${icon} New ${label} — Agri Core Admin`, {
        body,
        icon: "assets/icon-192.png",
        tag: `agri-admin-${label}-${Date.now()}`
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some browsers throw if the page isn't allowed to construct Notification directly — ignore */ }
  }
}

function watch({ collection: name, label, icon, text }) {
  const q = query(collection(db, name), orderBy("submittedAt", "desc"));
  let knownIds = null;
  const unsub = onSnapshot(q, (snap) => {
    if (knownIds === null) {
      knownIds = new Set(snap.docs.map((d) => d.id));
      return;
    }
    snap.docChanges().forEach((change) => {
      if (change.type !== "added" || knownIds.has(change.doc.id)) return;
      knownIds.add(change.doc.id);
      const data = change.doc.data();
      const body = text(data);
      if (body) notify({ icon, label, body });
    });
  }, (err) => console.error(`[AdminNotify] ${name} listener failed:`, err));
  unsubscribers.push(unsub);
}

/** Clear the unread badge — call when the admin actually looks (tab focus / clicks bell). */
export function clearAdminNotifyBadge() {
  unreadCount = 0;
  bumpTitle();
}

/**
 * Start watching for new submissions and alerting the admin. Safe to call
 * more than once — only sets up listeners the first time.
 */
export function initAdminNotifications() {
  if (started) return;
  started = true;

  window.addEventListener("focus", clearAdminNotifyBadge);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") clearAdminNotifyBadge();
  });

  WATCHED.forEach(watch);
}

/** Stop all listeners — call on admin logout. */
export function stopAdminNotifications() {
  started = false;
  unsubscribers.splice(0).forEach((unsub) => { try { unsub(); } catch { /* ignore */ } });
  clearAdminNotifyBadge();
}

/**
 * Wire up a "🔔 Enable notifications" bell button. Browsers require a real
 * user gesture (a click) before they'll show the permission prompt, so this
 * must be triggered from a click handler rather than called automatically.
 */
export function initAdminNotifyBell(buttonEl) {
  if (!buttonEl || typeof Notification === "undefined") {
    if (buttonEl) buttonEl.classList.add("hidden");
    return;
  }

  function render() {
    if (Notification.permission === "granted") {
      buttonEl.textContent = "🔔 Notifications On";
      buttonEl.disabled = true;
      buttonEl.title = "You'll get a notification for every new registration, term, or resource submission while this tab is open.";
    } else if (Notification.permission === "denied") {
      buttonEl.textContent = "🔕 Notifications Blocked";
      buttonEl.disabled = true;
      buttonEl.title = "Notifications are blocked in your browser settings for this site — enable them from your browser's site settings to turn this back on.";
    } else {
      buttonEl.textContent = "🔔 Enable Notifications";
      buttonEl.disabled = false;
      buttonEl.title = "Get notified in this browser the moment a new registration, term, or resource comes in.";
    }
  }

  buttonEl.addEventListener("click", async () => {
    try {
      await Notification.requestPermission();
    } catch (err) {
      console.error("[AdminNotify] permission request failed:", err);
    }
    render();
  });

  render();
}
