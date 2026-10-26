// Custom Spotify player: hidden embed driven by postMessage, track list, album save, rating placement.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), {
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  let onMsg;
  const sent = [];
  const store = {};
  const tracks = [1, 2, 3].map((n) => ({ id: `t${n}`, name: `Song ${n}`, number: n, ms: 180000, saved: n === 2 }));
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener: (fn) => (onMsg = fn) }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "spotify-status") return { connected: true };
        if (m.type === "spotify-tracks") return { tracks: tracks.map((t) => ({ ...t })) };
        if (m.type === "spotify-album") return { saved: false };
        if (m.type === "spotify-album-save") return { ok: true };
        if (m.type === "spotify-art") return { url: "" };
        if (m.type === "spotify-save") return { ok: true };
        return {};
      },
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("spengine.js"));
  w.__eymReadyWait = 0;
  w.eval(read("spplayer.js"));
  w.eval(read("sidepanel.js"));
  await tick();
  const d = w.document;
  onMsg({ type: "play", tabId: 7, payload: {
    id: "1", title: "Album", artist: "Band", artUrl: "", href: "https://rateyourmusic.com/release/album/band/album/", rating: 4,
    entries: [{ service: "spotify", href: "https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7" }],
  } });
  await tick(20);
  const sp = d.querySelector(".sp");
  assert.ok(sp, "custom player rendered");
  assert.strictEqual(d.querySelectorAll(".sp-row").length, 3);
  // rating sits under the head, above the list
  assert.ok(d.querySelector(".sp-rate #rate-box"), "rating moved under the art");
  assert.ok(d.querySelector(".sp-head .sp-meta .sp-rate #rate-box"), "rating beside the art");
  assert.strictEqual(d.querySelector(".sp-count").textContent, "♥ 1/3");
  assert.strictEqual(d.querySelector(".sp-album").textContent, "♡");
  // hidden iframe until a song is chosen; clicking a row loads that track in it
  const frame = d.querySelector(".sp-frame");
  assert.ok(frame.src.includes("/embed/track/t1"), "autoplays the first song");
  assert.ok(d.querySelectorAll(".sp-row")[0].classList.contains("sp-current"));
  const posted = [];
  d.querySelectorAll(".sp-row")[1].click();
  assert.ok(frame.src.includes("/embed/track/t2"));
  assert.ok(d.querySelectorAll(".sp-row")[1].classList.contains("sp-current"));
  // album save
  d.querySelector(".sp-album").click();
  await tick(5);
  assert.ok(sent.some((m) => m.type === "spotify-album-save" && m.save === true));
  assert.strictEqual(d.querySelector(".sp-album").textContent, "♥");
  // heart saves a song without selecting it
  d.querySelectorAll(".sp-heart")[0].click();
  await tick(5);
  assert.ok(sent.some((m) => m.type === "spotify-save" && m.id === "t1" && m.save === true));
  // playing a different (non-spotify-player) release puts the rating box back
  onMsg({ type: "play", tabId: 7, payload: { id: "2", title: "B", artist: "C", artUrl: "", href: "https://rateyourmusic.com/release/album/c/b/", rating: 0, entries: [] } });
  await tick(5);
  assert.ok(!d.querySelector(".sp-rate #rate-box"));
  assert.ok(d.querySelector("#now > #rate-box"), "rating restored");

  // Offscreen mode: commands go to the background's offscreen engine; its broadcasts drive the card
  {
    const dom2 = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w2 = dom2.window;
    w2.IntersectionObserver = class { observe() {} unobserve() {} };
    const cmds = [];
    const asked = [];
    let broadcast;
    let dead = false;
    let stale = false;
    let closed = 0;
    let engState = { key: "", idx: -1, want: false, seen: false, paused: true, pos: 0, dur: 0 };
    w2.chrome = {
      runtime: {
        connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {} }),
        onMessage: { addListener: (fn) => (broadcast = fn), removeListener() {} },
        sendMessage: async (m) => {
          if (m.type === "eng-ensure") return { ok: true };
          if (m.type === "eng-close") { closed++; stale = false; return {}; }
          if (m.type === "eng-cmd") {
            cmds.push(m);
            if (dead && m.cmd === "toggle") {
              dead = false;
              return {}; // the offscreen player went away
            }
            if (m.cmd === "load") engState = { ...engState, key: m.key };
            if (m.cmd === "toggle" && stale) return { state: { ...engState, want: true } }; // alive but its player is dead
            if (m.cmd === "toggle" && !stale) engState = { ...engState, want: true, paused: false, seen: true };
            if (m.cmd === "select" && !stale && m.autoplay) engState = { ...engState, seen: true, paused: false };
            if (m.cmd === "select") engState = { ...engState, idx: m.i, want: !!m.autoplay };
            return { state: engState };
          }
          if (m.type === "spotify-status") return { connected: true };
          if (m.type === "spotify-tracks") { asked.push(m.id); return { tracks: tracks.map((t) => ({ ...t })) }; }
          if (m.type === "spotify-newer") return { id: "NEWID", name: "Album (Super Deluxe)" };
          return {};
        },
      },
      storage: { local: { get: async (k) => ({ [k]: undefined }), set: async () => {} }, onChanged: { addListener() {} } },
    };
    w2.eval(read("content.js"));
    w2.eval(read("spengine.js"));
    w2.eval(read("spplayer.js"));
    w2.eval(read("sidepanel.js"));
    await tick();
    const pay = { id: "1", title: "Album", artist: "Band", artUrl: "", href: "https://rateyourmusic.com/release/album/band/album/", rating: 0, entries: [{ service: "spotify", href: "https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7" }] };
    const info = w2.__embedYourMusic.classifyAny("https://open.spotify.com/album/49JPEgPvEaFp89xqzeQvF7");
    const EK = "spotify:album:NEWID";
    const card = await w2.__eymSpPlayer.build(info, pay, {});
    assert.ok(card, "card built with offscreen driver");
    assert.deepStrictEqual(asked, ["NEWID"], "newer edition's tracks are used");
    assert.ok(cmds.some((c) => c.cmd === "load" && c.key === "spotify:album:NEWID"), "engine keyed by the edition");
    assert.ok(/Super Deluxe/.test(card.querySelector(".sp-edition").textContent), "edition shown");
    assert.ok(cmds.some((c) => c.cmd === "load" && c.tracks.length === 3), "tracks loaded into the engine");
    assert.strictEqual(card.querySelector(".sp-frame"), null, "no iframe in the panel");
    w2.document.body.append(card);
    await tick(5);
    assert.ok(cmds.some((c) => c.cmd === "select" && c.i === 0 && c.autoplay), "autoplay starts song 1");
    broadcast({ type: "eng-state", state: { key: EK, idx: 1, want: true, seen: true, paused: false, pos: 5000, dur: 180000 } });
    assert.ok(card.querySelectorAll(".sp-row")[1].classList.contains("sp-on"), "state from offscreen shown");
    assert.strictEqual(card.querySelector(".sp-play").textContent, "⏸");
    // reopened while playing the same release: adopt, don't restart
    engState = { key: EK, idx: 1, want: true, seen: true, paused: false, pos: 9000, dur: 180000 };
    cmds.length = 0;
    const again = await w2.__eymSpPlayer.build(info, pay, {});
    await tick(5);
    assert.ok(!cmds.some((c) => c.cmd === "load" || c.cmd === "select"), "reopen adopts the running playback");
    w2.document.body.append(again);
    assert.ok(again.querySelectorAll(".sp-row")[1].classList.contains("sp-current"));
    // paused for a while, the offscreen player is gone: play must come back at the same song and second, not song 1
    cmds.length = 0;
    dead = true;
    again.querySelector(".sp-play").click();
    await tick(30);
    const sel = cmds.find((c) => c.cmd === "select");
    assert.ok(sel && sel.i === 1 && sel.startMs === 9000 && !sel.autoplay, "rebuilt engine returns to song 2 at 0:09");
    assert.ok(cmds.map((c) => c.cmd).lastIndexOf("toggle") > cmds.indexOf(sel), "the repeated toggle comes after the select");
    // hibernated: the offscreen document answers but its player is dead; play must notice, rebuild and resume
    w2.__eymStallWait = 1200;
    engState = { key: EK, idx: 1, want: false, seen: true, paused: true, pos: 9000, dur: 180000 };
    stale = true;
    cmds.length = 0;
    closed = 0;
    again.querySelector(".sp-play").click();
    await tick(2500);
    assert.strictEqual(closed, 1, "stalled player was closed and rebuilt");
    const rsel = cmds.find((c) => c.cmd === "select" && c.autoplay);
    assert.ok(rsel && rsel.i === 1 && rsel.startMs === 9000, "rebuilt at song 2, 0:09, playing");
    assert.ok(cmds.some((c) => c.cmd === "load"), "album reloaded");
    w2.__eymStallWait = 0;
    // engine gone (timed out) and the panel reopened on the same album: back to the saved song and second
    engState = null;
    cmds.length = 0;
    const back = await w2.__eymSpPlayer.build(info, pay, { autoplay: false, resume: { key: info.key, idx: 2, pos: 61000 } });
    assert.ok(back);
    assert.ok(cmds.some((c) => c.cmd === "select" && c.i === 2 && c.startMs === 61000 && !c.autoplay), "resumes song 3 at 1:01, paused");
  }
  console.log("spplayer tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
