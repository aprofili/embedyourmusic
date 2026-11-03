// Page world of Spotify's embed: scales every audio / video element by our volume (0-100 from spvolume.js;
// 100 = the element at full volume, so the default 50 leaves room to go louder). Spotify's own volume writes are
// kept and multiplied, so its player still behaves as it expects.
(() => {
  const proto = globalThis.HTMLMediaElement && HTMLMediaElement.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, "volume");
  if (!desc || !desc.set || proto.__eymVolume) return;
  proto.__eymVolume = true;
  let ours = 0.5;
  const clamp = (x) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 1));
  const theirs = new WeakMap();
  const els = new Set();
  const apply = (el) => {
    els.add(el);
    if (!theirs.has(el)) theirs.set(el, desc.get.call(el));
    try {
      desc.set.call(el, clamp(theirs.get(el) * ours));
    } catch {}
  };
  Object.defineProperty(proto, "volume", {
    configurable: true,
    enumerable: desc.enumerable,
    get() {
      return theirs.has(this) ? theirs.get(this) : desc.get.call(this);
    },
    set(v) {
      theirs.set(this, clamp(Number(v)));
      apply(this);
    },
  });
  const play = proto.play;
  proto.play = function (...args) {
    apply(this);
    return play.apply(this, args);
  };
  document.addEventListener("play", (e) => e.target instanceof HTMLMediaElement && apply(e.target), true);
  document.addEventListener("eym-volume", (e) => {
    ours = clamp(Number(e.detail) / 100);
    for (const el of els) apply(el);
    for (const el of document.querySelectorAll("audio, video")) apply(el);
  });
})();
