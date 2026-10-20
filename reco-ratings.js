// Recommendations page: a star-rating widget to the left of each row's exclude (X) button.
// Same widget and request as the release page's Rate box (RYMrating "l" + release id), so it
// runs in the page's own JavaScript world. The li id suffix is the release id (it matches the
// id passed to addExclusion).

(() => {
  if (!/^\/recommendations\//.test(location.pathname)) return;

  const EVENTS = {
    mousemove: "onMouseMove",
    mouseover: "onMouseOver",
    mouseout: "onMouseOut",
    touchstart: "onTouchStart",
    touchmove: "onTouchMove",
    touchend: "onTouchEnd",
    click: "onClick",
  };

  function buildWidget(id) {
    const box = document.createElement("div");
    box.id = `my_catalog_rating_l_${id}`;
    box.className = "my_catalog_rating";
    box.tabIndex = 0;

    const stars = document.createElement("div");
    stars.id = `rating_stars_l_${id}`;
    stars.className = "rating_stars star-0m";

    const saving = document.createElement("div");
    saving.className = "rating_loading";
    saving.textContent = "Saving...";

    const num = document.createElement("div");
    num.id = `rating_num_l_${id}`;
    num.className = "rating_num";
    num.textContent = "0.0";

    box.append(stars, saving, num);
    return box;
  }

  function enhance(li) {
    const match = /^component_discography_item_(\d+)$/.exec(li.id);
    if (!match || li.querySelector(".rym-reco-rate")) return;
    const id = match[1];

    const wrap = document.createElement("div");
    wrap.className = "rym-reco-rate";
    const box = buildWidget(id);
    wrap.append(box);

    const exclude = li.querySelector(".component_discography_item_exclude");
    if (exclude) exclude.before(wrap);
    else li.append(wrap);

    // The widget must be in the document before RYMrating is created: it looks elements up by id.
    window[`rating_l_${id}`] = new window.RYMrating("l", Number(id), 0);
    // Look the widget up at event time: it is replaced once the saved rating is known.
    for (const [type, method] of Object.entries(EVENTS)) {
      box.addEventListener(
        type,
        (e) => {
          if (type === "click" || type.startsWith("touch")) box.dataset.touched = "1";
          window[`rating_l_${id}`][method](e, box);
          if (type === "click") {
            // Keep the shared cache in step with what you just rated.
            setTimeout(() => {
              const s = /star-(\d+)m/.exec(box.querySelector(".rating_stars").className);
              if (s) {
                box.dataset.cur = s[1];
                rel.setRating(id, Number(s[1]));
              }
            }, 1500);
          }
        },
        { passive: type.startsWith("touch") ? false : undefined }
      );
    }
    // Leaving the stars always shows your real rating (0 if unrated), never the last hover.
    box.addEventListener("mouseleave", () => {
      setTimeout(() => {
        if (box.classList.contains("loading")) return;
        const cur = Number(box.dataset.cur ?? li.dataset.eymRating ?? 0) || 0;
        const stars = box.querySelector(".rating_stars");
        const num = box.querySelector(".rating_num");
        if (stars) stars.className = `rating_stars star-${cur}m`;
        if (num) num.textContent = (cur / 2).toFixed(1);
      }, 0);
    });
    loadFromCache(li, id, box);
  }

  // The list doesn't include your own ratings, so read each one from the release page
  // (its widget is initialised as new RYMrating('l', id, <0-10>)). Rows are fetched when they
  // scroll into view, plus an in-order pass from the top to find the first unrated row.
  // Results are written to the row (data-eym-rating, class rym-rated) for content.css and
  // recommendations.js, which run in the other JavaScript world and share only the DOM.
  // release-data.js is a separate script in this world; if the browser ran it after this one,
  // __eymRelease isn't there yet, so look it up on each use instead of capturing it once.
  const STUB = { peek: () => null, get: () => Promise.reject(new Error("not ready")), setRating() {}, blocked: () => false };
  const rel = new Proxy({}, { get: (_t, k) => (globalThis.__eymRelease || STUB)[k] });

  function applyRating(id, box, rating) {
    if (box.dataset.touched) return; // you already rated it here
    window[`rating_l_${id}`] = new window.RYMrating("l", Number(id), rating);
    const stars = box.querySelector(`#rating_stars_l_${id}`);
    const num = box.querySelector(`#rating_num_l_${id}`);
    if (stars) stars.className = `rating_stars star-${rating}m`;
    if (num) num.textContent = (rating / 2).toFixed(1);
  }

  // Network requests the first-unrated walk may make per page load.
  const NET_BUDGET = 3;
  let netUsed = 0;

  function showRating(li, id, box, rating) {
    li.dataset.eymRating = String(rating);
    li.classList.toggle("rym-rated", rating > 0);
    if (rating > 0) applyRating(id, box, rating);
  }

  // Rows already in the cache are decorated for free; nothing is fetched for rows just because
  // they scrolled into view.
  function loadFromCache(li, id, box) {
    const rec = rel.peek(id);
    if (rec && rec.ratingKnown) showRating(li, id, box, rec.rating);
  }

  async function loadRating(li, id, box) {
    const link = li.querySelector("a.component_discography_item_link.release");
    if (!link) return;
    let rec = rel.peek(id);
    if (!rec) {
      if (netUsed >= NET_BUDGET) return;
      netUsed++;
      try {
        rec = await rel.get(id, link.getAttribute("href"));
      } catch {
        return;
      }
    }
    if (!rec.ratingKnown) return;
    const rating = rec.rating;
    if (rating === null) return;
    showRating(li, id, box, rating);
  }

  // Walk the list from the top until the first row you haven't rated; recommendations.js loads it.
  const MAX_SCAN = 40;
  let marked = false;
  async function findFirstUnrated() {
    await scanForUnrated();
    document.dispatchEvent(new Event("eym-scan-done"));
  }

  async function scanForUnrated() {
    if (marked) return;
    let looked = 0;
    for (const li of document.querySelectorAll("li.component_discography_item")) {
      if (looked >= MAX_SCAN || rel.blocked()) return; // bounded: never walk the whole list
      if (netUsed >= NET_BUDGET && !rel.peek((/^component_discography_item_(\d+)$/.exec(li.id) || [])[1])) return;
      const m = /^component_discography_item_(\d+)$/.exec(li.id);
      const box = li.querySelector(".my_catalog_rating");
      if (!m || !box) continue;
      looked++;
      await loadRating(li, m[1], box);
      if (li.dataset.eymRating === "0") {
        marked = true;
        li.dataset.eymFirstUnrated = "";
        document.dispatchEvent(new Event("eym-first-unrated"));
        return;
      }
    }
  }


  // One bad row must not stop the rest; the first error is shown on the page for diagnosis.
  function reportError(li, e) {
    try {
      console.warn("[EmbedYourMusic] star widget failed", li && li.id, e);
      if (document.querySelector(".rym-reco-error")) return;
      const note = document.createElement("div");
      note.className = "rym-reco-error";
      note.textContent = `Star widget error (${(li && li.id) || "?"}): ${(e && e.message) || e}`;
      const list = document.querySelector("#page_recommendations_group_main_left") || document.body;
      list.prepend(note);
    } catch {
      /* ignore */
    }
  }

  function scan() {
    for (const li of document.querySelectorAll("li.component_discography_item")) {
      try {
        enhance(li);
      } catch (e) {
        reportError(li, e);
      }
    }
  }

  async function start() {
    // Give release-data.js a moment if it hasn't loaded yet.
    for (let i = 0; i < 20 && !globalThis.__eymRelease; i++) await new Promise((r) => setTimeout(r, 100));
    scan();
    findFirstUnrated();
    let timer;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scan, 200);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // RYMrating ships with RYM's release-page script, which this page doesn't load. If it isn't
  // defined, load that script from the same place and version as the site bundle.
  function whenReady(cb) {
    if (typeof window.RYMrating === "function") return cb();
    const bundle = document.querySelector('script[src*="/js/bundle.js"]');
    if (bundle && !document.querySelector("script[data-rym-reco-release]")) {
      const s = document.createElement("script");
      s.src = bundle.src.replace("/js/bundle.js", "/js/page/release.js");
      s.dataset.rymRecoRelease = "";
      document.head.append(s);
    }
    let tries = 0;
    const timer = setInterval(() => {
      if (typeof window.RYMrating === "function") {
        clearInterval(timer);
        cb();
      } else if (++tries > 50) {
        clearInterval(timer); // not available: leave the page as it is
      }
    }, 100);
  }

  whenReady(start);
})();
