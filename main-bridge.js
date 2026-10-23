// Runs in the page's own JavaScript world on every RYM page. The extension's other scripts live in
// an isolated world and cannot call RYM's page code, so they ask for it with a DOM event:
//   document.dispatchEvent(new CustomEvent("eym-main", { detail: JSON.stringify({ action, id }) }))
//  - "suggestions": run RYM's own SuggestionsLoad for a release into the hidden list
//    #suggestions_release_<id> that the requester created (the album page doesn't need to be open).
//  - "rate": RYM's own CatalogSetRating for a release.
//  - "review": fill in and press RYM's own review form on the release page (text, optional publish).
//  - "listening": RYM's own "Set listening" request (AddPlayHistoryFromText) for a release.
(() => {
  const loadScript = (path, ready, cb) => {
    if (ready()) return cb();
    const bundle = document.querySelector('script[src*="/js/bundle.js"]');
    if (!bundle) return;
    const s = document.createElement("script");
    s.src = bundle.src.replace("/js/bundle.js", path);
    s.onload = () => cb();
    document.head.append(s);
  };

  function suggestions(id) {
    const ul = document.getElementById(`suggestions_release_${id}`);
    if (!ul) return;
    loadScript(
      "/js/component/suggestions.js",
      () => window.RYMsuggestions && typeof window.RYMsuggestions.load === "function",
      () => {
        try {
          window.RYMsuggestions.load(window.$(ul));
        } catch (e) {
          console.warn("[EmbedYourMusic] suggestions failed", e);
        }
      }
    );
  }

  function listening(id) {
    try {
      // On the release page: RYM's own "Set listening" box (Save listening = the whole album, nothing selected).
      const ph = window.RYMPlayHistory;
      if (ph && typeof ph.save === "function" && document.getElementById("listening_save_btn")) {
        ph.assoc_id = Number(id);
        ph.save();
        return;
      }
      // Same request as the "Set" box on your profile: AddPlayHistoryFromText with the [AlbumID] shortcut.
      window.rym.request.post("AddPlayHistoryFromText", { play_str: `[Album${id}]` }, null, "script");
    } catch (e) {
      console.warn("[EmbedYourMusic] set listening failed", e);
    }
  }

  // RYM's own CatalogSetRating (what the star widget sends), 0-10 half-stars. Works from any RYM page.
  function rate(id, rating) {
    if (!Number.isInteger(rating) || rating < 0 || rating > 10) return;
    try {
      // The response script reports back to the page's rating object for this release; give it one if the page has none.
      const name = `rating_l_${id}`;
      if (!window[name]) window[name] = { _ratingCallback() {}, onChange() {} };
      window.rym.request.post("CatalogSetRating", { type: "l", assoc_id: id, rating }, null, "script");
    } catch (e) {
      console.warn("[EmbedYourMusic] rating failed", e);
    }
  }

  // RYM's review form on a release page (#review_body, #review_publish, #review_save_btn), driven like a person would.
  function review(text, publish) {
    const body = document.getElementById("review_body");
    const save = document.getElementById("review_save_btn");
    if (!body || !save || !window.review) return false;
    body.value = String(text || "");
    body.dispatchEvent(new Event("input", { bubbles: true }));
    body.dispatchEvent(new Event("change", { bubbles: true }));
    const pub = document.getElementById("review_publish");
    if (pub && pub.checked !== !!publish) pub.click();
    save.disabled = false;
    save.click();
    return true;
  }

  document.addEventListener("eym-main", (e) => {
    let d;
    try {
      d = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!d || !/^\d+$/.test(String(d.id))) return;
    if (d.action === "suggestions") suggestions(d.id);
    else if (d.action === "listening") listening(d.id);
    else if (d.action === "rate") rate(d.id, d.rating);
    else if (d.action === "review") review(d.text, d.publish);
  });
})();
