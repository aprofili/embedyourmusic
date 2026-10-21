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
  const order = [...sp.children].map((c) => c.className.split(" ")[0]);
  assert.ok(order.indexOf("sp-rate") > order.indexOf("sp-head") && order.indexOf("sp-rate") < order.indexOf("sp-list"));
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
  console.log("spplayer tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
