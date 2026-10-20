// Side panel player: shows what you started playing on rateyourmusic.com (album art, service
// tabs, player, your star rating, and for Spotify the track list with ♥). Pages send the release
// through background.js while this panel is open; with it closed, pages embed players in the page.
// content.js is loaded first for its embed helpers (it finds nothing to do on this page).
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const eym = globalThis.__embedYourMusic;
  const { classifyAny, makeFrame, resolveBandcamp, trackList, LABELS } = eym;
  const ORDER = ["spotify", "applemusic", "soundcloud", "bandcamp", "youtube", "tidal", "deezer"];
  const HISTORY_KEY = "sidebar:history";
  const HISTORY_MAX = 10;

  const $ = (id) => document.getElementById(id);
  let current = null; // { payload, tabId }
  let history = [];
  let token = 0;

  // Connected while open: this is how pages know to play here.
  const port = api.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "play") show(msg.payload, msg.tabId);
    else if (msg.type === "rating" && current && current.payload.id === msg.id) setRating(msg.rating);
  });

  // ---- Rating ----
  let rating = 0;
  let hover = 0;

  function drawStars() {
    const box = $("rating");
    box.textContent = "";
    const shown = hover || rating;
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement("span");
      star.className = "star " + (shown >= i * 2 ? "full" : shown === i * 2 - 1 ? "half" : "");
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
        b.addEventListener("mouseleave", () => {
          hover = 0;
          drawStars();
        });
        b.addEventListener("click", () => rate(value));
        star.append(b);
      }
      box.append(star);
    }
  }

  function setRating(value) {
    rating = value;
    hover = 0;
    if (current) current.payload.rating = value;
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
      $("rating-note").textContent = `Couldn't rate from here (${(res && res.error) || "no response"}). Open the release page to rate.`;
    }
  }

  // ---- Player ----
  function show(payload, tabId) {
    const my = ++token;
    current = { payload, tabId };
    $("empty").hidden = true;
    $("now").hidden = false;
    $("art").src = payload.artUrl || "";
    const title = $("title");
    title.textContent = payload.title || "Untitled";
    title.href = payload.href || "#";
    $("artist").textContent = payload.artist || "";
    setRating(payload.rating || 0);

    const tabs = $("tabs");
    const body = $("body");
    tabs.textContent = "";
    body.textContent = "";

    const entries = [];
    for (const service of ORDER) {
      const e = (payload.entries || []).find((x) => x.service === service);
      const info = e && classifyAny(e.href);
      if (info && info.service === service) entries.push({ service, href: e.href, info });
    }
    if (!entries.length) {
      body.textContent = "No streaming links for this release.";
      body.className = "hint";
    } else {
      body.className = "";
      const slots = new Map();
      const buttons = new Map();
      let active = null;

      const load = (entry, slot) => {
        const { info, service } = entry;
        if (info.kind !== "bandcamp") {
          if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
          const frame = makeFrame(info.src, info.height, `${LABELS[service]} player`);
          slot.append(frame);
          const list = service === "spotify" && trackList(info, frame);
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

    remember(payload);
  }

  // ---- Recently played (kept across closing the panel) ----
  function remember(payload) {
    history = [payload, ...history.filter((p) => p.href !== payload.href)].slice(0, HISTORY_MAX);
    api.storage.local.set({ [HISTORY_KEY]: history }).catch(() => {});
    drawHistory();
  }

  function drawHistory() {
    const list = $("history");
    list.textContent = "";
    $("history-box").hidden = history.length < 2;
    for (const p of history.slice(1)) {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = p.artUrl || "";
      const label = document.createElement("span");
      label.textContent = `${p.artist ? p.artist + " — " : ""}${p.title}`;
      li.append(img, label);
      li.addEventListener("click", () => show(p, null)); // the originating tab is unknown: rating needs a fresh play
      list.append(li);
    }
  }

  api.storage.local
    .get(HISTORY_KEY)
    .then((got) => {
      history = (got && got[HISTORY_KEY]) || [];
      if (history.length && !current) show(history[0], null);
      else drawHistory();
    })
    .catch(() => {});
})();
