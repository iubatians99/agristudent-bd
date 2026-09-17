/**
 * SLIDES-NOTES LOADING FIX
 * 
 * This code handles:
 * 1. Loading files with AND without noteType (fallback for old files)
 * 2. Showing "Arrangement Needed" message for uncategorized files
 * 3. Proper folder organization
 */

// ============================================
// LOAD HAND NOTES (with fallback for uncategorized)
// ============================================
async function loadHandNotes() {
  const listEl = document.getElementById("handnotes-list");
  const countEl = document.getElementById("handnotes-count");
  const viewAllLink = document.getElementById("handnotes-view-all");
  
  if (!listEl) return;
  listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>Loading files…</p>";

  try {
    const db = getFirestore();
    
    // Load files WITH noteType = hand_notes
    const categorizedSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        where("noteType", "==", "hand_notes"),
        orderBy("uploadedAt", "desc"),
        limit(100)
      )
    );
    
    // Load files WITHOUT noteType (old files) - fallback
    const uncategorizedSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        orderBy("uploadedAt", "desc")
      )
    );
    
    // Filter uncategorized to only ones without noteType
    const uncategorized = uncategorizedSnap.docs
      .filter(d => !d.data().noteType || d.data().noteType === "")
      .slice(0, 100);
    
    // Combine both lists
    const all = [
      ...categorizedSnap.docs.map(d => ({ id: d.id, ...d.data(), isCategorized: true })),
      ...uncategorized.map(d => ({ id: d.id, ...d.data(), isCategorized: false, needsArrangement: true }))
    ];
    
    if (all.length === 0) {
      listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>📭 No hand notes available yet. <a href='slides-notes.html#unlock'>Upload your notes</a> to get started!</p>";
      countEl.textContent = "(0)";
      return;
    }
    
    // Show first 6 on main page
    const displayItems = all.slice(0, 6);
    renderFileCards(displayItems, listEl);
    
    countEl.textContent = `(${all.length})`;
    viewAllLink.style.display = all.length > 6 ? "inline-block" : "none";
    
    // Store all for view-all
    window.handnotesAllFiles = all;
    
  } catch (err) {
    console.error("[Load Hand Notes] Error:", err);
    listEl.innerHTML = `<p style='color:var(--terracotta-500);font-size:.9rem;'>Error loading files: ${err.message}</p>`;
  }
}

// ============================================
// LOAD CLASS LECTURE SLIDES (with fallback)
// ============================================
async function loadClassSlides() {
  const listEl = document.getElementById("slides-list");
  const countEl = document.getElementById("slides-count");
  const viewAllLink = document.getElementById("slides-view-all");
  
  if (!listEl) return;
  listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>Loading files…</p>";

  try {
    const db = getFirestore();
    
    // Load files WITH noteType = class_slide
    const categorizedSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        where("noteType", "==", "class_slide"),
        orderBy("uploadedAt", "desc"),
        limit(100)
      )
    );
    
    const all = categorizedSnap.docs.map(d => ({ id: d.id, ...d.data(), isCategorized: true }));
    
    if (all.length === 0) {
      listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>📭 No class slides available yet. <a href='slides-notes.html#unlock'>Upload slides</a> to get started!</p>";
      countEl.textContent = "(0)";
      return;
    }
    
    // Show first 6 on main page
    const displayItems = all.slice(0, 6);
    renderFileCards(displayItems, listEl);
    
    countEl.textContent = `(${all.length})`;
    viewAllLink.style.display = all.length > 6 ? "inline-block" : "none";
    
    // Store all for view-all
    window.slidesAllFiles = all;
    
  } catch (err) {
    console.error("[Load Class Slides] Error:", err);
    listEl.innerHTML = `<p style='color:var(--terracotta-500);font-size:.9rem;'>Error loading files: ${err.message}</p>`;
  }
}

// ============================================
// LOAD IMAGES (with fallback)
// ============================================
async function loadImages() {
  const listEl = document.getElementById("images-list");
  const countEl = document.getElementById("images-count");
  const viewAllLink = document.getElementById("images-view-all");
  
  if (!listEl) return;
  listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>Loading images…</p>";

  try {
    const db = getFirestore();
    
    // Load image files
    const allSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        where("fileType", "==", "image"),
        orderBy("uploadedAt", "desc"),
        limit(100)
      )
    );
    
    const all = allSnap.docs.map(d => ({ id: d.id, ...d.data(), isCategorized: true }));
    
    if (all.length === 0) {
      listEl.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>📭 No images available yet. <a href='slides-notes.html#unlock'>Upload images</a> to get started!</p>";
      countEl.textContent = "(0)";
      return;
    }
    
    // Show first 6 on main page
    const displayItems = all.slice(0, 6);
    renderFileCards(displayItems, listEl);
    
    countEl.textContent = `(${all.length})`;
    viewAllLink.style.display = all.length > 6 ? "inline-block" : "none";
    
    // Store all for view-all
    window.imagesAllFiles = all;
    
  } catch (err) {
    console.error("[Load Images] Error:", err);
    listEl.innerHTML = `<p style='color:var(--terracotta-500);font-size:.9rem;'>Error loading images: ${err.message}</p>`;
  }
}

// ============================================
// RENDER FILE CARDS
// ============================================
function renderFileCards(items, container) {
  if (!items || items.length === 0) {
    container.innerHTML = "<p style='color:var(--moss-600);font-size:.9rem;text-align:center;padding:1rem;'>No files found</p>";
    return;
  }
  
  let html = "";
  
  items.forEach(item => {
    const courseDisplay = `${esc(item.courseCode || "")} — ${esc(item.courseName || "")}`;
    const faculty = esc(item.facultyName || "");
    const descriptionHtml = item.description ? `<p style='font-size:.8rem;color:var(--moss-600);margin:.3rem 0 0;line-height:1.4;'>${esc(item.description)}</p>` : "";
    
    // Show arrangement notice if needed
    const arrangementNotice = item.needsArrangement ? 
      `<div style='background:#fff9e6;border:1px solid #f0c800;border-radius:4px;padding:.4rem .6rem;font-size:.75rem;color:#8a7f00;margin-bottom:.6rem;'>⚠️ This file needs arrangement. Admin will organize it soon.</div>` 
      : "";
    
    html += `
      <div class="resource-card">
        <h3 style="margin:.2rem 0 .3rem;">${courseDisplay}</h3>
        <p style="font-size:.85rem;color:var(--moss-600);margin:.2rem 0;">${faculty}</p>
        ${arrangementNotice}
        ${descriptionHtml}
        <button class="unlock-btn" data-id="${item.id}" data-type="${item.fileType}" style="margin-top:.6rem;">🔓 Unlock</button>
      </div>
    `;
  });
  
  container.innerHTML = html;
  
  // Add event listeners
  container.querySelectorAll(".unlock-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      openUnlockGate(id);
    });
  });
}

// ============================================
// FALLBACK LOADER IF QUERIES FAIL
// ============================================
async function loadAllResourcesAsBackup() {
  try {
    const db = getFirestore();
    
    // Fetch ALL approved resources without specific noteType filter
    const allSnap = await getDocs(
      query(
        collection(db, "resources"),
        where("status", "==", "approved"),
        orderBy("uploadedAt", "desc"),
        limit(200)
      )
    );
    
    // Separate by noteType
    const handNotes = [];
    const classSlides = [];
    const images = [];
    
    allSnap.docs.forEach(doc => {
      const data = doc.data();
      const item = { id: doc.id, ...data };
      
      if (data.fileType === "image") {
        images.push(item);
      } else if (data.noteType === "class_slide") {
        classSlides.push(item);
      } else if (data.noteType === "hand_notes" || !data.noteType) {
        // Uncategorized defaults to hand notes
        if (!data.noteType) item.needsArrangement = true;
        handNotes.push(item);
      }
    });
    
    // Render each folder
    const handnotesContainer = document.getElementById("handnotes-list");
    const slidesContainer = document.getElementById("slides-list");
    const imagesContainer = document.getElementById("images-list");
    
    if (handnotesContainer) renderFileCards(handNotes.slice(0, 6), handnotesContainer);
    if (slidesContainer) renderFileCards(classSlides.slice(0, 6), slidesContainer);
    if (imagesContainer) renderFileCards(images.slice(0, 6), imagesContainer);
    
  } catch (err) {
    console.error("[Backup loader] Error:", err);
  }
}

// ============================================
// INIT
// ============================================
async function initSlideNotesLoading() {
  try {
    await Promise.all([
      loadHandNotes(),
      loadClassSlides(),
      loadImages()
    ]);
  } catch (err) {
    console.error("[Init] Error:", err);
    // Fallback if all else fails
    loadAllResourcesAsBackup();
  }
}

// Run on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSlideNotesLoading);
} else {
  initSlideNotesLoading();
}
