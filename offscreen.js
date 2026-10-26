// Offscreen document (Chromium): hosts the Spotify engine so music keeps playing when the side panel is closed.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  // The OS media session (Windows/macOS/Linux volume overlay, media keys, headset buttons) controls the engine
  // through the background, which also receives the same key via the extension shortcut and ignores the repeat.
  const ms = globalThis.navigator && navigator.mediaSession;
  let shown = "";
  const showSession = (state) => {
    if (!ms) return;
    try {
      const k = `${state.key}|${state.title}|${state.artist}`;
      if (k !== shown && state.key) {
        shown = k;
        ms.metadata = new MediaMetadata({ title: state.title || "Spotify", artist: state.artist || "", album: "EmbedYourMusic" });
      }
      ms.playbackState = state.want && state.seen && !state.paused ? "playing" : "paused";
    } catch {}
  };
  const engine = globalThis.__eymSpEngine.create(document.body, (state, event) => {
    showSession(state);
    api.runtime.sendMessage({ type: "eng-state", state, event }).catch(() => {});
  });
  if (ms) {
    for (const [action, cmd] of [["play", "toggle"], ["pause", "toggle"], ["nexttrack", "next"], ["previoustrack", "prev"]]) {
      try {
        ms.setActionHandler(action, () => api.runtime.sendMessage({ type: "media-key", cmd }).catch(() => {}));
      } catch {}
    }
  }
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "eng-cmd") return false;
    sendResponse({ state: engine.handle(msg) });
    return false;
  });
})();
