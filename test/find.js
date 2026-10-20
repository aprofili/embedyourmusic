// Fallback lookup by artist/title/year when RYM's page can't be fetched.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const src = fs.readFileSync(require("path").join(__dirname, "..", "background.js"), "utf8");
const block = src.match(/\/\/ <shared:find>([\s\S]*?)\/\/ <\/shared:find>/)[1];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(block + "\nthis.pickAlbum = pickAlbum; this.findAlbumLinks = findAlbumLinks;", ctx);

(async () => {
  const want = { artist: "Portraits of Tracy", title: "Q: From Where Do Our Primal Instincts Originate? A: MTV!", year: 2026 };
  const getText = async (u) =>
    JSON.stringify(
      u.includes("itunes")
        ? { results: [
            { collectionName: "Other", artistName: "Portraits of Tracy", releaseDate: "2020-01-01", collectionViewUrl: "https://music.apple.com/us/album/other/1" },
            { collectionName: "Q: From Where Do Our Primal Instincts Originate? A: MTV! - EP", artistName: "Portraits of Tracy", releaseDate: "2026-03-01T08:00:00Z", collectionViewUrl: "https://music.apple.com/us/album/q/999?uo=4" },
          ] }
        : { data: [{ id: 5, title: "Q: From Where Do Our Primal Instincts Originate? A: MTV!", artist: { name: "Portraits Of Tracy" } }] }
    );
  const links = JSON.parse(JSON.stringify(await ctx.findAlbumLinks(want, getText)));
  assert.deepStrictEqual(links, [
    { service: "applemusic", href: "https://music.apple.com/us/album/q/999" },
    { service: "deezer", href: "https://www.deezer.com/album/5" },
  ]);
  assert.strictEqual(ctx.pickAlbum({ artist: "A", title: "Same" }, [{ title: "Same", artist: "B", href: "x" }]), null);
  // A failing service doesn't break the other
  const half = await ctx.findAlbumLinks(want, async (u) => { if (u.includes("itunes")) throw new Error("x"); return getText(u); });
  assert.strictEqual(half.length, 1);
  console.log("find tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
