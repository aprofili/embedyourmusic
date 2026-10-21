// Spotify playback engine: Spotify's embed in a hidden iframe, driven by postMessage. It runs either in the
// side panel (fallback) or in an offscreen document (Chromium), where it keeps playing after the panel closes.
// handle({cmd: "load"|"select"|"toggle"|"get", ...}) -> state snapshot; emit(state, event) reports changes.
(() => {
  function create(host, emit) {
    const frame = document.createElement("iframe");
    frame.className = "sp-frame";
    frame.title = "Spotify player";
    frame.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    host.append(frame);

    let tracks = [];
    let key = "";
    let rymId = "";
    let idx = -1;
    let want = false;
    let st = { seen: false, paused: true, pos: 0, dur: 0 };
    let failed = false;
    let got = 0;
    let readyOnce = false;
    let started = false;
    let fired = false;
    let timers = [];
    let lastToggle = 0;
    let lastEmit = 0;
    let selectedAt = 0;
    let fixes = 0; // reconcile attempts for the current want/actual mismatch
    const heard = new Map();

    const snap = () => ({ key, rymId, idx, want, seen: st.seen, paused: st.paused, pos: st.pos, dur: st.dur, got, failed, total: tracks.length, started });
    const out = (event, force) => {
      const now = Date.now();
      if (!force && !event && now - lastEmit < 700) return;
      lastEmit = now;
      try {
        emit(snap(), event || null);
      } catch {}
    };
    const playing = () => want && st.seen && !st.paused;
    const post = (command, extra) => {
      if (command === "toggle") lastToggle = Date.now();
      try {
        frame.contentWindow.postMessage({ command, ...(extra || {}) }, "*");
      } catch {}
    };
    // Start playback, but never twice in quick succession (two toggles = play then pause).
    const kick = () => {
      if (want && !playing() && Date.now() - lastToggle > 2200) post("toggle");
    };

    function select(i, autoplay) {
      if (i < 0 || i >= tracks.length) return;
      timers.forEach(clearTimeout);
      timers = [];
      idx = i;
      want = !!autoplay;
      failed = false;
      fixes = 0;
      selectedAt = Date.now();
      st = { seen: false, paused: true, pos: 0, dur: 0 };
      readyOnce = false;
      frame.src = `https://open.spotify.com/embed/track/${tracks[i].id}?utm_source=embedyourmusic`;
      let event = null;
      if (autoplay) {
        if (!started) {
          started = true;
          event = "played";
        }
        // Press play once the embed is up: on its "ready" message, and again a few times in case that is
        // missed (toggle is the command Spotify documents). Stops once it plays.
        for (const ms of [1500, 4000, 6500]) timers.push(setTimeout(kick, ms));
        timers.push(
          setTimeout(() => {
            if (want && !playing()) {
              failed = true;
              out(null, true);
            }
          }, 8000)
        );
      }
      out(event, true);
    }

    function load(m) {
      if (m.key !== key) {
        timers.forEach(clearTimeout);
        timers = [];
        key = m.key;
        idx = -1;
        want = false;
        failed = false;
        started = false;
        fired = false;
        heard.clear();
        st = { seen: false, paused: true, pos: 0, dur: 0 };
        try {
          frame.src = "about:blank";
        } catch {}
      }
      rymId = m.rymId || "";
      tracks = (m.tracks || []).map((t) => ({ id: t.id, ms: t.ms }));
    }

    // What the embed is really doing is the truth; we steer it toward `want` with "toggle" (the command that is known
    // to work) and never send one blindly: a toggle against the wrong state is what froze playback before.
    function reconcile() {
      if (idx < 0 || !st.seen) return;
      const actual = !st.paused;
      if (want === actual) {
        fixes = 0;
        return;
      }
      if (fixes < 4 && Date.now() - lastToggle > 1800) {
        fixes++;
        post("toggle");
      }
    }

    function toggle() {
      if (idx < 0) return select(0, true);
      want = !want;
      fixes = 0;
      lastToggle = 0;
      if (st.seen) reconcile();
      else if (want) kick();
      else post("pause"); // nothing heard from the embed yet
      out(null, true);
    }

    // Jump to a fraction (0..1) of the current song (Spotify's iFrame API: seek, in seconds).
    function seek(frac) {
      if (idx < 0 || !st.dur || !(frac >= 0)) return;
      const f = Math.min(0.999, frac);
      post("seek", { timestamp: Math.round((f * st.dur) / 1000) });
      st.pos = f * st.dur;
      selectedAtGuard();
      out(null, true);
    }
    const selectedAtGuard = () => {
      // The next progress message may still carry the old position; ended-detection must not read the jump as a finish.
      lastEmit = 0;
    };

    window.addEventListener("message", (e) => {
      if (e.origin !== "https://open.spotify.com" || e.source !== frame.contentWindow) return;
      const d = e.data && typeof e.data === "object" ? e.data : {};
      const p = d.payload || d.data || d;
      got++;
      try {
        if (localStorage.eymDebug) console.log("[EmbedYourMusic] spotify message", e.data);
      } catch {}
      if (d.type === "ready" && want && !readyOnce) {
        readyOnce = true;
        setTimeout(kick, 300);
      }
      if (typeof p.isPaused !== "boolean") return;
      // The previous song's page can still be talking for a moment after the src changes: ignore that.
      if (Date.now() - selectedAt < 900) return;
      // A message from the previous song's page still in flight: ignore it.
      const uri = String(p.playingURI || p.uri || "");
      if (/^spotify:track:/.test(uri) && idx >= 0 && tracks[idx] && !uri.includes(tracks[idx].id)) return;
      const prevPos = st.pos;
      const prevDur = st.dur;
      const wasPlaying = st.seen && !st.paused;
      st = { seen: true, paused: p.isPaused, pos: Number(p.position) || 0, dur: Number(p.duration) || prevDur };
      failed = false;
      // Finished: it stopped at (or snapped back from) the very end -> next song.
      const ended = want && st.paused && wasPlaying && prevDur && prevPos >= prevDur - 4000 && (st.pos === 0 || st.pos >= prevDur - 800);
      if (ended) {
        if (idx + 1 < tracks.length) return select(idx + 1, true);
        want = false;
      }
      reconcile();
      out();
    });

    // Wall-clock listening time per song (doesn't depend on the embed's progress messages).
    setInterval(() => {
      if (idx < 0 || !want || (st.seen && st.paused)) return;
      heard.set(idx, (heard.get(idx) || 0) + 1000);
      if (!fired && [...heard.values()].filter((ms) => ms >= 20000).length >= Math.min(4, tracks.length)) {
        fired = true;
        out("listened", true);
      }
    }, 1000);

    return {
      frame,
      handle(m) {
        if (m.cmd === "load") load(m);
        else if (m.cmd === "select") select(m.i, m.autoplay);
        else if (m.cmd === "toggle") toggle();
        else if (m.cmd === "seek") seek(m.frac);
        else if (m.cmd === "next") {
          if (idx + 1 < tracks.length) select(idx + 1, true);
        } else if (m.cmd === "prev") {
          if (idx > 0) select(st.pos > 3000 ? idx : idx - 1, true);
        }
        return snap();
      },
    };
  }

  globalThis.__eymSpEngine = { create };
})();
