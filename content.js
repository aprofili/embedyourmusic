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

  // Which row is the embed playing? It posts playback updates to the parent window; their shape is
  // undocumented, so try several things in order: a track id anywhere in the message, the track
  // name, a track-number field, then the duration (closest match; ties go to the track after the
  // previous one, since albums play in order). Returns an index into rows, or -1.
  const normTitle = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");

  function matchTrack(rows, data, prev = -1) {
    let text = "";
    try {
      text = JSON.stringify(data) || "";
    } catch {
      /* not serializable */
    }
    const d = data && typeof data === "object" ? data : {};
    const p = d.payload || d.data || d;
    // 1. a track id anywhere in the message
    const byId = rows.findIndex(
      (r) => r.t.id && (text.includes(`track:${r.t.id}`) || text.includes(`track/${r.t.id}`) || (r.t.id.length >= 12 && text.includes(r.t.id)))
    );
    if (byId >= 0) return byId;
    // 2. the track name (long enough to be distinctive)
    const flat = normTitle(text);
    const byName = rows.map((r, i) => [i, normTitle(r.t.name)]).filter(([, n]) => n.length >= 4 && flat.includes(n));
    if (byName.length === 1) return byName[0][0];
    // 3. a track-number field
    for (const k of Object.keys(p || {})) {
      if (/track.?(num|no|index)/i.test(k) && Number.isInteger(p[k])) {
        const i = rows.findIndex((r) => r.t.number === p[k]);
        if (i >= 0) return i;
      }
    }
    // 4. duration
    const dur = typeof p.duration === "number" ? p.duration : typeof p.durationMs === "number" ? p.durationMs : 0;
    if (dur > 0) {
      const near = rows
        .map((r, i) => ({ i, diff: Math.abs(r.t.ms - dur) }))
        .filter((x) => x.diff <= 2500)
        .sort((x, y) => x.diff - y.diff);
      if (near.length === 1) return near[0].i;
      if (near.length > 1) {
        if (near[1].diff - near[0].diff >= 400) return near[0].i; // clearly closest
        const after = near.filter((x) => x.i > prev).sort((x, y) => x.i - y.i)[0];
        return (after || near[0]).i;
      }
    }
    return -1;
  }

  // onListened fires once when you've really listened: 4 different tracks (or all of a shorter
  // release) heard for 20+ seconds each, judged from the embed's reported play position.
  function watchPlayback(frame, rows, onHit, onListened) {
    watchers.push({ frame, rows, onHit, onListened, prev: -1, heard: new Map(), fired: false });
    if (watchers.length > 1) return;
    window.addEventListener("message", (e) => {
      if (e.origin !== "https://open.spotify.com") return;
      try {
        if (localStorage.eymDebug) console.log("[EmbedYourMusic] spotify message", e.data);
      } catch {}
      for (const w of watchers) {
        if (!w.frame.isConnected || e.source !== w.frame.contentWindow) continue;
        const i = matchTrack(w.rows, e.data, w.prev);
        if (i < 0) continue;
        w.prev = i;
        const hit = w.rows[i];
        for (const r of w.rows) r.row.classList.toggle("rym-track-playing", r === hit);
        if (w.onHit) w.onHit(hit);
        const d = e.data && typeof e.data === "object" ? e.data : {};
        const p = d.payload || d.data || d;
        if (w.onListened && !w.fired && typeof p.position === "number" && !p.isPaused) {
          w.heard.set(i, Math.max(w.heard.get(i) || 0, p.position));
          const done = [...w.heard.values()].filter((ms) => ms >= 20000).length;
          if (done >= Math.min(4, w.rows.length)) {
            w.fired = true;
            w.onListened();
          }
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
    const count = document.createElement(compact ? "button" : "span");
    count.className = "rym-like-count";
    count.hidden = true;
    // Compact mode: clicking the count opens the full track list with a ♥ per song.
    const panel = document.createElement("div");
    panel.className = "rym-tracks-list";
    panel.hidden = true;
    let onSaved = () => {};
    if (compact) {
      count.type = "button";
      count.addEventListener("click", () => {
        panel.hidden = !panel.hidden;
        count.classList.toggle("rym-open", !panel.hidden);
      });
      const bar = document.createElement("div");
      bar.className = "rym-like-bar";
      bar.append(count, like);
      box.append(bar, panel);
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
          onSaved();
          const r = await send({ type: "spotify-save", id: t.id, save: want });
          if (r.error) {
            t.saved = !want;
            paint();
            onSaved();
            heart.title = `Failed: ${r.error}`;
          }
        });
        const label = document.createElement("span");
        label.textContent = `${res.tracks.length > 1 ? `${t.number}. ` : ""}${t.name}  ${fmtTime(t.ms)}`;
        row.append(heart, label);
        (compact ? panel : list).append(row);
      }
      if (compact) {
        let cur = null;
        const paintCount = () => {
          count.textContent = `♥ ${rows.filter((r) => r.t.saved).length}/${rows.length}`;
          const liked = rows.filter((r) => r.t.saved).map((r) => `♥ ${r.t.number ? r.t.number + ". " : ""}${r.t.name}`);
          count.title = (liked.length ? liked.join("\n") : "None of this release is in your Liked Songs yet") + "\n(click for the track list)";
          count.hidden = false;
        };
        paintCount();
        onSaved = () => {
          paintCount();
          if (cur) paintLike();
        };
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
        if (frame) watchPlayback(frame, rows, show, opts && opts.onListened);
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
  // Real cover URL of a lazy-loaded <picture> (RYM keeps it in <source data-srcset> until scrolled into view).
  const fromPicture = (img) => {
    const pic = img && img.closest && img.closest("picture");
    if (!pic) return "";
    for (const type of ["image/jpeg", "image/webp", ""]) {
      const src = [...pic.querySelectorAll("source")].find((s) => !type || s.getAttribute("type") === type);
      const set = src && (src.getAttribute("srcset") || src.getAttribute("data-srcset"));
      const first = set && set.trim().split(",")[0].trim().split(/\s+/)[0];
      if (first) return first;
    }
    return "";
  };
  const imgUrl = (img) => {
    let s = img && (img.currentSrc || img.getAttribute("src") || "");
    if (!s || s.startsWith("data:")) s = (img && img.getAttribute("data-src")) || fromPicture(img);
    if (!s) return "";
    if (s.startsWith("//")) s = "https:" + s;
    return /\/i\/\d+\/w\//.test(s) ? s : s.replace(/\/i\/\d+\//, "/i/300/"); // "/w/" URLs carry a per-size hash: leave them alone
  };

  // Release links under `root` as [{ title, artist, href, artUrl }]. Tolerant of RYM's markup:
  // a titled link to /release/<type>/<artist>/<title>/, with the artist link and cover in the same row.
  function isVideoPath(p) {
    return /^\/release\/(video|musicvideo|music-video|concert|film|dvd)\//.test(p);
  }
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
      if (isVideoPath(path)) continue; // live videos and the like: nothing to play in a music player
      if (a.querySelector("img, picture")) continue; // a cover link, not the title link
      const title = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) continue; // image-only link
      let row = a.closest("li, tr");
      if (!row) {
        // Plain divs: the smallest ancestor that has an artist link and only this release.
        row = a.parentElement;
        for (let n = a.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) {
          const others = [...n.querySelectorAll('a[href^="/release/"]')].filter((x) => pathOf(x) !== path && /^\/release\/[^/]+\/[^/]+\/[^/]+\/?$/.test(pathOf(x)));
          if (others.length) break;
          row = n;
          if (n.querySelector("a.artist")) break;
        }
      }
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

  // Side panel asks for this page's "Suggestions": they load lazily, so press RYM's own refresh
  // button if they haven't, then read them. (One RYM request, only when you open Similar.)
  async function loadSimilar(id) {
    id = String(id);
    const onPage = document.querySelector(".section_suggestions ul.suggestions");
    const here = onPage && onPage.getAttribute("data-assoc-id") === id;
    let ul = here ? onPage : null;
    let temp = false;
    if (!ul) {
      // Any other RYM page: make a hidden list and have RYM's own code (main-bridge.js) fill it.
      ul = document.createElement("ul");
      ul.id = `suggestions_release_${id}`;
      ul.dataset.object = "release";
      ul.setAttribute("data-assoc-id", id);
      ul.style.display = "none";
      document.body.append(ul);
      temp = true;
    }
    const read = () => scrapeReleases(ul, 24, location.pathname);
    try {
      let items = read();
      if (!items.length) {
        if (here) {
          const btn = document.querySelector(".section_suggestions .page_object_section_suggestions_refresh");
          if (btn) btn.click();
        } else {
          document.dispatchEvent(new CustomEvent("eym-main", { detail: JSON.stringify({ action: "suggestions", id }) }));
        }
        for (let i = 0; i < 40 && !items.length; i++) {
          await new Promise((r) => setTimeout(r, 200));
          items = read();
        }
      }
      if (!items.length) throw new Error("RYM didn't return suggestions");
      if (here) ul.dataset.eymSim = "1";
      saveSidebarData("sidebar:similar", { [id]: { t: Date.now(), items } }, 15);
      return items;
    } finally {
      if (temp) ul.remove();
    }
  }

  // RYM's own "Set listening" for a release (runs RYM's request in the page world).
  function setListening(id) {
    document.dispatchEvent(new CustomEvent("eym-main", { detail: JSON.stringify({ action: "listening", id: String(id) }) }));
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
      const res = await send({ type: "find-album", want: { artist: item.artist || guessArtist(new URL(item.href).pathname), title: item.title, year: 0 } });
      entries = ((res && res.links) || [])
        .map((l) => ({ ...l, info: classifyAny(l.href) }))
        .filter((l) => l.info && l.info.service === l.service);
    }
    const id = (rec && rec.id) || item.id || (await knownId(item.href)) || "";
    rememberId(item.href, id);
    if (!entries.length && item.spotify) {
      const info = classifyAny(item.spotify);
      if (info && info.service === "spotify") entries = [{ service: "spotify", href: item.spotify }];
    }
    return {
      id,
      title: item.title || (rec && rec.title) || "",
      artist: item.artist || (rec && rec.artist) || "",
      artUrl: item.artUrl || (rec && rec.art) || "",
      href: item.href,
      rating: rec && rec.ratingKnown ? rec.rating : 0,
      ratingKnown: !!(rec && rec.ratingKnown),
      entries: entries.map((e) => ({ service: e.service, href: e.href })),
    };
  }

  // Persistent href -> release id map (storage.local "sidebar:ids"): ids are what Similar and rating need,
  // and several places learn them for free (history, recommendations, any release page you open, any load).
  let idQueue = {};
  let idTimer;
  function rememberId(href, id) {
    if (!href || !id) return;
    try {
      idQueue[new URL(href, "https://rateyourmusic.com").pathname] = String(id);
    } catch {
      return;
    }
    clearTimeout(idTimer);
    idTimer = setTimeout(async () => {
      const pairs = idQueue;
      idQueue = {};
      try {
        const got = await api.storage.local.get("sidebar:ids");
        const map = { ...((got && got["sidebar:ids"]) || {}), ...pairs };
        const keys = Object.keys(map);
        if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete map[k];
        await api.storage.local.set({ "sidebar:ids": map });
      } catch {}
    }, 500);
  }
  async function knownId(href) {
    try {
      const got = await api.storage.local.get("sidebar:ids");
      return ((got && got["sidebar:ids"]) || {})[new URL(href, "https://rateyourmusic.com").pathname] || "";
    } catch {
      return "";
    }
  }

  // New releases: /new-music/, minus videos (the panel then drops what Spotify doesn't have).
  async function fetchNewMusic() {
    const rel = globalThis.__eymRelease;
    if (rel && rel.blocked()) throw new Error(rel.blockMessage());
    const res = await fetch("/new-music/", { credentials: "same-origin" });
    if (!res.ok) {
      if (rel) rel.noteStatus(res.status);
      throw new Error(rel && rel.blocked() ? rel.blockMessage() : `HTTP ${res.status}`);
    }
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const items = scrapeReleases(doc, 150);
    if (!items.length) throw new Error("no releases found on the new-music page");
    return { items, t: Date.now() };
  }

  // Your RYM play history (what "Set listening" records): newest first, one entry per release.
  function scrapeHistory(doc) {
    const out = [];
    const seen = new Set();
    for (const it of doc.querySelectorAll(".play_history_item")) {
      const a = it.querySelector("a.album");
      if (!a) continue;
      const href = new URL(a.getAttribute("href"), "https://rateyourmusic.com").href;
      if (seen.has(href)) continue;
      seen.add(href);
      const artist = it.querySelector("a.artist");
      const m = /\[Album(\d+)\]/.exec(a.getAttribute("title") || "");
      out.push({
        id: m ? m[1] : "",
        title: a.textContent.replace(/\s+/g, " ").trim(),
        artist: artist ? artist.textContent.replace(/\s+/g, " ").trim() : "",
        href,
        artUrl: imgUrl(it.querySelector("img")),
      });
    }
    return out;
  }

  async function fetchHistory() {
    const rel = globalThis.__eymRelease;
    if (rel && rel.blocked()) throw new Error(rel.blockMessage());
    const me = document.querySelector("a.header_profile_main[href^='/~']");
    if (!me) throw new Error("not signed in");
    const user = me.getAttribute("href").slice(2).replace(/\/.*$/, "");
    const res = await fetch(`/play-history/${user}/`, { credentials: "same-origin" });
    if (!res.ok) {
      if (rel) rel.noteStatus(res.status);
      throw new Error(rel && rel.blocked() ? rel.blockMessage() : `HTTP ${res.status}`);
    }
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const items = scrapeHistory(doc);
    for (const i of items) rememberId(i.href, i.id);
    return { items };
  }

  // One page of your 4+ star albums (your collection filtered to 4.0-5.0; the side panel caches it).
  // -> { items, pages }
  async function fetchFavorites(page = 1) {
    const rel = globalThis.__eymRelease;
    if (rel && rel.blocked()) throw new Error(rel.blockMessage());
    const me = document.querySelector("a.header_profile_main[href^='/~']");
    if (!me) throw new Error("not signed in");
    const user = me.getAttribute("href").slice(2).replace(/\/.*$/, "");
    const res = await fetch(`/collection/${user}/r4.0-5.0${page > 1 ? `/${page}` : ""}`, { credentials: "same-origin" });
    if (!res.ok) {
      if (rel) rel.noteStatus(res.status);
      throw new Error(rel && rel.blocked() ? rel.blockMessage() : `HTTP ${res.status}`);
    }
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const items = [];
    for (const it of scrapeReleases(doc, 300)) {
      const a = [...doc.querySelectorAll("a[href]")].find((x) => x.getAttribute("href") === new URL(it.href).pathname);
      const row = a && a.closest("tr");
      const img = row && row.querySelector('img[alt$="stars"]');
      const m = img && /([\d.]+) stars/.exec(img.getAttribute("alt"));
      if (!m || Number(m[1]) >= 4) items.push(it); // the page is already filtered; this is a guard
    }
    const nums = [...doc.querySelectorAll(".navlinknum, .navlinkcurrent")].map((n) => Number(n.textContent)).filter(Boolean);
    const pages = Math.max(1, ...nums);
    if (!items.length) throw new Error("no albums found on your collection page");
    return { items, pages };
  }


  // ---- Any album cover, anywhere on the site, opens in the side panel while it is open ----
  const sidebarIsOpen = () => !!(document.documentElement.classList && document.documentElement.classList.contains("eym-sidebar"));
  const pathOf = (a) => {
    try {
      return new URL(a.getAttribute("href"), "https://rateyourmusic.com").pathname;
    } catch {
      return "";
    }
  };
  const RELEASE_PATH = /^\/release\/[^/]+\/[^/]+\/[^/]+\/?$/;

  // The link around a cover image that points at a release page, or null. The recommendations page
  // and the release page's own cover have their own handlers.
  function coverAnchor(el) {
    const a = el && el.closest && el.closest("a[href]");
    if (!a || !a.querySelector("img") || !RELEASE_PATH.test(pathOf(a))) return null;
    if (a.closest("#page_sections_recommendations") || a.classList.contains("rym-art-link")) return null;
    return a;
  }

  // Title / artist / art for a cover link: look in the surrounding row for the titled link to the same release.
  // Artist when the cover has no artist link next to it (Previous/Next, etc.): the page's own artist on a
  // release page (prev/next are the same artist's), else the artist slug of /release/<type>/<artist>/<title>/.
  function guessArtist(path) {
    const own = document.querySelector(".album_info a.artist");
    if (own && /^\/release\//.test(location.pathname)) return own.textContent.replace(/\s+/g, " ").trim();
    const m = /^\/release\/[^/]+\/([^/]+)\//.exec(path);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]).replace(/-/g, " ");
    } catch {
      return m[1].replace(/-/g, " ");
    }
  }

  function describeCover(a) {
    const path = pathOf(a);
    const img = a.querySelector("img");
    let node = a;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const t = [...node.querySelectorAll("a[href]")].find((x) => x !== a && !x.querySelector("img") && pathOf(x) === path && x.textContent.trim());
      if (t) {
        const artist = node.querySelector("a.artist");
        return {
          title: t.textContent.replace(/\s+/g, " ").trim(),
          artist: artist ? artist.textContent.replace(/\s+/g, " ").trim() : guessArtist(path),
          href: `https://rateyourmusic.com${path}`,
          artUrl: imgUrl(img),
        };
      }
    }
    return {
      title: ((img && img.getAttribute("alt")) || "").replace(/^cover art for\s*/i, "").trim() || "Album",
      artist: guessArtist(path),
      href: `https://rateyourmusic.com${path}`,
      artUrl: imgUrl(img),
    };
  }

  // One floating ▶ follows the pointer over covers (no layout changes to RYM's markup).
  let floater;
  function showFloater(a) {
    const img = a.querySelector("img");
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return;
    if (!floater) {
      floater = document.createElement("div");
      floater.append(document.createElement("span"));
      floater.firstChild.textContent = "▶";
      document.body.append(floater);
    }
    floater.className = "rym-float-play" + (r.width >= 120 ? " rym-float-big" : "");
    Object.assign(floater.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "flex" });
  }
  const hideFloater = () => {
    if (floater) floater.style.display = "none";
  };

  async function playCover(a) {
    a.classList.add("rym-cover-loading");
    try {
      const payload = await loadRelease(describeCover(a));
      if (!(await sidebarPlay(payload))) location.href = a.href; // panel closed meanwhile
    } catch {
      location.href = a.href; // couldn't load it here: just go to the album page
    } finally {
      a.classList.remove("rym-cover-loading");
    }
  }

  if (typeof document.addEventListener !== "function") {
    /* minimal test document: no cover handling */
  } else {
  document.addEventListener(
    "mouseover",
    (e) => {
      if (!sidebarIsOpen()) return;
      const a = coverAnchor(e.target);
      if (a) showFloater(a);
      else hideFloater();
    },
    true
  );
  document.addEventListener("scroll", hideFloater, true);
  document.addEventListener(
    "click",
    (e) => {
      if (!sidebarIsOpen() || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = coverAnchor(e.target);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      hideFloater();
      playCover(a);
    },
    true
  );
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
      artUrl: og ? (/\/i\/\d+\/w\//.test(og.content) ? og.content : og.content.replace("/i/1200/", "/i/300/")) : "",
      href: location.href.split("#")[0],
      rating: m ? Number(m[1]) : 0,
      ratingKnown: !!m,
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
      if (msg && msg.type === "load-similar") {
        loadSimilar(msg.id)
          .then((items) => sendResponse({ items }))
          .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
        return true;
      }
      if (msg && msg.type === "check-rating") {
        const rel = globalThis.__eymRelease;
        if (!rel) {
          sendResponse({ error: "not ready" });
          return false;
        }
        let p;
        try {
          p = new URL(msg.href).pathname;
        } catch {
          p = msg.href;
        }
        // One request to the release page (cached afterwards); a fresh read, so skip any stale copy.
        rel
          .get(String(msg.id), p)
          .then((r) => sendResponse({ rating: r.rating || 0, ratingKnown: !!r.ratingKnown }))
          .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
        return true;
      }
      if (msg && msg.type === "set-listening") {
        setListening(msg.id);
        sendResponse({ ok: true });
        return false;
      }
      if (msg && (msg.type === "load-release" || msg.type === "fetch-favorites" || msg.type === "fetch-history" || msg.type === "fetch-newmusic")) {
        (msg.type === "load-release" ? loadRelease(msg.item) : msg.type === "fetch-history" ? fetchHistory() : msg.type === "fetch-newmusic" ? fetchNewMusic() : fetchFavorites(msg.page))
          .then((r) => sendResponse(msg.type === "load-release" ? { payload: r } : r))
          .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
        return true;
      }
      if (msg && msg.type === "exclude") {
        // Side panel's X: press the row's own exclude button on the recommendations page.
        const x = document.querySelector(`#component_discography_item_${CSS.escape(String(msg.id))} .component_discography_item_exclude i, #component_discography_item_${CSS.escape(String(msg.id))} .component_discography_item_exclude`);
        if (x) x.click();
        sendResponse({ ok: !!x });
        return false;
      }
      if (!msg || msg.type !== "rate") return false;
      const box = document.getElementById(`my_catalog_rating_l_${msg.id}`);
      if (box) {
        rateOnPage(box, msg.id, Number(msg.rating));
        sendResponse({ ok: true });
        return false;
      }
      // No widget on this page: send RYM's own rating request (main-bridge.js) and keep the cache in step.
      const rating = Number(msg.rating);
      document.dispatchEvent(new CustomEvent("eym-main", { detail: JSON.stringify({ action: "rate", id: String(msg.id), rating }) }));
      const rel = globalThis.__eymRelease;
      if (rel && rel.setRating) rel.setRating(String(msg.id), rating);
      sendResponse({ ok: true });
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

  // Release page header: "Title (year)" with the full date as a tooltip on the year, the artist (a link) below it,
  // and the RYM average next to your stars; the Artist / Released / RYM Rating rows of Album info go.
  function tidyHeader() {
    if (document.querySelector(".rym-year") || (globalThis.matchMedia && !globalThis.matchMedia("(min-width: 768px)").matches)) return;
    const title = document.querySelector(".release_page .album_title");
    const info = document.querySelector(".release_page table.album_info");
    if (!title || !info) return;
    const rowOf = (re) => [...info.querySelectorAll("tr")].find((tr) => {
      const th = tr.querySelector("th");
      return th && re.test(th.textContent.trim());
    });
    const artistRow = rowOf(/^artist$/i);
    const releasedRow = rowOf(/^released$/i);
    const ratingRow = rowOf(/^rym rating$/i);
    const artistLink = artistRow && artistRow.querySelector("a.artist");
    const released = releasedRow && releasedRow.querySelector("td");
    const year = released && /\b(19|20)\d\d\b/.exec(released.textContent);
    const anchor = title.querySelector("input.album_shortcut") || title.querySelector(".album_artist_small");
    if (year) {
      const wrap = document.createElement("span");
      wrap.className = "rym-year";
      const tip = document.createElement("span");
      tip.textContent = year[0];
      tip.title = released.textContent.replace(/\s+/g, " ").trim();
      wrap.append(" (", tip, ")");
      title.insertBefore(wrap, anchor);
    } else {
      const marker = document.createElement("span");
      marker.className = "rym-year";
      title.insertBefore(marker, anchor);
    }
    if (artistLink) {
      const line = document.createElement("div");
      line.className = "rym-title-artist";
      const a = artistLink.cloneNode(true);
      a.removeAttribute("itemprop");
      line.append(a);
      title.insertBefore(line, title.querySelector(".album_artist_small"));
    }
    // RYM's average next to your rating stars
    const avg = ratingRow && ratingRow.querySelector(".avg_rating");
    const num = ratingRow && ratingRow.querySelector(".num_ratings b");
    const mine = document.querySelector(".release_my_catalog .my_catalog_rating");
    if (avg && num && mine && avg.textContent.trim()) {
      const s = document.createElement("span");
      s.className = "rym-avg";
      s.textContent = `${avg.textContent.trim()} Avg over ${num.textContent.trim()} ratings`;
      mine.after(s);
    }
    for (const tr of [artistRow, releasedRow, ratingRow]) if (tr) tr.classList.add("rym-gone");
  }

  // Homepage: drop the welcome blurb and the site-wide counts, so the page starts at the two Featured sections.
  // (Found by their headings, not RYM's class names: everything before the "Featured reviews" block goes.)
  function trimHome() {
    if (typeof location === "undefined" || location.pathname !== "/" || document.documentElement.dataset.eymHome) return;
    const heads = [...document.querySelectorAll("h1, h2, h3, div, span, a")].filter((n) => !n.children.length && /^featured reviews\b/i.test(n.textContent.trim()));
    const own = (n) => [...n.childNodes].filter((x) => x.nodeType === 3).map((x) => x.textContent).join("").trim();
    const welcome = [...document.querySelectorAll("h1, h2, h3, div, span")].find((n) => /^welcome to\b/i.test(own(n)));
    if (!heads.length || !welcome) return;
    // Climb from the Featured heading to the level where the welcome blurb is an earlier relative.
    let block = heads[0];
    while (block.parentElement && !block.parentElement.contains(welcome)) block = block.parentElement;
    const parent = block.parentElement;
    if (!parent || parent === document.body) return;
    document.documentElement.dataset.eymHome = "1";
    for (let n = parent.firstElementChild; n && n !== block; n = n.nextElementSibling) n.classList.add("rym-gone");
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

  // Opening a release page tells the shared cache its rating and links, so nothing needs fetching later.
  function recordThisRelease() {
    const rel = globalThis.__eymRelease;
    const box = document.querySelector('[id^="my_catalog_rating_l_"]');
    const holder = document.querySelector(".media_link_container[data-links]");
    if (!rel || !rel.put || !box || document.documentElement.dataset.eymRecorded) return;
    const id = box.id.replace("my_catalog_rating_l_", "");
    const stars = document.getElementById(`rating_stars_l_${id}`);
    const m = stars && /star-(\d+)m/.exec(stars.className);
    if (!m) return;
    document.documentElement.dataset.eymRecorded = "1";
    const meta = rel.extractMeta ? rel.extractMeta(document) : { links: holder ? holder.getAttribute("data-links") : null };
    rel.put(id, { rating: Number(m[1]), ratingKnown: true, ...meta }, location.pathname);
    rememberId(location.pathname, id);
    try {
      api.runtime.sendMessage({ type: "release-recorded" }).catch(() => {});
    } catch {}
  }

  // Visiting /new-music/ saves its list for the panel (no request needed).
  function publishNewMusic() {
    if (typeof location === "undefined" || !/^\/new-music\//.test(location.pathname) || document.documentElement.dataset.eymNew) return;
    const items = scrapeReleases(document, 150);
    if (!items.length) return;
    document.documentElement.dataset.eymNew = "1";
    saveSidebarData("sidebar:newmusic", { items, t: Date.now() });
  }

  function run() {
    publishNewMusic();
    recordThisRelease();
    addNavLink();
    buildHero();
    tidyHeader();
    trimHome();
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

  globalThis.__embedYourMusic = { classify, classifyAny, makeFrame, resolveBandcamp, trackList, sidebarOpen, sidebarPlay, parseLinks, scrapeReleases, scrapeHistory, saveSidebarData, rememberId, isVideoPath, matchTrack, ORDER, LABELS, addCollapseToggles, buildHero, tidyHeader, buildTabs, run };
})();
