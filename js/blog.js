// ============================================
// AGRI CORE — blog.js (ENHANCED)
// Facebook-style student timeline with gallery image support
// ============================================
import { db, CLOUDINARY_UPLOAD_URL, CLOUDINARY_UPLOAD_PRESET } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, getDoc, setDoc,
  query, orderBy, limit, startAfter, getDocs, where, serverTimestamp, increment, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { normalizeEmail } from "./identity.js";
import { getSession } from "./session.js";
import { initEmailNotifications } from "./email-config.js";

initEmailNotifications();

const PAGE_SIZE = 8;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024; // 8MB per image
const MAX_IMAGES_PER_POST = 10;

// ============================================
// ESCAPE HELPER
// ============================================
function esc(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ============================================
// RICH-TEXT SANITIZER
// ============================================
const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "BR", "P", "DIV", "UL", "OL", "LI", "SPAN", "IMG"]);
const ALLOWED_WRAPPER_CLASSES = ["inline-image", "align-left", "align-right", "align-center", "align-none"];
// Only ever trust image URLs we uploaded ourselves (Cloudinary) — never a user-supplied src.
const TRUSTED_IMAGE_SRC = /^https:\/\/res\.cloudinary\.com\//;

function sanitizeNode(node, out) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(esc(node.textContent));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tag = node.tagName;

  // Word-doc import support: headings, links, and tables aren't part of
  // the composer's own toolbar, so they're not in ALLOWED_TAGS — but a
  // .docx pasted in via the 📎 importer produces them constantly, and
  // dropping them down to bare unwrapped text (the generic fallback
  // below) would flatten every heading and table into a run-on paragraph.
  // These four tags get their own lightweight mapping onto the existing
  // allowed set instead, so the imported formatting mostly survives.
  if (/^H[1-6]$/.test(tag)) {
    out.push("<p><strong>");
    node.childNodes.forEach(child => sanitizeNode(child, out));
    out.push("</strong></p>");
    return;
  }
  if (tag === "A") {
    const href = node.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      out.push(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">`);
      node.childNodes.forEach(child => sanitizeNode(child, out));
      out.push("</a>");
    } else {
      node.childNodes.forEach(child => sanitizeNode(child, out)); // unsafe/relative href — keep the text, drop the link
    }
    return;
  }
  if (tag === "TABLE" || tag === "TBODY" || tag === "THEAD") {
    node.childNodes.forEach(child => sanitizeNode(child, out));
    return;
  }
  if (tag === "TR") {
    let cellIndex = 0;
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === "TD" || child.tagName === "TH")) {
        if (cellIndex > 0) out.push(" &nbsp;|&nbsp; ");
        cellIndex++;
      }
      sanitizeNode(child, out);
    });
    out.push("<br>");
    return;
  }
  if (tag === "TD" || tag === "TH") {
    node.childNodes.forEach(child => sanitizeNode(child, out));
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    node.childNodes.forEach(child => sanitizeNode(child, out));
    return;
  }

  if (tag === "BR") { out.push("<br>"); return; }

  if (tag === "IMG") {
    const src = node.getAttribute("src") || "";
    if (!TRUSTED_IMAGE_SRC.test(src)) return; // drop anything that isn't one of our uploads
    const alt = esc(node.getAttribute("alt") || "Post image");
    out.push(`<img src="${esc(src)}" alt="${alt}" loading="lazy">`);
    return;
  }

  if (tag === "DIV") {
    const classes = (node.getAttribute("class") || "")
      .split(/\s+/)
      .filter(c => ALLOWED_WRAPPER_CLASSES.includes(c));

    if (classes.includes("inline-image")) {
      let styleAttr = "";
      const width = node.style && node.style.width;
      if (width && /^\d{2,4}px$/.test(width)) styleAttr = ` style="width:${width}"`;
      out.push(`<div class="${classes.join(" ")}"${styleAttr}>`);
      node.childNodes.forEach(child => sanitizeNode(child, out));
      out.push("</div>");
      return;
    }

    out.push("<div>");
    node.childNodes.forEach(child => sanitizeNode(child, out));
    out.push("</div>");
    return;
  }

  const openTag = tag.toLowerCase();
  out.push(`<${openTag}>`);
  node.childNodes.forEach(child => sanitizeNode(child, out));
  out.push(`</${openTag}>`);
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  // Strip composer-only UI chrome (resize handle, delete/align buttons) before sanitizing content
  template.content.querySelectorAll(".inline-image-resize, .inline-image-delete, .inline-image-toolbar, .inline-image-spinner, button").forEach(el => el.remove());
  template.content.querySelectorAll(".inline-image").forEach(el => el.classList.remove("selected", "is-uploading", "dragging"));
  const out = [];
  template.content.childNodes.forEach(node => sanitizeNode(node, out));
  return out.join("").trim();
}

function plainTextLength(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || "").trim().length;
}

// ============================================
// TIME-AGO HELPER
// ============================================
function timeAgo(date) {
  if (!date) return "Just now";
  const now = Date.now();
  const elapsed = now - date.getTime();
  const secs = Math.floor(elapsed / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (secs < 60) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ============================================
// SESSION & AUTH HELPERS
// ============================================
function requireSession() {
  const s = getSession();
  if (!s) {
    alert("You must be logged in to do that.");
    window.location.href = "login.html";
  }
  return s;
}

// ============================================
// VIEW TRACKING
// A view is counted every time a visitor genuinely sees the post — there
// is no localStorage/24h dedupe here on purpose: opening the same blog
// again (new tab, refresh, coming back later the same day) should add a
// fresh view each time, exactly like the like/comment counters treat
// each new action as new. The only thing guarded against is a SINGLE
// viewing being counted more than once (see activeViewTrackers below).
// ============================================

// Page-wide registry of the ONE active dwell-timer/observer pair per post
// id (see the long comment inside renderPostCard for why this exists —
// short version: prevents a single real view from bumping the Firestore
// counter more than once when the same post is rendered in more than one
// place, or a feed reset leaves an old tracker running against a
// now-removed DOM node).
const activeViewTrackers = new Map();

function stopViewTracking(id) {
  const tracker = activeViewTrackers.get(id);
  if (!tracker) return;
  if (tracker.timer) clearTimeout(tracker.timer);
  if (tracker.observer) tracker.observer.disconnect();
  activeViewTrackers.delete(id);
}

function stopAllViewTracking() {
  activeViewTrackers.forEach((tracker) => {
    if (tracker.timer) clearTimeout(tracker.timer);
    if (tracker.observer) tracker.observer.disconnect();
  });
  activeViewTrackers.clear();
}

// ============================================
// LIVE STATS SYNC (views / likes / comments / shares)
// ------------------------------------------------------------------
// FIX — reactions looked "stuck": the feed only ever fetched each post's
// counters ONCE, the moment the page loaded (a plain getDocs call, not a
// live listener). So if you kept a tab open and watched it while a
// DIFFERENT, genuinely distinct student reacted from their own device,
// your screen never found out — the write went through and Firestore's
// number really did go up, you just weren't subscribed to hear about it.
// Two people testing on two screens at once will always look "capped at
// N" under a one-time-fetch model, no matter how high N actually is.
//
// Fix: each rendered post subscribes to a live onSnapshot() listener on
// its OWN blogPosts/{id} document (one listener per unique post id on
// screen, not per DOM node — a post can be rendered twice at once, as a
// pinned deep link + its normal feed slot). Every time ANY user's
// like/view/comment/share write lands, every open browser with that
// post visible updates its numbers immediately, and every rendered copy
// of that same post (pinned + feed) is kept in sync together — matching
// the same "update every copy" approach bumpView already used for views.
// ============================================
const activeStatsListeners = new Map();

function stopStatsListening(id) {
  const unsub = activeStatsListeners.get(id);
  if (!unsub) return;
  unsub();
  activeStatsListeners.delete(id);
}

function stopAllStatsListening() {
  activeStatsListeners.forEach(unsub => unsub());
  activeStatsListeners.clear();
}

function applyLiveStats(id, data) {
  document.querySelectorAll(`.blog-post-card[data-id="${id}"]`).forEach(card => {
    const stats = card.querySelector(".blog-post-stats");
    // Views is intentionally NOT live-synced here (see bumpView below) —
    // the number a visitor sees should stay put for their whole visit
    // and only reflect the new total the next time they open the post.
    const likeCountEl = card.querySelector(".blog-like-count");
    if (likeCountEl) likeCountEl.textContent = `❤️ ${data.likesCount || 0}`;
    const commentCountEl = card.querySelector(".blog-comment-count");
    if (commentCountEl) commentCountEl.textContent = `💬 ${data.commentsCount || 0}`;
    if (stats && stats.children[3]) stats.children[3].textContent = `↗️ ${data.sharesCount || 0}`;
  });
}

function subscribeToLiveStats(id) {
  if (activeStatsListeners.has(id)) return; // already listening for this post — every DOM copy is updated by applyLiveStats anyway
  const unsub = onSnapshot(doc(db, "blogPosts", id), (snap) => {
    if (!snap.exists()) return;
    applyLiveStats(id, snap.data());
  }, (err) => {
    console.error("[Blog] live stats listener failed:", err);
  });
  activeStatsListeners.set(id, unsub);
}

// ============================================
// LIKE STATE — per registered student, via Firestore (not a browser flag)
// ------------------------------------------------------------------
// Reacting stays login-gated (only a registered student can react) —
// but the "only 2 of 5 test accounts could react, the 3rd showed as
// already-reacted" bug was real and is separate from the login gate.
//
// ROOT CAUSE: myLikedPostIds (the "have I liked this post?" set) was
// only ever fetched ONCE, the moment blog.html's script first ran, for
// whichever account was logged in at that exact instant. If the active
// account changed after that WITHOUT a fresh script run — logging in as
// a different account in another tab (same browser, same localStorage
// session key), or the browser restoring this tab from back/forward
// cache instead of truly reloading it — every like button kept judging
// "already liked?" against the FIRST account's like docs. So the next
// real click, made under account 2 or 3, could see a post as already
// liked (because account 1 had liked it) and fire an "unlike" for a
// like that account never made — deleting nothing (silent no-op) but
// still decrementing likesCount, and leaving that account permanently
// stuck looking "already reacted" on that post.
//
// FIX: track WHICH identity myLikedPostIds currently reflects
// (myLikedIdentity). Before trusting it — on every like click, and
// whenever the tab could have missed an account change (pageshow from
// bfcache, another tab changing the session, the tab regaining focus)
// — re-check the CURRENT session's email against myLikedIdentity and
// re-fetch + re-render every like button the moment they differ, so
// state is always judged against the account that's actually reacting,
// never a stale one.
// ============================================
let myLikedPostIds = new Set();
let myLikedIdentity = null; // normalized email that myLikedPostIds currently reflects, or null (logged out)

async function loadMyLikes() {
  myLikedPostIds = new Set();
  const s = getSession();
  const identity = (s && s.email) ? normalizeEmail(s.email) : null;
  myLikedIdentity = identity;
  if (!identity) return; // logged-out visitors have no like docs to load
  try {
    const snap = await getDocs(query(collection(db, "blogLikes"), where("email", "==", identity)));
    snap.forEach(d => {
      const postId = d.data().postId;
      if (postId) myLikedPostIds.add(postId);
    });
  } catch (err) {
    console.error("[Blog] failed to load your likes:", err);
  }
}

// Re-paints every currently-rendered like button (icon + active state)
// from myLikedPostIds — used after a refresh so the UI catches up
// without needing a full page reload.
function refreshAllLikeButtonsFromState() {
  document.querySelectorAll(".blog-post-card").forEach(card => {
    const id = card.dataset.id;
    const btn = card.querySelector(".blog-like-btn");
    if (!id || !btn) return;
    const liked = myLikedPostIds.has(id);
    btn.classList.toggle("is-active", liked);
    btn.innerHTML = liked ? "❤️ Like" : "🤍 Like";
  });
}

// Call before trusting myLikedPostIds for anything account-sensitive
// (a like click, or a moment the tab could have missed an account
// switch). No-ops when nothing has actually changed.
async function ensureLikeStateForCurrentUser() {
  const s = getSession();
  const currentIdentity = (s && s.email) ? normalizeEmail(s.email) : null;
  if (currentIdentity === myLikedIdentity) return;
  await loadMyLikes();
  refreshAllLikeButtonsFromState();
}

// bfcache restore (browser back/forward without a real reload) and
// cross-tab session changes (another tab logging into a different
// account) are exactly the two ways myLikedPostIds could go stale
// without this tab's own script re-running — catch both proactively
// instead of waiting for the next click.
window.addEventListener("pageshow", (e) => {
  if (e.persisted) ensureLikeStateForCurrentUser();
});
window.addEventListener("storage", (e) => {
  if (e.key === "agri_session_v1") ensureLikeStateForCurrentUser();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") ensureLikeStateForCurrentUser();
});

// ============================================
// PENDING IMAGES ARRAY (for composer preview)
// ============================================
let pendingImages = []; // Array of { name, url (blob or cloudinary), file }

// ============================================
// DOM REFS
// ============================================
const composerLoggedIn = document.getElementById("composer-logged-in");
const composerLoggedOut = document.getElementById("composer-logged-out");
const composerOpenBtn = document.getElementById("composer-open-btn");
const composerCloseBtn = document.getElementById("composer-close");
const composerModal = document.getElementById("composer-modal");
const composerAvatarImg = document.getElementById("composer-avatar");

const postTitleInput = document.getElementById("post-title-input");
const postBodyInput = document.getElementById("post-body-input");
const postImageInput = document.getElementById("post-image-input");
const postInlineImageInput = document.getElementById("post-inline-image-input");
const postInlineImageLabel = document.getElementById("post-inline-image-label");
const postDocxInput = document.getElementById("post-docx-input");
const postUploadStatus = document.getElementById("post-upload-status");
const postError = document.getElementById("post-error");
const postSubmitBtn = document.getElementById("post-submit-btn");

// Tracks in-flight inline uploads so submit can wait for them, and the wrapper
// currently being dragged so it can be dropped at a new spot in the text.
let inlineUploadsInFlight = 0;
let draggedInlineImage = null;

// Remembers where the cursor was in the post body. Opening the native file
// picker (for the 📄 inline-image button) steals focus/selection away from
// the contenteditable, so by the time the chosen file comes back in the
// "change" event, window.getSelection() no longer points inside the post —
// without this, every inline image would land at the end of the text
// instead of where the user was actually typing.
let savedRange = null;

function captureBodySelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && postBodyInput.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }
}

const composerImagePreview = document.getElementById("composer-image-preview");
const composerPreviewGrid = document.getElementById("composer-preview-grid");
const postGalleryImageLabel = document.getElementById("post-gallery-image-label");
const composerImageHint = document.getElementById("composer-image-hint");

const blogFeed = document.getElementById("blog-feed");
const blogFeedEmpty = document.getElementById("blog-feed-empty");
const loadMoreBtn = document.getElementById("blog-load-more");

// Full post modal (Facebook-style "See more" popup)
const fullPostModal = document.getElementById("full-post-modal");
const fullPostClose = document.getElementById("full-post-close");
const fullPostBadge = document.getElementById("full-post-badge");
const fullPostTitle = document.getElementById("full-post-title");
const fullPostHeader = document.getElementById("full-post-header");
const fullPostBody = document.getElementById("full-post-body");
const fullPostGallery = document.getElementById("full-post-gallery");

// Lightbox elements
const imageLightbox = document.getElementById("image-lightbox");
const lightboxImage = document.getElementById("lightbox-image");
const lightboxClose = document.getElementById("lightbox-close");
const lightboxPrev = document.getElementById("lightbox-prev");
const lightboxNext = document.getElementById("lightbox-next");
const lightboxCounter = document.getElementById("lightbox-counter");
const lightboxCaption = document.getElementById("lightbox-caption");
let lightboxGallery = [];
let lightboxIndex = 0;

// ============================================
// COMPOSER UI LOGIC
// ============================================
function updateComposerUI() {
  const s = getSession();
  if (s) {
    composerLoggedIn.classList.remove("hidden");
    composerLoggedOut.classList.add("hidden");
    composerAvatarImg.src = s.avatarUrl || "assets/avatar-male.svg";
  } else {
    composerLoggedIn.classList.add("hidden");
    composerLoggedOut.classList.remove("hidden");
  }
}

composerOpenBtn?.addEventListener("click", () => {
  composerModal.classList.remove("hidden");
  postTitleInput.focus();
  updateImageModeUI();
});

composerCloseBtn?.addEventListener("click", () => {
  composerModal.classList.add("hidden");
  resetComposer();
});

composerModal?.addEventListener("click", (e) => {
  if (e.target === composerModal) {
    composerModal.classList.add("hidden");
    resetComposer();
  }
});

function resetComposer() {
  postTitleInput.value = "";
  postBodyInput.innerHTML = "";
  postError.classList.add("hidden");
  postError.textContent = "";
  postUploadStatus.textContent = "";
  pendingImages = [];
  inlineUploadsInFlight = 0;
  draggedInlineImage = null;
  savedRange = null;
  composerImagePreview.classList.add("hidden");
  composerPreviewGrid.innerHTML = "";
  // Always clear edit mode here — this is the one place every "close the
  // composer" path (cancel, backdrop click, successful submit) runs
  // through, so a cancelled edit can never leak into the next new post.
  delete composerModal.dataset.editingPostId;
  postSubmitBtn.textContent = "📝 Post";
  updateImageModeUI();
}

// ============================================
// OPEN COMPOSER IN EDIT MODE — loads an existing post's title, body, and
// gallery images into the composer so saving updates the SAME document
// (never creates a new one). Existing gallery images are re-added to
// pendingImages as already-hosted URLs (no .file), which
// uploadPendingImages() passes straight through instead of re-uploading —
// so they're kept unless the user removes them from the preview.
// ============================================
function openPostEditor(id, item) {
  resetComposer();
  postTitleInput.value = item.title || "";
  postBodyInput.innerHTML = item.content || "";
  // Normalizes both the old format (imageUrls as plain URL strings, from
  // before per-image titles existed) and the new format (objects with a
  // url + title) into the same pendingImages shape the composer uses.
  pendingImages = (item.imageUrls || []).map(entry => {
    if (typeof entry === "string") return { name: "existing-image", url: entry, title: "" };
    return { name: "existing-image", url: entry.url, title: entry.title || "" };
  });
  updateImagePreview();
  composerModal.dataset.editingPostId = id;
  composerModal.classList.remove("hidden");
  postSubmitBtn.textContent = "💾 Save Changes";
  postTitleInput.focus();
}

// ============================================
// IMAGE PREVIEW MANAGEMENT (in composer)
// ============================================
function updateImagePreview() {
  if (pendingImages.length === 0) {
    composerImagePreview.classList.add("hidden");
    updateImageModeUI();
    return;
  }
  composerImagePreview.classList.remove("hidden");
  composerPreviewGrid.innerHTML = pendingImages.map((img, idx) => `
    <div class="composer-preview-item">
      <div class="composer-preview-thumb">
        <img src="${typeof img.url === "string" ? img.url : URL.createObjectURL(img.url)}" alt="">
        <button type="button" class="composer-preview-remove" data-idx="${idx}">✕</button>
      </div>
      <input type="text" class="composer-preview-title-input" data-idx="${idx}"
        placeholder="Add a title (optional)" value="${esc(img.title || "")}" maxlength="120">
    </div>
  `).join("");

  // Wire remove buttons
  composerPreviewGrid.querySelectorAll(".composer-preview-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.idx);
      pendingImages.splice(idx, 1);
      updateImagePreview();
      updateImageModeUI();
    });
  });

  // Wire title inputs — keep pendingImages in sync as the author types,
  // so the title travels with the image whether it's a fresh upload or
  // one carried over from editing an existing post.
  composerPreviewGrid.querySelectorAll(".composer-preview-title-input").forEach(input => {
    input.addEventListener("input", () => {
      const idx = parseInt(input.dataset.idx);
      if (pendingImages[idx]) pendingImages[idx].title = input.value;
    });
  });

  updateImageModeUI();
}

function totalImageCount() {
  return pendingImages.length + postBodyInput.querySelectorAll(".inline-image").length;
}

// ============================================
// IMAGE MODE LOCK — a post uses ONE image system at a time: either
// inline images (dropped into the text) or a gallery grid (below the
// post), never both. Whichever one already has images locks out the
// other button until it's emptied again, so people can't accidentally
// mix the two.
// ============================================
function updateImageModeUI() {
  const inlineCount = postBodyInput.querySelectorAll(".inline-image").length;
  const galleryCount = pendingImages.length;

  const galleryLocked = inlineCount > 0 && galleryCount === 0;
  const inlineLocked = galleryCount > 0 && inlineCount === 0;

  postGalleryImageLabel?.classList.toggle("is-disabled", galleryLocked);
  if (postImageInput) postImageInput.disabled = galleryLocked;
  if (postGalleryImageLabel) {
    postGalleryImageLabel.title = galleryLocked
      ? "Remove your inline images first to switch to a photo grid"
      : "Add photos to a grid below the post";
  }

  postInlineImageLabel?.classList.toggle("is-disabled", inlineLocked);
  if (postInlineImageInput) postInlineImageInput.disabled = inlineLocked;
  if (postInlineImageLabel) {
    postInlineImageLabel.title = inlineLocked
      ? "Remove your photo grid first to switch to inline images"
      : "Insert an image inside the text — drag & resize it";
  }

  if (composerImageHint) {
    if (inlineCount > 0) {
      composerImageHint.textContent = "📄 Using inline images for this post — click one to resize, drag the corner, or drag it to move. Remove all inline images to switch to a photo grid instead.";
    } else if (galleryCount > 0) {
      composerImageHint.textContent = "🖼️ Using a photo grid for this post — remove all grid photos to switch to inline images instead.";
    } else {
      composerImageHint.textContent = "📄 Inline — drops an image right in your text; click it to resize, drag the corner, or drag the whole image to move it, just like laying out a page. 🖼️ Gallery — adds a premium photo grid under the post. A post can use one style of images at a time (inline OR grid) — or none at all for a text-only post.";
    }
  }
}

postImageInput?.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);

  if (postBodyInput.querySelectorAll(".inline-image").length > 0) {
    postError.classList.remove("hidden");
    postError.textContent = "This post already uses inline images — remove them first to use a photo grid instead.";
    postImageInput.value = "";
    return;
  }

  // Validate total images (gallery + inline combined)
  if (totalImageCount() + files.length > MAX_IMAGES_PER_POST) {
    postError.classList.remove("hidden");
    postError.textContent = `Max ${MAX_IMAGES_PER_POST} images per post`;
    return;
  }

  // Validate each file
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      postError.classList.remove("hidden");
      postError.textContent = `Only image files allowed: ${file.name}`;
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      postError.classList.remove("hidden");
      postError.textContent = `Image too large (max 8MB): ${file.name}`;
      return;
    }
  }

  // Add to pending
  files.forEach(file => {
    pendingImages.push({ name: file.name, url: file, file, title: "" });
  });
  postError.classList.add("hidden");
  updateImagePreview();
  postImageInput.value = "";
});

// ============================================
// INLINE IMAGES — insert directly into the post text,
// draggable to reposition and resizable via a corner handle
// ============================================
// Grab the cursor position the instant before the native file picker opens
// and steals focus — this is the spot the image should land in.
postInlineImageLabel?.addEventListener("mousedown", captureBodySelection);
postInlineImageLabel?.addEventListener("touchstart", captureBodySelection, { passive: true });
// Also keep it fresh anytime the user is actively placing their cursor/typing,
// so it's accurate even before the button is touched.
postBodyInput?.addEventListener("keyup", captureBodySelection);
postBodyInput?.addEventListener("mouseup", captureBodySelection);
postBodyInput?.addEventListener("input", captureBodySelection);

postInlineImageInput?.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  postInlineImageInput.value = "";

  if (pendingImages.length > 0) {
    postError.classList.remove("hidden");
    postError.textContent = "This post already uses a photo grid — remove those photos first to use inline images instead.";
    return;
  }

  if (totalImageCount() + files.length > MAX_IMAGES_PER_POST) {
    postError.classList.remove("hidden");
    postError.textContent = `Max ${MAX_IMAGES_PER_POST} images per post`;
    return;
  }

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      postError.classList.remove("hidden");
      postError.textContent = `Only image files allowed: ${file.name}`;
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      postError.classList.remove("hidden");
      postError.textContent = `Image too large (max 8MB): ${file.name}`;
      continue;
    }
    postError.classList.add("hidden");
    await insertInlineImage(file);
    updateImageModeUI();
  }
});

// ============================================
// IMPORT FROM WORD DOC (.docx) — 📎 button
// ============================================
// Converts a .docx file straight into the composer body: headings,
// bold/italic, lists, links and images all come through automatically via
// mammoth.js (loaded lazily from CDN so pages that never use this feature
// don't pay for it). Images embedded in the doc are uploaded to Cloudinary
// the same way any other post image is, so the saved post never depends on
// the original file. Only .docx (Word 2007+, a zip container) is supported —
// mammoth can't read the old binary .doc format.
const MAX_DOCX_SIZE = 20 * 1024 * 1024; // 20MB
const MAMMOTH_CDN_URL = "https://cdn.jsdelivr.net/npm/mammoth@1.12.2/mammoth.browser.min.js";

let mammothLoadPromise = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  if (mammothLoadPromise) return mammothLoadPromise;
  mammothLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MAMMOTH_CDN_URL;
    script.onload = () => {
      if (window.mammoth) resolve(window.mammoth);
      else reject(new Error("Word-import library failed to load. Please try again."));
    };
    script.onerror = () => {
      mammothLoadPromise = null; // allow a retry on the next attempt
      reject(new Error("Couldn't load the Word-import library — check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return mammothLoadPromise;
}

function base64ToFile(base64, contentType, name) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  return new File([bytes], name, { type: contentType || "image/png" });
}

postDocxInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  postDocxInput.value = "";
  if (!file) return;

  if (!/\.docx$/i.test(file.name)) {
    postError.classList.remove("hidden");
    postError.textContent = "Please upload a .docx file (Word 2007 or newer) — older .doc files aren't supported. Re-save it as .docx and try again.";
    return;
  }
  if (file.size > MAX_DOCX_SIZE) {
    postError.classList.remove("hidden");
    postError.textContent = "That Word file is too large (max 20MB).";
    return;
  }

  const hasExistingContent = postBodyInput.innerText.trim().length > 0 || postBodyInput.querySelector("img");
  if (hasExistingContent && !confirm("Importing this Word document will replace everything currently in the post editor. Continue?")) {
    return;
  }

  postError.classList.add("hidden");
  postUploadStatus.textContent = "Reading document…";

  try {
    const mammoth = await loadMammoth();
    const arrayBuffer = await file.arrayBuffer();

    // Capture each embedded image as base64 behind a placeholder src rather
    // than letting mammoth inline it as a giant data: URI — the placeholder
    // gets swapped for a real Cloudinary URL below, and a data: URI would be
    // dropped anyway since the sanitizer only trusts our own uploaded images.
    const docxImages = [];
    let docxImageCounter = 0;
    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        const id = `docx-img-${docxImageCounter++}`;
        docxImages.push({ id, base64: await image.read("base64"), contentType: image.contentType });
        return { src: `docx-import-placeholder:${id}` };
      })
    });

    const template = document.createElement("template");
    template.innerHTML = result.value;

    // Use the doc's first heading as the post title, if the title field
    // is still empty — otherwise leave whatever the author already typed.
    if (!postTitleInput.value.trim()) {
      const firstHeading = template.content.querySelector("h1, h2, h3");
      if (firstHeading) {
        postTitleInput.value = firstHeading.textContent.trim().slice(0, 200);
        firstHeading.remove();
      }
    }

    if (docxImages.length) {
      postUploadStatus.textContent = `Uploading ${docxImages.length} image${docxImages.length === 1 ? "" : "s"} from the document…`;
      for (const img of docxImages) {
        const target = template.content.querySelector(`img[src="docx-import-placeholder:${img.id}"]`);
        if (!target) continue;
        try {
          const ext = (img.contentType || "").split("/")[1] || "png";
          const url = await uploadOneImage(base64ToFile(img.base64, img.contentType, `docx-image.${ext}`));
          target.setAttribute("src", url);
        } catch (err) {
          console.error("[Blog] docx image upload failed:", err);
          target.remove(); // drop it rather than leave a broken/untrusted src behind
        }
      }
    }

    postBodyInput.innerHTML = template.innerHTML;
    updateImageModeUI();
    postUploadStatus.textContent = "Imported from Word document — review the formatting below before posting.";
    setTimeout(() => {
      if (postUploadStatus.textContent.startsWith("Imported from Word")) postUploadStatus.textContent = "";
    }, 5000);
  } catch (err) {
    console.error("[Blog] Word import failed:", err);
    postUploadStatus.textContent = "";
    postError.classList.remove("hidden");
    const msg = String(err?.message || "");
    postError.textContent = /central directory|not a valid zip|corrupt/i.test(msg)
      ? "That file doesn't look like a valid .docx — please re-save it as Word (.docx) and try again."
      : (msg || "Couldn't import that document. Please try again.");
  }
});

function insertNodeAtCursor(node) {
  // Prefer the last position we explicitly captured (savedRange) over the
  // "live" selection. The reason: calling postBodyInput.focus() when there's
  // no active selection makes the browser default the caret to the very
  // start of the contenteditable — so checking the live selection first
  // would wrongly pick up that "start" position and silently override the
  // spot the user actually placed their cursor at.
  try {
    let range;
    if (savedRange && postBodyInput.contains(savedRange.startContainer) && postBodyInput.contains(savedRange.endContainer)) {
      range = savedRange;
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && postBodyInput.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        range = sel.getRangeAt(0);
      } else {
        range = document.createRange();
        range.selectNodeContents(postBodyInput);
        range.collapse(false); // end of content
      }
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);

    postBodyInput.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
  } catch (err) {
    // A stale savedRange (e.g. the editor's content shifted since the cursor
    // position was captured) can throw here. Previously that exception
    // stopped insertInlineImage() before it ever reached the upload step,
    // leaving the image permanently stuck on its initial "Uploading…" state
    // with no way to recover. Fall back to appending at the end instead of
    // losing the image or freezing its spinner.
    console.warn("[Blog] cursor position was stale, appending image at the end instead:", err);
    if (!node.isConnected) postBodyInput.appendChild(node);
  }
}

function wireInlineImageWrapper(wrapper) {
  wrapper.setAttribute("draggable", "true");

  wrapper.addEventListener("dragstart", (ev) => {
    draggedInlineImage = wrapper;
    ev.dataTransfer.effectAllowed = "move";
    try { ev.dataTransfer.setData("text/plain", ""); } catch (err) { /* Firefox needs this set, ignore elsewhere */ }
    setTimeout(() => wrapper.classList.add("dragging"), 0);
  });
  wrapper.addEventListener("dragend", () => {
    wrapper.classList.remove("dragging");
    draggedInlineImage = null;
  });

  const INLINE_MIN_WIDTH = 80;
  const INLINE_MAX_WIDTH = 560;

  // Resize via bottom-right handle (pointer events cover mouse + touch)
  const resizeHandle = wrapper.querySelector(".inline-image-resize");
  resizeHandle?.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startWidth = wrapper.getBoundingClientRect().width;
    resizeHandle.setPointerCapture(ev.pointerId);

    function onMove(e2) {
      const delta = e2.clientX - startX;
      const newWidth = Math.max(INLINE_MIN_WIDTH, Math.min(INLINE_MAX_WIDTH, Math.round(startWidth + delta)));
      wrapper.style.width = `${newWidth}px`;
    }
    function onUp(e3) {
      try { resizeHandle.releasePointerCapture(e3.pointerId); } catch (err) {}
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onUp);
    }
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onUp);
  });

  // Quick +/- size buttons — an easier, tap-friendly alternative to dragging
  // the corner handle, especially on mobile.
  wrapper.querySelectorAll(".inline-size-btn").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const currentWidth = wrapper.getBoundingClientRect().width;
      const step = btn.dataset.size === "up" ? 40 : -40;
      const newWidth = Math.max(INLINE_MIN_WIDTH, Math.min(INLINE_MAX_WIDTH, Math.round(currentWidth + step)));
      wrapper.style.width = `${newWidth}px`;
    });
  });

  // Delete
  const deleteBtn = wrapper.querySelector(".inline-image-delete");
  deleteBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    wrapper.remove();
    updateImageModeUI();
  });

  // Alignment — "none" sits inline in the paragraph; left/right float so text wraps beside it; center stands alone
  wrapper.querySelectorAll(".inline-align-btn:not(.inline-size-btn)").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      wrapper.classList.remove("align-left", "align-right", "align-center", "align-none");
      wrapper.classList.add(`align-${btn.dataset.align}`);
      wrapper.querySelectorAll(".inline-align-btn:not(.inline-size-btn)").forEach(b => b.classList.toggle("is-active", b === btn));
    });
  });
}

async function insertInlineImage(file) {
  const wrapper = document.createElement("div");
  wrapper.className = "inline-image align-none is-uploading";
  wrapper.style.width = "260px";
  wrapper.contentEditable = "false";

  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);
  img.alt = "Post image";
  wrapper.appendChild(img);

  const spinner = document.createElement("div");
  spinner.className = "inline-image-spinner";
  spinner.textContent = "Uploading…";
  wrapper.appendChild(spinner);

  const toolbar = document.createElement("div");
  toolbar.className = "inline-image-toolbar";
  toolbar.innerHTML = `
    <button type="button" class="inline-align-btn is-active" data-align="none" title="In text">🔤</button>
    <button type="button" class="inline-align-btn" data-align="left" title="Wrap text right">⬅️</button>
    <button type="button" class="inline-align-btn" data-align="center" title="Center, own line">⏺️</button>
    <button type="button" class="inline-align-btn" data-align="right" title="Wrap text left">➡️</button>
    <span class="inline-toolbar-divider"></span>
    <button type="button" class="inline-align-btn inline-size-btn" data-size="down" title="Smaller">➖</button>
    <button type="button" class="inline-align-btn inline-size-btn" data-size="up" title="Bigger">➕</button>
  `;
  wrapper.appendChild(toolbar);

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "inline-image-resize";
  wrapper.appendChild(resizeHandle);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "inline-image-delete";
  deleteBtn.textContent = "✕";
  wrapper.appendChild(deleteBtn);

  try {
    wireInlineImageWrapper(wrapper);
    insertNodeAtCursor(wrapper);
  } catch (err) {
    // Whatever went wrong, get the image into the document some way rather
    // than leaving it detached — the line below only fires runInlineUpload
    // when the wrapper is actually attached, and a detached-but-uploading
    // node is exactly how the spinner used to get stuck forever.
    console.error("[Blog] inline image insertion failed, appending as fallback:", err);
    if (!wrapper.isConnected) postBodyInput.appendChild(wrapper);
  }

  await runInlineUpload(wrapper, img, spinner, file);
}

async function runInlineUpload(wrapper, img, spinner, file) {
  inlineUploadsInFlight++;
  wrapper.classList.add("is-uploading");
  wrapper.classList.remove("upload-failed");
  spinner.innerHTML = "Uploading…";
  try {
    const url = await uploadOneImage(file);
    img.src = url;
    wrapper.classList.remove("is-uploading");
  } catch (err) {
    console.error("[Blog] inline image upload failed:", err);
    // Keep the image in place (the user already positioned it) and offer a
    // retry instead of silently deleting their work.
    wrapper.classList.remove("is-uploading");
    wrapper.classList.add("upload-failed");
    spinner.innerHTML = `Upload failed<br><button type="button" class="inline-image-retry">Tap to retry</button>`;
    spinner.querySelector(".inline-image-retry")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      runInlineUpload(wrapper, img, spinner, file);
    });
  } finally {
    inlineUploadsInFlight--;
  }
}

// Drop target: reposition a dragged inline image at the new cursor spot
function getRangeFromPoint(x, y) {
  if (document.caretRangeFromPoint) {
    return document.caretRangeFromPoint(x, y);
  }
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

postBodyInput?.addEventListener("dragover", (ev) => {
  if (!draggedInlineImage) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
});

postBodyInput?.addEventListener("drop", (ev) => {
  if (!draggedInlineImage) return;
  ev.preventDefault();
  const node = draggedInlineImage;
  draggedInlineImage = null;
  const range = getRangeFromPoint(ev.clientX, ev.clientY);
  if (range) {
    range.collapse(true);
    range.insertNode(node);
  } else {
    postBodyInput.appendChild(node);
  }
  node.classList.remove("dragging");
});

// Select/deselect (shows the align/resize/delete controls on the active image)
postBodyInput?.addEventListener("click", (ev) => {
  const wrapper = ev.target.closest(".inline-image");
  postBodyInput.querySelectorAll(".inline-image.selected").forEach(w => {
    if (w !== wrapper) w.classList.remove("selected");
  });
  if (wrapper) wrapper.classList.add("selected");
});

document.addEventListener("click", (ev) => {
  if (!postBodyInput || postBodyInput.contains(ev.target)) return;
  postBodyInput.querySelectorAll(".inline-image.selected").forEach(w => w.classList.remove("selected"));
});

// ============================================
// TEXT FORMATTING BUTTONS
// ============================================
document.querySelectorAll(".composer-format-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    const cmd = btn.dataset.cmd;
    document.execCommand(cmd, false, null);
    postBodyInput.focus();
  });
});

// Font size selector
const fontSizeSelect = document.getElementById("font-size-select");
fontSizeSelect?.addEventListener("change", (e) => {
  const size = e.target.value;
  if (size) {
    document.execCommand("fontSize", false, "7"); // Use size 7 as largest
    const spans = postBodyInput.querySelectorAll("span[style*='font-size']");
    spans.forEach(span => {
      span.style.fontSize = size;
    });
    postBodyInput.focus();
    fontSizeSelect.value = ""; // Reset dropdown
  }
});

// ============================================
// UPLOAD IMAGES TO CLOUDINARY & GET URLS
// ============================================
const UPLOAD_TIMEOUT_MS = 25000;

async function uploadOneImage(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  // Without a timeout a stalled connection (flaky mobile data, a dropped
  // request) leaves the "Uploading…" spinner spinning forever with no way
  // out. Abort and fail cleanly instead so the UI can recover.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(CLOUDINARY_UPLOAD_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Upload timed out — check your connection and try again");
    throw new Error("Upload failed — check your connection and try again");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  const data = await response.json();
  if (!data.secure_url) throw new Error("Upload failed");
  return data.secure_url;
}

async function uploadPendingImages() {
  if (pendingImages.length === 0) return [];

  const urls = [];
  // Only entries that came from a fresh file picker have `.file` — entries
  // carried over from an edited post are already-hosted Cloudinary URLs and
  // just pass through unchanged, so they never get re-uploaded or dropped.
  // Every entry is saved as { url, title } so each image keeps its own title.
  const toUploadCount = pendingImages.filter(img => img.file).length;
  if (toUploadCount > 0) postUploadStatus.textContent = `Uploading ${toUploadCount} image(s)...`;

  let uploadedSoFar = 0;
  for (const img of pendingImages) {
    if (!img.file) {
      urls.push({ url: img.url, title: img.title || "" });
      continue;
    }
    try {
      const url = await uploadOneImage(img.file);
      urls.push({ url, title: img.title || "" });
      uploadedSoFar++;
      postUploadStatus.textContent = `Uploading image ${uploadedSoFar}/${toUploadCount}...`;
    } catch (err) {
      console.error(`Failed to upload image:`, err);
      throw new Error(`Failed to upload image: ${img.name}`);
    }
  }

  postUploadStatus.textContent = "";
  return urls;
}

// ============================================
// POST SUBMISSION
// ============================================
postSubmitBtn?.addEventListener("click", async () => {
  const s = requireSession();
  if (!s) return;

  const title = postTitleInput.value.trim();
  const body = postBodyInput.innerHTML;
  const bodyText = plainTextLength(body);
  const inlineImageCount = postBodyInput.querySelectorAll(".inline-image").length;

  // Validate
  if (!title) {
    postError.classList.remove("hidden");
    postError.textContent = "Please add a title";
    return;
  }
  if (title.length > 200) {
    postError.classList.remove("hidden");
    postError.textContent = "Title too long (max 200 chars)";
    return;
  }
  if (bodyText === 0 && pendingImages.length === 0 && inlineImageCount === 0) {
    postError.classList.remove("hidden");
    postError.textContent = "Add some text or images";
    return;
  }
  if (bodyText > 20000) {
    postError.classList.remove("hidden");
    postError.textContent = "Post too long (max 20k chars)";
    return;
  }
  if (inlineUploadsInFlight > 0) {
    postError.classList.remove("hidden");
    postError.textContent = "Please wait for images to finish uploading";
    return;
  }
  if (postBodyInput.querySelectorAll(".inline-image.is-uploading").length > 0) {
    postError.classList.remove("hidden");
    postError.textContent = "Please wait for images to finish uploading";
    return;
  }

  postSubmitBtn.disabled = true;
  postError.classList.add("hidden");

  try {
    // Upload images
    const imageUrls = await uploadPendingImages();

    // Sanitize text
    const sanitized = sanitizeHTML(body);

    const editingPostId = composerModal.dataset.editingPostId;

    if (editingPostId) {
      // Editing an existing post — mark as pending approval
      await updateDoc(doc(db, "blogPosts", editingPostId), {
        title,
        content: sanitized,
        imageUrls,
        status: "pending_edit", // New status for edited posts waiting approval
        editedAt: serverTimestamp(),
        editedBy: normalizeEmail(s.email)
      });
      delete composerModal.dataset.editingPostId;
      alert("Your changes have been submitted for admin review.");
    } else {
      // Creating a new post
      const docRef = await addDoc(collection(db, "blogPosts"), {
        title,
        content: sanitized,
        imageUrls,
        authorEmail: normalizeEmail(s.email),
        authorRegId: s.regId,
        authorName: s.fullName || s.email,
        authorAvatar: s.avatarUrl || "assets/avatar-male.svg",
        status: "pending",
        likesCount: 0,
        commentsCount: 0,
        sharesCount: 0,
        views: 0,
        createdAt: serverTimestamp()
      });
    }

    // Success — reset and close
    resetComposer();
    composerModal.classList.add("hidden");
    postUploadStatus.textContent = "";
    postSubmitBtn.textContent = "📝 Post"; // Reset button text

    // Reload feed to show new post at top
    resetFeed();
    loadMorePosts();

  } catch (err) {
    console.error("[Blog] Post submit failed:", err);
    postError.classList.remove("hidden");
    postError.textContent = err.message || "Failed to save post. Please try again.";
  } finally {
    postSubmitBtn.disabled = false;
  }
});

// ============================================
// IMAGE GALLERY BUILDER (Facebook-style)
// ============================================
// Gallery entries can be either a plain URL string (older posts, saved
// before per-image titles existed) or a { url, title } object (current
// format) — these two helpers read either shape the same way everywhere
// a gallery image is displayed.
function galleryImgUrl(entry) {
  return typeof entry === "string" ? entry : (entry?.url || "");
}
function galleryImgTitle(entry) {
  return typeof entry === "string" ? "" : (entry?.title || "");
}

function buildGalleryHTML(imageUrls) {
  if (!imageUrls || imageUrls.length === 0) return "";

  const count = Math.min(imageUrls.length, 4); // Show max 4 inline
  const visibleUrls = imageUrls.slice(0, 4);
  const overflowCount = imageUrls.length - 4;

  let galleryClass = `gallery-${count}`;
  if (imageUrls.length > 4) galleryClass = "gallery-5plus";

  const tileHTML = visibleUrls.map((entry, idx) => {
    const isOverflow = (idx === 3 && overflowCount > 0);
    const url = galleryImgUrl(entry);
    const title = galleryImgTitle(entry);
    return `
      <div class="blog-gallery-tile ${isOverflow ? "tile-overflow" : ""}" 
           data-overflow="+${overflowCount}" 
           data-index="${idx}"
           data-full-index="${idx}">
        <img src="${esc(url)}" alt="${esc(title || "Post image")}" loading="lazy">
      </div>
    `;
  }).join("");

  return `
    <div class="blog-gallery ${galleryClass}">
      <div class="blog-gallery-grid">
        ${tileHTML}
      </div>
    </div>
  `;
}

// ============================================
// LIGHTBOX HANDLERS
// ============================================
function openLightbox(gallery, index) {
  lightboxGallery = gallery;
  lightboxIndex = Math.max(0, Math.min(index, gallery.length - 1));
  showLightboxImage();
  imageLightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  imageLightbox.classList.add("hidden");
  document.body.style.overflow = "";
  lightboxGallery = [];
  lightboxIndex = 0;
}

function showLightboxImage() {
  if (lightboxGallery.length === 0) return;
  const entry = lightboxGallery[lightboxIndex];
  const url = galleryImgUrl(entry);
  const title = galleryImgTitle(entry);
  lightboxImage.src = url;
  lightboxImage.alt = title || "Post image";
  if (lightboxCaption) {
    lightboxCaption.textContent = title;
    lightboxCaption.classList.toggle("hidden", !title);
  }
  lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxGallery.length}`;
  
  lightboxPrev.classList.toggle("disabled", lightboxIndex === 0);
  lightboxNext.classList.toggle("disabled", lightboxIndex === lightboxGallery.length - 1);
}

lightboxClose?.addEventListener("click", closeLightbox);
lightboxPrev?.addEventListener("click", () => {
  if (lightboxIndex > 0) {
    lightboxIndex--;
    showLightboxImage();
  }
});
lightboxNext?.addEventListener("click", () => {
  if (lightboxIndex < lightboxGallery.length - 1) {
    lightboxIndex++;
    showLightboxImage();
  }
});

// Keyboard navigation
document.addEventListener("keydown", (e) => {
  if (imageLightbox.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft" && lightboxIndex > 0) {
    lightboxIndex--;
    showLightboxImage();
  }
  if (e.key === "ArrowRight" && lightboxIndex < lightboxGallery.length - 1) {
    lightboxIndex++;
    showLightboxImage();
  }
});

// Layout note: the feed used to live in its own independently-scrolling
// box (with a sticky hero/composer pinned above it) so the page had two
// separate scrollbars fighting each other — the disorienting "sometimes
// the whole page moves, sometimes just part of it scrolls" feeling.
// That's gone now: the composer trigger and the feed both flow in normal
// document order and the whole page scrolls together, single-surface,
// like a real Facebook timeline. Only the top navbar stays sticky.

// ============================================
// FULL POST MODAL — "See more" popup
// ============================================
function openFullPostModal(item) {
  fullPostBadge.innerHTML = statusBadgeHTML(item.status);
  fullPostTitle.textContent = item.title || "";
  const created = item.createdAt?.toDate?.() || null;
  fullPostHeader.innerHTML = `
    <img class="blog-post-avatar" src="${esc(item.authorAvatar || "assets/avatar-male.svg")}" alt="">
    <div>
      <div class="blog-post-author">${esc(item.authorName || "Student")}${item.authorStudentId ? ` <span class="blog-post-studentid">· ${esc(item.authorStudentId)}</span>` : ""}</div>
      <div class="blog-post-time">${esc(timeAgo(created))}</div>
    </div>
  `;
  fullPostBody.innerHTML = item.content;
  fullPostGallery.innerHTML = buildGalleryHTML(item.imageUrls);

  const galleryTiles = fullPostGallery.querySelectorAll(".blog-gallery-tile");
  galleryTiles.forEach((tile, idx) => {
    tile.addEventListener("click", () => openLightbox(item.imageUrls || [], idx));
  });

  fullPostModal.classList.remove("hidden");
}

function closeFullPostModal() {
  fullPostModal.classList.add("hidden");
}

fullPostClose?.addEventListener("click", closeFullPostModal);
fullPostModal?.addEventListener("click", (e) => {
  if (e.target === fullPostModal) closeFullPostModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !fullPostModal.classList.contains("hidden")) closeFullPostModal();
});

// Collapses a post body to 2 lines (via -webkit-line-clamp) once it's
// tall enough to overflow that, and adds a "See more" toggle that expands
// it in place and swaps to "See less" to collapse it back. Re-checks
// after any images inside finish loading, since those can push the true
// height past the threshold only once they've rendered — but only ever
// makes that collapse/no-collapse decision once, so it doesn't fight with
// the user's own See more / See less clicks afterward.
function wireSeeMore(bodyEl, item) {
  if (!bodyEl || bodyEl.dataset.seeMoreWired) return;
  const evaluate = () => {
    if (bodyEl.dataset.seeMoreAdded) return;
    const lineHeight = parseFloat(getComputedStyle(bodyEl).lineHeight) || 24;
    const twoLineHeight = lineHeight * 2;
    if (bodyEl.scrollHeight > twoLineHeight + 4) {
      bodyEl.dataset.seeMoreAdded = "1";
      bodyEl.classList.add("is-collapsed");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "blog-see-more-btn";
      btn.textContent = "See more";
      let expanded = false;
      const setExpanded = (next) => {
        expanded = next;
        bodyEl.classList.toggle("is-collapsed", !expanded);
        btn.textContent = expanded ? "See less" : "See more";
      };
      btn.addEventListener("click", () => setExpanded(!expanded));
      // Once expanded, clicking anywhere in the body text itself (not
      // just the See less button) collapses it back — matches the
      // Facebook-style behavior the user asked for. Skipped while the
      // user is actively selecting text, so this never fights a normal
      // copy/highlight drag.
      bodyEl.addEventListener("click", () => {
        if (!expanded) return;
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) return;
        setExpanded(false);
      });
      bodyEl.insertAdjacentElement("afterend", btn);
    }
  };
  bodyEl.dataset.seeMoreWired = "1";
  // renderPostCard() calls this before the card is appended to the feed,
  // so bodyEl has no layout yet and scrollHeight would read as 0 — every
  // post would look "short enough" and never get a See more button.
  // Deferring to the next frame runs the check once the card is actually
  // in the document and has real layout.
  requestAnimationFrame(evaluate);
  bodyEl.querySelectorAll("img").forEach(img => {
    if (!img.complete) img.addEventListener("load", evaluate, { once: true });
  });
}

// ============================================
// FEED — RENDER POST CARD
// ============================================
// Only two labels are ever shown to visitors: a post is either
// "Verified" (admin-approved) or "Not verified" (still pending review).
// Rejected posts are never rendered in the public feed/deep-link flow,
// so there's no separate "Not approved" label to show.
function statusBadgeHTML(status, isEdited) {
  if (isEdited || status === "pending_edit" || status === "pending") {
    return `<span class="blog-badge blog-badge--pending">🕓 Pending Admin Approval</span>`;
  }
  if (status === "approved") return `<span class="blog-badge blog-badge--approved">✅ Public</span>`;
  if (status === "rejected") return `<span class="blog-badge blog-badge--pending">❌ Rejected</span>`;
  return `<span class="blog-badge blog-badge--pending">🕓 Pending Admin Approval</span>`;
}

function renderPostCard(id, item) {
  const created = item.createdAt?.toDate?.() || null;
  const article = document.createElement("article");
  article.className = "blog-post-card";
  article.dataset.id = id;
  // Lowercased search haystacks — read by applyBlogSearch() so filtering
  // never has to re-parse the rendered HTML.
  article.dataset.searchTitle = (item.title || "").toLowerCase();
  article.dataset.searchAuthor = (item.authorName || "").toLowerCase();

  // Per-user truth from Firestore (see loadMyLikes above) — not a
  // browser-wide localStorage flag, so each individual account sees its
  // own, correct like state even on a shared device.
  const alreadyLiked = myLikedPostIds.has(id);

  // Build gallery HTML
  const galleryHTML = buildGalleryHTML(item.imageUrls);

  const s = getSession();
  const isAuthor = s && normalizeEmail(s.email) === item.authorEmail;
  // Firestore Timestamp objects don't have .getTime(), so the old check
  // here always silently evaluated to false — the badge never actually
  // reflected an edit. Reading the status field directly is what's true.
  const isEdited = item.status === "pending_edit";

  article.innerHTML = `
    <header class="blog-post-header">
      <img class="blog-post-avatar" src="${esc(item.authorAvatar || "assets/avatar-male.svg")}" alt="">
      <div>
        <div class="blog-post-author">${esc(item.authorName || "Student")}${item.authorStudentId ? ` <span class="blog-post-studentid">· ${esc(item.authorStudentId)}</span>` : ""}</div>
        <div class="blog-post-time">${esc(timeAgo(created))}</div>
      </div>
      <div class="blog-post-menu" ${!isAuthor ? 'style="display:none;"' : ''}>
        <button type="button" class="blog-menu-btn blog-edit-btn" title="Edit this post">✏️ Edit</button>
        <button type="button" class="blog-menu-btn blog-delete-btn" title="Delete this post">🗑️ Delete</button>
      </div>
    </header>
    <h2 class="blog-post-title">${esc(item.title)}</h2>
    ${statusBadgeHTML(item.status, isEdited)}
    <div class="blog-post-body">${item.content}</div>
    ${galleryHTML}
    <div class="blog-post-stats">
      <span>👁️ ${item.views || 0} views</span>
      <span class="blog-like-count">❤️ ${item.likesCount || 0}</span>
      <span class="blog-comment-count">💬 ${item.commentsCount || 0}</span>
      <span>↗️ ${item.sharesCount || 0}</span>
    </div>
    <div class="blog-post-actions">
      <button type="button" class="blog-action-btn blog-like-btn ${alreadyLiked ? "is-active" : ""}">
        ${alreadyLiked ? "❤️" : "🤍"} Like
      </button>
      <button type="button" class="blog-action-btn blog-comment-toggle">💬 Comment</button>
      <button type="button" class="blog-action-btn blog-share-btn">↗️ Share</button>
    </div>
    <div class="blog-comments-section hidden">
      <div class="blog-comments-list"></div>
      <div class="blog-comment-composer"></div>
    </div>
  `;

  wirePostCard(article, id, item);
  wireSeeMore(article.querySelector(".blog-post-body"), item);
  subscribeToLiveStats(id);

  // ============================================
  // VIEW TRACKING
  // A view counts every time a visitor — logged in, logged out,
  // registered or not, doesn't matter — keeps this post at least half
  // on-screen for 5 continuous seconds. Leaving the post (scrolling
  // away) before 5s is up cancels the timer; it starts over from 0 if
  // they scroll back. There is no dedupe beyond that single viewing:
  // reopening the blog later (new tab, refresh, coming back tomorrow)
  // counts as a brand-new view each time, on purpose.
  //
  // FIX — double counting: the same post can be rendered in more than one
  // DOM node at once (a "📌 Shared post" pinned copy from a ?post=ID deep
  // link, sitting right above that same post's normal spot in the feed
  // below it — see loadDeepLinkedPost()), or a stale copy can be left
  // running after resetFeed() wipes the feed and reloads it. Each render
  // used to start its own independent 5s timer + IntersectionObserver, so
  // one real visit could bump the Firestore counter two or more times.
  // activeViewTrackers is a page-wide registry (module scope, shared by
  // every renderPostCard call) that guarantees at most ONE dwell timer /
  // observer is ever running for a given post id at a time — like a
  // singleton effect keyed by id instead of by DOM node, the way a
  // well-behaved React effect keyed on post id would dedupe this. Every
  // teardown path (view counted, resetFeed, post deleted) removes the
  // post's entry so a genuinely fresh render can track it again.
  // ============================================
  // Deliberately silent: this only writes the new total to Firestore.
  // It does NOT touch the on-screen number — the visitor keeps seeing
  // the count that was there when the page loaded, with no live
  // "0 → 1" jump while they're reading. The new total shows up the
  // next time this post is opened (a fresh page load re-reads views
  // from Firestore), which is exactly where the increment should be
  // visible, not mid-read.
  async function bumpView() {
    try {
      await updateDoc(doc(db, "blogPosts", id), { views: increment(1) });
    } catch (err) {
      // A permission-denied error here almost always means the
      // firestore.rules views-increment rule hasn't been published to
      // Firebase yet (Console → Firestore Database → Rules → Publish) —
      // the count silently fails to save without that.
      console.error("[Blog] View update failed (check firestore.rules is published):", err);
    }
  }

  stopViewTracking(id); // tear down any earlier tracker for this same post id

  const tracker = { timer: null, observer: null };
  activeViewTrackers.set(id, tracker);

  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (tracker.timer) return; // already counting down for this viewing session
        tracker.timer = setTimeout(() => {
          bumpView();
          stopViewTracking(id);
        }, 5000);
      } else if (tracker.timer) {
        // Left the post before 5s of continuous viewing — doesn't count;
        // timer restarts fresh if it comes back into view.
        clearTimeout(tracker.timer);
        tracker.timer = null;
      }
    });
  }, { threshold: 0.5 });

  tracker.observer = io;
  io.observe(article);

  return article;
}

// ============================================
// FEED — WIRE UP POST INTERACTIONS
// ============================================
function wirePostCard(article, id, item) {
  const likeBtn = article.querySelector(".blog-like-btn");
  const likeCountEl = article.querySelector(".blog-like-count");
  const commentToggle = article.querySelector(".blog-comment-toggle");
  const commentsSection = article.querySelector(".blog-comments-section");
  const commentsList = article.querySelector(".blog-comments-list");
  const commentComposer = article.querySelector(".blog-comment-composer");
  const commentCountEl = article.querySelector(".blog-comment-count");
  const shareBtn = article.querySelector(".blog-share-btn");
  const editBtn = article.querySelector(".blog-edit-btn");
  const deleteBtn = article.querySelector(".blog-delete-btn");

  let commentsLoaded = false;

  // Edit button
  editBtn?.addEventListener("click", () => {
    const s = getSession();
    if (!s || normalizeEmail(s.email) !== item.authorEmail) {
      alert("You can only edit your own posts");
      return;
    }
    openPostEditor(id, item);
  });

  // Delete button
  deleteBtn?.addEventListener("click", () => {
    const s = getSession();
    if (!s || normalizeEmail(s.email) !== item.authorEmail) {
      alert("You can only delete your own posts");
      return;
    }
    if (!confirm("Are you sure you want to delete this post? This cannot be undone.")) {
      return;
    }
    deleteDoc(doc(db, "blogPosts", id)).then(() => {
      stopViewTracking(id);
      stopStatsListening(id);
      article.remove();
      // Show success message
      alert("Post deleted successfully");
    }).catch(err => {
      console.error("Delete failed:", err);
      alert("Failed to delete post");
    });
  });

  // Gallery tile clicks
  const galleryTiles = article.querySelectorAll(".blog-gallery-tile");
  if (galleryTiles.length > 0) {
    galleryTiles.forEach((tile, idx) => {
      tile.addEventListener("click", () => {
        openLightbox(item.imageUrls || [], idx);
      });
    });
  }

  // Like button — must be logged in as a registered student; see the
  // LIKE STATE comment above for why we re-sync before trusting state.
  likeBtn.addEventListener("click", async () => {
    const s = requireSession();
    if (!s) return;
    likeBtn.disabled = true;
    try {
      await ensureLikeStateForCurrentUser(); // catch a just-happened account switch before acting
      const identity = normalizeEmail(s.email);
      const likeId = `${id}_${identity}`;
      const isLiked = myLikedPostIds.has(id); // canonical state, not the button's DOM class
      if (isLiked) {
        await deleteDoc(doc(db, "blogLikes", likeId));
        await updateDoc(doc(db, "blogPosts", id), { likesCount: increment(-1) });
        item.likesCount = Math.max(0, (item.likesCount || 1) - 1);
        likeBtn.classList.remove("is-active");
        likeBtn.innerHTML = "🤍 Like";
        myLikedPostIds.delete(id);
      } else {
        await setDoc(doc(db, "blogLikes", likeId), { postId: id, email: identity, createdAt: serverTimestamp() });
        await updateDoc(doc(db, "blogPosts", id), { likesCount: increment(1) });
        item.likesCount = (item.likesCount || 0) + 1;
        likeBtn.classList.add("is-active");
        likeBtn.innerHTML = "❤️ Like";
        myLikedPostIds.add(id);
      }
      likeCountEl.textContent = `❤️ ${item.likesCount}`;
    } catch (err) {
      console.error("[Blog] like toggle failed:", err);
      alert("Something went wrong. Please try again.");
    } finally {
      likeBtn.disabled = false;
    }
  });

  // Comment toggle
  commentToggle.addEventListener("click", async () => {
    commentsSection.classList.toggle("hidden");
    if (!commentsSection.classList.contains("hidden") && !commentsLoaded) {
      commentsLoaded = true;
      await loadComments(id, commentsList);
      renderCommentComposer(commentComposer, id, commentsList, commentCountEl, item);
    }
  });

  // Share button
  shareBtn.addEventListener("click", async () => {
    const url = `${window.location.origin}${window.location.pathname}?post=${id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: item.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        alert("Link copied to clipboard!");
      }
      await updateDoc(doc(db, "blogPosts", id), { sharesCount: increment(1) });
      item.sharesCount = (item.sharesCount || 0) + 1;
      const statEl = article.querySelectorAll(".blog-post-stats span")[3];
      if (statEl) statEl.textContent = `↗️ ${item.sharesCount}`;
    } catch (err) {
      // User cancelled share — not an error
    }
  });
}

// ============================================
// COMMENTS — LOAD & RENDER
// ============================================
async function loadComments(postId, listEl) {
  listEl.innerHTML = `<p class="blog-comments-loading">Loading comments…</p>`;
  try {
    const q = query(collection(db, "blogComments"), where("postId", "==", postId));
    const snap = await getDocs(q);
    if (snap.empty) {
      listEl.innerHTML = `<p class="blog-comments-empty">No comments yet — be the first!</p>`;
      return;
    }
    const comments = snap.docs
      .map(d => d.data())
      .sort((a, b) => (a.createdAt?.toDate?.() || 0) - (b.createdAt?.toDate?.() || 0));

    listEl.innerHTML = comments.map(c => `
      <div class="blog-comment-row">
        <img src="${esc(c.authorAvatar || "assets/avatar-male.svg")}" alt="" class="blog-comment-avatar">
        <div class="blog-comment-bubble">
          <div class="blog-comment-author">${esc(c.authorName || "Student")}</div>
          <div class="blog-comment-text">${esc(c.text)}</div>
        </div>
      </div>
    `).join("");
  } catch (err) {
    console.error("[Blog] loading comments failed:", err);
    listEl.innerHTML = `<p class="blog-comments-empty">Couldn't load comments.</p>`;
  }
}

function renderCommentComposer(container, postId, listEl, commentCountEl, item) {
  const s = getSession();
  if (!s) {
    container.innerHTML = `<p class="blog-comment-login-hint"><a href="login.html">Log in</a> to leave a comment.</p>`;
    return;
  }
  container.innerHTML = `
    <div class="blog-comment-input-row">
      <img src="${esc(s.avatarUrl || "assets/avatar-male.svg")}" alt="" class="blog-comment-avatar">
      <input type="text" class="blog-comment-input" placeholder="Write a comment…" maxlength="2000">
      <button type="button" class="blog-comment-send-btn">Send</button>
    </div>
  `;
  const input = container.querySelector(".blog-comment-input");
  const sendBtn = container.querySelector(".blog-comment-send-btn");

  async function submitComment() {
    const text = input.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    try {
      await addDoc(collection(db, "blogComments"), {
        postId,
        text,
        authorEmail: normalizeEmail(s.email),
        authorRegId: s.regId,
        authorName: s.fullName || s.email,
        authorAvatar: s.avatarUrl || "assets/avatar-male.svg",
        createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "blogPosts", postId), { commentsCount: increment(1) });
      item.commentsCount = (item.commentsCount || 0) + 1;
      commentCountEl.textContent = `💬 ${item.commentsCount}`;
      input.value = "";
      await loadComments(postId, listEl);
    } catch (err) {
      console.error("[Blog] comment submit failed:", err);
      alert("Something went wrong posting your comment. Please try again.");
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", submitComment);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submitComment(); });
}

// ============================================
// FEED — PAGINATION
// ============================================
let lastDoc = null;
let feedDone = false;

function resetFeed() {
  // Tear down every in-flight view tracker before wiping the DOM nodes
  // they're watching — otherwise their setTimeout callbacks still fire
  // later against detached elements and can double-count a view.
  stopAllViewTracking();
  stopAllStatsListening();
  blogFeed.innerHTML = "";
  lastDoc = null;
  feedDone = false;
  blogFeedEmpty.classList.add("hidden");
  loadMoreBtn.classList.remove("hidden");
}

async function loadMorePosts() {
  if (feedDone) return;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";
  try {
    let q = query(collection(db, "blogPosts"), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
    if (lastDoc) q = query(collection(db, "blogPosts"), orderBy("createdAt", "desc"), startAfter(lastDoc), limit(PAGE_SIZE));

    const snap = await getDocs(q);
    if (snap.empty && !lastDoc) {
      blogFeedEmpty.classList.remove("hidden");
      loadMoreBtn.classList.add("hidden");
      return;
    }
    if (snap.docs.length < PAGE_SIZE) {
      feedDone = true;
      loadMoreBtn.classList.add("hidden");
    }
    lastDoc = snap.docs[snap.docs.length - 1] || lastDoc;

    const session = getSession();
    const viewerEmail = session ? normalizeEmail(session.email) : "";
    snap.docs.forEach(d => {
      const item = d.data();
      const isAuthor = viewerEmail && normalizeEmail(item.authorEmail) === viewerEmail;
      // Pending/rejected posts belong only to their author's timeline.
      // Everyone else can see a post only after admin approval.
      if (item.status !== "approved" && !isAuthor) return;
      blogFeed.appendChild(renderPostCard(d.id, item));
    });
  } catch (err) {
    console.error("[Blog] failed to load feed:", err);
    blogFeed.insertAdjacentHTML("beforeend", `<p style="color:var(--terracotta-500);text-align:center;">Couldn't load the timeline. Please refresh.</p>`);
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
  }
}

loadMoreBtn?.addEventListener("click", loadMorePosts);

// ============================================
// FEED — SEARCH (by title or author)
// ============================================
// Firestore has no free-text index for these fields, so search works
// client-side over what's already loaded. When a search starts, we
// page in the rest of the feed first (reusing loadMorePosts) so the
// search covers the whole timeline, not just the first page.
const searchInput = document.getElementById("blog-search-input");
const searchClearBtn = document.getElementById("blog-search-clear");
const searchEmptyEl = document.getElementById("blog-search-empty");
const searchEmptyTermEl = document.getElementById("blog-search-empty-term");

let searchDebounceTimer = null;
let isLoadingFullFeedForSearch = false;

async function ensureFullFeedLoaded() {
  if (isLoadingFullFeedForSearch) return;
  isLoadingFullFeedForSearch = true;
  loadMoreBtn.classList.add("hidden");
  try {
    while (!feedDone) {
      await loadMorePosts();
    }
  } finally {
    isLoadingFullFeedForSearch = false;
  }
}

function applyBlogSearch(rawQuery) {
  const q = rawQuery.trim().toLowerCase();
  searchClearBtn.classList.toggle("hidden", q.length === 0);

  if (q.length === 0) {
    blogFeed.querySelectorAll(".blog-post-card").forEach(card => card.classList.remove("search-hidden"));
    searchEmptyEl.classList.add("hidden");
    blogFeedEmpty.classList.toggle("hidden", blogFeed.querySelector(".blog-post-card") != null);
    loadMoreBtn.classList.toggle("hidden", feedDone);
    return;
  }

  let anyVisible = false;
  blogFeed.querySelectorAll(".blog-post-card").forEach(card => {
    const matches = card.dataset.searchTitle.includes(q) || card.dataset.searchAuthor.includes(q);
    card.classList.toggle("search-hidden", !matches);
    if (matches) anyVisible = true;
  });

  blogFeedEmpty.classList.add("hidden");
  loadMoreBtn.classList.add("hidden");
  searchEmptyTermEl.textContent = rawQuery.trim();
  searchEmptyEl.classList.toggle("hidden", anyVisible);
}

searchInput?.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  const value = searchInput.value;
  searchDebounceTimer = setTimeout(async () => {
    if (value.trim().length > 0) {
      await ensureFullFeedLoaded();
    }
    applyBlogSearch(searchInput.value);
  }, 250);
});

searchClearBtn?.addEventListener("click", () => {
  searchInput.value = "";
  applyBlogSearch("");
  searchInput.focus();
});

// ============================================
// DEEP LINK — ?post=ID
// ============================================
async function loadDeepLinkedPost() {
  const params = new URLSearchParams(window.location.search);
  const postId = params.get("post");
  if (!postId) return;
  try {
    const snap = await getDoc(doc(db, "blogPosts", postId));
    if (!snap.exists()) return;
    const item = snap.data();
    const s = getSession();
    const isAuthor = s && normalizeEmail(s.email) === normalizeEmail(item.authorEmail);
    if (item.status !== "approved" && !isAuthor) return;
    const wrapper = document.createElement("div");
    wrapper.className = "blog-pinned-post";
    wrapper.innerHTML = `<div class="blog-pinned-label">📌 Shared post</div>`;
    wrapper.appendChild(renderPostCard(snap.id, item));
    blogFeed.parentNode.insertBefore(wrapper, blogFeed);
  } catch (err) {
    console.error("[Blog] failed to load shared post:", err);
  }
}

// ============================================
// DEEP LINK — ?editPost=ID  (opened from the "Edit" button on the
// profile page's "My Blog Posts" list)
// ============================================
async function loadDeepLinkedEdit() {
  const params = new URLSearchParams(window.location.search);
  const postId = params.get("editPost");
  if (!postId) return;
  const s = getSession();
  if (!s) return;
  try {
    const snap = await getDoc(doc(db, "blogPosts", postId));
    if (!snap.exists()) return;
    const item = snap.data();
    if (normalizeEmail(s.email) !== item.authorEmail) {
      alert("You can only edit your own posts");
      return;
    }
    openPostEditor(postId, item);
  } catch (err) {
    console.error("[Blog] failed to load post for editing:", err);
  }
}

// ============================================
// HERO STATS — approved post count + distinct contributor count, shown
// in the banner above the feed. A lightweight query (approved posts
// only) so it doesn't compete with the main feed pagination.
// ============================================
async function loadHeroStats() {
  const postsEl = document.getElementById("blog-hero-stat-posts");
  const authorsEl = document.getElementById("blog-hero-stat-authors");
  if (!postsEl && !authorsEl) return;
  try {
    const snap = await getDocs(query(collection(db, "blogPosts"), where("status", "==", "approved")));
    const authors = new Set(snap.docs.map(d => normalizeEmail(d.data().authorEmail || "")).filter(Boolean));
    if (postsEl) postsEl.textContent = snap.size;
    if (authorsEl) authorsEl.textContent = authors.size;
  } catch (err) {
    console.error("[Blog] failed to load hero stats:", err);
  }
}

// ============================================
// INIT
// ============================================
// loadMyLikes() must finish before any post card renders (loadMorePosts /
// loadDeepLinkedPost both call renderPostCard, which reads myLikedPostIds
// synchronously) — otherwise every card would briefly, or permanently,
// render as "not liked" even for posts the current user already liked.
async function initBlogFeed() {
  updateComposerUI();
  await loadMyLikes();
  loadDeepLinkedPost();
  loadDeepLinkedEdit();
  loadMorePosts();
  loadHeroStats();
}
initBlogFeed();
