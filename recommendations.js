// Recommendations page (/recommendations/...): play buttons on cover art, a sticky player on the
// right, and the playlists/settings/affinities sections moved below the lists.
// Loaded after content.js in the same isolated world; reuses its embed helpers.
(() => {
  const eym = globalThis.__embedYourMusic;
  const container = document.getElementById("page_sections_recommendations");
  if (!eym || !container) return;

  const { classifyAny, makeFrame, resolveBandcamp, trackList, LABELS } = eym;
  // Phone layout: no sticky side panel; the player opens inline under the tapped row.
  const mobile = matchMedia("(max-width: 59.99em)").matches;
  // The iOS userscript has no page-world script, so it reads ratings itself (see ratedScan).
  const standalone = !!globalThis.__eymBridge;
  const ORDER = ["spotify", "applemusic", "soundcloud", "bandcamp", "youtube", "tidal", "deezer"];

  const url = (u) => (/^https?:\/\//.test(u) ? u : `https://${u}`);
  // RYM's data-links JSON → plain URLs that classifyAny understands.
  const HREF = {
    spotify: (id, v) => `https://open.spotify.com/${v.type || "album"}/${id}`,
    applemusic: (id, v) => `https://geo.music.apple.com/${v.loc || "us"}/album/${v.album || "album"}/${id}`,
    soundcloud: (id, v) => (v.url ? url(v.url) : null),
    tidal: (id, v) => `https://tidal.com/${v.type || "album"}/${id}`,
    deezer: (id, v) => `https://www.deezer.com/${v.type || "album"}/${id}`,
    youtube: (id, v) =>
      v.type === "playlist" ? `https://www.youtube.com/playlist?list=${id}` : `https://www.youtube.com/watch?v=${id}`,
    bandcamp: (id, v) => (v.url ? url(v.url) : /bandcamp\.com/.test(id) ? url(id) : null),
  };

  function parseLinks(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return [];
    }
    const out = [];
    for (const service of ORDER) {
      const items = data[service];
      if (!items) continue;
      const ids = Object.keys(items);
      const id = ids.find((k) => items[k] && items[k].default) || ids[0];
      if (!id) continue;
      const href = HREF[service](id, items[id] || {});
      const info = href && classifyAny(href);
      if (info && info.service === service) out.push({ service, href, info });
    }
    return out;
  }

  const cache = new Map(); // release path -> Promise<entries>
  function linksFor(path) {
    if (!cache.has(path)) {
      cache.set(
        path,
        fetch(path, { credentials: "same-origin" })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
          .then((html) => {
            const doc = new DOMParser().parseFromString(html, "text/html");
            const el = doc.querySelector("[data-links]");
            return el ? parseLinks(el.getAttribute("data-links")) : [];
          })
          .catch((e) => {
            cache.delete(path); // allow retry
            throw e;
          })
      );
    }
    return cache.get(path);
  }

  // ---- Player panel ----
  const panel = document.createElement("aside");
  panel.id = "rym-reco-player";
  const sticky = document.createElement("div");
  sticky.className = "rym-reco-sticky";
  const title = document.createElement("div");
  title.className = "rym-reco-title";
  const tabs = document.createElement("div");
  tabs.className = "rym-reco-tabs";
  const body = document.createElement("div");
  body.className = "rym-reco-body";
  sticky.append(title, tabs, body);
  const host = document.createElement("li"); // mobile: holds the player under the playing row
  host.className = "rym-reco-inline";
  host.hidden = true;
  if (mobile) {
    host.append(sticky);
  } else {
    panel.append(sticky);
    container.append(panel);
  }
  container.classList.add("rym-reco");
  if (mobile) container.classList.add("rym-reco-mobile");
  body.textContent = mobile ? "" : "Click ▶ on a cover to preview it here.";
  body.classList.add("rym-reco-hint");

  let token = 0;
  let currentLi = null;

  function message(text, href) {
    body.textContent = "";
    body.classList.add("rym-reco-hint");
    body.append(text);
    if (href) {
      body.append(" ");
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open release page";
      body.append(a);
    }
  }

  function show(entries, releaseHref, my) {
    tabs.textContent = "";
    body.textContent = "";
    body.classList.remove("rym-reco-hint");
    if (!entries.length) return message("No streaming links on this release.", releaseHref);

    const slots = new Map();
    let active = null;
    const buttons = new Map();

    function load(entry, slot) {
      const { info, service } = entry;
      if (info.kind !== "bandcamp") {
        if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
        // Taller than the default so more of the tracklist shows.
        const tall = !mobile && service === "spotify" && /\/embed\/(album|playlist)\//.test(info.src);
        const frame = makeFrame(info.src, tall ? 560 : info.height, `${LABELS[service]} player`);
        slot.append(frame);
        const tracks = service === "spotify" && trackList(info, frame);
        if (tracks) slot.append(tracks);
        return;
      }
      slot.textContent = "Loading…";
      resolveBandcamp(info.url).then((res) => {
        if (my !== token) return;
        slot.textContent = "";
        if (res) slot.append(makeFrame(res.src, res.height, "Bandcamp player"));
        else slot.append(`Couldn't load the Bandcamp player. `, Object.assign(document.createElement("a"), { href: entry.href, target: "_blank", rel: "noopener", textContent: "Open on Bandcamp" }));
      });
    }

    function select(entry) {
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
    }

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
    select(entries.find((e) => e.service === "spotify") || entries[0]);
  }

  function play(li) {
    const link = li.querySelector("a.component_discography_item_link.release");
    if (!link) return Promise.resolve();
    const my = ++token;
    if (currentLi) currentLi.classList.remove("rym-reco-current");
    currentLi = li;
    li.classList.add("rym-reco-current");
    if (mobile) {
      li.after(host);
      host.hidden = false;
    }

    const artist = li.querySelector("a.artist");
    title.textContent = `${artist ? artist.textContent.trim() : ""} — ${link.textContent.trim()}`;
    tabs.textContent = "";
    body.textContent = "Loading…";
    body.classList.add("rym-reco-hint");

    return linksFor(link.getAttribute("href"))
      .then((entries) => {
        if (my === token) show(entries, link.href, my);
      })
      .catch(() => {
        if (my === token) message("Couldn't load streaming links.", link.href);
      });
  }

  // ---- List decoration ----
  function decorate() {
    for (const li of container.querySelectorAll("li.component_discography_item:not([data-rym-reco])")) {
      li.setAttribute("data-rym-reco", "");
      const art = li.querySelector("a.component_discography_item_image_link");
      if (art) {
        const btn = document.createElement("span");
        btn.className = "rym-play";
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", "Preview");
        btn.textContent = "▶";
        // The whole cover is the click target; modified clicks (new tab etc.) still navigate.
        art.addEventListener("click", (e) => {
          if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          if (mobile && li === currentLi && !host.hidden) {
            // Tapping the playing cover again closes the player.
            host.hidden = true;
            li.classList.remove("rym-reco-current");
            currentLi = null;
            token++;
            return;
          }
          play(li);
        });
        art.append(btn);
      }
      // Compact stats replace the Avg / Ratings / Reviews columns.
      const avg = li.querySelector(".component_discography_item_details_average");
      const ratings = li.querySelector(".component_discography_item_details_ratings .full");
      const info = li.querySelector(".component_discography_item_info_inner");
      if (avg && info) {
        const s = document.createElement("div");
        s.className = "rym-reco-stats";
        s.textContent = `★ ${avg.textContent.trim()}` + (ratings ? ` · ${ratings.textContent.trim()} ratings` : "");
        info.append(s);
      }
    }
  }

  // Reveal the page (content.css covers it with a spinner until then).
  const ready = () => document.documentElement.classList.add("eym-ready");
  setTimeout(ready, 7000); // never leave the page covered

  // The first row you haven't rated (found by reco-ratings.js) loads into the player on its own.
  // reco-ratings.js signals "eym-scan-done" once it has looked; the page is revealed after that
  // album's player is up. If that script can't run, the timeout above reveals the page.
  const auto = () => {
    const li = container.querySelector("li[data-eym-first-unrated]");
    if (li && !currentLi) {
      const done = play(li);
      if (mobile && li.getBoundingClientRect().top > 300) {
        window.scrollTo(0, li.getBoundingClientRect().top + window.scrollY - 80);
      }
      return done;
    }
    return Promise.resolve();
  };
  document.addEventListener("eym-first-unrated", auto);
  document.addEventListener("eym-scan-done", () => auto().then(ready));

  // ---- iOS userscript: read your ratings from the release pages (same logic as reco-ratings.js) ----
  function ratedScan() {
    const RATING = /new RYMrating\(\s*['"]l['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/;
    const queue = [];
    let active = 0;
    const known = new Map();
    const idOf = (li) => (/^component_discography_item_(\d+)$/.exec(li.id) || [])[1];

    function pump() {
      while (active < 2 && queue.length) {
        active++;
        queue.shift()().finally(() => {
          active--;
          pump();
        });
      }
    }

    function ratingOf(li) {
      const id = idOf(li);
      if (!id) return Promise.resolve(null);
      if (!known.has(id)) {
        known.set(
          id,
          new Promise((resolve) => {
            try {
              const cached = sessionStorage.getItem(`eym:rating:${id}`);
              if (cached !== null) return resolve(Number(cached));
            } catch {}
            queue.push(async () => {
              let rating = null;
              try {
                const link = li.querySelector("a.component_discography_item_link.release");
                const res = await fetch(link.getAttribute("href"), { credentials: "same-origin" });
                const m = res.ok && RATING.exec(await res.text());
                if (m && m[1] === id) rating = Number(m[2]);
              } catch {}
              if (rating !== null) {
                try {
                  sessionStorage.setItem(`eym:rating:${id}`, String(rating));
                } catch {}
              }
              resolve(rating);
            });
            pump();
          }).then((rating) => {
            if (rating === null) known.delete(id);
            return rating;
          })
        );
      }
      return known.get(id);
    }

    const mark = (li, rating) => {
      li.dataset.eymRating = String(rating);
      li.classList.toggle("rym-rated", rating > 0);
    };

    // Rows that scroll into view get dimmed if rated.
    const visible = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        visible.unobserve(e.target);
        ratingOf(e.target).then((r) => r !== null && mark(e.target, r));
      }
    });
    const watched = new WeakSet();
    const watchRows = () => {
      for (const li of container.querySelectorAll("li.component_discography_item")) {
        if (!watched.has(li)) {
          watched.add(li);
          visible.observe(li);
        }
      }
    };
    watchRows();
    new MutationObserver(watchRows).observe(container, { childList: true, subtree: true });

    // In-order pass from the top to find the first unrated row.
    (async () => {
      for (const li of container.querySelectorAll("li.component_discography_item")) {
        const r = await ratingOf(li);
        if (r === null) continue;
        mark(li, r);
        if (r === 0) {
          li.dataset.eymFirstUnrated = "";
          break;
        }
      }
      document.dispatchEvent(new Event("eym-scan-done"));
    })();
  }

  decorate();
  if (standalone) ratedScan();
  let timer;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(decorate, 300);
  }).observe(container, { childList: true, subtree: true });
})();
