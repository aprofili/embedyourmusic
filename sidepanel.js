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
  let hist = []; // newest first; pos is the one on screen (back = older, forward = newer)
  let pos = 0;
  let token = 0;

  // Connected while open: this is how pages know to play here.
  const port = api.runtime.connect({ name: "sidepanel" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "play") {
      const p = { ...msg.payload, tabId: msg.tabId };
      hist = [p, ...hist.filter((x) => x.href !== p.href)].slice(0, HISTORY_MAX);
      pos = 0;
      save();
      render(p);
    }
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
    if (current) {
      current.payload.rating = value;
      save();
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
      $("rating-note").textContent = `Couldn't rate from here (${(res && res.error) || "no response"}). Open the release page to rate.`;
    }
  }

  // ---- Player ----
  function render(payload) {
    const my = ++token;
    const tabId = payload.tabId == null ? null : payload.tabId;
    current = { payload, tabId };
    $("empty").hidden = true;
    $("now").hidden = false;
    setArt(payload);
    $("back").disabled = pos >= hist.length - 1;
    $("fwd").disabled = pos <= 0;
    $("pos").textContent = hist.length > 1 ? `${pos + 1} / ${hist.length}` : "";
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

    drawHistory();
  }

  // ---- Album art: RYM's image host may refuse our referrer; fall back to Spotify's thumbnail ----
  function setArt(payload) {
    const img = $("art");
    img.referrerPolicy = "no-referrer";
    img.onerror = async () => {
      img.onerror = null;
      const sp = (payload.entries || []).find((e) => e.service === "spotify");
      if (!sp) return;
      try {
        const r = await fetch("https://open.spotify.com/oembed?url=" + encodeURIComponent(sp.href));
        const j = await r.json();
        if (j.thumbnail_url && current && current.payload === payload) img.src = j.thumbnail_url;
      } catch {
        /* no art */
      }
    };
    img.src = payload.artUrl || "";
    if (!payload.artUrl) img.onerror();
  }

  function go(delta) {
    const next = pos + delta;
    if (next < 0 || next >= hist.length) return;
    pos = next;
    render(hist[pos]);
  }
  $("back").addEventListener("click", () => go(1));
  $("fwd").addEventListener("click", () => go(-1));

  // ---- History (kept across closing the panel) ----
  function save() {
    api.storage.local.set({ [HISTORY_KEY]: hist }).catch(() => {});
  }

  function drawHistory() {
    const list = $("history");
    list.textContent = "";
    $("history-box").hidden = hist.length < 2;
    hist.forEach((p, i) => {
      if (i === pos) return;
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.referrerPolicy = "no-referrer";
      img.src = p.artUrl || "";
      const label = document.createElement("span");
      label.textContent = `${p.artist ? p.artist + " — " : ""}${p.title}`;
      li.append(img, label);
      li.addEventListener("click", () => {
        pos = i;
        render(p);
      });
      list.append(li);
    });
  }

  api.storage.local
    .get(HISTORY_KEY)
    .then((got) => {
      if (current) return;
      hist = (got && got[HISTORY_KEY]) || [];
      if (hist.length) render(hist[0]);
    })
    .catch(() => {});
})();
