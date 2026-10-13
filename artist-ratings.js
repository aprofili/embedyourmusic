// Artist pages: replace each discography row's "Rate" cell with RYM's star-rating widget, so a
// release can be rated in one click instead of expanding the issues list first.
//
// Runs in the page's own JavaScript world (manifest "world": "MAIN") because it uses RYM's
// RYMrating class. That is the same class and request (CatalogSetRating, type "l") the release
// page's Rate/Catalog box uses, so ratings are saved exactly as they are there.

(() => {
  if (!/^\/artist\//.test(location.pathname)) return;

  const EVENTS = {
    mousemove: "onMouseMove",
    mouseover: "onMouseOver",
    mouseout: "onMouseOut",
    touchstart: "onTouchStart",
    touchmove: "onTouchMove",
    touchend: "onTouchEnd",
    click: "onClick",
  };

  // RYM shows the user's existing rating in the cell as e.g. "4.5"; the widget uses a 0-10 scale.
  function currentRating(cell) {
    const shown = cell.querySelector(".disco_cat_inner");
    const value = shown ? parseFloat(shown.textContent) : NaN;
    return Number.isFinite(value) ? Math.round(value * 2) : 0;
  }

  // Same markup as the release page's widget; RYMrating finds these elements by id.
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

  function enhance(row) {
    const match = /^release_(\d+)$/.exec(row.id);
    const cell = row.querySelector(":scope > .disco_expandcat > .disco_cat");
    if (!match || !cell || cell.querySelector(".my_catalog_rating")) return;
    if (typeof window.RYMrating !== "function") return; // RYM's script isn't ready yet

    const id = match[1];
    const rating = currentRating(cell);

    const box = buildWidget(id);
    // Clicks on the stars must not also trigger the cell's "expand issues" handler.
    const wrap = document.createElement("span");
    wrap.className = "rym-rate";
    wrap.addEventListener("click", (e) => e.stopPropagation());
    wrap.append(box);

    cell.textContent = "";
    cell.classList.add("rym-rate-cell");
    cell.append(wrap);

    // The widget must be in the document before RYMrating is created: it looks the elements up.
    // The server's reply calls back into window.rating_l_<id>, as on the release page.
    const widget = (window[`rating_l_${id}`] = new window.RYMrating("l", Number(id), rating));
    for (const [type, method] of Object.entries(EVENTS)) {
      box.addEventListener(type, (e) => widget[method](e, box), {
        passive: type.startsWith("touch") ? false : undefined,
      });
    }
  }

  function scan() {
    for (const row of document.querySelectorAll('[id^="disco_type_"] .disco_release')) enhance(row);
  }

  scan();

  // The discography is re-rendered when it is sorted or filtered.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 200);
  }).observe(document.body, { childList: true, subtree: true });
})();
