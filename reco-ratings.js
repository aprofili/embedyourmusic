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
              if (s) rel.setRating(id, Number(s[1]));
            }, 1500);
          }
        },
        { passive: type.startsWith("touch") ? false : undefined }
      );
    }
    watchVisible(li, id, box);
  }

  // The list doesn't include your own ratings, so read each one from the release page
  // (its widget is initialised as new RYMrating('l', id, <0-10>)). Rows are fetched when they
  // scroll into view, plus an in-order pass from the top to find the first unrated row.
  // Results are written to the row (data-eym-rating, class rym-rated) for content.css and
  // recommendations.js, which run in the other JavaScript world and share only the DOM.
  const rel = globalThis.__eymRelease;

  function applyRating(id, box, rating) {
    if (box.dataset.touched) return; // you already rated it here
    window[`rating_l_${id}`] = new window.RYMrating("l", Number(id), rating);
    const stars = box.querySelector(`#rating_stars_l_${id}`);
    const num = box.querySelector(`#rating_num_l_${id}`);
    if (stars) stars.className = `rating_stars star-${rating}m`;
    if (num) num.textContent = (rating / 2).toFixed(1);
  }

  // Cached, throttled, de-duplicated by release-data.js. null = unknown.
  function ratingOf(li, id) {
    const link = li.querySelector("a.component_discography_item_link.release");
    if (!link) return Promise.resolve(null);
    return rel
      .get(id, link.getAttribute("href"))
      .then((r) => (r.ratingKnown ? r.rating : null))
      .catch(() => null);
  }

  async function loadRating(li, id, box) {
    const rating = await ratingOf(li, id);
    if (rating === null) return;
    li.dataset.eymRating = String(rating);
    li.classList.toggle("rym-rated", rating > 0);
    if (rating > 0) applyRating(id, box, rating);
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

  const visible =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            visible.unobserve(e.target);
            e.target.__eymLoad();
          }
        })
      : null;

  function watchVisible(li, id, box) {
    li.__eymLoad = () => loadRating(li, id, box);
    if (visible) visible.observe(li);
    else li.__eymLoad();
  }

  function scan() {
    for (const li of document.querySelectorAll("li.component_discography_item")) enhance(li);
  }

  function start() {
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
