// Shared by recommendations.js and reco-ratings.js (each world loads its own copy): one cached,
// throttled read of a release page, giving both your rating and the streaming links.
// Goal: as few requests to rateyourmusic.com as possible.
//   - Results live in localStorage (shared by every tab): rated releases 14 days, unrated 20 min.
//   - One request at a time, ~400ms apart; concurrent callers for a release share one request.
//   - A 403/429/503 pauses all fetching: 15 min, then 1 h, 6 h, 24 h if it keeps happening, so a
//     blocked browser isn't poked every 15 minutes. Any success resets the ladder.
(() => {
  if (globalThis.__eymRelease) return;

  const RATED_TTL = 14 * 24 * 3600 * 1000;
  const UNRATED_TTL = 20 * 60 * 1000;
  const BLOCK_LADDER = [5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3];
  const GAP_MS = globalThis.__eymGapMs ?? 400; // (tests set 0)
  const BLOCK_KEY = "eym:blocked-until";
  const COUNT_KEY = "eym:block-count";
  const STATUS_KEY = "eym:block-status";
  const RATING = /new RYMrating\(\s*['"]l['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/;

  const key = (id) => `eym:rel:${id}`;
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  // Everything useful on a release page, read from a parsed document (a fetched page, or the open one).
  function extractMeta(doc) {
    const q = (s) => doc.querySelector(s);
    const titleEl = q(".album_title");
    const textNode = titleEl && [...titleEl.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const artistEl = q(".album_artist_small a.artist, [itemprop='byArtist'] a, a.artist");
    const og = q('meta[property="og:image"]');
    const released = [...doc.querySelectorAll(".album_info th, .album_info_outer th")].find((th) => /^released/i.test(th.textContent.trim()));
    const year = released && /\b(19|20)\d\d\b/.exec(released.nextElementSibling ? released.nextElementSibling.textContent : "");
    const links = q("[data-links]");
    return {
      title: textNode ? textNode.textContent.trim() : titleEl ? titleEl.textContent.trim() : "",
      artist: artistEl ? artistEl.textContent.trim() : "",
      art: og && og.content ? (/\/i\/\d+\/w\//.test(og.content) ? og.content : og.content.replace(/\/i\/\d+\//, "/i/300/")) : "",
      year: year ? Number(year[0]) : 0,
      links: links ? links.getAttribute("data-links") : null,
    };
  }

  // The release id, from whichever marker the page has.
  const ID_MARKS = [/\[Album(\d+)\]/, /my_catalog_rating_l_(\d+)/, /rating_stars_l_(\d+)/, /["']assoc_id["']\s*[:=]\s*["']?(\d+)/, /CatalogSetRating[^)]*?(\d{3,})/];
  function idFromHtml(html) {
    const m = RATING.exec(html);
    if (m) return m[1];
    for (const re of ID_MARKS) {
      const x = re.exec(html);
      if (x) return x[1];
    }
    return "";
  }

  // Tell the extension a rating is known (content.js saves it for the side panel, which greys out rated albums).
  // A DOM event so it also crosses from the page's world (reco-ratings.js) to the extension's.
  function told(id, path, rating) {
    try {
      if (typeof document !== "undefined" && document.dispatchEvent)
        document.dispatchEvent(new CustomEvent("eym-rated", { detail: JSON.stringify({ id: String(id || ""), path: path || "", rating: Number(rating) || 0 }) }));
    } catch {}
  }

  function cached(id) {
    try {
      const rec = JSON.parse(store.get(key(id)));
      if (rec && Date.now() - rec.t < (rec.rating > 0 ? RATED_TTL : UNRATED_TTL)) return rec;
    } catch {}
    return null;
  }

  // Streaming links never change, so for "just play it" a record of any age (up to 30 days) will do.
  const LINKS_TTL = 30 * 24 * 3600 * 1000;
  function cachedAny(id) {
    try {
      const rec = JSON.parse(store.get(key(id)));
      if (rec && rec.links && Date.now() - rec.t < LINKS_TTL) return rec;
    } catch {}
    return null;
  }

  const blockedUntil = () => Number(store.get(BLOCK_KEY)) || 0;
  const blocked = () => blockedUntil() > Date.now();

  let tail = Promise.resolve();
  const inflight = new Map();
  let lastFetch = 0;

  // Any request to RYM (ours or the collection fetch) reports its status here.
  function noteStatus(status) {
    if (![429, 503].includes(status)) return; // 403 is the bot check on script requests, not a rate limit
    const count = (Number(store.get(COUNT_KEY)) || 0) + 1;
    store.set(COUNT_KEY, String(count));
    store.set(STATUS_KEY, String(status));
    store.set(BLOCK_KEY, String(Date.now() + BLOCK_LADDER[Math.min(count, BLOCK_LADDER.length) - 1]));
  }

  // Background-tab fallback (extension only). The tab's content script stores the record; read it back.
  async function openInTab(href, seq) {
    try {
      const rt = globalThis.chrome && chrome.runtime;
      if (!rt || !rt.sendMessage || !rt.id) return null;
      const res = await rt.sendMessage({ type: "open-release", href, seq: seq || 0 });
      if (!res || !res.ok) return null;
      const id = store.get(hrefKey(href));
      let rec = null;
      try {
        rec = id && JSON.parse(store.get(key(id)));
      } catch {}
      if (!rec) return null;
      store.set(COUNT_KEY, "0");
      return { ...rec, id, net: true };
    } catch {
      return null;
    }
  }

  let botCheckUntil = 0; // a script request just met RYM's bot check: go straight to a real page load for a while
  async function network(id, href, seq) {
    const wait = lastFetch + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (blocked()) {
      // Script requests are paused (RYM said 429/503): a normal page load in a background tab still works.
      const viaTab = href && (await openInTab(href));
      if (viaTab) return viaTab;
      throw new Error(blockMessage());
    }
    if (href && botCheckUntil > Date.now()) {
      const viaTab = await openInTab(href, seq);
      if (viaTab) return viaTab;
    }
    lastFetch = Date.now();
    const res = await fetch(href, { credentials: "same-origin" });
    if (res.status === 403) {
      // Bot check on a script request: a real page load in a background tab usually gets through.
      botCheckUntil = Date.now() + 10 * 60e3;
      const viaTab = await openInTab(href, seq);
      if (viaTab) return viaTab;
    }
    if (!res.ok) {
      noteStatus(res.status);
      throw new Error(res.status === 404 ? "not found" : blocked() ? blockMessage() : `HTTP ${res.status}`);
    }
    store.set(COUNT_KEY, "0");
    const html = await res.text();
    const m = RATING.exec(html);
    const rid = id != null ? id : idFromHtml(html);
    const doc = new DOMParser().parseFromString(html, "text/html");
    // One request, everything: links, your rating, title / artist / art / year.
    const rec = {
      t: Date.now(),
      rating: m && m[1] === rid ? Number(m[2]) : 0,
      ratingKnown: !!(m && m[1] === rid),
      ...extractMeta(doc),
    };
    if (rid) store.set(key(rid), JSON.stringify(rec));
    if (rec.ratingKnown) {
      let path = "";
      try {
        path = new URL(href, "https://rateyourmusic.com").pathname;
      } catch {}
      told(rid, path, rec.rating);
    }
    return { ...rec, id: rid, net: true }; // net: this call hit the network (not persisted)
  }

  function blockMessage() {
    const mins = Math.max(1, Math.ceil((blockedUntil() - Date.now()) / 60000));
    const when = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
    return `RYM answered HTTP ${store.get(STATUS_KEY) || "429"}; paused for ${when}`;
  }

  // Cached record only; never touches the network.
  const peek = (id) => cached(id);

  function clearBlock() {
    store.set(BLOCK_KEY, "0");
    store.set(COUNT_KEY, "0");
  }

  // -> Promise<{ rating, ratingKnown, links }>; rejects on failure.
  const failed = new Map(); // key -> { until, message }: don't re-ask RYM about a page that just failed
  const remember = (k, e) => {
    if (!blocked()) failed.set(k, { until: Date.now() + 5 * 60e3, message: String((e && e.message) || e) });
    throw e;
  };
  const recall = (k) => {
    const f = failed.get(k);
    if (!f || f.until < Date.now()) return null;
    return Promise.reject(new Error(f.message));
  };

  function get(id, href) {
    const hit = cached(id);
    if (hit) return Promise.resolve(hit);
    const bad = recall(id);
    if (bad) return bad;
    if (!inflight.has(id)) {
      const job = tail.then(() => network(id, href)).catch((e) => remember(id, e));
      tail = job.catch(() => {});
      inflight.set(
        id,
        job.finally(() => inflight.delete(id))
      );
    }
    return inflight.get(id);
  }

  // For playing: stale records are fine (links don't change); otherwise like get().
  function getLinks(id, href) {
    const any = cachedAny(id);
    return any ? Promise.resolve(any) : get(id, href);
  }

  // Same, when only the release URL is known (side panel lists). Returns { id, rating, ratingKnown, links }.
  const hrefKey = (href) => {
    try {
      return `eym:href:${new URL(href, location.href).pathname}`;
    } catch {
      return `eym:href:${href}`;
    }
  };
  const hrefJobs = new Map();
  // opts.skip(): true once nobody wants this any more (the panel moved on to another album): don't start it.
  function getByHref(href, opts) {
    const known = store.get(hrefKey(href));
    const hit = known && cachedAny(known);
    if (hit) return Promise.resolve({ ...hit, id: known });
    const bad = recall(href);
    if (bad) return bad;
    if (!hrefJobs.has(href)) {
      const job = tail
        .then(() => {
          if (opts && opts.skip && opts.skip()) throw new Error("superseded");
          return network(null, href, opts && opts.seq);
        })
        .then((rec) => {
          if (rec.id) store.set(hrefKey(href), rec.id);
          return rec;
        })
        .catch((e) => remember(href, e));
      tail = job.catch(() => {});
      hrefJobs.set(href, job.finally(() => hrefJobs.delete(href)));
    }
    return hrefJobs.get(href);
  }

  // A release page you open yourself already holds everything: store it, zero requests.
  function put(id, rec, path) {
    if (!id) return;
    if (path) store.set(hrefKey(path), id);
    const r = { t: Date.now(), rating: 0, ratingKnown: false, ...rec };
    if (r.links == null) r.links = "{}"; // read from the page: no links means none, not unknown
    store.set(key(id), JSON.stringify(r));
    if (r.ratingKnown) told(id, path, r.rating);
  }

  // Keep the cache right after you rate something on the page.
  function setRating(id, rating) {
    try {
      const rec = JSON.parse(store.get(key(id))) || { links: null };
      store.set(key(id), JSON.stringify({ ...rec, t: Date.now(), rating, ratingKnown: true }));
    } catch {}
    told(id, "", rating);
  }

  if (store.get(STATUS_KEY) === "403") clearBlock(); // pauses from the old 403 handling

  globalThis.__eymRelease = { get, getLinks, getByHref, put, extractMeta, idFromHtml, noteStatus, peek, setRating, blocked, blockMessage, clearBlock };
})();
