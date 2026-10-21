// Offscreen document (Chromium): hosts the Spotify engine so music keeps playing when the side panel is closed.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const engine = globalThis.__eymSpEngine.create(document.body, (state, event) => {
    api.runtime.sendMessage({ type: "eng-state", state, event }).catch(() => {});
  });
  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "eng-cmd") return false;
    sendResponse({ state: engine.handle(msg) });
    return false;
  });
})();
