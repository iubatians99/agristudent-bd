// ============================================
// CREDIT WALLET — single source of truth for how a student's credit
// balance is calculated.
//
// Before this file existed, the exact same math was hand-copied in THREE
// places (js/profile.js renderCredits, js/admin.js computeCreditsBalance,
// js/resources.js hnGetRemainingCredits) and had already drifted out of
// sync at least once (see the historical note in computeCreditWallet
// below) — one copy silently zeroed every upload-earned credit while the
// other two still showed the correct total. Whenever the three copies
// don't agree, the number shown to the student is effectively random
// depending on which page they're looking at. Centralizing the formula
// here means there is exactly one place left to get it right.
//
// EARNING RULES (see also README / product spec):
//   • Registration bonus  — every registered student starts with 5 free
//                            credits (a floor, never reduced).
//   • File upload         — +1 credit per file uploaded via "⬆️ Upload
//                            Your Resource" (Hand Notes / Class Slides /
//                            Images), regardless of moderation outcome —
//                            the reward is for contributing, not for
//                            passing review. A 5-file upload = 5 credits.
//   • Classroom code      — +10 credits once an admin APPROVES the code
//                            submitted via "🏫 Send Us Classroom Code".
//                            A locked/pending/rejected code earns 0.
//   • Buy Admin a Coffee  — the admin decides the exact amount when
//                            approving a coffee-support request; stored
//                            per-grant as `creditsGranted`.
//
// SPENDING RULES:
//   • Unlocking one resource file costs 1 credit (see
//     js/resources.js `window.__tryUseResourceCredit`), which writes a
//     `fileUnlocks` doc with source:"credit". That doc is what "used"
//     counts — permanently, even if the unlock is later revoked (e.g. by
//     an admin account restriction) — because the credit really was
//     spent at that moment; revoking access later doesn't refund it.
//   • `fileUnlocks` docs created as a SIDE EFFECT of earning (uploading
//     to instantly unlock one specific gated file, or an approved
//     classroom code granting access) are tagged source:"notes_earn" /
//     "classroom_earn" and never counted as spending — no credit was
//     drawn from the wallet for those.
//   • `creditDebt` is a one-off penalty an admin can apply (lifting an
//     account restriction — js/admin.js) that wipes the wallet to zero
//     at that moment without touching any underlying earned-credit
//     record. It is stored as a running offset on the registration doc
//     and subtracted from every future balance calculation.
// ============================================

/** Every registered account is guaranteed at least this many credits. */
export const REGISTRATION_BONUS_CREDITS = 5;
/** Credits awarded for one approved Classroom Code submission. */
export const CLASSROOM_CODE_CREDITS = 10;

/**
 * Pure calculation — takes already-fetched Firestore-shaped items and
 * returns a fully itemised wallet. No network calls happen in here, so
 * this same function can run against a fresh fetch (admin.js) or an
 * already-cached in-memory list (resources.js `window.__hnAccessItems`)
 * without duplicating the actual math in either place.
 *
 * @param {object} params
 * @param {Array}  params.resourceItems   Docs from the "resources" collection
 *                                         belonging to this student (any status).
 *                                         Each may have `fileUrls: [...]`.
 * @param {Array}  params.classroomItems  Docs from "classroomCodes" belonging
 *                                         to this student. Each has `status`.
 * @param {Array}  params.manualItems     Docs from "manualUnlocks" belonging to
 *                                         this student. Coffee grants have
 *                                         `source === "coffee"` and `creditsGranted`.
 * @param {Array}  params.fileUnlockItems Docs from "fileUnlocks" belonging to
 *                                         this student. Each has `source`.
 * @param {number} [params.registrationCredits] Raw value stored on the
 *                                         registration doc (defaults applied
 *                                         internally — always floored at 5).
 * @param {number} [params.creditDebt]    Raw `creditDebt` value stored on the
 *                                         registration doc.
 */
export function computeCreditWallet({
  resourceItems = [],
  classroomItems = [],
  manualItems = [],
  fileUnlockItems = [],
  registrationCredits = 0,
  creditDebt = 0
} = {}) {
  const registrationBonus = Math.max(REGISTRATION_BONUS_CREDITS, Number(registrationCredits || 0));

  const uploadCredits = resourceItems.reduce(
    (n, i) => n + (Array.isArray(i.fileUrls) ? i.fileUrls.length : 1),
    0
  );

  const approvedClassroomCodes = classroomItems.filter(i => i.status === "approved");
  const classroomCredits = approvedClassroomCodes.length * CLASSROOM_CODE_CREDITS;

  const coffeeGrants = manualItems.filter(i => i.source === "coffee");
  const coffeeCredits = coffeeGrants.reduce((n, i) => n + Math.max(0, Number(i.creditsGranted || 0)), 0);

  // A fileUnlocks doc counts as "spent" unless it was written as a
  // *reward* for earning (an upload-triggered unlock or a classroom-code
  // grant) rather than a wallet withdrawal. Revoked unlocks still count —
  // see the module doc comment above.
  const spentUnlocks = fileUnlockItems.filter(
    i => i.source !== "notes_earn" && i.source !== "classroom_earn"
  );
  const creditsUsed = spentUnlocks.length;

  const debt = Math.max(0, Number(creditDebt || 0));
  const creditsEarned = registrationBonus + uploadCredits + classroomCredits + coffeeCredits;
  const creditsRemaining = Math.max(0, creditsEarned - creditsUsed - debt);

  return {
    registrationBonus,
    uploadCredits,
    uploadFileCount: resourceItems.reduce((n, i) => n + (Array.isArray(i.fileUrls) ? i.fileUrls.length : 1), 0),
    classroomCredits,
    approvedClassroomCount: approvedClassroomCodes.length,
    coffeeCredits,
    coffeeGrantCount: coffeeGrants.length,
    creditsEarned,
    creditsUsed,
    creditDebt: debt,
    creditsRemaining,
    // Human-readable breakdown for UI rendering — kept here so every
    // surface (profile, admin) shows the exact same line items in the
    // exact same order.
    breakdown: [
      { label: "Welcome bonus", amount: registrationBonus, icon: "🎁" },
      { label: "File uploads", amount: uploadCredits, icon: "⬆️", detail: `${resourceItems.length} contribution${resourceItems.length === 1 ? "" : "s"}` },
      { label: "Classroom codes", amount: classroomCredits, icon: "🏫", detail: approvedClassroomCodes.length ? `${approvedClassroomCodes.length} approved` : null },
      { label: "Coffee support", amount: coffeeCredits, icon: "☕", detail: coffeeGrants.length ? `${coffeeGrants.length} grant${coffeeGrants.length === 1 ? "" : "s"}` : null }
    ].filter(row => row.amount > 0 || row.label === "Welcome bonus")
  };
}

/**
 * Convenience fetch-and-compute wrapper for callers that don't already
 * have the underlying docs in memory (admin.js, and profile.js for the
 * registration-doc fields). Callers that already fetched resources /
 * classroomCodes / manualUnlocks / fileUnlocks for another reason (e.g.
 * to also render access-time / upload lists) should call
 * computeCreditWallet() directly with those same docs instead of
 * fetching everything twice.
 */
export async function fetchCreditWallet(db, firestoreFns, email) {
  const { collection, query, where, getDocs, doc, getDoc } = firestoreFns;
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return computeCreditWallet({});

  const safeDocs = async (q) => {
    try { const snap = await getDocs(q); return snap.docs.map(d => ({ id: d.id, ...d.data() })); }
    catch (err) { console.warn("[Credits] query failed:", err); return []; }
  };

  const [resourceItems, classroomItems, manualItems, fileUnlockItems, regDocs] = await Promise.all([
    safeDocs(query(collection(db, "resources"), where("uploaderEmail", "==", normalized))),
    safeDocs(query(collection(db, "classroomCodes"), where("fromEmail", "==", normalized))),
    safeDocs(query(collection(db, "manualUnlocks"), where("fromEmail", "==", normalized))),
    safeDocs(query(collection(db, "fileUnlocks"), where("fromEmail", "==", normalized))),
    safeDocs(query(collection(db, "registrations"), where("email", "==", normalized)))
  ]);

  const regData = regDocs[0] || {};
  return computeCreditWallet({
    resourceItems,
    classroomItems,
    manualItems,
    fileUnlockItems,
    registrationCredits: regData.registrationCredits,
    creditDebt: regData.creditDebt
  });
}
