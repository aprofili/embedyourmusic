// Accent colour: skin tones lose to other clear colours unless they really dominate.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const w = new JSDOM("<body></body>", { runScripts: "outside-only", virtualConsole: new VirtualConsole() }).window;
w.chrome = { runtime: { sendMessage: async () => ({}) } };
w.eval(fs.readFileSync(path.join(__dirname, "..", "spplayer.js"), "utf8"));
const { pickAccent } = w.__eymSpPlayer;
const hsl2rgb = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
};
const img = (parts) => {
  const out = [];
  for (const [n, h, s, l] of parts) for (let i = 0; i < n; i++) out.push(...hsl2rgb(h, s, l), 255);
  return out;
};
const near = (h, want) => Math.min(Math.abs(h - want), 360 - Math.abs(h - want)) < 15;
// a face (skin) filling 55% of the cover, a pink shirt 20%, dark rest -> pink
let a = pickAccent(img([[550, 25, 0.45, 0.65], [200, 335, 0.7, 0.6], [250, 0, 0, 0.1]]));
assert.ok(near(a[0], 335), `pink wins over skin (got ${a[0]})`);
// nearly all skin -> skin is fine
a = pickAccent(img([[950, 25, 0.45, 0.65], [50, 220, 0.5, 0.5]]));
assert.ok(near(a[0], 25), `skin when it dominates (got ${a[0]})`);
// non-skin warm colour (saturated orange) is not penalised
a = pickAccent(img([[400, 30, 0.95, 0.5], [300, 200, 0.5, 0.5]]));
assert.ok(near(a[0], 30), `vivid orange isn't treated as skin (got ${a[0]})`);
// greyscale image -> no hue, but a value
a = pickAccent(img([[100, 0, 0, 0.5]]));
assert.ok(a && a[1] === 0);
console.log("accent tests passed");
