// Side panel: our own Spotify player (the engine is spengine.js). What you see is art, title, a track list you pick from,
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
    const accent = `hsl(${hsl[0]} ${s}% ${l}%)`;
    root.style.setProperty("--sp-a", accent);
    // Hearts: the same family, lighter and slightly warmer so they stand out on the tinted card.
    const light = `hsl(${(hsl[0] + 20) % 360} ${Math.min(95, s + 10)}% ${Math.min(75, l + 18)}%)`;
    root.style.setProperty("--sp-h", light);
    // The whole panel (tabs, stars, lists, links, background) takes the same colours.
    const rs = document.documentElement.style;
    rs.setProperty("--tint", accent);
    rs.setProperty("--tint-h", light);
    rs.setProperty("--accent", light);
    rs.setProperty("--star", light);
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
    const artbox = el("div", "sp-artbox");
    const img = el("img", "sp-art");
    img.referrerPolicy = "no-referrer";
    const albumBtn = el("button", "sp-album", "♡");
    albumBtn.type = "button";
    albumBtn.hidden = true;
    artbox.append(img, albumBtn);
    head.append(artbox);
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
    const count = el("span", "sp-count");
    // Spotify's logo (top right of the card) shows / hides Spotify's own player, for when ours doesn't respond.
    const embedBtn = el("button", "sp-embed-toggle");
    embedBtn.type = "button";
    embedBtn.title = "Show Spotify's own player";
    embedBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><g fill="none" stroke="#000" stroke-linecap="round" stroke-opacity=".85"><path d="M5.6 9.2c4.2-1.2 8.7-.8 12.6 1.4" stroke-width="2"/><path d="M6.4 12.5c3.5-1 7.2-.6 10.4 1.2" stroke-width="1.7"/><path d="M7.2 15.5c2.8-.8 5.7-.5 8.2.9" stroke-width="1.4"/></g></svg>';
    controls.append(play, count);

    const barRow = el("div", "sp-barrow");
    const bar = el("div", "sp-bar");
    const fill = el("div", "sp-bar-fill");
    bar.append(fill);
    const clock = el("span", "sp-clock", "");
    barRow.append(bar, clock);
    const msg = el("div", "sp-msg");
    msg.hidden = true;
    const list = el("div", "sp-list");
    const rateSlot = el("div", "sp-rate");
    root.rateSlot = rateSlot;
    root.append(head, controls, barRow, msg, rateSlot, list, embedBtn);

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
        albumBtn.textContent = saved ? "♥" : "♡";
        albumBtn.title = saved ? "In your library (click to remove)" : "Save album to your library";
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
    // The engine (Spotify's embed + a bit of state) lives in an offscreen document when the browser has one, so
    // it keeps playing with the panel closed; otherwise here in the panel. This view only sends commands and paints.
    const driver = await makeDriver(root);
    let S = { key: "", idx: -1, want: false, seen: false, paused: true, pos: 0, dur: 0, failed: false, got: 0 };
    let started = false;
    const paint = () => {
      const playing = S.want && S.seen && !S.paused;
      const idx = S.idx;
      play.textContent = playing ? "⏸" : "▶";
      root.classList.toggle("sp-playing", playing);
      rows.forEach((r, i) => {
        r.row.classList.toggle("sp-current", i === idx);
        r.row.classList.toggle("sp-on", i === idx && playing);
        r.n.textContent = tracks.length > 1 ? String(r.t.number || i + 1) : "▶";
      });
      now.textContent = idx >= 0 && tracks[idx] ? tracks[idx].name : "";
      clock.textContent = idx >= 0 && S.dur ? `${fmt(S.pos)} / ${fmt(S.dur)}` : "";
      fill.style.width = S.dur ? `${Math.min(100, (S.pos / S.dur) * 100)}%` : "0";
      msg.hidden = !S.failed;
      if (S.failed) {
        msg.textContent = `Spotify's player didn't start (${S.got ? `${S.got} messages heard` : "no messages from it"}). Use the Spotify logo to open it directly.`;
      }
    };
    driver.onState((s, event) => {
      S = s;
      if (event === "played" && opts.onPlay && !started) {
        started = true;
        opts.onPlay();
      }
      if (event === "listened" && opts.onListened) opts.onListened();
      paint();
    });
    const command = async (c) => {
      const s = await driver.cmd(c);
      if (s) {
        S = s;
        paint();
      }
    };
    const select = (i, autoplay) => command({ cmd: "select", i, autoplay });
    play.addEventListener("click", () => command({ cmd: "toggle" }));
    embedBtn.addEventListener("click", () => {
      if (driver.remote) window.open(`https://open.spotify.com/${kind}/${id}`, "_blank", "noopener");
      else {
        driver.frame.classList.toggle("sp-frame-shown");
        if (S.idx < 0) select(0, false);
      }
    });
    embedBtn.title = driver.remote ? "Open on Spotify" : "Show Spotify's own player";

    // Already playing this release (the panel was closed and reopened): pick up where it is.
    const cur = await driver.cmd({ cmd: "get" });
    if (cur && cur.key === info.key && cur.idx >= 0) {
      S = cur;
      started = true;
    } else {
      S = (await driver.cmd({ cmd: "load", key: info.key, rymId: payload.id || "", tracks: tracks.map((t) => ({ id: t.id, ms: t.ms })) })) || S;
      if (opts.autoplay !== false) setTimeout(() => S.idx < 0 && select(0, true), 0);
    }

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
    return root;
  }

  // Where the engine runs: the offscreen document if the browser has one (asked via the background), else here.
  async function makeDriver(host) {
    const r = await send({ type: "eng-ensure" });
    const subs = new Set();
    if (r && r.ok) {
      let alive = false;
      const onMsg = (m) => {
        if (!m || m.type !== "eng-state") return;
        if (!host.isConnected) {
          if (alive) api.runtime.onMessage.removeListener(onMsg); // our card was replaced
          return;
        }
        alive = true;
        subs.forEach((f) => f(m.state, m.event));
      };
      api.runtime.onMessage.addListener(onMsg);
      return {
        remote: true,
        onState: (f) => subs.add(f),
        cmd: async (c) => {
          const res = await send({ type: "eng-cmd", ...c });
          return res && res.state;
        },
      };
    }
    const engine = globalThis.__eymSpEngine.create(host, (s, e) => subs.forEach((f) => f(s, e)));
    return { remote: false, frame: engine.frame, onState: (f) => subs.add(f), cmd: async (c) => engine.handle(c) };
  }

  const resetTint = () => {
    const rs = document.documentElement.style;
    for (const p of ["--tint", "--tint-h", "--accent", "--star"]) rs.removeProperty(p);
  };

  globalThis.__eymSpPlayer = { build, resetTint };
})();
