// Visiting your own play-history page saves it for the panel, and remembers who you are.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const file = "/root/.claude/uploads/9f0b7094-47c7-58f0-bb8e-5a0c55e1425f/2878dd16-attachment.txt";
if (process.env.EYM_NO_REAL || !fs.existsSync(file)) {
  console.log("pages tests skipped");
  process.exit(0);
}
(async () => {
  const dom = new JSDOM(fs.readFileSync(file, "utf8"), { url: "https://rateyourmusic.com/play-history/jkprilfools/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const store = {};
  w.chrome = { runtime: { sendMessage: async () => ({}), onMessage: { addListener() {} } }, storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } } };
  w.eval(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(store["sidebar:user"], "jkprilfools");
  assert.ok(store["sidebar:rymhist"] && store["sidebar:rymhist"].items.length >= 1, "play history saved on visit");
  console.log("pages tests passed");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
