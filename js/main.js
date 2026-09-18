// ============================================
// AGRI CORE — main.js (shared across pages)
// ============================================

// ------------------------------------------------------------------
// Mobile nav toggle — implemented with a SINGLE delegated listener on
// `document` rather than binding to specific elements. This is
// deliberate: navbar.html is injected asynchronously via fetch(), and
// several pages re-render or re-check the navbar after other async
// work (session/auth state, etc). Binding directly to `.nav-toggle`
// worked only if that exact element still existed at bind-time; any
// re-injection or timing mismatch silently left the button dead. Event
// delegation on `document` has no such race — it inspects whatever is
// in the DOM at the moment of the click, every time.
// ------------------------------------------------------------------
(function () {
  function getDrawerParts() {
    return {
      toggle: document.querySelector('.nav-toggle'),
      links: document.querySelector('.nav-links'),
      backdrop: document.getElementById('nav-drawer-backdrop')
    };
  }

  let scrollLockY = 0;
  function openDrawer() {
    const { toggle, links, backdrop } = getDrawerParts();
    if (!links) return;
    links.classList.add('open');
    backdrop?.classList.add('open');
    toggle?.setAttribute('aria-expanded', 'true');
    // Lock the body with position:fixed (rather than plain overflow:hidden)
    // so iOS Safari can't rubber-band-scroll the page behind the open
    // drawer — that's the "page moves underneath the menu" glitch.
    scrollLockY = window.scrollY || window.pageYOffset || 0;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollLockY}px`;
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.classList.add('nav-drawer-locked');
  }
  function closeDrawer() {
    const { toggle, links, backdrop } = getDrawerParts();
    links?.classList.remove('open');
    backdrop?.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-drawer-locked');
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    window.scrollTo(0, scrollLockY);
  }
  function isDrawerOpen() {
    return document.querySelector('.nav-links.open') != null;
  }

  document.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.nav-toggle');
    if (toggleBtn) {
      e.preventDefault();
      isDrawerOpen() ? closeDrawer() : openDrawer();
      return;
    }
    if (e.target.closest('.nav-links-close')) {
      closeDrawer();
      return;
    }
    if (e.target.closest('#nav-drawer-backdrop')) {
      closeDrawer();
      return;
    }
    // Tapping a menu link should navigate AND close the drawer behind it.
    const navLink = e.target.closest('.nav-links a');
    if (navLink) {
      closeDrawer();
      return;
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawerOpen()) closeDrawer();
  });

  // Subtle shadow once the page has scrolled past the very top — makes
  // the sticky navbar read as "lifted" above the content instead of
  // blending into it. Re-checked on scroll regardless of when the
  // navbar itself was injected.
  const updateShadow = () => {
    const navbar = document.querySelector('.navbar');
    if (navbar) navbar.classList.toggle('is-scrolled', window.scrollY > 4);
  };
  window.addEventListener('scroll', updateShadow, { passive: true });
  window.addEventListener('load', updateShadow);
  if (typeof window.whenNavbarReady === "function") {
    window.whenNavbarReady(updateShadow);
  }
})();

// ------------------------------------------------------------------
// "Section updated" bookkeeping (drives the slow blink on homepage cards —
// see js/section-updates.js).
//
// Each browser remembers, per section, WHEN the visitor last looked at it.
// The homepage compares that against the newest content timestamp in the
// section and blinks the card if there is something newer. Opening a
// section page (from the card, the navbar, a bookmark — anything) marks
// it as seen, so the blink stops.
//
// Lives here (not in section-updates.js) because main.js is loaded on every
// page, while section-updates.js only runs on the homepage.
// ------------------------------------------------------------------
(function () {
  const KEY = 'agri_section_seen_v1';

  // page file name (without .html) -> homepage card key
  const PAGE_TO_SECTION = {
    'knowledge-hub': 'knowledge',
    'timeline': 'timeline',
    'resources': 'resources',
    'slides-notes': 'resources',
    'previous-questions': 'resources',
    'calculators': 'calculators',
    'blog': 'blog',
    'help': 'help'
  };

  function read() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  function write(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch (err) { /* private mode / storage full — blink just won't persist */ }
  }

  window.AgriSectionSeen = {
    get: read,
    // Mark a section as seen. `upTo` lets the homepage pass the newest
    // update time it knows about, so a slightly-fast server/admin clock
    // can't leave the card blinking after the visitor has opened it.
    mark(section, upTo) {
      const seen = read();
      seen[section] = Math.max(Date.now(), Number(upTo) || 0);
      write(seen);
    },
    // First-ever visit (or a section that has no record yet): start the
    // baseline at "now" so old content doesn't blink — only NEW updates do.
    ensureBaseline(sections) {
      const seen = read();
      let changed = false;
      const now = Date.now();
      sections.forEach((key) => {
        if (typeof seen[key] !== 'number') { seen[key] = now; changed = true; }
      });
      if (changed) write(seen);
      return seen;
    }
  };

  const page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/i, '');
  const section = PAGE_TO_SECTION[page];
  if (section) window.AgriSectionSeen.mark(section);
})();

document.addEventListener('DOMContentLoaded', () => {

  // Animated stat counters (runs once, respects reduced motion)
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (prefersReduced) {
      el.textContent = target.toLocaleString() + '+';
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
        el.textContent = target.toLocaleString() + '+';
        clearInterval(timer);
      } else {
        el.textContent = Math.floor(current).toLocaleString() + '+';
      }
    }, stepTime);
  });

  // Universal search is now handled by js/search.js (live Firestore results).

  // Scroll-triggered reveal animation — fades + lifts elements with the
  // ".reveal" class into view as they enter the viewport. Staggers slightly
  // by index so groups (cards, stats) don't all pop in at once.
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (prefersReducedMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach(el => el.classList.add('is-visible'));
    } else {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });

      revealEls.forEach((el, i) => {
        el.style.transitionDelay = `${Math.min(i % 6, 5) * 70}ms`;
        observer.observe(el);
      });
    }
  }
});

// ------------------------------------------------------------------
// Global image fallback — if any avatar/logo/photo fails to load (a
// dead URL, a slow/offline Cloudinary asset, a moved file, etc.) swap
// it for a lightweight inline placeholder instead of leaving the
// browser's broken-image icon on screen. Delegated + capture:true so
// it also catches images that are added to the page later (feed
// posts, comments, profile switches) without extra wiring per page.
// ------------------------------------------------------------------
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || img.dataset.fallbackApplied) return;
  img.dataset.fallbackApplied = "true";
  const isAvatar = /avatar/i.test(img.className) || /avatar/i.test(img.src || '');
  const isLogo = /brand-mark|logo/i.test(img.className);
  const fill = isAvatar ? '%236B9B5E' : '%23DCD5C3';
  const glyph = isAvatar ? encodeURIComponent('👤') : (isLogo ? encodeURIComponent('🌱') : encodeURIComponent('🖼️'));
  img.src = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='16' fill='${fill}' opacity='0.25'/%3E%3Ctext x='50' y='58' font-size='40' text-anchor='middle'%3E${glyph}%3C/text%3E%3C/svg%3E`;
  img.style.objectFit = 'cover';
}, true);
