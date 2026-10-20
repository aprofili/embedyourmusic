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

  function setRating(value) {
    rating = value;
    hover = 0;
    if (current) {
      current.payload.rating = value;
      store.set(LAST_KEY, current.payload);
    }
    $("rating-note").textContent = value ? `Your rating: ${value / 2}` : "Not rated";
    drawStars();
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
      $("rating-note").textContent = `Couldn't rate from here (${(res && res.error) || "no response"}). Use the RYM tab.`;
    }
  }

  // ---- Player ----
  function render(payload) {
    const my = ++token;
    current = { payload, tabId: payload.tabId == null ? null : payload.tabId, counted: false };
    $("empty").hidden = true;
    $("now").hidden = false;
    setRating(payload.rating || 0);
    store.set(LAST_KEY, payload);

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
        if (info.kind !== "bandcamp") {
          if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
          const frame = makeFrame(info.src, info.height, `${LABELS[service]} player`);
          slot.append(frame);
          const list = service === "spotify" && trackList(info, frame, { compact: true });
          if (list) slot.append(list);
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
      return rec && rec.items.length ? { items: rec.items } : { message: "Open this album's RYM page to load its suggestions." };
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
    async favorites() {
      let rec = await store.get(FAVS_KEY);
      if (!rec || Date.now() - rec.t > FAVS_TTL) {
        let res;
        try {
          res = await api.runtime.sendMessage({ type: "to-rym", tabId: current && current.tabId, msg: { type: "fetch-favorites" } });
        } catch {
          res = null;
        }
        if (res && res.items) {
          rec = { t: Date.now(), items: res.items };
          store.set(FAVS_KEY, rec);
        } else if (!rec) {
          return { message: `Couldn't load your 4+ star albums (${(res && res.error) || "no response"}).` };
        }
      }
      return { items: shuffle(rec.items) };
    },
    async history() {
      return played.length ? { items: played } : { message: "Albums you press play on will show up here." };
    },
  };

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
        if (item.rated) row.classList.add("rated");
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
    acc.querySelector(".acc-head").addEventListener("click", () => {
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
  Promise.all([store.get(PLAYED_KEY), store.get(LAST_KEY)]).then(([p, last]) => {
    played = p || [];
    if (!current && last) render(last);
  });
})();
