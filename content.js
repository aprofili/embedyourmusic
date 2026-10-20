// Adds inline players on RateYourMusic: tabbed players for the release page's streaming icons,
// plus plain embeds for loose Spotify/Bandcamp links elsewhere. Also tidies the release page layout.

(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const SPOTIFY_RE =
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(album|track|playlist|artist|episode|show)\/([A-Za-z0-9]+)/;

  const LABELS = {
    spotify: "Spotify",
    applemusic: "Apple Music",
    soundcloud: "SoundCloud",
    bandcamp: "Bandcamp",
    youtube: "YouTube",
    tidal: "Tidal",
    deezer: "Deezer",
  };

  // Embed info for any supported streaming service, or null.
  //   kind "iframe":   { src, height, maxWidth? } is ready to use.
  //   kind "bandcamp": { url } must be resolved to a player URL by the background script.
  function classifyAny(href) {
    if (!href) return null;

    const sp = href.match(SPOTIFY_RE);
    if (sp) {
      const [, type, id] = sp;
      const compact = type === "track" || type === "episode";
      return {
        service: "spotify",
        kind: "iframe",
        key: `spotify:${type}:${id}`,
        src: `https://open.spotify.com/embed/${type}/${id}`,
        height: compact ? 152 : 352,
      };
    }

    let u;
    try {
      u = new URL(href);
    } catch {
      return null;
    }
    const host = u.hostname.replace(/^www\./, "");
    const parts = u.pathname.split("/").filter(Boolean);

    if (host.endsWith(".bandcamp.com") && /^\/(album|track)\//.test(u.pathname)) {
      const clean = `https://${u.hostname}${u.pathname}`;
      return { service: "bandcamp", kind: "bandcamp", key: `bandcamp:${clean}`, url: clean };
    }

    if (
      (host === "geo.music.apple.com" || host === "music.apple.com") &&
      parts.length >= 3 &&
      ["album", "song", "playlist"].includes(parts[1])
    ) {
      return {
        service: "applemusic",
        kind: "iframe",
        key: `applemusic:${u.pathname}`,
        src: `https://embed.music.apple.com${u.pathname}${u.search}`,
        height: parts[1] === "song" ? 175 : 450,
      };
    }

    if (host === "soundcloud.com" && parts.length >= 2) {
      const params = new URLSearchParams({
        url: `https://soundcloud.com${u.pathname}`,
        color: "#ff5500",
        auto_play: "false",
        hide_related: "true",
        show_comments: "false",
        show_user: "true",
        show_reposts: "false",
        show_teaser: "false",
        visual: "false",
      });
      return {
        service: "soundcloud",
        kind: "iframe",
        key: `soundcloud:${u.pathname}`,
        src: `https://w.soundcloud.com/player/?${params}`,
        height: parts.includes("sets") ? 450 : 166,
      };
    }

    if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
      let id = null;
      let list = null;
      if (host === "youtu.be") id = parts[0];
      else if (u.pathname === "/watch") id = u.searchParams.get("v");
      else if (u.pathname === "/playlist") list = u.searchParams.get("list");

      let src = null;
      if (id && /^[\w-]{6,}$/.test(id)) src = `https://www.youtube-nocookie.com/embed/${id}`;
      else if (list && /^[\w-]+$/.test(list))
        src = `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`;
      if (src) {
        return {
          service: "youtube",
          kind: "iframe",
          key: `youtube:${id || list}`,
          src,
          height: 405,
          maxWidth: 720,
        };
      }
    }

    if (host === "tidal.com" || host === "listen.tidal.com") {
      const p = parts[0] === "browse" ? parts.slice(1) : parts;
      if (p.length >= 2 && ["album", "track", "playlist", "video"].includes(p[0]) && /^[\w-]+$/.test(p[1])) {
        return {
          service: "tidal",
          kind: "iframe",
          key: `tidal:${p[0]}:${p[1]}`,
          src: `https://embed.tidal.com/${p[0]}s/${p[1]}`,
          height: p[0] === "track" ? 150 : p[0] === "video" ? 315 : 400,
        };
      }
    }

    if (host === "deezer.com") {
      const i = parts.findIndex((x) => ["album", "track", "playlist", "artist"].includes(x));
      if (i >= 0 && /^\d+$/.test(parts[i + 1] || "")) {
        const type = parts[i];
        return {
          service: "deezer",
          kind: "iframe",
          key: `deezer:${type}:${parts[i + 1]}`,
          src: `https://widget.deezer.com/widget/auto/${type}/${parts[i + 1]}`,
          height: type === "track" ? 150 : 350,
        };
      }
    }

    return null;
  }

  // Loose links on the page (reviews, lists, ...) only get Spotify and Bandcamp players.
  function classify(href) {
    const info = classifyAny(href);
    return info && (info.service === "spotify" || info.service === "bandcamp") ? info : null;
  }

  function makeFrame(src, height, title) {
    const frame = document.createElement("iframe");
    frame.className = "rym-embed-frame";
    frame.title = title;
    frame.height = String(height);
    frame.loading = "lazy";
    frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = src;
    return frame;
  }

  async function resolveBandcamp(url) {
    try {
      const res = await api.runtime.sendMessage({ type: "resolve-bandcamp", url });
      return res && res.embed ? res.embed : null;
    } catch {
      return null;
    }
  }

  // ---- Spotify track list with per-track library saves (via background.js) ----
  async function send(msg) {
    try {
      return (await api.runtime.sendMessage(msg)) || { error: "no response" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  const fmtTime = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

  // Bold the track that's playing. The Spotify embed posts playback updates to the parent window
  // (the same messages its iFrame API uses). Match by track URI when present, else by duration.
  // Set localStorage.eymDebug = "1" to log the raw messages.
  const watchers = [];
  function watchPlayback(frame, rows, onHit) {
    watchers.push({ frame, rows, onHit });
    if (watchers.length > 1) return;
    window.addEventListener("message", (e) => {
      if (e.origin !== "https://open.spotify.com") return;
      try {
        if (localStorage.eymDebug) console.log("[EmbedYourMusic] spotify message", e.data);
      } catch {}
      for (const w of watchers) {
        if (!w.frame.isConnected || e.source !== w.frame.contentWindow) continue;
        const d = e.data;
        const p = (d && (d.payload || d.data)) || d || {};
        const uri = typeof p.playingURI === "string" ? p.playingURI : typeof p.uri === "string" ? p.uri : "";
        let hit = null;
        const m = uri.match(/track[:/]([A-Za-z0-9]+)/);
        if (m) hit = w.rows.find((r) => r.t.id === m[1]);
        else if (typeof p.duration === "number" && p.duration > 0) {
          const near = w.rows.filter((r) => Math.abs(r.t.ms - p.duration) <= 1500);
          if (near.length === 1) hit = near[0];
        }
        if (hit) {
          for (const r of w.rows) r.row.classList.toggle("rym-track-playing", r === hit);
          if (w.onHit) w.onHit(hit);
        }
      }
    });
  }

  // Returns an element, or null when the Spotify link isn't an album or track.
  function trackList(info, frame, opts) {
    const compact = !!(opts && opts.compact);
    if (globalThis.__eymBridge) return null; // userscript: no background script to talk to
    const [, kind, id] = (info.key || "").split(":");
    if (kind !== "album" && kind !== "track") return null;

    const box = document.createElement("div");
    box.className = "rym-tracks";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "rym-tracks-toggle";
    toggle.textContent = "♡ Save tracks ▴";
    const list = document.createElement("div");
    list.className = "rym-tracks-list";
    if (compact) {
      box.classList.add("rym-tracks-compact");
    } else box.append(toggle);
    box.append(list);

    // Compact mode (side panel): one button that likes the song playing right now. It stays
    // hidden until the embed reports what is playing.
    const like = document.createElement("button");
    like.type = "button";
    like.className = "rym-like-current";
    like.hidden = true;
    const count = document.createElement("span");
    count.className = "rym-like-count";
    count.hidden = true;
    if (compact) {
      const bar = document.createElement("div");
      bar.className = "rym-like-bar";
      bar.append(count, like);
      box.append(bar);
    }

    const note = (text) => {
      list.textContent = "";
      const p = document.createElement("p");
      p.className = "rym-embed-msg";
      p.textContent = text;
      list.append(p);
      return p;
    };

    async function load() {
      note("Loading…");
      const status = await send({ type: "spotify-status" });
      if (status.unsupported || (status.error && !("connected" in status))) {
        return note(status.unsupported ? "Track saving isn't available here." : `Spotify: ${status.error}`);
      }
      if (!status.connected) {
        const p = note("Connect Spotify once to save tracks. Redirect URI to register in your Spotify app: ");
        const code = document.createElement("code");
        code.textContent = status.redirectUri;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rym-tab";
        btn.textContent = "Connect Spotify";
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          const r = await send({ type: "spotify-connect" });
          if (r.error) {
            btn.disabled = false;
            p.append(document.createElement("br"), `Login failed: ${r.error}`);
          } else load();
        });
        p.append(code, document.createElement("br"), btn);
        return;
      }
      const res = await send({ type: "spotify-tracks", kind, id });
      if (res.error) return note(`Couldn't load tracks (${res.error}).`);
      list.textContent = "";
      const rows = [];
      for (const t of res.tracks) {
        const row = document.createElement("div");
        row.className = "rym-track";
        rows.push({ t, row });
        const heart = document.createElement("button");
        heart.type = "button";
        heart.className = "rym-heart";
        const paint = () => {
          heart.textContent = t.saved ? "♥" : "♡";
          heart.classList.toggle("rym-saved", t.saved);
          heart.title = t.saved ? "Remove from Liked Songs" : "Save to Liked Songs";
        };
        paint();
        heart.addEventListener("click", async () => {
          const want = !t.saved;
          t.saved = want; // optimistic
          paint();
          const r = await send({ type: "spotify-save", id: t.id, save: want });
          if (r.error) {
            t.saved = !want;
            paint();
            heart.title = `Failed: ${r.error}`;
          }
        });
        const label = document.createElement("span");
        label.textContent = `${res.tracks.length > 1 ? `${t.number}. ` : ""}${t.name}  ${fmtTime(t.ms)}`;
        row.append(heart, label);
        if (!compact) list.append(row);
      }
      if (compact) {
        let cur = null;
        const paintCount = () => {
          count.textContent = `♥ ${rows.filter((r) => r.t.saved).length}/${rows.length}`;
          const liked = rows.filter((r) => r.t.saved).map((r) => `♥ ${r.t.number ? r.t.number + ". " : ""}${r.t.name}`);
          count.title = liked.length ? liked.join("\n") : "None of this release is in your Liked Songs yet";
          count.hidden = false;
        };
        paintCount();
        const paintLike = () => {
          paintCount();
          const t = cur.t;
          like.textContent = `${t.saved ? "♥ Liked" : "♡ Like"}: ${t.name}`;
          like.classList.toggle("rym-saved", t.saved);
          like.hidden = false;
        };
        like.addEventListener("click", async () => {
          if (!cur) return;
          const t = cur.t;
          const want = !t.saved;
          t.saved = want;
          paintLike();
          const r = await send({ type: "spotify-save", id: t.id, save: want });
          if (r.error) {
            t.saved = !want;
            paintLike();
            like.title = `Failed: ${r.error}`;
          }
        });
        const show = (hit) => {
          if (cur !== hit) {
            cur = hit;
            like.title = "";
          }
          paintLike();
        };
        if (rows.length === 1) show(rows[0]); // a single track: nothing to detect
        if (frame) watchPlayback(frame, rows, show);
        return;
      }
      if (frame) watchPlayback(frame, rows);
    }

    // Open by default; the button collapses it.
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? "♡ Save tracks ▾" : "♡ Save tracks ▴";
    });
    load();
    return box;
  }


  // ---- Streaming links from RYM's data-links JSON (shared by the reco page and the side panel) ----
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


  // ---- Album lists for the side panel ----
  const imgUrl = (img) => {
    let s = img && (img.currentSrc || img.getAttribute("src") || "");
    if (!s || s.startsWith("data:")) s = (img && img.getAttribute("data-src")) || "";
    if (!s) return "";
    if (s.startsWith("//")) s = "https:" + s;
    return s.replace(/\/i\/\d+\//, "/i/300/");
  };

  // Release links under `root` as [{ title, artist, href, artUrl }]. Tolerant of RYM's markup:
  // a titled link to /release/<type>/<artist>/<title>/, with the artist link and cover in the same row.
  function scrapeReleases(root, limit = 60, skipPath = "") {
    const out = [];
    const seen = new Set();
    for (const a of root.querySelectorAll("a[href]")) {
      let path;
      try {
        path = new URL(a.getAttribute("href"), "https://rateyourmusic.com").pathname;
      } catch {
        continue;
      }
      if (!/^\/release\/[^/]+\/[^/]+\/[^/]+\/?$/.test(path) || seen.has(path) || path === skipPath) continue;
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue; // image-only link
      const row = a.closest("li, tr") || a.parentElement;
      const artist = row && row.querySelector("a.artist");
      seen.add(path);
      out.push({
        title,
        artist: artist ? artist.textContent.replace(/\s+/g, " ").trim() : "",
        href: `https://rateyourmusic.com${path}`,
        artUrl: imgUrl(row && row.querySelector("img")),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // Small keyed store in storage.local (the side panel reads it).
  async function saveSidebarData(key, patch, maxKeys) {
    try {
      if (!api.storage || !api.storage.local) return;
      const got = await api.storage.local.get(key);
      const map = { ...((got && got[key]) || {}), ...patch };
      const keys = Object.keys(map);
      if (maxKeys && keys.length > maxKeys) {
        keys.sort((x, y) => (map[x].t || 0) - (map[y].t || 0));
        for (const k of keys.slice(0, keys.length - maxKeys)) delete map[k];
      }
      await api.storage.local.set({ [key]: map });
    } catch {
      /* best effort */
    }
  }

  // Release pages: the "Suggestions" list loads lazily; save it once it is there.
  function publishSimilar() {
    const ul = document.querySelector(".section_suggestions ul.suggestions");
    if (!ul || ul.dataset.eymSim) return;
    const id = ul.getAttribute("data-assoc-id");
    const items = scrapeReleases(ul, 24, location.pathname);
    if (!id || !items.length) return;
    ul.dataset.eymSim = "1";
    saveSidebarData("sidebar:similar", { [id]: { t: Date.now(), items } }, 15);
  }

  // Side panel asked for a release by URL: its streaming links, id and your rating.
  async function loadRelease(item) {
    const rel = globalThis.__eymRelease;
    if (!rel || !rel.getByHref) throw new Error("not ready");
    let rec;
    let entries = [];
    try {
      rec = await rel.getByHref(item.href);
      entries = rec.links ? parseLinks(rec.links) : [];
    } catch (e) {
      rec = null;
      if (!/paused|HTTP|blocking/.test(String(e.message))) throw e;
    }
    if (!entries.length) {
      // RYM unavailable or no links listed: look the release up by name.
      const res = await send({ type: "find-album", want: { artist: item.artist, title: item.title, year: 0 } });
      entries = ((res && res.links) || [])
        .map((l) => ({ ...l, info: classifyAny(l.href) }))
        .filter((l) => l.info && l.info.service === l.service);
    }
    return {
      id: rec ? rec.id : "",
      title: item.title,
      artist: item.artist,
      artUrl: item.artUrl,
      href: item.href,
      rating: rec && rec.ratingKnown ? rec.rating : 0,
      entries: entries.map((e) => ({ service: e.service, href: e.href })),
    };
  }

  // Your 4+ star albums: one request to your collection page (the side panel caches the result).
  async function fetchFavorites() {
    const rel = globalThis.__eymRelease;
    if (rel && rel.blocked()) throw new Error(rel.blockMessage());
    const me = document.querySelector("a.header_profile_main[href^='/~']");
    if (!me) throw new Error("not signed in");
    const user = me.getAttribute("href").slice(2).replace(/\/.*$/, "");
    const res = await fetch(`/collection/${user}/r4.0-5.0/`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    let items = scrapeReleases(doc, 300);
    // If the page shows each row's rating, keep only 4+ (guards against an unfiltered list).
    const rated = [];
    for (const it of items) {
      const a = [...doc.querySelectorAll("a[href]")].find((x) => x.getAttribute("href") === new URL(it.href).pathname);
      const row = a && (a.closest("tr") || a.closest("li"));
      const m = row && /star-(\d+)m|data-rating="(\d+)"/.exec(row.innerHTML);
      const v = m ? Number(m[1] || m[2]) : null;
      if (v === null || v >= 8) rated.push(it);
    }
    items = rated;
    if (!items.length) throw new Error("no albums found on your collection page");
    return items;
  }

  // ---- Sidebar player (side panel) ----
  // When the extension's side panel is open, "play" actions go there instead of embedding in the page.
  async function sidebarOpen() {
    const r = await send({ type: "sidebar-state" });
    return !!(r && r.open);
  }

  // html.eym-sidebar lets the CSS simplify pages while the panel is open.
  function setSidebarClass(open) {
    const cl = document.documentElement && document.documentElement.classList;
    if (cl && cl.toggle) cl.toggle("eym-sidebar", !!open);
  }
  sidebarOpen().then(setSidebarClass);
  if (api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "sidebar-changed") setSidebarClass(msg.open);
    });
  }

  async function sidebarPlay(payload) {
    const r = await send({ type: "sidebar-play", payload });
    return !!(r && r.handled);
  }

  // What the side panel needs to show this release page.
  function releasePayload(entries, service) {
    const box = document.querySelector('[id^="my_catalog_rating_l_"]');
    const id = box ? box.id.replace("my_catalog_rating_l_", "") : "";
    const titleEl = document.querySelector(".album_title");
    const textNode = titleEl && [...titleEl.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const artistEl = document.querySelector(".album_artist_small a.artist, [itemprop='byArtist'] a, a.artist");
    const og = document.querySelector('meta[property="og:image"]');
    const stars = id && document.getElementById(`rating_stars_l_${id}`);
    const m = stars && /star-(\d+)m/.exec(stars.className);
    return {
      id,
      title: textNode ? textNode.textContent.trim() : titleEl ? titleEl.textContent.trim() : document.title,
      artist: artistEl ? artistEl.textContent.trim() : "",
      artUrl: og ? og.content.replace("/i/1200/", "/i/300/") : "",
      href: location.href.split("#")[0],
      rating: m ? Number(m[1]) : 0,
      service,
      entries: entries.map((e) => ({ service: e.info.service, href: e.a.href })),
    };
  }

  // The side panel's stars drive the page's own rating widget (same widget, same request RYM
  // makes when you click it): hover and click at the position of the wanted half-star.
  function rateOnPage(box, id, rating) {
    const rect = box.getBoundingClientRect();
    const cs = getComputedStyle(box);
    const x0 = rect.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
    const init = { bubbles: true, cancelable: true, clientX: x0 + (rating - 0.5) * 9, clientY: rect.top + rect.height / 2, view: window };
    for (const type of ["mouseover", "mousemove"]) box.dispatchEvent(new MouseEvent(type, init));
    box.dispatchEvent(new MouseEvent("click", { ...init, button: 0 }));
    setTimeout(() => {
      const s = document.getElementById(`rating_stars_l_${id}`);
      const m = s && /star-(\d+)m/.exec(s.className);
      if (m) send({ type: "rating-changed", id, rating: Number(m[1]) });
    }, 1500);
  }

  if (typeof location !== "undefined" && /^https?:$/.test(location.protocol) && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg && (msg.type === "load-release" || msg.type === "fetch-favorites")) {
        (msg.type === "load-release" ? loadRelease(msg.item) : fetchFavorites())
          .then((r) => sendResponse(msg.type === "load-release" ? { payload: r } : { items: r }))
          .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
        return true;
      }
      if (!msg || msg.type !== "rate") return false;
      const box = document.getElementById(`my_catalog_rating_l_${msg.id}`);
      if (!box) sendResponse({ ok: false, error: "rating widget not found on that page" });
      else {
        rateOnPage(box, msg.id, Number(msg.rating));
        sendResponse({ ok: true });
      }
      return false;
    });
  }

  const seen = new Set();
  const lazy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazy.unobserve(entry.target);
        entry.target.__load();
      }
    },
    { rootMargin: "300px" }
  );

  // ---- Loose links: one embed per link ----
  function place(link, wrapper) {
    // Put the embed after the link's container, keeping several embeds in link order.
    let ref = link.parentElement || link;
    while (
      ref.nextElementSibling &&
      ref.nextElementSibling.classList.contains("rym-embed")
    ) {
      ref = ref.nextElementSibling;
    }
    ref.after(wrapper);
  }

  function embed(link, info) {
    if (seen.has(info.key)) return;
    seen.add(info.key);

    // Not a <div>: extra divs would shift RYM's div:nth-of-type() selectors.
    const wrapper = document.createElement("aside");
    wrapper.className = "rym-embed";
    wrapper.style.minHeight = `${info.height || 120}px`;

    wrapper.__load = async () => {
      if (info.kind !== "bandcamp") {
        wrapper.append(makeFrame(info.src, info.height, `${LABELS[info.service]} player`));
        return;
      }
      const res = await resolveBandcamp(info.url);
      if (res) {
        wrapper.style.minHeight = `${res.height}px`;
        wrapper.append(makeFrame(res.src, res.height, "Bandcamp player"));
      } else {
        wrapper.remove();
      }
    };

    place(link, wrapper);
    lazy.observe(wrapper);
  }

  function scan(root) {
    const links = root.querySelectorAll
      ? root.querySelectorAll("a[href]")
      : [];
    for (const link of links) {
      // The release page's icon row is handled by buildTabs below.
      if (link.closest(".rym-embed, .media_link_container")) continue;
      const info = classify(link.href);
      if (info) embed(link, info);
    }
  }

  // ---- Release page: streaming icons become tabs that switch a single player ----
  const tabbed = new WeakSet();

  function buildTabs(container) {
    const row = container.querySelector(".ui_media_links");
    if (!row || tabbed.has(row)) return;

    const entries = [];
    const taken = new Set();
    for (const a of row.querySelectorAll("a[href]")) {
      const info = classifyAny(a.href);
      if (!info || taken.has(info.service)) continue; // not embeddable (e.g. Qobuz) stays a link
      taken.add(info.service);
      entries.push({ a, info, slot: null });
    }
    if (!entries.length) return;
    tabbed.add(row);
    container.classList.add("rym-has-tabs");

    const panel = document.createElement("aside");
    panel.className = "rym-embed rym-embed-panel";
    row.after(panel);

    function loadInto(entry) {
      const { info, slot } = entry;
      const label = LABELS[info.service];
      if (info.kind !== "bandcamp") {
        if (info.maxWidth) slot.style.maxWidth = `${info.maxWidth}px`;
        slot.append(makeFrame(info.src, info.height, `${label} player`));
        const tracks = info.service === "spotify" && trackList(info, slot.querySelector("iframe"));
        if (tracks) slot.append(tracks);
        return;
      }
      slot.textContent = "Loading…";
      resolveBandcamp(info.url).then((res) => {
        slot.textContent = "";
        if (res) {
          slot.append(makeFrame(res.src, res.height, "Bandcamp player"));
          return;
        }
        const msg = document.createElement("p");
        msg.className = "rym-embed-msg";
        msg.append(`Couldn't load the ${label} player. `);
        const open = document.createElement("a");
        open.href = entry.a.href;
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = `Open on ${label}`;
        msg.append(open);
        slot.append(msg);
      });
    }

    let active = null;
    function select(entry) {
      if (active === entry) return;
      active = entry;
      for (const e of entries) {
        const on = e === entry;
        e.a.classList.toggle("rym-tab-active", on);
        e.a.setAttribute("aria-pressed", String(on));
        if (e.slot) e.slot.hidden = !on;
      }
      if (!entry.slot) {
        const slot = document.createElement("div");
        slot.className = "rym-embed-slot";
        entry.slot = slot;
        slot.__load = () => loadInto(entry);
        panel.append(slot);
        lazy.observe(slot); // loads when visible, so hidden duplicates never load
      }
    }

    for (const entry of entries) {
      entry.a.classList.add("rym-tab");
      entry.a.setAttribute("aria-pressed", "false");
      entry.a.addEventListener("click", (e) => {
        // Let modified clicks (new tab, etc.) behave like normal links.
        if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        // Sidebar open: play there and keep the page free of embeds. Otherwise embed in the page.
        sidebarPlay(releasePayload(entries, entry.info.service)).then((handled) => {
          if (!handled) select(entry);
          else
            for (const x of entries) {
              x.a.classList.toggle("rym-tab-active", x === entry);
              x.a.setAttribute("aria-pressed", String(x === entry));
            }
        });
      });
    }

    sidebarOpen().then((open) => {
      if (!open) select(entries.find((e) => e.info.service === "spotify") || entries[0]);
    });
  }

  // ---- Page cleanup ----
  // Collapsing itself is done in content.css (so it applies before first paint).
  // Keep this list in sync with the selectors there.
  // [selector, toggle label, options]. Default: CSS collapses these and the toggle expands them.
  // { open: true }   starts open; the toggle collapses it (class added by JS).
  // { inside: true } for table cells: toggle goes inside the cell and wraps its contents.
  const COLLAPSIBLE = [
    [".section_outer.section_issues", "Issues"],
    [".release_page > div:nth-of-type(3)", "Contributions"],
    [".page_object_section_discussion.page_object_section", "Discussion"],
    [".section_comments", "Comments"],
    [".section_credits", "Credits"],
    [".section_tracklisting", "Tracklist"],
    [".section_lists", "Lists"],
    [".section_outer.section_catalog", "Catalog"],
    [".section_outer.section_reviews", "Reviews", { open: true }],
    [".album_info_outer > tbody > tr > td", "Album info", { open: true, inside: true }],
    [".section_suggestions", "Suggestions", { open: true }],
  ];

  const prepared = new WeakSet();

  // Use the section's own title (its first <h2>) as the toggle label and hide the original,
  // so the title isn't shown twice. Falls back to the configured label if there is no title.
  function adoptTitle(el, fallback) {
    const h2 = el.querySelector("h2");
    const text = h2 && h2.textContent.replace(/\s+/g, " ").trim();
    if (!text) return fallback;
    const header = h2.parentElement;
    // If the title is all its header holds, hide the whole header row; otherwise hide just the
    // title so controls beside it (e.g. "Add to list", "Show track credits") stay.
    const hide = header !== el && header.children.length === 1 ? header : h2;
    hide.classList.add("rym-title-hidden");
    return text;
  }

  function addCollapseToggles(root) {
    for (const [selector, fallbackLabel, opts = {}] of COLLAPSIBLE) {
      for (const el of root.querySelectorAll(selector)) {
        if (prepared.has(el)) continue;
        prepared.add(el);
        const label = adoptTitle(el, fallbackLabel);

        // Element whose visibility is toggled.
        let target = el;
        if (opts.inside) {
          // Wrap the cell's contents (<aside>, not <div>, to keep nth-of-type counts intact).
          target = document.createElement("aside");
          target.className = "rym-collapse-body";
          while (el.firstChild) target.append(el.firstChild);
          el.append(target);
        }

        // <button>, not <div>, so div:nth-of-type() counts are unaffected.
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "rym-collapse-toggle";

        const render = (open) => {
          toggle.setAttribute("aria-expanded", String(open));
          toggle.textContent = `${open ? "\u25BE" : "\u25B8"} ${label}`;
        };

        if (opts.open) {
          render(true);
          toggle.addEventListener("click", () => {
            const collapsed = target.classList.toggle("rym-collapsed");
            render(!collapsed);
          });
        } else {
          render(false);
          toggle.addEventListener("click", () => {
            render(target.classList.toggle("rym-expanded"));
          });
        }

        if (opts.inside) el.prepend(toggle);
        else el.before(toggle);
      }
    }
  }

  // ---- Release page layout ----
  // Left column:  cover art, Rate/Catalog, Previous/Next, Album info, then RYM's other left sections.
  // Right column: album title, player, suggestions, then RYM's other right sections.
  function moveWithToggle(el, dest) {
    const prev = el.previousElementSibling;
    if (prev && prev.classList.contains("rym-collapse-toggle")) dest.append(prev);
    dest.append(el);
  }

  function buildHero() {
    if (document.querySelector(".rym-hero-main")) return;
    // On narrow (mobile) layouts RYM hides the desktop art block; leave the page alone.
    if (globalThis.matchMedia && !globalThis.matchMedia("(min-width: 768px)").matches) return;

    const left = document.querySelector(".release_page .release_left_column");
    const right = document.querySelector(".release_page .release_right_column");
    if (!left || !right) return;
    const frame = left.querySelector(":scope > .page_release_art_frame");
    const frameInner = frame && frame.querySelector(":scope > .hide-for-small");
    const art = frameInner && frameInner.querySelector(":scope > a");
    if (!art) return;

    const mainInfo = right.querySelector(":scope > .section_main_info");
    const title = mainInfo && mainInfo.querySelector(":scope > .page_section > .album_title");
    const titleBar =
      title && title.nextElementSibling && title.nextElementSibling.matches("table.color_bar")
        ? title.nextElementSibling
        : null;
    const albumInfo = mainInfo && mainInfo.querySelector("table.album_info_outer");
    const rate = right.querySelector(":scope > .section_my_catalog");
    const nav = left.querySelector(".section_release_navigation");
    const navBox = nav && (nav.closest(".hide-for-small") || nav);
    const colorBar = left.querySelector(":scope > table.color_bar");
    const suggestions = left.querySelector(".section_suggestions");

    // <aside>, not <div>: extra divs could shift RYM's div:nth-of-type() selectors.
    const main = document.createElement("aside");
    main.className = "rym-hero-main";

    // Right column top: title and its bar, then the player block, then suggestions.
    if (title) main.append(title);
    if (titleBar) main.append(titleBar);
    // Everything in the art block except the cover itself: player icons, RYM's player,
    // submit link (and any embed we add beside them).
    for (const node of [...frameInner.childNodes]) {
      if (node !== art) main.append(node);
    }
    if (suggestions) moveWithToggle(suggestions, main);
    right.prepend(main);

    // Left column: Rate/Catalog right under the art, Album info after Previous/Next.
    let after = colorBar || frame;
    if (rate) {
      after.after(rate);
      after = rate;
    }
    if (albumInfo) (navBox || after).after(albumInfo);

    // The old info box is left holding only mobile-only content; don't show an empty panel.
    if (mainInfo && !mainInfo.querySelector(":scope > .page_section > :not(.show-for-small)")) {
      mainInfo.classList.add("rym-emptied");
    }
  }

  // "recommended" next to new music / genres / charts / lists in the top bar.
  function addNavLink() {
    if (document.querySelector(".eym-nav-reco")) return;
    const lists = document.querySelector('.header_links_inner a.header_item[href="/lists/"]');
    const me = document.querySelector("a.header_profile_main[href^='/~']");
    if (!lists || !me) return;
    const user = me.getAttribute("href").slice(2).replace(/\/.*$/, "");
    const a = document.createElement("a");
    a.className = "header_item eym-nav-reco";
    a.href = `/recommendations/${user}/release/`;
    a.textContent = "recommended";
    lists.after(a);
  }

  // A big ▶ on the cover of a release page starts the default player (sidebar if open).
  function addArtPlay() {
    const frame = document.querySelector(".release_page .page_release_art_frame");
    const link = frame && [...frame.querySelectorAll("a")].find((a) => a.querySelector("img"));
    if (!link || link.querySelector(".rym-art-play")) return;
    const tabs = [...document.querySelectorAll(".media_link_container .rym-tab")];
    if (!tabs.length) return;
    link.classList.add("rym-art-link");
    const btn = document.createElement("span");
    btn.className = "rym-art-play";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Play");
    btn.textContent = "▶";
    link.append(btn);
    link.addEventListener("click", (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      const pick = tabs.find((t) => t.id === "spotify") || tabs.find((t) => /spotify/i.test(t.href)) || tabs[0];
      pick.click();
      const panel = document.querySelector(".rym-embed-panel");
      if (panel && !document.documentElement.classList.contains("eym-sidebar")) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function run() {
    addNavLink();
    buildHero();
    addCollapseToggles(document);
    for (const c of document.querySelectorAll(".media_link_container")) buildTabs(c);
    scan(document);
    addArtPlay();
    publishSimilar();
  }

  run();
  // Release pages: reveal the page now that the layout is final. (The recommendations page is
  // revealed by recommendations.js once its first album is loaded.)
  if (!document.getElementById("page_sections_recommendations")) document.documentElement.classList.add("eym-ready");

  // RYM injects links and sections dynamically (media popups, lazy sections).
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      run();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  globalThis.__embedYourMusic = { classify, classifyAny, makeFrame, resolveBandcamp, trackList, sidebarOpen, sidebarPlay, parseLinks, scrapeReleases, saveSidebarData, ORDER, LABELS, addCollapseToggles, buildHero, buildTabs, run };
})();
