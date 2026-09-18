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
//   • `creditDebt` is a legacy one-off penalty that wiped the wallet to
//     zero at that moment without touching any underlying earned-credit
//     record. Superseded by `creditsResetAt` below for any account
//     restricted after that field was introduced, but the math still
//     honors an old `creditDebt` value on accounts that never got a
//     `creditsResetAt` stamp, so nobody's balance jumps the day this
//     shipped.
//   • `creditsResetAt` is the current restriction penalty (js/admin.js
//     restrictAccountById): being restricted even once makes the whole
//     account "start over" exactly as if it were a brand-new account —
//     the 5-credit welcome bonus is granted fresh, and every earn/spend
//     item from before that moment (uploads, approved classroom codes,
//     coffee grants, past unlocks) stops counting toward the balance AND
//     drops out of the visible breakdown/recentActivity, so it truly
//     looks and behaves like a new registration. Only earn/spend events
//     timestamped strictly after `creditsResetAt` (plus the fresh
//     welcome bonus) count. It's a permanent stamp, not cleared when the
//     restriction period ends — restricting the same account again later
//     just moves the stamp forward, resetting whatever was (re-)earned
//     since the last reset too.
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
 * @param {number} [params.creditDebt]    Raw legacy `creditDebt` value stored
 *                                         on the registration doc. Ignored
 *                                         whenever `creditsResetAt` is set —
 *                                         the two penalties never stack.
 * @param {*}      [params.creditsResetAt] Raw `creditsResetAt` value stored
 *                                         on the registration doc (an admin
 *                                         restriction penalty — see the
 *                                         module doc comment above). When
 *                                         set, every earn/spend item dated
 *                                         at or before this moment is
 *                                         excluded from the balance AND from
 *                                         `breakdown`/`recentActivity` — the
 *                                         welcome bonus is still granted, so
 *                                         the account reads exactly like a
 *                                         fresh registration.
 * @param {*}      [params.accountRestrictedAt] Raw `accountRestrictedAt`
 *                                         value stored on the registration
 *                                         doc. Fallback ONLY: used as the
 *                                         reset point when `creditsResetAt`
 *                                         itself isn't set — i.e. an account
 *                                         that was restricted before
 *                                         `creditsResetAt` existed, or by
 *                                         any path that only ever touched
 *                                         `accountRestrictedAt`. Ignored
 *                                         whenever `creditsResetAt` has a
 *                                         value.
 * @param {*}      [params.registrationDate] The registration doc's
 *                                         `submittedAt`, used only to date
 *                                         the "Welcome bonus" row in
 *                                         `recentActivity` — never affects
 *                                         the balance math.
 */
export function computeCreditWallet({
  resourceItems = [],
  classroomItems = [],
  manualItems = [],
  fileUnlockItems = [],
  registrationCredits = 0,
  creditDebt = 0,
  creditsResetAt = null,
  accountRestrictedAt = null,
  registrationDate = null
} = {}) {
  // accountRestrictedAt is a fallback ONLY — it covers an account that was
  // restricted before creditsResetAt existed (or currently sits restricted
  // under an older code path that never wrote creditsResetAt). Once such an
  // account goes through restrict/unrestrict again under the current code,
  // creditsResetAt gets written explicitly and takes over for good.
  const resetAtMs = toMs(creditsResetAt) || toMs(accountRestrictedAt);

  // Restricted-then-reset accounts get a fresh welcome bonus just like a
  // real new registration would — that's the point of the reset. Only
  // the historical items below get filtered by date; the bonus itself
  // always applies.
  const registrationBonus = Math.max(REGISTRATION_BONUS_CREDITS, Number(registrationCredits || 0));

  const countedResourceItems = resetAtMs
    ? resourceItems.filter(i => toMs(i.submittedAt) > resetAtMs)
    : resourceItems;
  const uploadCredits = countedResourceItems.reduce(
    (n, i) => n + (Array.isArray(i.fileUrls) ? i.fileUrls.length : 1),
    0
  );

  const countedClassroomItems = resetAtMs
    ? classroomItems.filter(i => toMs(i.approvedAt || i.submittedAt) > resetAtMs)
    : classroomItems;
  const approvedClassroomCodes = countedClassroomItems.filter(i => i.status === "approved");
  const classroomCredits = approvedClassroomCodes.length * CLASSROOM_CODE_CREDITS;

  const countedManualItems = resetAtMs
    ? manualItems.filter(i => toMs(i.grantedAt) > resetAtMs)
    : manualItems;
  const coffeeGrants = countedManualItems.filter(i => i.source === "coffee");
  const coffeeCredits = coffeeGrants.reduce((n, i) => n + Math.max(0, Number(i.creditsGranted || 0)), 0);

  // A fileUnlocks doc counts as "spent" unless it was written as a
  // *reward* for earning (an upload-triggered unlock or a classroom-code
  // grant) rather than a wallet withdrawal. Revoked unlocks still count —
  // see the module doc comment above.
  const countedFileUnlockItems = resetAtMs
    ? fileUnlockItems.filter(i => toMs(i.unlockedAt || i.submittedAt) > resetAtMs)
    : fileUnlockItems;
  const spentUnlocks = countedFileUnlockItems.filter(
    i => i.source !== "notes_earn" && i.source !== "classroom_earn"
  );
  const creditsUsed = spentUnlocks.length;

  // The legacy debt offset and the reset stamp are two different
  // generations of the same penalty — never apply both at once.
  const debt = resetAtMs ? 0 : Math.max(0, Number(creditDebt || 0));
  const creditsEarned = registrationBonus + uploadCredits + classroomCredits + coffeeCredits;
  const creditsRemaining = Math.max(0, creditsEarned - creditsUsed - debt);

  return {
    registrationBonus,
    uploadCredits,
    uploadFileCount: countedResourceItems.reduce((n, i) => n + (Array.isArray(i.fileUrls) ? i.fileUrls.length : 1), 0),
    classroomCredits,
    approvedClassroomCount: approvedClassroomCodes.length,
    coffeeCredits,
    coffeeGrantCount: coffeeGrants.length,
    creditsEarned,
    creditsUsed,
    creditDebt: debt,
    creditsResetAt: resetAtMs || null,
    creditsRemaining,
    // Human-readable breakdown for UI rendering — kept here so every
    // surface (profile, admin) shows the exact same line items in the
    // exact same order.
    breakdown: [
      { label: "Welcome bonus", amount: registrationBonus, icon: "🎁" },
      { label: "File uploads", amount: uploadCredits, icon: "⬆️", detail: `${countedResourceItems.length} contribution${countedResourceItems.length === 1 ? "" : "s"}` },
      { label: "Classroom codes", amount: classroomCredits, icon: "🏫", detail: approvedClassroomCodes.length ? `${approvedClassroomCodes.length} approved` : null },
      { label: "Coffee support", amount: coffeeCredits, icon: "☕", detail: coffeeGrants.length ? `${coffeeGrants.length} grant${coffeeGrants.length === 1 ? "" : "s"}` : null }
    ].filter(row => row.amount > 0 || row.label === "Welcome bonus"),
    // The 5 most recent earn/spend events, newest first — a real
    // chronological feed rather than the category totals in `breakdown`
    // above (which is still returned for anything that wants the old
    // rollup view). Every event carries its own date, so mixing earns and
    // uses in one list and slicing to 5 is safe. Pre-reset items are
    // already excluded via the `counted*Items` lists above, and the
    // Welcome bonus is re-dated to the reset moment so the feed reads
    // exactly like a brand-new account's activity.
    recentActivity: buildRecentActivity({
      resourceItems: countedResourceItems,
      classroomItems: countedClassroomItems,
      manualItems: countedManualItems,
      fileUnlockItems: countedFileUnlockItems,
      registrationBonus, registrationDate: resetAtMs || registrationDate
    })
  };
}

function toMs(val) {
  if (!val) return 0;
  if (typeof val === "number") return val;
  if (typeof val?.toDate === "function") return val.toDate().getTime();
  if (typeof val?.seconds === "number") return val.seconds * 1000;
  const parsed = new Date(val).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildRecentActivity({ resourceItems, classroomItems, manualItems, fileUnlockItems, registrationBonus, registrationDate }) {
  const events = [];

  events.push({
    type: "earn", icon: "🎁", label: "Welcome bonus",
    amount: registrationBonus, dateMs: toMs(registrationDate)
  });

  resourceItems.forEach(i => {
    const n = Array.isArray(i.fileUrls) ? i.fileUrls.length : 1;
    events.push({
      type: "earn", icon: "⬆️",
      label: i.courseCode ? `Uploaded to ${i.courseCode}` : "File upload",
      amount: n, dateMs: toMs(i.submittedAt)
    });
  });

  classroomItems.filter(i => i.status === "approved").forEach(i => {
    events.push({
      type: "earn", icon: "🏫",
      label: i.classroomCode ? `Classroom code ${i.classroomCode} approved` : "Classroom code approved",
      amount: CLASSROOM_CODE_CREDITS, dateMs: toMs(i.approvedAt || i.submittedAt)
    });
  });

  manualItems.filter(i => i.source === "coffee").forEach(i => {
    const amount = Math.max(0, Number(i.creditsGranted || 0));
    if (amount <= 0) return;
    events.push({
      type: "earn", icon: "☕", label: "Coffee support grant",
      amount, dateMs: toMs(i.grantedAt)
    });
  });

  fileUnlockItems
    .filter(i => i.source !== "notes_earn" && i.source !== "classroom_earn")
    .forEach(i => {
      events.push({
        type: "use", icon: "🔓", label: "Unlocked a file",
        amount: 1, dateMs: toMs(i.unlockedAt || i.submittedAt)
      });
    });

  return events.sort((a, b) => b.dateMs - a.dateMs).slice(0, 5);
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
    creditDebt: regData.creditDebt,
    creditsResetAt: regData.creditsResetAt,
    accountRestrictedAt: regData.accountRestrictedAt,
    registrationDate: regData.submittedAt
  });
}
