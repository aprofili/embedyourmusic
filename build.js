// Builds browser-specific packages into dist/.
// manifest.json is the Chromium (Edge/Chrome) manifest and also loads directly from the repo root.
// Firefox needs background.scripts instead of a service worker, plus a gecko id.
const fs = require("fs");
const path = require("path");

const root = __dirname;
const FILES = ["background.js", "content.js", "content.css", "artist-ratings.js", "rules.json"];
const base = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

const firefox = {
  ...base,
  background: { scripts: ["background.js"] },
  browser_specific_settings: {
    gecko: {
      id: "embedyourmusic@aprofili",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
  },
};

function emit(name, manifest) {
  const dir = path.join(root, "dist", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of FILES) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`built dist/${name}`);
}

emit("chromium", base);
emit("firefox", firefox);
