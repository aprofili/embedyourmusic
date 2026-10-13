// Artist-page rating widgets, on rows shaped like RYM's real discography markup.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "content.css"), "utf8");
const js = fs.readFileSync(path.join(root, "artist-ratings.js"), "utf8");

const row = (id, cat) => `<div class="disco_release" id="release_${id}"><div class="disco_expandcat"><div class="disco_expandissues has_cat" onClick="RYMartistPage.expandIssues(${id});"><span class="expand_num">+152</span><span class="expand_arrow"><i class="fa fa-caret-down"></i></span></div><span class="disco_cat" onClick="RYMartistPage.expandIssues(${id});">
  ${cat}</span></div><div class="disco_info"><a class="album" href="/release/album/x/${id}/">Album ${id}</a></div></div><div class="disco_issues_section" id="issues_${id}"></div>`;

const UNRATED = `<span data-tiptip="To rate or catalog..." class="has_tip disco_cat_catalog_msg">Rate</span>`;
const RATED = `<span class="disco_cat_inner">5.0</span>`;
const ROWS = () => row(17, UNRATED) + row(16, RATED) + row(18, UNRATED);

function load({ withRating = true, url = "https://rateyourmusic.com/artist/the-beatles" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>
      <div id="disco_type_s">${ROWS()}</div>
      <div id="elsewhere"><div class="disco_release" id="release_99"><div class="disco_expandcat"><span class="disco_cat">Rate</span></div></div></div>
    </body></html>`,
    { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() }
  );
  const { window } = dom;
  window.created = [];
  window.defineRating = () => {
    window.RYMrating = class {
      constructor(type, id, rating) {
        const stars = window.document.getElementById(`rating_stars_${type}_${id}`);
        const num = window.document.getElementById(`rating_num_${type}_${id}`);
        if (!stars || !num) throw new Error("widget elements must exist before RYMrating is constructed");
        this.type = type;
        this.assoc_id = id;
        this.rating = rating;
        this.calls = [];
        stars.className = `rating_stars star-${rating}m`;
        num.textContent = rating ? (rating / 2).toFixed(1) : "---";
        window.created.push(this);
      }
    };
    for (const m of ["onMouseMove", "onMouseOver", "onMouseOut", "onTouchStart", "onTouchMove", "onTouchEnd", "onClick"]) {
      window.RYMrating.prototype[m] = function (e, el) {
        this.calls.push([m, e.type, el.id]);
      };
    }
  };
  if (withRating) window.defineRating();
  window.eval(js);
  return window;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const w = load();
  const d = w.document;
  const $ = (s) => d.querySelector(s);

  // Widgets replace the "Rate" cells; ids match what RYM's class looks up
  assert.strictEqual(d.querySelectorAll("#disco_type_s .my_catalog_rating").length, 3);
  assert.ok($("#my_catalog_rating_l_17") && $("#rating_stars_l_17") && $("#rating_num_l_17"));
  assert.ok(!$("#release_17 .disco_cat_catalog_msg"), "'Rate' text replaced");
  assert.ok($("#release_17 .disco_cat").classList.contains("rym-rate-cell"));

  // Created with the album id (same as the release page: new RYMrating('l', albumId, rating))
  const byId = Object.fromEntries(w.created.map((r) => [r.assoc_id, r]));
  assert.deepStrictEqual(Object.keys(byId).sort(), ["16", "17", "18"]);
  assert.strictEqual(byId[17].type, "l");
  assert.strictEqual(byId[17].rating, 0, "unrated starts at 0");
  assert.strictEqual(byId[16].rating, 10, "existing 5.0 rating shown as 10 on RYM's 0-10 scale");
  assert.strictEqual($("#rating_num_l_16").textContent, "5.0");
  // The server's reply calls window.rating_l_<id>
  assert.strictEqual(w.rating_l_17, byId[17]);
  assert.strictEqual(w.rating_l_16, byId[16]);

  // Events are forwarded to RYM's handlers with the widget element, like the inline handlers
  const box = $("#my_catalog_rating_l_17");
  let expanded = 0;
  $("#release_17 .disco_cat").addEventListener("click", () => expanded++);
  for (const type of ["mousemove", "mouseover", "mouseout", "click"]) {
    box.dispatchEvent(new w.MouseEvent(type, { bubbles: true, cancelable: true }));
  }
  assert.deepStrictEqual(
    byId[17].calls.map((c) => c[0]),
    ["onMouseMove", "onMouseOver", "onMouseOut", "onClick"]
  );
  assert.ok(byId[17].calls.every((c) => c[2] === "my_catalog_rating_l_17"));
  assert.strictEqual(expanded, 0, "rating click does not expand the issues list");

  // The expand arrow still works as before (its own inline handler is untouched)
  assert.ok($("#release_17 .disco_expandissues").getAttribute("onClick").includes("expandIssues(17)"));

  // Rows outside the discography list are left alone
  assert.strictEqual($("#release_99 .disco_cat").textContent, "Rate");

  // Idempotent
  const n = d.querySelectorAll(".my_catalog_rating").length;
  d.body.append(d.createElement("p"));
  await wait(300);
  assert.strictEqual(d.querySelectorAll(".my_catalog_rating").length, n);
  assert.strictEqual(w.created.length, 3);

  // Re-rendered discography (sort/filter) is enhanced again
  $("#disco_type_s").innerHTML = row(17, UNRATED) + row(20, UNRATED);
  await wait(300);
  assert.ok($("#release_17 .my_catalog_rating") && $("#release_20 .my_catalog_rating"));
  assert.strictEqual(d.querySelectorAll("#disco_type_s .my_catalog_rating").length, 2);

  // RYM's script not loaded yet: nothing changes, then it is picked up when ready
  const late = load({ withRating: false });
  assert.strictEqual(late.document.querySelectorAll(".my_catalog_rating").length, 0);
  assert.strictEqual(late.document.querySelector("#release_17 .disco_cat").textContent.trim(), "Rate");
  late.defineRating();
  late.document.body.append(late.document.createElement("p"));
  await wait(300);
  assert.strictEqual(late.document.querySelectorAll("#disco_type_s .my_catalog_rating").length, 3);

  // Only artist pages
  const other = load({ url: "https://rateyourmusic.com/release/album/the-beatles/abbey-road/" });
  assert.strictEqual(other.document.querySelectorAll(".my_catalog_rating").length, 0);

  console.log("artist tests passed");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
