// Runs in the page's own JavaScript world on every RYM page. The extension's other scripts live in
// an isolated world and cannot call RYM's page code, so they ask for it with a DOM event:
//   document.dispatchEvent(new CustomEvent("eym-main", { detail: JSON.stringify({ action, id }) }))
//  - "suggestions": run RYM's own SuggestionsLoad for a release into the hidden list
//    #suggestions_release_<id> that the requester created (the album page doesn't need to be open).
//  - "listening": RYM's own "Set listening" request (AddPlayHistory) for a release.
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
      // Same request as RYM's "Set listening" with no track selected (the album itself).
      window.rym.request.post("AddPlayHistory", { object: "release", assoc_id: id, track_id: "", comments: "" }, null, "script");
    } catch (e) {
      console.warn("[EmbedYourMusic] set listening failed", e);
    }
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
  });
})();
