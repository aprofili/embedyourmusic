// Inside Spotify's embed (the hidden player in the offscreen document or the panel): passes the panel's volume
// setting (storage "sidebar:volume", 0-100, 50 = default) to spvolume-main.js, which applies it to the audio.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api || !api.storage) return;
  let v = 50;
  const tell = () => document.dispatchEvent(new CustomEvent("eym-volume", { detail: String(v) }));
  api.storage.local.get("sidebar:volume").then((o) => {
    if (o && typeof o["sidebar:volume"] === "number") v = o["sidebar:volume"];
    tell();
  }, () => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes["sidebar:volume"]) return;
    const n = changes["sidebar:volume"].newValue;
    v = typeof n === "number" ? n : 50;
    tell();
  });
  // (in case the page script wasn't listening yet when the first value went out)
  document.addEventListener("play", tell, true);
})();
