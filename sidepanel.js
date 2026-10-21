// Side panel player: what you started playing on rateyourmusic.com (RYM link, service tabs,
// player, your star rating, a Like-current-song button for Spotify) plus lists of other albums to
// play: Similar, Recommended, Challenge, Favorites and History. Pages send the release through
// background.js while this panel is open; with it closed, pages embed players in the page.
// content.js is loaded first for its embed helpers (it finds nothing to do on this page).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const eym = globalThis.__embedYourMusic;
  const { classifyAny, makeFrame, resolveBandcamp, trackList, ORDER, LABELS } = eym;
  const PLAYED_KEY = "sidebar:played";
  const LAST_KEY = "sidebar:last";
  const PLAYED_MAX = 100;
  const FAVS_KEY = "sidebar:favs35";
  const FAVS_TTL = 24 * 3600 * 1000;
  const ROW = 44; // px, see .item in sidepanel.css

  const $ = (id) => document.getElementById(id);
  const selfWrites = {}; // key -> time this panel last wrote it (so its own writes don't trigger a refresh)
  const store = {
    get: (k) => api.storage.local.get(k).then((o) => (o && o[k]) || null).catch(() => null),
    set: (k, v) => {
      selfWrites[k] = Date.now();
      return api.storage.local.set({ [k]: v }).catch(() => {});
    },
  };
  let current = null; // { payload, tabId, counted }
  let played = []; // newest first, no duplicates
  let token = 0;
  // Your ratings (0-10) seen anywhere: { "p:<release path>": r, "i:<release id>": r } (content.js and this panel write
  // it). Rated albums are greyed out in Recommended / Challenge / Similar / More by artist / New music and skipped by the dice.
  let ratings = {};
  const pathKey = (href) => {
    try {
      return `p:${new URL(href, "https://rateyourmusic.com").pathname}`;
    } catch {
      return "";
    }
  };
  const ratingOf = (item) => Math.max(ratings[pathKey(item.href)] || 0, (item.id && ratings[`i:${item.id}`]) || 0);
  const isRated = (item) => !!item.rated || ratingOf(item) > 0;
  // Grey out (or un-grey) rows already on screen.
  function dimRows() {
    for (const row of document.querySelectorAll(".acc .item[data-href]")) {
      const kind = row.closest(".acc").dataset.kind;
      if (kind === "history" || kind === "favorites") continue;
      row.classList.toggle("rated", isRated({ href: row.dataset.href, id: row.dataset.id, rated: row.dataset.rated === "1" }));
    }
  }

  // ---- Connection to the background worker ----
  // Connected while open: this is how pages know to play here. The worker can be stopped and
  // restarted by the browser (which drops this port), so reconnect and ping to keep it alive.
  let port;
  function connect() {
    port = api.runtime.connect({ name: "sidepanel" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "play") render({ ...msg.payload, tabId: msg.tabId });
      else if (msg.type === "rating" && current && current.payload.id === msg.id) setRating(msg.rating);
      else if (msg.type === "history") {
        toast(msg.text, !msg.ok);
        if (msg.ok) refreshOpenList("history");
      }
    });
    port.onDisconnect.addListener(() => setTimeout(connect, 200));
  }
  connect();
  setInterval(() => {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      /* reconnects via onDisconnect */
    }
  }, 20000);

  // ---- Rating ----
  let rating = 0;
  let hover = 0;

  // Built once and updated in place: rebuilding on hover would remove the element under the
  // pointer, so its mouseleave would never fire and the hover value would stick.
  const starEls = [];
  function buildStars() {
    const box = $("rating");
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement("span");
      star.textContent = "★";
      for (const [side, value] of [["l", i * 2 - 1], ["r", i * 2]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = side;
        b.title = `${value / 2} stars`;
        b.addEventListener("mouseenter", () => {
          hover = value;
          drawStars();
        });
        b.addEventListener("click", () => rate(value));
        star.append(b);
      }
      starEls.push(star);
      box.append(star);
    }
    const clear = () => {
      hover = 0;
      drawStars();
    };
    box.addEventListener("mouseleave", clear);
    document.documentElement.addEventListener("mouseleave", clear);
    window.addEventListener("blur", clear);
  }

  function drawStars() {
    const shown = hover || rating;
    starEls.forEach((star, idx) => {
      const i = idx + 1;
      star.className = "star " + (shown >= i * 2 ? "full" : shown === i * 2 - 1 ? "half" : "");
    });
  }
  buildStars();

  function noteRating(href, value, known, id) {
    if (!href || !known) return;
    const k = pathKey(href);
    if (ratings[k] === value && (!id || ratings[`i:${id}`] === value)) return;
    ratings[k] = value;
    if (id) ratings[`i:${id}`] = value;
    store.set("sidebar:ratings", ratings);
    dimRows();
  }

  function setRating(value, known = true) {
    rating = value;
    hover = 0;
    if (current) {
      current.payload.rating = value;
      if (known) current.payload.ratingKnown = true;
      store.set(LAST_KEY, current.payload);
      noteRating(current.payload.href, value, known, current.payload.id);
    }
    const note = $("rating-note");
    note.textContent = "";
    if (!known) {
      // Rating never read for this album: offer one request to find out (stars still work).
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "more";
      btn.textContent = "Check rating";
      btn.title = "Fetch your current rating from RYM (one request)";
      btn.addEventListener("click", checkRating);
      note.append(btn);
    } else note.textContent = value ? `Your rating: ${value / 2}` : "Not rated";
    drawStars();
  }

  async function rememberIdLocal(href, id) {
    try {
      const ids = (await store.get("sidebar:ids")) || {};
      ids[new URL(href).pathname] = id;
      await store.set("sidebar:ids", ids);
    } catch {}
  }

  // The album's RYM id (rating, Similar and play history need it): known, remembered, or read from its page.
  async function ensureId(who) {
    const p = who.payload;
    if (p.id || !p.href) return p.id || "";
    try {
      const ids = await store.get("sidebar:ids");
      p.id = (ids && ids[new URL(p.href).pathname]) || "";
    } catch {}
    if (p.id) return p.id;
    const r = await api.runtime.sendMessage({ type: "to-rym", tabId: who.tabId, msg: { type: "check-rating", id: "", href: p.href, title: p.title, artist: p.artist } }).catch(() => null);
    if (r && r.id) {
      p.id = r.id;
      rememberIdLocal(p.href, r.id);
      if (r.ratingKnown && current === who) setRating(r.rating, true);
    }
    return p.id || "";
  }

  async function checkRating() {
    if (!current) return;
    const who = current;
    $("rating-note").textContent = "Checking…";
    let res;
    try {
      res = await api.runtime.sendMessage({ type: "to-rym", tabId: who.tabId, msg: { type: "check-rating", id: who.payload.id || "", href: who.payload.href, title: who.payload.title, artist: who.payload.artist } });
    } catch {
      res = null;
    }
    if (current !== who) return;
    if (res && res.id && !who.payload.id) {
      who.payload.id = res.id;
      rememberIdLocal(who.payload.href, res.id);
    }
    if (res && res.ratingKnown) setRating(res.rating, true);
    else {
      setRating(rating, false);
      $("rating-note").append(` (${(res && res.error) || "couldn't read it"})`);
    }
  }

  async function rate(value) {
    if (!current) return;
    if (!current.payload.id) {
      $("rating-note").textContent = "Finding album…";
      if (!(await ensureId(current))) {
        $("rating-note").textContent = "Couldn't find this album's RYM id.";
        return;
      }
    }
    $("rating-note").textContent = "Saving…";
    let res;
    try {
      res = await api.runtime.sendMessage({ type: "rate", tabId: current.tabId, id: current.payload.id, rating: value });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      setRating(value); // confirmed by the page's own widget a moment later
    } else {
      $("rating-note").textContent = `Couldn't rate (${(res && res.error) || "no response"}).`;
    }
  }

  // Stay blank until the first view is built, then fade in (no flash of the unloaded state).
  // ---- Keeping your place while a new album loads ----
  // The player area keeps its height while it is swapped, then eases to the new height; the row you clicked stays
  // where it was on screen (the scroll position follows the layout) until you scroll yourself.
  let anchor = null;
  let anchorOff = null;
  function holdPlace(row) {
    if (anchorOff) anchorOff();
    anchor = null;
    anchorOff = null;
    const now = $("now");
    if (now.hidden === false && now.offsetHeight) now.style.minHeight = `${now.offsetHeight}px`;
    if (!row || typeof ResizeObserver === "undefined") return;
    const scroller = document.scrollingElement || document.documentElement;
    const a = { row, top: row.getBoundingClientRect().top };
    anchor = a;
    const fix = () => {
      if (anchor !== a || !row.isConnected) return;
      const d = row.getBoundingClientRect().top - a.top;
      if (Math.abs(d) >= 1) scroller.scrollTop += d;
    };
    const ro = new ResizeObserver(fix);
    ro.observe(now);
    ro.observe(document.body);
    const stop = () => {
      ro.disconnect();
      clearTimeout(timer);
      for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) window.removeEventListener(ev, stop, true);
      if (anchor === a) anchor = null;
      anchorOff = null;
    };
    const timer = setTimeout(stop, 6000);
    for (const ev of ["wheel", "touchstart", "keydown", "pointerdown"]) window.addEventListener(ev, stop, true);
    anchorOff = stop;
  }
  // The new player is in: let the area ease from the held height to the new one.
  function settlePlace() {
    const now = $("now");
    if (!now.style.minHeight) return;
    const from = now.offsetHeight;
    now.style.minHeight = "";
    const to = now.offsetHeight;
    if (Math.abs(from - to) < 2 || !now.animate) return;
    now.style.overflow = "hidden";
    const an = now.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 350, easing: "ease" });
    an.onfinish = an.oncancel = () => (now.style.overflow = "");
  }

  const reveal = () => {
    document.body.classList.add("ready");
    settlePlace();
  };
  setTimeout(reveal, 3500); // never stay blank

  // The rating box moves into the custom player (under the art); anything that clears the body puts it back first.
  const rateBox = $("rate-box");
  const rateHome = rateBox.parentNode;
  const restoreRate = () => {
    if (rateBox.parentNode !== rateHome) rateHome.append(rateBox);
  };
  {
    const bodyEl = $("body");
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    Object.defineProperty(bodyEl, "textContent", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        restoreRate();
        desc.set.call(this, v);
      },
    });
  }

  // ---- Player ----
  function render(payload, restore) {
    const my = ++token;
    current = { payload, tabId: payload.tabId == null ? null : payload.tabId, counted: false };
    $("empty").hidden = true;
    $("now").hidden = false;
    setRating(payload.rating || 0, payload.ratingKnown !== false);
    store.set(LAST_KEY, payload);
    noteRating(payload.href, payload.rating, payload.ratingKnown !== false, payload.id);

    const tabs = $("tabs");
    const body = $("body");
    if (!anchorOff) holdPlace(null);
    tabs.textContent = "";
    body.textContent = "";
    body.className = "";

    // First tab: RYM, a plain link to the album page.
    const rym = document.createElement("a");
    rym.className = "rym-reco-tab rym-link";
    rym.textContent = "RYM";
    rym.href = payload.href || "#";
    rym.target = "_blank";
    rym.rel = "noopener";
    rym.title = "Open the album page on RYM";
    tabs.append(rym);

    const entries = [];
    for (const service of ORDER) {
      const e = (payload.entries || []).find((x) => x.service === service);
      const info = e && classifyAny(e.href);
      if (info && info.service === service) entries.push({ service, href: e.href, info });
    }

    if (!entries.length) {
      if (globalThis.__eymSpPlayer) globalThis.__eymSpPlayer.resetTint();
      // Nothing to embed: still show what this is.
      const box = document.createElement("div");
      box.className = "fallback";
      if (payload.artUrl) {
        const img = document.createElement("img");
        img.referrerPolicy = "no-referrer";
        img.src = payload.artUrl;
        box.append(img);
      }
      const text = document.createElement("div");
      const t = document.createElement("strong");
      t.textContent = payload.title || "Untitled";
      const a = document.createElement("div");
      a.textContent = payload.artist || "";
      const note = document.createElement("div");
      note.className = "hint";
      note.textContent = "No streaming links found for this release.";
      text.append(t, a, note);
      box.append(text);
      body.append(box);
      reveal();
    } else {
      const slots = new Map();
      const buttons = new Map();
      let active = null;

      const load = (entry, slot) => {
        const { info, service } = entry;
        const plain = () => {
          if (globalThis.__eymSpPlayer) globalThis.__eymSpPlayer.resetTint();
          if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
          const frame = makeFrame(info.src, info.height, `${LABELS[service]} player`);
          slot.append(frame);
          if (service === "spotify") {
            // Best effort: once the embed reports it is paused, press play for the user.
            const kick = (e) => {
              if (e.origin !== "https://open.spotify.com" || e.source !== frame.contentWindow) return;
              const d = e.data && typeof e.data === "object" ? e.data : {};
              const q = d.payload || d.data || d;
              if (typeof q.isPaused !== "boolean") return;
              window.removeEventListener("message", kick);
              if (q.isPaused) frame.contentWindow.postMessage({ command: "toggle" }, "*");
            };
            window.addEventListener("message", kick);
          }
          const list = service === "spotify" && trackList(info, frame, { compact: true, onListened: () => markListening(payload) });
          if (list) slot.append(list);
        };
        if (service === "spotify" && globalThis.__eymSpPlayer) {
          // Our own player (hidden embed + track list) when Spotify is connected; else the plain embed.
          slot.textContent = "Loading…";
          globalThis.__eymSpPlayer
            .build(info, payload, { autoplay: !restore, onArt: (u) => noteArt(payload.href, u), onPlay: () => {
              if (current && current.payload === payload && !current.counted) {
                current.counted = true;
                addPlayed(payload);
              }
            } })
            .then((node) => {
              if (my !== token) return;
              slot.textContent = "";
              if (node) {
                slot.append(node);
                node.rateSlot.append(rateBox);
              } else plain();
              reveal();
            })
            .catch(() => {
              if (my !== token) return;
              slot.textContent = "";
              plain();
              reveal();
            });
          return;
        }
        if (info.kind !== "bandcamp") {
          plain();
          reveal();
          return;
        }
        slot.textContent = "Loading…";
        resolveBandcamp(info.url).then((res) => {
          if (my !== token) return;
          slot.textContent = "";
          if (res) slot.append(makeFrame(res.src, res.height, "Bandcamp player"));
          else slot.append("Couldn't load the Bandcamp player.");
          reveal();
        });
      };

      const select = (entry) => {
        if (active === entry) return;
        active = entry;
        for (const [e, b] of buttons) {
          b.classList.toggle("rym-tab-active", e === entry);
          b.setAttribute("aria-pressed", String(e === entry));
        }
        for (const s of slots.values()) s.hidden = true;
        let slot = slots.get(entry);
        if (!slot) {
          slot = document.createElement("div");
          slot.className = "rym-embed-slot";
          slots.set(entry, slot);
          body.append(slot);
          load(entry, slot);
        }
        slot.hidden = false;
      };

      for (const entry of entries) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rym-reco-tab";
        b.textContent = LABELS[entry.service];
        b.setAttribute("aria-pressed", "false");
        b.addEventListener("click", () => select(entry));
        buttons.set(entry, b);
        tabs.append(b);
      }
      select(entries.find((e) => e.service === payload.service) || entries.find((e) => e.service === "spotify") || entries[0]);
    }

    refreshOpenList("similar");
    setArtistHead(payload.artist);
    refreshOpenList("artist");
  }

  // After really listening (see watchPlayback), set the album as "currently listening" on RYM, once a day.
  // Small status note at the bottom of the panel (play history sent, a list being re-read, ...).
  let toastTimer;
  function toast(text, bad) {
    let t = document.getElementById("eym-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "eym-toast";
      document.body.append(t);
    }
    t.textContent = text;
    t.classList.toggle("bad", !!bad);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 6000 : 3000);
  }

  // Play history is sent by the background (it also works with the panel closed); it reports back for the toast.
  function markListening(payload) {
    api.runtime.sendMessage({ type: "listened", state: { rymId: payload.id || "", href: payload.href || "", title: payload.title || "", artist: payload.artist || "" } }).catch(() => {});
  }

  // ---- History: only releases whose player you actually interacted with ----
  // Clicking play inside the (cross-origin) player moves focus into its iframe, which blurs this window.
  window.addEventListener("blur", () => {
    setTimeout(() => {
      const el = document.activeElement;
      if (current && !current.counted && el && el.tagName === "IFRAME" && $("body").contains(el)) {
        current.counted = true;
        addPlayed(current.payload);
      }
    }, 0);
  });

  function addPlayed(payload) {
    const entry = {
      id: payload.id,
      title: payload.title,
      artist: payload.artist,
      artUrl: payload.artUrl || (played.find((p) => p.href === payload.href) || {}).artUrl || "",
      href: payload.href,
      at: Date.now(),
    };
    played = [entry, ...played.filter((p) => p.href !== entry.href)].slice(0, PLAYED_MAX);
    store.set(PLAYED_KEY, played);
    refreshOpenList("history");
  }

  // ---- Lists ----
  // Album URL -> a cover URL that loaded here (a fallback, or Spotify's). Fills covers that were missing before.
  let artOk = {};
  let artTimer;
  store.get("sidebar:art-ok").then((v) => (artOk = { ...(v || {}), ...artOk }));
  function noteArt(href, url) {
    if (!href || artOk[href] === url) return;
    artOk[href] = url;
    const p = played.find((x) => x.href === href);
    if (p && !p.artUrl) p.artUrl = url;
    clearTimeout(artTimer);
    artTimer = setTimeout(() => {
      const keys = Object.keys(artOk);
      if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete artOk[k];
      store.set("sidebar:art-ok", artOk);
      store.set(PLAYED_KEY, played);
    }, 1000);
  }
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const isVideo = (i) => {
    try {
      return /^\/release\/(video|musicvideo|music-video|concert|film|dvd)\//.test(new URL(i.href).pathname);
    } catch {
      return false;
    }
  };

  // A list scraped badly (titles missing, e.g. only "▶") is not shown; it is re-read from RYM instead.
  const goodTitle = (i) => i && /[\p{L}\p{N}]/u.test(i.title || "");
  const healthy = (items) => !!(items && items.length && items.filter(goodTitle).length >= items.length * 0.8);

  // ---- List data: one loader for every list read from a RYM page ----
  // Visiting the page saves the list too. Missing or broken: read it now (the background uses a RYM tab you have open
  // on that page, else a helper tab it closes again). Older than its ttl: show it and refresh behind the scenes.
  const H = 3600e3;
  const LISTS = {
    recommended: { key: "sidebar:lists", ttl: 12 * H, msg: { type: "read-reco" }, label: "your recommendations page", page: "https://rateyourmusic.com/recommendations/", get: (v) => v && v.recommended },
    challenge: { key: "sidebar:lists", ttl: 12 * H, msg: { type: "read-reco" }, label: "your recommendations page", page: "https://rateyourmusic.com/recommendations/", get: (v) => v && v.challenge },
    newmusic: { key: "sidebar:newmusic", ttl: 6 * H, msg: { type: "fetch-newmusic" }, label: "RYM's new-music page", page: "https://rateyourmusic.com/new-music/", get: (v) => v },
    history: { key: "sidebar:rymhist", ttl: 0.5 * H, msg: { type: "fetch-history" }, label: "your RYM play history", page: "https://rateyourmusic.com/", get: (v) => v },
  };
  const toStore = (kind, res) => {
    const t = Date.now();
    if (LISTS[kind].key === "sidebar:lists") return { recommended: { t, items: res.recommended || [] }, challenge: { t, items: res.challenge || [] } };
    return { t, items: res.items || [] };
  };
  const sameKey = (kind) => Object.keys(LISTS).filter((k) => LISTS[k].key === LISTS[kind].key);
  const refreshing = new Map();
  function refreshList(kind) {
    const L = LISTS[kind];
    if (refreshing.has(L.key)) return refreshing.get(L.key);
    const job = api.runtime
      .sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: L.msg })
      .catch(() => null)
      .then(async (res) => {
        if (!res || res.error) return { error: (res && res.error) || "no response" };
        const next = toStore(kind, res);
        const got = L.get(next);
        // Never replace a good list with an empty or broken read (an empty play history is fine).
        if (!(got && (healthy(got.items) || (kind === "history" && Array.isArray(res.items))))) return { error: "the page had no albums on it" };
        await store.set(L.key, next);
        return { ok: true };
      })
      .finally(() => refreshing.delete(L.key));
    refreshing.set(L.key, job);
    return job;
  }
  async function listData(kind) {
    const L = LISTS[kind];
    let v = L.get(await store.get(L.key));
    if (v && healthy(v.items)) {
      if (Date.now() - (v.t || 0) > L.ttl) refreshList(kind).then((r) => r.ok && sameKey(kind).forEach(refreshOpenList));
      return { items: v.items.filter(goodTitle) };
    }
    if (kind !== "history") toast(v && v.items && v.items.length ? `That list looked broken; re-reading ${L.label}…` : `Reading ${L.label}…`);
    const r = await refreshList(kind);
    v = L.get(await store.get(L.key));
    if (v && healthy(v.items)) return { items: v.items.filter(goodTitle) };
    if (r.ok && kind === "history") return { items: [] }; // nothing played yet is a fine answer
    return { error: r.error || "the list came out empty or broken", label: L.label, page: L.page };
  }
  const failed = (d) => ({ message: `Couldn't read ${d.label} (${d.error}).`, retry: true, page: d.page });

  const setArtistHead = (name) => {
    const h = document.querySelector('.acc[data-kind="artist"] .acc-head');
    if (h) h.textContent = name ? `More by ${name}` : "More by this artist";
  };

  // -> { items } or { message }
  const SOURCES = {
    async similar() {
      if (!current) return { message: "Play an album to see similar albums." };
      await ensureId(current);
      if (!current.payload.id) return { message: "Couldn't find this album's RYM id, so no similar albums yet." };
      const all = await store.get("sidebar:similar");
      const rec = all && all[current.payload.id];
      if (rec && rec.items.length) return { items: rec.items };
      // Not saved yet: ask the album's RYM tab to load and read its Suggestions.
      let res;
      try {
        res = await api.runtime.sendMessage({ type: "to-rym", tabId: current.tabId, msg: { type: "load-similar", id: current.payload.id, href: current.payload.href } });
      } catch {
        res = null;
      }
      if (res && res.items && res.items.length) return { items: res.items };
      return { message: `Couldn't load suggestions (${(res && res.error) || "no response"}).` };
    },
    // (the section's title carries the artist's name)
    // Other albums by the current artist (their RYM artist page, kept a week per artist).
    async artist() {
      if (!current) return { message: "Play an album to see more by its artist." };
      const m = /^\/release\/[^/]+\/([^/]+)\//.exec(new URL(current.payload.href || "https://x/").pathname);
      if (!m) return { message: "Play an album to see more by its artist." };
      const path = `/artist/${m[1]}`;
      const skip = new URL(current.payload.href).pathname;
      const all = (await store.get("sidebar:artist")) || {};
      const rec = all[path];
      setArtistHead((rec && rec.name) || current.payload.artist);
      const fresh = rec && rec.name && rec.items && rec.items.length && Date.now() - rec.t < 7 * 24 * H;
      let items = rec && rec.items;
      if (!fresh) {
        toast(`Reading ${current.payload.artist || "the artist"}'s page…`);
        const res = await api.runtime.sendMessage({ type: "to-rym", tabId: current.tabId, msg: { type: "fetch-artist", path, name: current.payload.artist, skip: "" } }).catch(() => null);
        if (res && res.items && res.items.length) {
          items = res.items;
          all[path] = { t: Date.now(), items, name: res.name || "" };
          setArtistHead(res.name || current.payload.artist);
          const keys = Object.keys(all);
          if (keys.length > 40) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 40).forEach((k) => delete all[k]);
          store.set("sidebar:artist", all);
        } else if (!items) return failed({ label: "the artist's page", error: (res && res.error) || "no response", page: `https://rateyourmusic.com${path}` });
      }
      items = items.filter((i) => new URL(i.href).pathname !== skip);
      return items.length ? { items } : { message: "No other albums by this artist." };
    },
    async recommended() {
      const d = await listData("recommended");
      return d.items ? d : failed(d);
    },
    async challenge() {
      const d = await listData("challenge");
      return d.items ? d : failed(d);
    },
    // /new-music/ (saved when you visit it, else fetched through a RYM tab), minus videos, minus anything Spotify
    // doesn't have (checked fuzzily by the background; answers are cached for a week). Re-checked every 6 hours.
    async newmusic() {
      const d = await listData("newmusic");
      if (!d.items) return failed(d);
      // Only what Spotify has (answers cached a week by the background); the filtered list is kept until the raw one changes.
      const raw = await store.get("sidebar:newmusic");
      const done = await store.get("sidebar:newmusic-f");
      if (done && raw && done.src === raw.t && healthy(done.items)) return { items: done.items };
      const f = (await api.runtime.sendMessage({ type: "sp-filter", items: d.items }).catch(() => null)) || { items: d.items, filtered: false };
      const items = f.items.filter((i) => !isVideo(i));
      if (f.filtered && raw) store.set("sidebar:newmusic-f", { t: Date.now(), src: raw.t, items });
      return items.length ? { items } : { message: "Nothing from the new-music page is on Spotify right now." };
    },
    // Pages of your collection filtered to 3.5-5 stars. First open: page 1. After that at most one more
    // random page per day (so the pick widens slowly without hammering RYM).
    async favorites() {
      const rec = (await store.get(FAVS_KEY)) || { pages: 0, got: {}, t: 0 };
      const loaded = Object.keys(rec.got || {}).length;
      const missing = [];
      for (let p = 1; p <= rec.pages; p++) if (!rec.got[p]) missing.push(p);
      const want = !loaded ? 1 : missing.length && Date.now() - rec.t > FAVS_TTL ? missing[Math.floor(Math.random() * missing.length)] : 0;
      const fetchPage = async (page) => {
        const res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "fetch-favorites", page } }).catch(() => null);
        if (!res || !res.items) return (res && res.error) || "no response";
        const now = (await store.get(FAVS_KEY)) || { pages: 0, got: {}, t: 0 };
        now.got = { ...(now.got || {}), [page]: res.items };
        now.pages = Math.max(res.pages || 1, now.pages || 0);
        now.t = Date.now();
        await store.set(FAVS_KEY, now);
        return "";
      };
      if (want && loaded) fetchPage(want).then((err) => !err && refreshOpenList("favorites")); // widen in the background
      let error = "";
      if (want && !loaded) {
        toast("Reading your 3.5+ star albums…");
        error = await fetchPage(want);
      }
      const items = Object.values(((await store.get(FAVS_KEY)) || {}).got || {}).flat();
      if (!items.length) return failed({ label: "your 3.5+ star albums", error: error || "none found", page: "https://rateyourmusic.com/" });
      return { items: shuffle(items) };
    },
    // History: what you played here, newest first. Separate from your RYM play history (only borrows its covers).
    async history() {
      const rec = await store.get("sidebar:rymhist");
      const art = new Map(((rec && rec.items) || []).map((i) => [i.href, i.artUrl]));
      const items = played.map((p) => (p.artUrl ? p : { ...p, artUrl: art.get(p.href) || "" }));
      return items.length ? { items } : { message: "Albums you listen to will show up here." };
    },
  };

  // 🎲: play a random entry. In lists of new music, skip albums you've already rated: known from the
  // list itself or from ratings seen before, otherwise from loading the album (a few tries at most).
  async function dice(kind, acc) {
    const my = ++token;
    let result;
    try {
      result = await SOURCES[kind]();
    } catch (e) {
      result = { message: String((e && e.message) || e) };
    }
    if (my !== token) return;
    if (!result.items) {
      openList(acc); // shows the message
      return;
    }
    $("empty").hidden = true;
    $("now").hidden = false;
    $("tabs").textContent = "";
    $("body").className = "hint";
    $("body").textContent = "Picking something…";
    const skipRated = kind !== "history" && kind !== "favorites";
    let tries = 0;
    for (const item of shuffle(kind === "history" ? result.items : result.items.filter((i) => !isVideo(i))).filter(goodTitle)) {
      if (skipRated && isRated(item)) continue;
      if (tries++ >= 8) {
        $("body").textContent = "Tried 8 albums and they were all rated. Try again.";
        return;
      }
      let res;
      try {
        res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "load-release", item } });
      } catch {
        res = null;
      }
      if (my !== token) return;
      if (!res || !res.payload) {
        if (res && /open a rateyourmusic|paused/.test(res.error || "")) {
          $("body").textContent = `Couldn't load (${res.error}).`;
          return;
        }
        continue;
      }
      const p = res.payload;
      if (skipRated && p.ratingKnown && p.rating > 0) {
        noteRating(item.href, p.rating, true, p.id);
        continue;
      }
      render({ ...p, tabId: res.tabId });
      return;
    }
    $("body").textContent = skipRated ? "Everything in this list is already rated." : "Nothing to play.";
  }

  async function playItem(item, row) {
    const my = ++token;
    holdPlace(row);
    $("empty").hidden = true;
    $("now").hidden = false;
    $("tabs").textContent = "";
    $("body").textContent = "Loading…";
    $("body").className = "hint";
    let res;
    try {
      res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "load-release", item } });
    } catch {
      res = null;
    }
    if (my !== token) return;
    if (res && res.payload) render({ ...res.payload, tabId: res.tabId });
    else {
      $("body").textContent = `Couldn't load that album (${(res && res.error) || "no response"}).`;
      settlePlace();
    }
  }

  function fillList(acc, kind, result) {
    const body = acc.querySelector(".acc-body");
    body.textContent = "";
    if (!result.items) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = result.message;
      body.append(p);
      if (result.retry) {
        const row = document.createElement("div");
        row.className = "retry-row";
        const again = document.createElement("button");
        again.type = "button";
        again.className = "more";
        again.textContent = "Try again";
        again.addEventListener("click", () => {
          openList(acc);
        });
        row.append(again);
        if (result.page) {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "more";
          open.textContent = "Open the page";
          open.title = "Opening it fills this list";
          open.addEventListener("click", () => api.tabs && api.tabs.create({ url: result.page }));
          row.append(open);
        }
        body.append(row);
      }
      return;
    }
    const items = (kind === "history" ? result.items : result.items.filter((i) => !isVideo(i))).filter(goodTitle);
    // Two columns. Show as many rows as fit in the window; "Show more" extends past it (the page then scrolls).
    const top = body.getBoundingClientRect().top;
    const fit = Math.max(6, Math.floor((window.innerHeight - top - 48) / ROW) * 2);
    let shown = Math.min(items.length, fit);
    const list = document.createElement("div");
    list.className = "grid";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "Show more";
    const paint = () => {
      list.textContent = "";
      for (const item of items.slice(0, shown)) {
        const row = document.createElement("div");
        row.className = "item";
        row.title = `${item.artist ? item.artist + " — " : ""}${item.title}`;
        const img = document.createElement("img");
        img.referrerPolicy = "no-referrer";
        img.loading = "lazy";
        const cands = [artOk[item.href], item.artUrl, ...(item.artAlts || [])].filter((u, k, a) => u && a.indexOf(u) === k);
        // Whatever cover finally loads is remembered for this album, so next time it shows straight away.
        img.addEventListener("load", () => {
          if (img.src && img.src !== item.artUrl) noteArt(item.href, img.src);
        });
        let tried = 0;
        let askedSpotify = false;
        const spotifyArt = () => {
          // RYM's image host wouldn't serve it here: use Spotify's cover of the same album.
          if (askedSpotify) return img.classList.add("noart");
          askedSpotify = true;
          api.runtime
            .sendMessage({ type: "cover-art", item: { href: item.href, title: item.title, artist: item.artist } })
            .then((r) => {
              if (r && r.url) img.src = r.url;
              else img.classList.add("noart");
            })
            .catch(() => img.classList.add("noart"));
        };
        img.addEventListener("error", () => {
          if (++tried < cands.length) img.src = cands[tried];
          else spotifyArt();
        });
        if (cands.length) img.src = cands[0];
        else spotifyArt();
        const label = document.createElement("span");
        label.className = "lbl";
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = item.title;
        label.append(t);
        if (item.artist) {
          const a = document.createElement("span");
          a.className = "a";
          a.textContent = item.artist;
          label.append(a);
        }
        row.append(img, label);
        row.addEventListener("click", () => playItem(item, row));
        row.dataset.href = item.href;
        if (item.id) row.dataset.id = item.id;
        if (item.rated) row.dataset.rated = "1";
        if (kind !== "history" && kind !== "favorites" && isRated(item)) row.classList.add("rated");
        if (kind === "recommended" || kind === "challenge") {
          const x = document.createElement("button");
          x.type = "button";
          x.className = "x";
          x.textContent = "✕";
          x.title = "Exclude from recommendations";
          x.addEventListener("click", (e) => {
            e.stopPropagation();
            exclude(kind, item, items);
            shown = Math.min(shown, items.length);
            paint();
          });
          row.append(x);
        }
        list.append(row);
      }
      more.hidden = shown >= items.length;
    };
    more.addEventListener("click", () => {
      shown = Math.min(items.length, 200);
      paint();
    });
    paint();
    body.append(list, more);
  }

  // The X: press the exclude button on your recommendations page, and drop it from the saved list.
  async function exclude(kind, item, items) {
    const at = items.indexOf(item);
    if (at >= 0) items.splice(at, 1);
    api.runtime.sendMessage({ type: "to-rym", urlPart: "/recommendations/", msg: { type: "exclude", id: item.id } }).catch(() => {});
    const all = await store.get("sidebar:lists");
    if (all && all[kind]) {
      all[kind].items = all[kind].items.filter((i) => i.id !== item.id);
      store.set("sidebar:lists", all);
    }
  }

  async function openList(acc, quiet) {
    for (const other of document.querySelectorAll(".acc.open")) {
      if (other !== acc) closeList(other);
    }
    acc.classList.add("open");
    const body = acc.querySelector(".acc-body");
    body.hidden = false;
    if (!quiet || !body.firstChild) body.textContent = "Loading…";
    const kind = acc.dataset.kind;
    let result;
    try {
      result = await SOURCES[kind]();
    } catch (e) {
      result = { message: String((e && e.message) || e) };
    }
    if (acc.classList.contains("open")) fillList(acc, kind, result);
  }

  function closeList(acc) {
    acc.classList.remove("open");
    acc.querySelector(".acc-body").hidden = true;
  }

  function refreshOpenList(kind) {
    const acc = document.querySelector(`.acc[data-kind="${kind}"].open`);
    if (acc) openList(acc, true);
  }

  for (const acc of document.querySelectorAll(".acc")) {
    const head = acc.querySelector(".acc-head");
    const bar = document.createElement("div");
    bar.className = "acc-bar";
    head.before(bar);
    bar.append(head);
    const die = document.createElement("button");
    die.type = "button";
    die.className = "dice";
    die.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><g fill="currentColor" stroke="none"><circle cx="8.5" cy="8.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="15.5" cy="15.5" r="1.6"/></g></svg>';
    die.title = "Play a random one";
    die.addEventListener("click", () => dice(acc.dataset.kind, acc));
    bar.append(die);
    head.addEventListener("click", () => {
      if (acc.classList.contains("open")) closeList(acc);
      else openList(acc);
    });
  }

  // Lists the RYM pages publish while this panel is open.
  if (api.storage.onChanged) {
    api.storage.onChanged.addListener((changes) => {
      if (changes["sidebar:lists"]) {
        refreshOpenList("recommended");
        refreshOpenList("challenge");
      }
      const theirs = (k) => changes[k] && !(Date.now() - (selfWrites[k] || 0) < 3000);
      if (theirs("sidebar:similar")) refreshOpenList("similar");
      if (theirs("sidebar:ratings")) {
        ratings = { ...ratings, ...(changes["sidebar:ratings"].newValue || {}) };
        dimRows();
      }
      if (theirs("sidebar:newmusic")) refreshOpenList("newmusic");
      if (theirs("sidebar:rymhist")) refreshOpenList("history");
      if (theirs("sidebar:favs35")) refreshOpenList("favorites");
    });
  }

  // ---- Restore ----
  // Releases before the lists existed kept their history under another key; fold it in once.
  // v1.9.8: art URLs that earlier versions rewrote to a size RYM doesn't have ("/i/300/w/…") never load. Drop them
  // (blank art) and let the favourites / history caches refetch with the right URLs.
  store.get("sidebar:art-fix").then(async (done) => {
    if (done) return;
    const bad = (u) => /\/i\/300\/w\//.test(u || "");
    const fix = (items) => (items || []).forEach((i) => bad(i.artUrl) && (i.artUrl = ""));
    const [pl, lists, sim] = await Promise.all([store.get(PLAYED_KEY), store.get("sidebar:lists"), store.get("sidebar:similar")]);
    if (pl) fix(pl), store.set(PLAYED_KEY, pl), (played = pl);
    if (lists) Object.values(lists).forEach((l) => fix(l.items)), store.set("sidebar:lists", lists);
    if (sim) Object.values(sim).forEach((r) => fix(r.items)), store.set("sidebar:similar", sim);
    store.set(FAVS_KEY, null);
    store.set("sidebar:rymhist", null);
    store.set("sidebar:art-fix", 1);
  });
  store.get("sidebar:ratings").then((r) => {
    // (older versions keyed this by full URL)
    const fixed = {};
    for (const [k, v] of Object.entries(r || {})) fixed[/^[pi]:/.test(k) ? k : pathKey(k)] = v;
    ratings = { ...fixed, ...ratings };
    dimRows();
  });
  Promise.all([store.get(PLAYED_KEY), store.get(LAST_KEY), store.get("sidebar:history"), store.get("sidebar:migrated")]).then(([p, last, old, done]) => {
    played = p || [];
    if (!done && old && old.length) {
      const have = new Set(played.map((x) => x.href));
      for (const o of old) {
        if (o.href && !have.has(o.href)) {
          played.push({ id: o.id, title: o.title, artist: o.artist, artUrl: o.artUrl, href: o.href });
          have.add(o.href);
        }
      }
      played = played.slice(0, PLAYED_MAX);
      store.set(PLAYED_KEY, played);
    }
    if (!done) store.set("sidebar:migrated", true);
    if (!current && last) render(last, true); // reopened by hand: show it, don't start it
    else if (!current) reveal();
  });
})();
