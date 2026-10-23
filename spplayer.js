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

  // Accent colour from RGBA pixel data, as [h, s, l]. Pixels are grouped by hue (20° buckets) and the heaviest bucket
  // wins: saturated, mid-light pixels count most; greys barely; skin tones count about a third, so a face only sets
  // the colour when it really dominates (a shirt, a background or lettering usually wins).
  function pickAccent(d) {
    const bins = Array.from({ length: 18 }, () => ({ w: 0, v: 0, x: 0, y: 0, s: 0, l: 0 }));
    let gw = 0, gl = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] !== undefined && d[i + 3] < 128) continue;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const l = (mx + mn) / 2;
      const dl = mx - mn;
      const sat = dl ? dl / (1 - Math.abs(2 * l - 1)) : 0;
      if (sat < 0.12 || l < 0.08 || l > 0.95) {
        gw += 1;
        gl += l;
        continue;
      }
      let h;
      if (mx === r) h = ((g - b) / dl) % 6;
      else if (mx === g) h = (b - r) / dl + 2;
      else h = (r - g) / dl + 4;
      h = (h * 60 + 360) % 360;
      let w = (0.15 + sat) * (l > 0.18 && l < 0.85 ? 1 : 0.4) * Math.min(1, dl * 3);
      const skin = h >= 5 && h <= 45 && sat >= 0.12 && sat <= 0.75 && l >= 0.25 && l <= 0.88;
      if (skin) w *= 0.35;
      const bin = bins[Math.floor(h / 20) % 18];
      bin.w += w;
      // vividness, for the second colour: strongly saturated, mid-light pixels (a red sign, a yellow light)
      bin.v += sat * sat * (l > 0.25 && l < 0.8 ? 1 : 0.3) * (skin ? 0.35 : 1);
      bin.x += Math.cos((h * Math.PI) / 180) * w;
      bin.y += Math.sin((h * Math.PI) / 180) * w;
      bin.s += sat * w;
      bin.l += l * w;
    }
    // neighbouring buckets count a little toward each other (a hue split across a bucket edge)
    let best = -1, bestW = 0;
    bins.forEach((bn, k) => {
      const w = bn.w + 0.5 * (bins[(k + 17) % 18].w + bins[(k + 1) % 18].w);
      if (bn.w > 0 && w > bestW) (best = k), (bestW = w);
    });
    if (best < 0) return gw ? [0, 0, gl / gw] : null;
    const hslOf = (bn) => [Math.round(((Math.atan2(bn.y, bn.x) * 180) / Math.PI + 360) % 360), bn.s / bn.w, bn.l / bn.w];
    const main = hslOf(bins[best]);
    // Second colour: the most vivid hue clearly apart from the main one (at least 60° away) that the art shows
    // in more than a speck (2% of its colour). Null when the art is really one colour family.
    const totalW = bins.reduce((a, b) => a + b.w, 0);
    const totalV = bins.reduce((a, b) => a + b.v, 0);
    const dist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    let second = null, bestV = 0;
    for (const bn of bins) {
      if (!bn.w || bn.w < totalW * 0.02) continue;
      const c = hslOf(bn);
      if (dist(c[0], main[0]) < 60) continue;
      if (bn.v > bestV && bn.v > totalV * 0.04) (bestV = bn.v), (second = c);
    }
    main.second = second;
    return main;
  }

  // Accent colour of an image; null if it can't be read.
  function dominant(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = c.height = 32;
          const g = c.getContext("2d", { willReadFrequently: true });
          g.drawImage(img, 0, 0, 32, 32);
          resolve(pickAccent(g.getImageData(0, 0, 32, 32).data));
        } catch {
          resolve(null); // cross-origin image without CORS: canvas is tainted
        }
      };
      img.src = url;
    });
  }

  // Two colours from the art: the main one tints the card and the panel (backgrounds, highlights, glow); a notable
  // second colour (if the art has one) marks what you act on: play button, progress, now-playing marks, hearts, stars.
  // The colours of the card before this one: a new card starts from them and fades to its own.
  let lastCols = null;
  const frames = (n) => new Promise((r) => (n > 0 && typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => frames(n - 1).then(r)) : r()));
  async function tint(root, url) {
    const hsl = await dominant(url);
    if (!hsl || hsl[1] < 0.05) {
      lastCols = null;
      return; // black-and-white art: keep the default colours
    }
    const vivid = (c, sMin, lMin, lMax) => [c[0], Math.round(Math.min(0.9, Math.max(sMin, c[1])) * 100), Math.round(Math.min(lMax, Math.max(lMin, c[2])) * 100)];
    const css = (c) => `hsl(${c[0]} ${c[1]}% ${c[2]}%)`;
    const main = vivid(hsl, 0.4, 0.45, 0.62);
    const two = hsl.second ? vivid(hsl.second, 0.6, 0.5, 0.62) : null;
    const accent = css(main);
    const pop = two ? css(two) : accent;
    // Hearts and stars: lighter version of the second colour (or of the main one, shifted a little warmer).
    const light = two ? `hsl(${two[0]} ${Math.min(95, two[1] + 5)}% ${Math.min(74, two[2] + 14)}%)` : `hsl(${(main[0] + 20) % 360} ${Math.min(95, main[1] + 10)}% ${Math.min(75, main[2] + 18)}%)`;
    // Let the card be on screen (showing the previous colours) before the new ones go in, so they fade.
    for (let i = 0; i < 30 && !root.isConnected; i++) await frames(1);
    await frames(2);
    root.style.setProperty("--sp-a", accent);
    root.style.setProperty("--sp-b", pop);
    root.style.setProperty("--sp-h", light);
    lastCols = { a: accent, b: pop, h: light };
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
    if (lastCols) {
      root.style.setProperty("--sp-a", lastCols.a);
      root.style.setProperty("--sp-b", lastCols.b);
      root.style.setProperty("--sp-h", lastCols.h);
    }
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
    // Title and artist link to their RYM pages (the artist page is read off the release's address).
    const link = (cls, text, href) => {
      const n = el(href ? "a" : "div", cls, text);
      if (href) {
        n.href = href;
        n.target = "_blank";
        n.rel = "noopener";
      }
      return n;
    };
    let artistHref = "";
    try {
      const m = /^\/release\/[^/]+\/([^/]+)\//.exec(new URL(payload.href, "https://rateyourmusic.com").pathname);
      if (m) artistHref = `https://rateyourmusic.com/artist/${m[1]}`;
    } catch {}
    meta.append(link("sp-title", payload.title || "Untitled", payload.href || ""), link("sp-artist", payload.artist || "", artistHref));
    const now = el("div", "sp-now", ""); // (kept for the painter; hidden: the track list already shows the song)
    now.hidden = true;
    const rateSlot = el("div", "sp-rate");
    root.rateSlot = rateSlot;
    meta.append(rateSlot);
    head.append(meta);

    const play = el("button", "sp-play", "▶");
    play.type = "button";
    play.title = "Play / pause";
    const count = el("span", "sp-count");
    const listHead = el("div", "sp-listhead");
    listHead.append(count);
    // Spotify's logo (top right of the card) shows / hides Spotify's own player, for when ours doesn't respond.
    const embedBtn = el("button", "sp-embed-toggle");
    embedBtn.type = "button";
    embedBtn.title = "Show Spotify's own player";
    embedBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><g fill="none" stroke="#000" stroke-linecap="round" stroke-opacity=".85"><path d="M5.6 9.2c4.2-1.2 8.7-.8 12.6 1.4" stroke-width="2"/><path d="M6.4 12.5c3.5-1 7.2-.6 10.4 1.2" stroke-width="1.7"/><path d="M7.2 15.5c2.8-.8 5.7-.5 8.2.9" stroke-width="1.4"/></g></svg>';
    const barRow = el("div", "sp-barrow");
    const bar = el("div", "sp-bar");
    const fill = el("div", "sp-bar-fill");
    bar.append(fill);
    const clock = el("span", "sp-clock", "");
    const repeatBtn = el("button", "sp-repeat");
    repeatBtn.type = "button";
    repeatBtn.title = "Repeat the album";
    repeatBtn.setAttribute("aria-pressed", "false");
    repeatBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>';
    barRow.append(play, bar, clock, repeatBtn);
    const msg = el("div", "sp-msg");
    msg.hidden = true;
    const list = el("div", "sp-list");
    root.append(head, barRow, msg, listHead, list, embedBtn);

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
      row.append(num, name, dur, heart);
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
    let shownPct = 0;
    let shownIdx = -1;
    let swapping = false;
    let scrubbing = false;
    let nextPct = 0;
    const paint = () => {
      driver.last = S; // (where it was, in case the engine has to be rebuilt)
      const playing = S.want && S.seen && !S.paused;
      const idx = S.idx;
      play.textContent = playing ? "⏸" : "▶";
      repeatBtn.classList.toggle("sp-repeat-on", !!S.repeat);
      repeatBtn.setAttribute("aria-pressed", String(!!S.repeat));
      root.classList.toggle("sp-playing", playing);
      rows.forEach((r, i) => {
        r.row.classList.toggle("sp-current", i === idx);
        r.row.classList.toggle("sp-on", i === idx && playing);
        r.n.textContent = tracks.length > 1 ? String(r.t.number || i + 1) : "▶";
      });
      now.textContent = idx >= 0 && tracks[idx] ? tracks[idx].name : "";
      if (!scrubbing) clock.textContent = idx >= 0 && S.dur ? `${fmt(S.pos)} / ${fmt(S.dur)}` : "";
      const pct = S.dur ? Math.min(100, (S.pos / S.dur) * 100) : 0;
      if (scrubbing) {
        // the user is dragging: leave the bar and clock alone
      } else if (swapping) {
        nextPct = pct;
      } else if (pct < shownPct - 5 || (idx !== shownIdx && pct < shownPct)) {
        // New song (or a restart): fade the old bar out, then fade the new one in from the start, no sliding back.
        swapping = true;
        nextPct = pct;
        fill.classList.add("sp-bar-swap");
        setTimeout(() => {
          fill.style.transition = "none";
          fill.style.width = `${nextPct}%`;
          shownPct = nextPct;
          void fill.offsetWidth;
          fill.style.transition = "";
          fill.classList.remove("sp-bar-swap");
          swapping = false;
        }, 260);
      } else {
        fill.style.width = `${pct}%`;
        shownPct = pct;
      }
      shownIdx = idx;
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
      if (opts.onProgress && s.idx >= 0) opts.onProgress(s);
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
    repeatBtn.addEventListener("click", () => {
      const on = !S.repeat;
      command({ cmd: "repeat", on });
      if (opts.onRepeat) opts.onRepeat(on);
    });
    // Scrub bar: click or drag to jump within the current song.
    const fracAt = (e) => {
      const r = bar.getBoundingClientRect();
      return r.width ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
    };
    const preview = (f) => {
      fill.style.transition = "none";
      fill.style.width = `${f * 100}%`;
      shownPct = f * 100;
      if (S.dur) clock.textContent = `${fmt(f * S.dur)} / ${fmt(S.dur)}`;
    };
    bar.addEventListener("pointerdown", (e) => {
      if (S.idx < 0 || !S.dur) return;
      scrubbing = true;
      bar.classList.add("sp-scrub");
      try {
        bar.setPointerCapture(e.pointerId);
      } catch {}
      preview(fracAt(e));
    });
    bar.addEventListener("pointermove", (e) => {
      if (scrubbing) preview(fracAt(e));
    });
    const endScrub = (e, commit) => {
      if (!scrubbing) return;
      scrubbing = false;
      bar.classList.remove("sp-scrub");
      fill.style.transition = "";
      if (commit) command({ cmd: "seek", frac: fracAt(e) });
    };
    bar.addEventListener("pointerup", (e) => endScrub(e, true));
    bar.addEventListener("pointercancel", (e) => endScrub(e, false));
    embedBtn.addEventListener("click", () => {
      if (driver.remote) window.open(`https://open.spotify.com/${kind}/${id}`, "_blank", "noopener");
      else {
        driver.frame.classList.toggle("sp-frame-shown");
        if (S.idx < 0) select(0, false);
      }
    });
    embedBtn.title = driver.remote ? "Open on Spotify" : "Show Spotify's own player";

    // Already playing this release (the panel was closed and reopened): pick up where it is.
    const loadCmd = { cmd: "load", key: info.key, rymId: payload.id || "", href: payload.href || "", title: payload.title || "", artist: payload.artist || "", tracks: tracks.map((t) => ({ id: t.id, ms: t.ms })) };
    const cur = await driver.cmd({ cmd: "get" });
    if (cur && cur.key === info.key && cur.idx >= 0) {
      if (driver.setLoad) driver.setLoad(loadCmd); // (so a vanished engine can be rebuilt from this)
      S = cur;
      started = true;
    } else {
      S = (await driver.cmd(loadCmd)) || S;
      // Start the first song's embed now (paused unless this was asked for) and wait until it answers, so the
      // card only appears once pressing play does something.
      // Same album as last time: back to the song (and second) it was at.
      const rs = opts.resume && opts.resume.idx >= 0 && opts.resume.idx < tracks.length ? opts.resume : null;
      await command({ cmd: "select", i: rs ? rs.idx : 0, autoplay: opts.autoplay !== false, startMs: rs ? rs.pos : 0 });
      for (let waited = 0; waited < (globalThis.__eymReadyWait ?? 6000) && !(S.seen || S.got > 0); waited += 150) await new Promise((r) => setTimeout(r, 150));
    }

    if (opts.repeat !== undefined && !!S.repeat !== !!opts.repeat) await command({ cmd: "repeat", on: !!opts.repeat });
    paint();
    // Spotify's own cover (always loads, and its image host allows reading the colours); RYM's art as a fallback.
    send({ type: "spotify-art", kind, id }).then((r) => {
      spArt = (r && r.url) || "";
      if (spArt) {
        if (opts.onArt) opts.onArt(spArt);
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
  // If the offscreen player stops answering, the engine moves into the panel so playback still works.
  async function makeDriver(host) {
    const timed = (m, ms = 4000) => Promise.race([send(m), new Promise((r) => setTimeout(() => r({ error: "timeout" }), ms))]);
    const r = await timed({ type: "eng-ensure" });
    const subs = new Set();
    let lastLoad = null;
    let engine = null;
    const d = { remote: false, frame: null, onState: (f) => subs.add(f), cmd: null };
    const local = () => {
      if (engine) return engine;
      engine = globalThis.__eymSpEngine.create(host, (s, e) => {
        subs.forEach((f) => f(s, e));
        send({ type: "eng-state", state: s, event: e || null }); // toolbar badge; play history
      });
      d.remote = false;
      d.frame = engine.frame;
      if (api.runtime.onMessage)
        api.runtime.onMessage.addListener((m, _s, reply) => {
          if (!m || m.type !== "eng-cmd" || !host.isConnected) return false;
          reply({ state: engine.handle(m) });
          return false;
        });
      return engine;
    };
    if (r && r.ok) {
      let alive = false;
      const onMsg = (m) => {
        if (!m || m.type !== "eng-state" || engine) return;
        if (!host.isConnected) {
          if (alive) api.runtime.onMessage.removeListener(onMsg); // our card was replaced
          return;
        }
        alive = true;
        subs.forEach((f) => f(m.state, m.event));
      };
      api.runtime.onMessage.addListener(onMsg);
      d.remote = true;
      d.setLoad = (c) => (lastLoad = c);
      d.cmd = async (c) => {
        if (c.cmd === "load") lastLoad = c;
        if (engine) return engine.handle(c);
        let res = await timed({ type: "eng-cmd", ...c });
        if (!(res && res.state) && c.cmd !== "get") {
          // The offscreen document was closed by the browser (after a while without audio): bring it back,
          // hand it the album again, and repeat the command.
          const e = await timed({ type: "eng-ensure" });
          if (e && e.ok) {
            if (lastLoad && c.cmd !== "load") {
              await timed({ type: "eng-cmd", ...lastLoad });
              // ...and back to the song and second it was at (a bare toggle would start the album over)
              const h = d.last;
              if (h && h.idx >= 0 && h.key === lastLoad.key && c.cmd !== "select") await timed({ type: "eng-cmd", cmd: "select", i: h.idx, autoplay: false, startMs: h.pos });
            }
            res = await timed({ type: "eng-cmd", ...c });
          }
        }
        if (res && res.state) return res.state;
        if (c.cmd === "get") return null;
        // Still nothing: play from the panel itself (and make sure the offscreen player can't play alongside).
        send({ type: "eng-close" });
        const eng = local();
        if (lastLoad && c.cmd !== "load") {
          eng.handle(lastLoad);
          const h = d.last;
          if (h && h.idx >= 0 && h.key === lastLoad.key && c.cmd !== "select") eng.handle({ cmd: "select", i: h.idx, autoplay: false, startMs: h.pos });
        }
        return eng.handle(c);
      };
      return d;
    }
    d.cmd = async (c) => local().handle(c);
    local();
    return d;
  }

  const resetTint = () => {
    lastCols = null;
    const rs = document.documentElement.style;
    for (const p of ["--tint", "--tint-h", "--accent", "--star"]) rs.removeProperty(p);
  };

  globalThis.__eymSpPlayer = { build, resetTint, pickAccent };
})();
