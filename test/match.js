// Which track is the Spotify embed playing? Several fallbacks.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const dom = new JSDOM("<body></body>", { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(), url: "https://rateyourmusic.com/x" });
const w = dom.window;
w.IntersectionObserver = class { observe() {} unobserve() {} };
w.chrome = { runtime: { sendMessage: async () => ({}) } };
w.eval(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"));
const { matchTrack } = w.__embedYourMusic;
const rows = [
  { t: { id: "A1aaaaaaaaaaaaaaaaaaaa", name: "Intro", number: 1, ms: 120000 } },
  { t: { id: "B2bbbbbbbbbbbbbbbbbbbb", name: "Now It's On", number: 2, ms: 248000 } },
  { t: { id: "C3cccccccccccccccccccc", name: "I'm On Standby", number: 3, ms: 192000 } },
  { t: { id: "D4dddddddddddddddddddd", name: "Same Length", number: 4, ms: 192500 } },
];
assert.strictEqual(matchTrack(rows, { payload: { playingURI: "spotify:track:B2bbbbbbbbbbbbbbbbbbbb" } }), 1, "uri");
assert.strictEqual(matchTrack(rows, { type: "x", payload: { nested: { uri: "spotify:track:C3cccccccccccccccccccc" } } }), 2, "id anywhere");
assert.strictEqual(matchTrack(rows, { payload: { title: "Now it's on!" } }), 1, "name, fuzzy");
assert.strictEqual(matchTrack(rows, { payload: { trackNumber: 3 } }), 2, "track number");
assert.strictEqual(matchTrack(rows, { payload: { duration: 248400 } }), 1, "duration, tolerant");
// two tracks ~ the same length: closest if clear, else the one after the previous
assert.strictEqual(matchTrack(rows, { payload: { duration: 192100 } }), 2, "closest");
assert.strictEqual(matchTrack(rows, { payload: { duration: 192250 } }, 2), 3, "tie goes to the next track");
assert.strictEqual(matchTrack(rows, { payload: { duration: 5000 } }), -1, "no match");
console.log("match tests passed");
