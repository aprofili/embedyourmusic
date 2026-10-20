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
  const BLOCK_LADDER = [15 * 60e3, 3600e3, 6 * 3600e3, 24 * 3600e3];
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
    if (![403, 429, 503].includes(status)) return;
    const count = (Number(store.get(COUNT_KEY)) || 0) + 1;
    store.set(COUNT_KEY, String(count));
    store.set(STATUS_KEY, String(status));
    store.set(BLOCK_KEY, String(Date.now() + BLOCK_LADDER[Math.min(count, BLOCK_LADDER.length) - 1]));
  }

  async function network(id, href) {
    const wait = lastFetch + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (blocked()) throw new Error(blockMessage());
    lastFetch = Date.now();
    const res = await fetch(href, { credentials: "same-origin" });
    if (!res.ok) {
      noteStatus(res.status);
      throw new Error(res.status === 404 ? "not found" : blocked() ? blockMessage() : `HTTP ${res.status}`);
    }
    store.set(COUNT_KEY, "0");
    const html = await res.text();
    const m = RATING.exec(html);
    const rid = id != null ? id : m ? m[1] : "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector("[data-links]");
    const rec = {
      t: Date.now(),
      rating: m && m[1] === rid ? Number(m[2]) : 0,
      ratingKnown: !!(m && m[1] === rid),
      links: el ? el.getAttribute("data-links") : null,
    };
    if (rid) store.set(key(rid), JSON.stringify(rec));
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
    if (blocked()) return Promise.reject(new Error(blockMessage()));
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
  function getByHref(href) {
    const known = store.get(hrefKey(href));
    const hit = known && cachedAny(known);
    if (hit) return Promise.resolve({ ...hit, id: known });
    if (blocked()) return Promise.reject(new Error(blockMessage()));
    const bad = recall(href);
    if (bad) return bad;
    if (!hrefJobs.has(href)) {
      const job = tail
        .then(() => network(null, href))
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
  function put(id, rec) {
    if (!id) return;
    store.set(key(id), JSON.stringify({ t: Date.now(), rating: 0, ratingKnown: false, links: null, ...rec }));
  }

  // Keep the cache right after you rate something on the page.
  function setRating(id, rating) {
    try {
      const rec = JSON.parse(store.get(key(id))) || { links: null };
      store.set(key(id), JSON.stringify({ ...rec, t: Date.now(), rating, ratingKnown: true }));
    } catch {}
  }

  globalThis.__eymRelease = { get, getLinks, getByHref, put, noteStatus, peek, setRating, blocked, blockMessage, clearBlock };
})();
