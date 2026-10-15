// Shared by recommendations.js and reco-ratings.js (each world loads its own copy): one cached,
// throttled read of a release page, giving both your rating and the streaming links.
// Goal: as few requests to rateyourmusic.com as possible.
//   - Results live in localStorage (shared by every tab): rated releases 14 days, unrated 20 min.
//   - One request at a time, ~400ms apart; concurrent callers for a release share one request.
//   - A 403/429/503 pauses all fetching for 15 minutes.
(() => {
  if (globalThis.__eymRelease) return;

  const RATED_TTL = 14 * 24 * 3600 * 1000;
  const UNRATED_TTL = 20 * 60 * 1000;
  const BLOCK_MS = 15 * 60 * 1000;
  const GAP_MS = globalThis.__eymGapMs ?? 400; // (tests set 0)
  const BLOCK_KEY = "eym:blocked-until";
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

  const blockedUntil = () => Number(store.get(BLOCK_KEY)) || 0;
  const blocked = () => blockedUntil() > Date.now();

  let tail = Promise.resolve();
  const inflight = new Map();
  let lastFetch = 0;

  async function network(id, href) {
    const wait = lastFetch + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (blocked()) throw new Error(blockMessage());
    lastFetch = Date.now();
    const res = await fetch(href, { credentials: "same-origin" });
    if (!res.ok) {
      if ([403, 429, 503].includes(res.status)) store.set(BLOCK_KEY, String(Date.now() + BLOCK_MS));
      throw new Error(res.status === 404 ? "not found" : blocked() ? blockMessage() : `HTTP ${res.status}`);
    }
    const html = await res.text();
    const m = RATING.exec(html);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector("[data-links]");
    const rec = {
      t: Date.now(),
      rating: m && m[1] === id ? Number(m[2]) : 0,
      ratingKnown: !!(m && m[1] === id),
      links: el ? el.getAttribute("data-links") : null,
    };
    store.set(key(id), JSON.stringify(rec));
    return rec;
  }

  function blockMessage() {
    const mins = Math.max(1, Math.ceil((blockedUntil() - Date.now()) / 60000));
    return `RYM is rate-limiting requests; paused for ${mins} more min`;
  }

  // -> Promise<{ rating, ratingKnown, links }>; rejects on failure.
  function get(id, href) {
    const hit = cached(id);
    if (hit) return Promise.resolve(hit);
    if (blocked()) return Promise.reject(new Error(blockMessage()));
    if (!inflight.has(id)) {
      const job = tail.then(() => network(id, href));
      tail = job.catch(() => {});
      inflight.set(
        id,
        job.finally(() => inflight.delete(id))
      );
    }
    return inflight.get(id);
  }

  // Keep the cache right after you rate something on the page.
  function setRating(id, rating) {
    try {
      const rec = JSON.parse(store.get(key(id))) || { links: null };
      store.set(key(id), JSON.stringify({ ...rec, t: Date.now(), rating, ratingKnown: true }));
    } catch {}
  }

  globalThis.__eymRelease = { get, setRating, blocked, blockMessage };
})();
