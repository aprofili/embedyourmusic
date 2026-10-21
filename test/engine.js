// Playback engine: pause / resume always follows what the embed reports (never a blind toggle).
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = new JSDOM("<body></body>", { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.eval(fs.readFileSync(path.join(__dirname, "..", "spengine.js"), "utf8"));
  const states = [];
  const eng = w.__eymSpEngine.create(w.document.body, (s, e) => states.push([s, e]));
  const sent = [];
  const full = [];
  const fake = { postMessage: (m) => (full.push(m), sent.push(m.command)) };
  Object.defineProperty(eng.frame, "contentWindow", { get: () => fake });
  const say = (payload) => {
    const ev = new w.Event("message");
    Object.assign(ev, { data: { type: "playback_update", payload }, origin: "https://open.spotify.com", source: fake });
    w.dispatchEvent(ev);
  };
  const tracks = [1, 2].map((n) => ({ id: `t${n}`, ms: 180000 }));
  eng.handle({ cmd: "load", key: "spotify:album:x", rymId: "1", tracks });
  eng.handle({ cmd: "select", i: 0, autoplay: true });
  await tick(1000); // messages right after a song change are from the old page and ignored
  say({ isPaused: true, position: 0, duration: 180000 });
  assert.ok(sent.includes("toggle"), "starts a paused embed with toggle");
  say({ isPaused: false, position: 1000, duration: 180000 });
  let s = eng.handle({ cmd: "get" });
  assert.ok(s.want && s.seen && !s.paused);
  // pause while playing
  sent.length = 0;
  eng.handle({ cmd: "toggle" });
  assert.deepStrictEqual(sent, ["toggle"], "pause = toggle against a playing embed");
  say({ isPaused: true, position: 2000, duration: 180000 });
  // resume while paused
  sent.length = 0;
  eng.handle({ cmd: "toggle" });
  assert.deepStrictEqual(sent, ["toggle"], "resume = toggle against a paused embed");
  say({ isPaused: false, position: 2500, duration: 180000 });
  // the embed keeps playing although we want it paused (the command was lost): it is retried, not flipped back
  sent.length = 0;
  eng.handle({ cmd: "toggle" }); // want = false; sends toggle
  say({ isPaused: false, position: 3000, duration: 180000 }); // still playing
  assert.strictEqual(sent.length, 1, "no second blind toggle within the guard window");
  await tick(1900);
  say({ isPaused: false, position: 4000, duration: 180000 });
  assert.strictEqual(sent.length, 2, "retried once the guard window passed");
  say({ isPaused: true, position: 4200, duration: 180000 });
  s = eng.handle({ cmd: "get" });
  assert.ok(!s.want && s.paused);
  sent.length = 0;
  say({ isPaused: true, position: 4200, duration: 180000 });
  assert.strictEqual(sent.length, 0, "settled: nothing more is sent");
  // seek: fraction of the song -> seconds
  eng.handle({ cmd: "seek", frac: 0.5 });
  const sk = full.filter((m) => m.command === "seek").pop();
  assert.ok(sk && sk.timestamp === 90, "seek posts seconds");
  assert.strictEqual(eng.handle({ cmd: "get" }).pos, 90000);
  eng.handle({ cmd: "next" });
  assert.strictEqual(eng.handle({ cmd: "get" }).idx, 1, "next song");
  console.log("engine tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
