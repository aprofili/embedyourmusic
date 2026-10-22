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
  // listening thresholds: History after 10 s, RYM "listening" after 3 songs x 20 s (here: 2-song release -> 2)
  {
    const ev = [];
    const e2 = w.__eymSpEngine.create(w.document.body, (st, e) => e && ev.push(e));
    const f2 = { postMessage() {} };
    Object.defineProperty(e2.frame, "contentWindow", { get: () => f2 });
    const say2 = (payload) => {
      const m = new w.Event("message");
      Object.assign(m, { data: { type: "playback_update", payload }, origin: "https://open.spotify.com", source: f2 });
      w.dispatchEvent(m);
    };
    e2.handle({ cmd: "load", key: "k2", tracks: [{ id: "a" }, { id: "b" }] });
    e2.handle({ cmd: "select", i: 0, autoplay: true });
    await tick(1000);
    say2({ isPaused: false, position: 1000, duration: 180000 });
    await tick(10500);
    assert.ok(ev.includes("played"), "History after 10 s");
    assert.ok(!ev.includes("listened"));
    await tick(10000);
    e2.handle({ cmd: "select", i: 1, autoplay: true });
    await tick(1000);
    say2({ isPaused: false, position: 1000, duration: 180000 });
    await tick(20500);
    assert.ok(ev.includes("listened"), "listening after 2 songs x 20 s on a 2-song release");
  }
  // seek: fraction of the song -> seconds
  eng.handle({ cmd: "seek", frac: 0.5 });
  const sk = full.filter((m) => m.command === "seek").pop();
  assert.ok(sk && sk.timestamp === 90, "seek posts seconds");
  assert.strictEqual(eng.handle({ cmd: "get" }).pos, 90000);
  eng.handle({ cmd: "next" });
  assert.strictEqual(eng.handle({ cmd: "get" }).idx, 1, "next song");
  // resume: select a song with a start time -> shows that time, seeks the embed there until it reports it
  {
    const e3 = w.__eymSpEngine.create(w.document.body, () => {});
    const out3 = [];
    const f3 = { postMessage: (m) => out3.push(m) };
    Object.defineProperty(e3.frame, "contentWindow", { get: () => f3 });
    const say3 = (payload) => {
      const m = new w.Event("message");
      Object.assign(m, { data: { type: "playback_update", payload }, origin: "https://open.spotify.com", source: f3 });
      w.dispatchEvent(m);
    };
    e3.handle({ cmd: "load", key: "k3", tracks: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const r3 = e3.handle({ cmd: "select", i: 2, autoplay: false, startMs: 95000 });
    assert.strictEqual(r3.idx, 2);
    assert.strictEqual(r3.pos, 95000, "shows the saved time straight away");
    await tick(1000);
    say3({ isPaused: true, position: 0, duration: 200000 }); // the embed starts at 0: not reported as the position
    assert.strictEqual(e3.handle({ cmd: "get" }).pos, 95000);
    assert.ok(out3.some((m) => m.command === "seek" && m.timestamp === 95), "seek to the saved second");
    await tick(1300);
    say3({ isPaused: true, position: 95500, duration: 200000 }); // it got there
    assert.strictEqual(e3.handle({ cmd: "get" }).pos, 95500);
  }
  console.log("engine tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
