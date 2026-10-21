// Side panel: our own Spotify player. Spotify's embed runs in a hidden iframe and is driven with
// postMessage ({command:"toggle"|"pause"}); what you see is art, title, a track list you pick from,
// play / pause, and a save-album button. Needs Spotify connected (the track list comes from its API).
// Falls back (returns null) when it isn't, so the normal embed is used instead.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const send = async (m) => {
    try {
      return (await api.runtime.sendMessage(m)) || { error: "no response" };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  };
  const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Dominant colour of an image (saturated pixels count more), as [h, s, l]; null if it can't be read.
  function dominant(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 24;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0, 24, 24);
          const d = g.getImageData(0, 0, 24, 24).data;
          let r = 0, gr = 0, b = 0, w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]);
            const mn = Math.min(d[i], d[i + 1], d[i + 2]);
            const wt = 0.05 + (mx - mn) / 255 + (mx > 40 && mx < 235 ? 0.2 : 0);
            r += d[i] * wt; gr += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
          }
          r /= w; gr /= w; b /= w;
          const mx = Math.max(r, gr, b) / 255, mn = Math.min(r, gr, b) / 255;
          const l = (mx + mn) / 2;
          const dl = mx - mn;
          let h = 0;
          if (dl) {
            if (mx === r / 255) h = ((gr - b) / 255 / dl) % 6;
            else if (mx === gr / 255) h = (b - r) / 255 / dl + 2;
            else h = (r - gr) / 255 / dl + 4;
          }
          const sat = dl ? dl / (1 - Math.abs(2 * l - 1)) : 0;
          resolve([Math.round(((h * 60) + 360) % 360), sat, l]);
        } catch {
          resolve(null); // cross-origin image without CORS: canvas is tainted
        }
      };
      img.src = url;
    });
  }

  async function tint(root, url) {
    const hsl = await dominant(url);
    if (!hsl) return;
    const s = Math.round(Math.min(0.85, Math.max(0.4, hsl[1])) * 100);
    const l = Math.round(Math.min(0.62, Math.max(0.45, hsl[2])) * 100);
    root.style.setProperty("--sp-a", `hsl(${hsl[0]} ${s}% ${l}%)`);
    root.classList.add("sp-tinted");
  }

  async function build(info, payload, opts = {}) {
    const [, kind, id] = (info.key || "").split(":");
    if (kind !== "album" && kind !== "track") return null;
    const status = await send({ type: "spotify-status" });
    if (!status.connected) return null;
    const res = await send({ type: "spotify-tracks", kind, id });
    if (res.error || !res.tracks || !res.tracks.length) return null;
    const tracks = res.tracks;

    const root = el("div", "sp");
    const head = el("div", "sp-head");
    const img = el("img", "sp-art");
    img.referrerPolicy = "no-referrer";
    head.append(img);
    let spArt = "";
    const setArt = (u) => {
      if (u) img.src = u;
      else img.hidden = true;
    };
    img.hidden = true;
    img.addEventListener("load", () => (img.hidden = false));
    img.addEventListener("error", () => {
      if (spArt && img.src !== spArt) img.src = spArt;
      else img.hidden = true;
    });
    const meta = el("div", "sp-meta");
    meta.append(el("div", "sp-title", payload.title || "Untitled"), el("div", "sp-artist", payload.artist || ""));
    const now = el("div", "sp-now", "");
    meta.append(now);
    head.append(meta);

    const controls = el("div", "sp-controls");
    const play = el("button", "sp-play", "▶");
    play.type = "button";
    play.title = "Play / pause";
    const albumBtn = el("button", "sp-album", "♡ Save album");
    albumBtn.type = "button";
    albumBtn.hidden = true;
    const count = el("span", "sp-count");
    const embedBtn = el("button", "sp-embed-toggle", "Spotify player");
    embedBtn.type = "button";
    embedBtn.title = "Show Spotify's own player (if something doesn't respond)";
    controls.append(play, albumBtn, count, embedBtn);

    const bar = el("div", "sp-bar");
    const fill = el("div", "sp-bar-fill");
    bar.append(fill);
    const msg = el("div", "sp-msg");
    msg.hidden = true;
    const list = el("div", "sp-list");
    const frame = document.createElement("iframe");
    frame.className = "sp-frame";
    frame.title = "Spotify player";
    frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    const rateSlot = el("div", "sp-rate");
    root.rateSlot = rateSlot;
    root.append(head, controls, bar, msg, rateSlot, list, frame);

    // ---- track list ----
    const rows = tracks.map((t, i) => {
      const row = el("div", "sp-row");
      const heart = el("button", "sp-heart");
      heart.type = "button";
      const num = el("span", "sp-num");
      const n = el("span", "sp-n", String(tracks.length > 1 ? t.number || i + 1 : "▶"));
      const eq = el("span", "sp-eq");
      eq.append(el("i"), el("i"), el("i"));
      num.append(n, eq);
      const name = el("span", "sp-name", t.name);
      const dur = el("span", "sp-dur", fmt(t.ms));
      const paintHeart = () => {
        heart.textContent = t.saved ? "♥" : "♡";
        heart.classList.toggle("sp-saved", !!t.saved);
        heart.title = t.saved ? "Remove from Liked Songs" : "Save to Liked Songs";
      };
      paintHeart();
      heart.addEventListener("click", async (e) => {
        e.stopPropagation();
        const want = !t.saved;
        t.saved = want;
        paintHeart();
        paintCount();
        const r = await send({ type: "spotify-save", id: t.id, save: want });
        if (r.error) {
          t.saved = !want;
          paintHeart();
          paintCount();
          heart.title = `Failed: ${r.error}`;
        }
      });
      row.append(heart, num, name, dur);
      row.addEventListener("click", () => select(i, true));
      list.append(row);
      return { t, row, n };
    });
    function paintCount() {
      count.textContent = `♥ ${tracks.filter((t) => t.saved).length}/${tracks.length}`;
      count.title = "Songs from this release in your Liked Songs";
    }
    paintCount();

    // ---- album save ----
    if (kind === "album") {
      let saved = null;
      const paintAlbum = () => {
        albumBtn.textContent = saved ? "♥ In your library" : "♡ Save album";
        albumBtn.classList.toggle("sp-saved", !!saved);
        albumBtn.hidden = saved == null;
      };
      send({ type: "spotify-album", id }).then((r) => {
        if (r && typeof r.saved === "boolean") {
          saved = r.saved;
          paintAlbum();
        }
      });
      albumBtn.addEventListener("click", async () => {
        const want = !saved;
        saved = want;
        paintAlbum();
        const r = await send({ type: "spotify-album-save", id, save: want });
        if (r.error) {
          saved = !want;
          paintAlbum();
          albumBtn.title = `Failed: ${r.error}`;
        }
      });
    }

    // ---- playback ----
    let idx = -1;
    let want = false;
    let st = { seen: false, paused: true, pos: 0, dur: 0 };
    let started = false;
    let got = 0; // messages heard from the embed (for the diagnostic line)
    let readyOnce = false;
    const heard = new Map();
    let fired = false;
    let timers = [];
    const post = (command) => {
      try {
        frame.contentWindow.postMessage({ command }, "*");
      } catch {}
    };
    const paint = () => {
      const playing = want && st.seen && !st.paused;
      play.textContent = playing ? "⏸" : "▶";
      root.classList.toggle("sp-playing", playing);
      rows.forEach((r, i) => {
        r.row.classList.toggle("sp-current", i === idx);
        r.row.classList.toggle("sp-on", i === idx && playing);
        if (i === idx && tracks.length > 1) r.n.textContent = String(r.t.number || i + 1);
        else r.n.textContent = tracks.length > 1 ? String(r.t.number || i + 1) : "▶";
      });
      now.textContent = idx >= 0 ? `${tracks[idx].name}${st.dur ? `  ${fmt(st.pos)} / ${fmt(st.dur)}` : ""}` : "";
      fill.style.width = st.dur ? `${Math.min(100, (st.pos / st.dur) * 100)}%` : "0";
    };

    function select(i, autoplay) {
      timers.forEach(clearTimeout);
      timers = [];
      idx = i;
      want = autoplay;
      st = { seen: false, paused: true, pos: 0, dur: 0 };
      readyOnce = false;
      msg.hidden = true;
      frame.src = `https://open.spotify.com/embed/track/${tracks[i].id}?utm_source=embedyourmusic`;
      if (autoplay && !started) {
        started = true;
        if (opts.onPlay) opts.onPlay();
      }
      if (autoplay) {
        // Press play once the embed is up: on its "ready" message (see below), and again a few times in
        // case that message is missed (toggle is the command Spotify documents). Stops once it plays.
        for (const ms of [1500, 3500, 6000]) {
          timers.push(setTimeout(() => want && !(st.seen && !st.paused) && post("toggle"), ms));
        }
        timers.push(
          setTimeout(() => {
            if (want && !(st.seen && !st.paused)) {
              msg.hidden = false;
              msg.textContent = `Spotify's player didn't start (${got ? `${got} messages heard` : "no messages from it"}). Press “Spotify player” to use it directly.`;
            }
          }, 8000)
        );
      }
      paint();
    }

    play.addEventListener("click", () => {
      if (idx < 0) return select(0, true);
      want = !want;
      if (!want) post("pause");
      else if (st.seen && st.paused) post("toggle");
      else if (!st.seen) post("toggle");
      paint();
    });

    embedBtn.addEventListener("click", () => {
      frame.classList.toggle("sp-frame-shown");
      if (idx < 0) select(0, false);
    });

    window.addEventListener("message", (e) => {
      if (e.origin !== "https://open.spotify.com" || !frame.isConnected || e.source !== frame.contentWindow) return;
      const d = e.data && typeof e.data === "object" ? e.data : {};
      const p = d.payload || d.data || d;
      got++;
      try {
        if (localStorage.eymDebug) console.log("[EmbedYourMusic] spotify message", e.data);
      } catch {}
      if (d.type === "ready" && want && !readyOnce) {
        readyOnce = true;
        setTimeout(() => want && !(st.seen && !st.paused) && post("toggle"), 300);
      }
      if (typeof p.isPaused !== "boolean") return;
      const prevPos = st.pos;
      const prevDur = st.dur;
      const wasPlaying = st.seen && !st.paused;
      st = { seen: true, paused: p.isPaused, pos: Number(p.position) || 0, dur: Number(p.duration) || prevDur };
      // Finished: it stopped at (or snapped back from) the very end -> next song.
      const ended = want && st.paused && wasPlaying && prevDur && prevPos >= prevDur - 2500 && (st.pos === 0 || st.pos >= prevDur - 500);
      if (ended) {
        if (idx + 1 < tracks.length) return select(idx + 1, true);
        want = false;
      }
      paint();
    });

    // Wall-clock listening time per song (doesn't depend on the embed's progress messages).
    setInterval(() => {
      if (!root.isConnected || idx < 0 || !want || (st.seen && st.paused)) return;
      const secs = (heard.get(idx) || 0) + 1000;
      heard.set(idx, secs);
      if (!fired && opts.onListened && [...heard.values()].filter((ms) => ms >= 20000).length >= Math.min(4, tracks.length)) {
        fired = true;
        opts.onListened();
      }
    }, 1000);

    paint();
    // Spotify's own cover (always loads, and its image host allows reading the colours); RYM's art as a fallback.
    send({ type: "spotify-art", kind, id }).then((r) => {
      spArt = (r && r.url) || "";
      if (spArt) {
        setArt(spArt);
        tint(root, spArt);
      } else {
        setArt(payload.artUrl);
        tint(root, payload.artUrl);
      }
    });
    if (opts.autoplay !== false) setTimeout(() => idx < 0 && select(0, true), 0);
    return root;
  }

  globalThis.__eymSpPlayer = { build };
})();
