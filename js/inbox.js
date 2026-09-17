// ============================================
// ADMIN → STUDENT INBOX
// ============================================
// A lightweight one-way messaging channel: an admin searches for a
// registered student in the admin panel ("Notify User") and sends them a
// short message, which shows up in that student's Profile → Inbox. The
// admin can see, per message, whether the student has opened it yet
// (and exactly when they did) — same "seen" idea as any chat app, just
// without real-time delivery (no push/Cloud Functions on this project's
// free Firebase plan — see js/admin-notify.js for that limitation).
//
// Collection: adminMessages/{id}
//   toRegId    — registrations/{id} of the recipient
//   toEmail    — recipient email (denormalized, for display)
//   toName     — recipient name at send time (denormalized, for display)
//   body       — message text
//   sentBy     — admin's email (from Firebase Auth)
//   sentAt     — serverTimestamp()
//   read       — false until the student opens it
//   readAt     — serverTimestamp() the moment they do
// ============================================
import { db } from "./firebase-config.js";
import {
  collection, addDoc, getDocs, query, where, orderBy, doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const COLLECTION = "adminMessages";

/** Admin panel only — composes and sends a new message to one student. */
export async function sendMessageToUser({ toRegId, toEmail, toName, body, sentBy, subject }) {
  if (!toRegId || !toEmail) throw new Error("No recipient selected.");
  if (!body || !body.trim()) throw new Error("Please write a message.");

  return addDoc(collection(db, COLLECTION), {
    toRegId,
    toEmail,
    toName: toName || "",
    subject: subject || "Message from Agri Core Admin",
    body: body.trim(),
    sentBy: sentBy || "",
    sentAt: serverTimestamp(),
    read: false,
    readAt: null
  });
}

/** Admin panel only — every message ever sent, newest first, for the "Sent Messages" list. */
export async function fetchAllSentMessages() {
  const q = query(collection(db, COLLECTION), orderBy("sentAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Student's own inbox — every message sent to their regId, newest first. */
export async function fetchMessagesForUser(regId) {
  if (!regId) return [];
  const q = query(collection(db, COLLECTION), where("toRegId", "==", regId));
  const snap = await getDocs(q);
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.sentAt?.toMillis?.() || 0) - (a.sentAt?.toMillis?.() || 0));
}

/** Marks one message as read — called the moment a student opens it. */
export async function markMessageRead(id) {
  if (!id) return;
  await updateDoc(doc(db, COLLECTION, id), { read: true, readAt: serverTimestamp() });
}

/** DD/MM/YYYY, HH:MM — used everywhere a message timestamp is shown, admin or student side. */
export function formatMessageDateTime(val) {
  const d = val?.toDate ? val.toDate() : (val instanceof Date ? val : new Date(val));
  if (!d || Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${d.getFullYear()}, ${hh}:${mm}`;
}
