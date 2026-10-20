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
  const FAVS_KEY = "sidebar:favs";
  const FAVS_TTL = 24 * 3600 * 1000;
  const ROW = 44; // px, see .item in sidepanel.css

  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => api.storage.local.get(k).then((o) => (o && o[k]) || null).catch(() => null),
    set: (k, v) => api.storage.local.set({ [k]: v }).catch(() => {}),
  };
  let current = null; // { payload, tabId, counted }
  let played = []; // newest first, no duplicates
  let token = 0;
  let ratings = {}; // release URL -> your rating (0-10) for albums seen here; lets the dice skip rated ones without a request

  // ---- Connection to the background worker ----
  // Connected while open: this is how pages know to play here. The worker can be stopped and
  // restarted by the browser (which drops this port), so reconnect and ping to keep it alive.
  let port;
  function connect() {
    port = api.runtime.connect({ name: "sidepanel" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "play") render({ ...msg.payload, tabId: msg.tabId });
      else if (msg.type === "rating" && current && current.payload.id === msg.id) setRating(msg.rating);
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

  function noteRating(href, value, known) {
    if (!href || !known) return;
    if (ratings[href] === value) return;
    ratings[href] = value;
    store.set("sidebar:ratings", ratings);
  }

  function setRating(value, known = true) {
    rating = value;
    hover = 0;
    if (current) {
      current.payload.rating = value;
      if (known) current.payload.ratingKnown = true;
      store.set(LAST_KEY, current.payload);
      noteRating(current.payload.href, value, known);
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

  async function checkRating() {
    if (!current || !current.payload.id) return;
    const who = current;
    $("rating-note").textContent = "Checking…";
    let res;
    try {
      res = await api.runtime.sendMessage({ type: "to-rym", tabId: who.tabId, msg: { type: "check-rating", id: who.payload.id, href: who.payload.href } });
    } catch {
      res = null;
    }
    if (current !== who) return;
    if (res && res.ratingKnown) setRating(res.rating, true);
    else {
      setRating(rating, false);
      $("rating-note").append(` (${(res && res.error) || "couldn't read it"})`);
    }
  }

  async function rate(value) {
    if (!current || !current.payload.id) return;
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
  function render(payload) {
    const my = ++token;
    current = { payload, tabId: payload.tabId == null ? null : payload.tabId, counted: false };
    $("empty").hidden = true;
    $("now").hidden = false;
    setRating(payload.rating || 0, payload.ratingKnown !== false);
    store.set(LAST_KEY, payload);
    noteRating(payload.href, payload.rating, payload.ratingKnown !== false);

    const tabs = $("tabs");
    const body = $("body");
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
    } else {
      const slots = new Map();
      const buttons = new Map();
      let active = null;

      const load = (entry, slot) => {
        const { info, service } = entry;
        const plain = () => {
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
            .build(info, payload, { onListened: () => markListening(payload), onPlay: () => {
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
            })
            .catch(() => {
              if (my !== token) return;
              slot.textContent = "";
              plain();
            });
          return;
        }
        if (info.kind !== "bandcamp") {
          plain();
          return;
        }
        slot.textContent = "Loading…";
        resolveBandcamp(info.url).then((res) => {
          if (my !== token) return;
          slot.textContent = "";
          if (res) slot.append(makeFrame(res.src, res.height, "Bandcamp player"));
          else slot.append("Couldn't load the Bandcamp player.");
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
  }

  // After really listening (see watchPlayback), set the album as "currently listening" on RYM, once a day.
  async function markListening(payload) {
    if (!payload.id) return;
    const seen = (await store.get("sidebar:listened")) || {};
    if (seen[payload.id] && Date.now() - seen[payload.id] < 24 * 3600e3) return;
    seen[payload.id] = Date.now();
    store.set("sidebar:listened", seen);
    api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "set-listening", id: payload.id } }).catch(() => {});
    setTimeout(() => store.set("sidebar:rymhist", { t: 0, items: [] }), 4000); // re-read RYM's history next time
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
      artUrl: payload.artUrl,
      href: payload.href,
    };
    played = [entry, ...played.filter((p) => p.href !== entry.href)].slice(0, PLAYED_MAX);
    store.set(PLAYED_KEY, played);
    refreshOpenList("history");
  }

  // ---- Lists ----
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // -> { items } or { message }
  const SOURCES = {
    async similar() {
      if (!current || !current.payload.id) return { message: "Play an album from its RYM page to see similar albums." };
      const all = await store.get("sidebar:similar");
      const rec = all && all[current.payload.id];
      if (rec && rec.items.length) return { items: rec.items };
      // Not saved yet: ask the album's RYM tab to load and read its Suggestions.
      let res;
      try {
        res = await api.runtime.sendMessage({ type: "to-rym", tabId: current.tabId, msg: { type: "load-similar", id: current.payload.id } });
      } catch {
        res = null;
      }
      if (res && res.items && res.items.length) return { items: res.items };
      return { message: `Couldn't load suggestions (${(res && res.error) || "no response"}).` };
    },
    async recommended() {
      const all = await store.get("sidebar:lists");
      const rec = all && all.recommended;
      return rec && rec.items.length ? { items: rec.items } : { message: "Open your recommendations page once to fill this list." };
    },
    async challenge() {
      const all = await store.get("sidebar:lists");
      const rec = all && all.challenge;
      return rec && rec.items.length ? { items: rec.items } : { message: "Open your recommendations page once to fill this list." };
    },
    // Pages of your collection filtered to 4-5 stars. First open: page 1. After that at most one more
    // random page per day (so the pick widens slowly without hammering RYM).
    async favorites() {
      let rec = (await store.get(FAVS_KEY)) || { pages: 0, got: {}, t: 0 };
      if (!rec.got && rec.items) rec = { pages: 1, got: { 1: rec.items }, t: rec.t }; // older format
      const loaded = Object.keys(rec.got || {}).length;
      const err = await store.get("sidebar:favs-err");
      const backoff = err && Date.now() - err < 15 * 60e3; // don't hammer RYM after a failure
      let want = 0;
      if (!loaded) want = 1;
      else if (loaded < rec.pages && Date.now() - rec.t > FAVS_TTL) {
        const missing = [];
        for (let p = 1; p <= rec.pages; p++) if (!rec.got[p]) missing.push(p);
        want = missing[Math.floor(Math.random() * missing.length)];
      }
      let res = null;
      if (want && !backoff) {
        try {
          res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "fetch-favorites", page: want } });
        } catch {
          res = null;
        }
        if (res && res.items) {
          rec.got = { ...(rec.got || {}), [want]: res.items };
          rec.pages = res.pages || rec.pages || 1;
          rec.t = Date.now();
          store.set(FAVS_KEY, rec);
        } else if (res && res.error && !/open a rateyourmusic/.test(res.error)) {
          store.set("sidebar:favs-err", Date.now());
        }
      }
      const items = Object.values(rec.got || {}).flat();
      if (!items.length) {
        return { message: backoff ? "Couldn't load your 4+ star albums a moment ago; try again in a few minutes." : `Couldn't load your 4+ star albums (${(res && res.error) || "no response"}).` };
      }
      return { items: shuffle(items) };
    },
    // Your RYM play history (newest first; cached 10 min) followed by albums played here that aren't in it yet.
    async history() {
      let rec = await store.get("sidebar:rymhist");
      const err = await store.get("sidebar:rymhist-err");
      if ((!rec || Date.now() - rec.t > 10 * 60e3) && !(err && Date.now() - err < 15 * 60e3)) {
        let res = null;
        try {
          res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "fetch-history" } });
        } catch {}
        if (res && res.items) {
          rec = { t: Date.now(), items: res.items };
          store.set("sidebar:rymhist", rec);
        } else if (res && res.error && !/open a rateyourmusic/.test(res.error)) store.set("sidebar:rymhist-err", Date.now());
      }
      const theirs = (rec && rec.items) || [];
      const have = new Set(theirs.map((i) => i.href));
      const items = [...played.filter((p) => !have.has(p.href)), ...theirs]; // just-played, not yet in RYM's history, first
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
    for (const item of shuffle(result.items)) {
      if (skipRated && (item.rated || ratings[item.href] > 0)) continue;
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
        noteRating(item.href, p.rating, true);
        continue;
      }
      render({ ...p, tabId: res.tabId });
      return;
    }
    $("body").textContent = skipRated ? "Everything in this list is already rated." : "Nothing to play.";
  }

  async function playItem(item) {
    const my = ++token;
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
    else $("body").textContent = `Couldn't load that album (${(res && res.error) || "no response"}).`;
  }

  function fillList(acc, kind, result) {
    const body = acc.querySelector(".acc-body");
    body.textContent = "";
    if (!result.items) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = result.message;
      body.append(p);
      return;
    }
    const items = result.items;
    // Show as many rows as fit in the window; "Show more" extends past it (the page then scrolls).
    const top = body.getBoundingClientRect().top;
    const fit = Math.max(3, Math.floor((window.innerHeight - top - 48) / ROW));
    let shown = Math.min(items.length, fit);
    const list = document.createElement("div");
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
        img.src = item.artUrl || "";
        const label = document.createElement("span");
        label.textContent = row.title;
        row.append(img, label);
        row.addEventListener("click", () => playItem(item));
        if (kind !== "history" && kind !== "favorites" && (item.rated || ratings[item.href] > 0)) row.classList.add("rated");
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

  async function openList(acc) {
    for (const other of document.querySelectorAll(".acc.open")) {
      if (other !== acc) closeList(other);
    }
    acc.classList.add("open");
    const body = acc.querySelector(".acc-body");
    body.hidden = false;
    body.textContent = "Loading…";
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
    if (acc) openList(acc);
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
    die.textContent = "🎲";
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
      if (changes["sidebar:similar"]) refreshOpenList("similar");
    });
  }

  // ---- Restore ----
  // Releases before the lists existed kept their history under another key; fold it in once.
  store.get("sidebar:ratings").then((r) => {
    ratings = { ...(r || {}), ...ratings };
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
    if (!current && last) render(last);
  });
})();
