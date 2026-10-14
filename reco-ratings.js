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
    const widget = (window[`rating_l_${id}`] = new window.RYMrating("l", Number(id), 0));
    for (const [type, method] of Object.entries(EVENTS)) {
      box.addEventListener(type, (e) => widget[method](e, box), {
        passive: type.startsWith("touch") ? false : undefined,
      });
    }
  }

  function scan() {
    for (const li of document.querySelectorAll("li.component_discography_item")) enhance(li);
  }

  function start() {
    scan();
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
