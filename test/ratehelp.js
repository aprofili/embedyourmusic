// "Help me decide": the comparison logic, and the panel flow (questions -> rating sent -> review box).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- logic: a consistent user always ends on their real rating, within 10 questions ----
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(read("ratehelp.js"), ctx);
  const H = ctx.__eymRateHelp;
  for (const levels of [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [4, 6, 7, 8, 9], [2, 5, 6, 7, 8, 10]]) {
    for (let truth = 1; truth <= 10; truth++) {
      const ans = [];
      let n = 0;
      while (!H.done(ans) && n < 20) {
        const l = H.nextLevel(ans, (x) => levels.includes(x));
        ans.push({ r: l, cmp: Math.sign(truth - l) });
        n++;
      }
      assert.ok(ans.length <= 10, "at most 10 questions");
      const got = H.estimate(ans);
      // With every level available it must be exact; with gaps, within the gap around it.
      if (levels.length === 10) assert.strictEqual(got, truth, `truth ${truth}: got ${got} after ${JSON.stringify(ans)}`);
      else assert.ok(Math.abs(got - truth) <= 2, `levels ${levels} truth ${truth}: got ${got}`);
    }
  }
  // the first question is in the middle of what you've rated, not at an extreme
  const first = H.nextLevel([], () => true);
  assert.ok(first >= 5 && first <= 6);
  // an inconsistent answer doesn't break it
  assert.ok(H.estimate([{ r: 6, cmp: 1 }, { r: 8, cmp: -1 }, { r: 7, cmp: 1 }, { r: 7, cmp: -1 }]) === 7);

  // ---- panel flow ----
  const dom = new JSDOM(read("sidepanel.html").replace(/<script[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.IntersectionObserver = class { observe() {} unobserve() {} };
  const lib = {};
  for (let r = 1; r <= 10; r++) for (let k = 0; k < 3; k++) lib[`/release/album/a${r}/t${r}-${k}/`] = [r, `Title ${r}.${k}`, `Artist ${r}`];
  const store = { "sidebar:ratedlib": lib };
  const sent = [];
  let onMsg;
  w.chrome = {
    runtime: {
      connect: () => ({ onMessage: { addListener: (fn) => (onMsg = fn) }, onDisconnect: { addListener() {} }, postMessage() {} }),
      sendMessage: async (m) => {
        sent.push(m);
        if (m.type === "ratings-sync") return { t: Date.now(), next: 0, pages: 3 };
        if (m.type === "rate") return { ok: true };
        if (m.type === "cover-art") return { url: "" };
        return {};
      },
    },
    storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) }, onChanged: { addListener() {} } },
  };
  w.eval(read("content.js"));
  w.eval(read("ratehelp.js"));
  w.eval(read("sidepanel.js"));
  await tick();
  onMsg({ type: "play", tabId: 7, payload: { id: "42", title: "New One", artist: "X", artUrl: "", href: "https://rateyourmusic.com/release/album/x/new-one/", rating: 0, ratingKnown: true, entries: [] } });
  await tick(20);
  const d = w.document;
  d.getElementById("rate-help").click();
  await tick(20);
  const truth = 7; // the user thinks it's a 3.5
  let asked = 0;
  for (; asked < 12; asked++) {
    const t = d.querySelector("#rate-quiz .rq-title");
    if (!t) break;
    const r = Number(/Title (\d+)/.exec(t.textContent)[1]);
    const label = truth > r ? "Better" : truth < r ? "Worse" : "About the same";
    [...d.querySelectorAll("#rate-quiz .rq-btns button")].find((b) => b.textContent === label).click();
    await tick(10);
  }
  assert.ok(asked <= 10, `asked ${asked}`);
  await tick(20);
  const rateMsg = sent.find((m) => m.type === "rate");
  assert.ok(rateMsg, "rating sent");
  assert.strictEqual(rateMsg.rating, truth);
  assert.strictEqual(rateMsg.id, "42");
  assert.ok(d.querySelector("#rate-quiz").textContent.includes("3.5"), "summary shows the result");
  assert.ok(!d.getElementById("review-box").hidden, "review box opens to leave a comment");
  console.log("ratehelp tests passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
