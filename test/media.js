// Media keys: the shortcut and the OS media session both reach the engine, but one press is handled once.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let onMsg, onCmd;
  const sent = [];
  const bg = {
    chrome: {
      runtime: { onMessage: { addListener: (fn) => (onMsg = fn) }, onConnect: { addListener() {} }, sendMessage: async (m) => { sent.push(m); return {}; } },
      storage: { local: { get: async () => ({}), set: async () => {} } },
      commands: { onCommand: { addListener: (fn) => (onCmd = fn) } },
    },
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    URL, URLSearchParams, Date, TextEncoder,
  };
  bg.globalThis = bg;
  vm.createContext(bg);
  vm.runInContext(read("background.js"), bg);
  const toggles = () => sent.filter((m) => m.type === "eng-cmd" && m.cmd === "toggle").length;
  onCmd("media-play-pause");
  onMsg({ type: "media-key", cmd: "toggle" }, {}, () => {}); // the same press via the OS media session
  await tick(20);
  assert.strictEqual(toggles(), 1, "one press, one toggle");
  await tick(700);
  onMsg({ type: "media-key", cmd: "toggle" }, {}, () => {});
  await tick(20);
  assert.strictEqual(toggles(), 2, "a later press counts");
  onMsg({ type: "media-key", cmd: "next" }, {}, () => {});
  await tick(20);
  assert.ok(sent.some((m) => m.cmd === "next"), "other keys are not swallowed");
  onMsg({ type: "media-key", cmd: "evil" }, {}, () => {});
  assert.ok(!sent.some((m) => m.cmd === "evil"));

  // offscreen document registers the media session
  const handlers = {};
  const session = { setActionHandler: (a, f) => (handlers[a] = f) };
  const out = [];
  const off = {
    document: { body: {} },
    navigator: { mediaSession: session },
    MediaMetadata: class { constructor(o) { Object.assign(this, o); } },
    chrome: { runtime: { sendMessage: async (m) => { out.push(m); return {}; }, onMessage: { addListener() {} } } },
    __eymSpEngine: { create: (_h, emit) => { off.emit = emit; return { handle: () => ({}) }; } },
  };
  off.globalThis = off;
  vm.createContext(off);
  vm.runInContext(read("offscreen.js"), off);
  assert.deepStrictEqual(Object.keys(handlers).sort(), ["nexttrack", "pause", "play", "previoustrack"]);
  handlers.play();
  handlers.nexttrack();
  assert.deepStrictEqual(out.map((m) => m.cmd), ["toggle", "next"]);
  off.emit({ key: "spotify:album:x", title: "Marrow", artist: "brakence", want: true, seen: true, paused: false }, "");
  assert.strictEqual(session.metadata.title, "Marrow");
  assert.strictEqual(session.playbackState, "playing");
  console.log("media tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
