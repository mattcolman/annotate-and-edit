/* Test-only runtime transport. Production uses Chrome messaging, never this
 * page-visible postMessage bridge. Run the real background.js against this
 * shim so smoke tests cover its routing as well as the content script. */
(() => {
  const id = "ae-smoke-extension";
  const topFrame = window === window.top;
  const documentId = crypto.randomUUID();
  const listeners = [];
  const backgroundListeners = [];
  const actionListeners = [];
  const children = new Map();
  const pending = new Map();
  const event = (list) => ({ addListener: (fn) => list.push(fn) });
  const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const sender = { id, tab: { id: 1 }, frameId: topFrame ? 0 : 1, documentId, url: location.href };
  function invoke(list, message, from) {
    return new Promise((resolve, reject) => {
      let held = false;
      try {
        for (const fn of list) {
          if (fn(copy(message), from, (value) => resolve(copy(value))) === true) held = true;
        }
        if (!held) resolve();
      } catch (error) { reject(error); }
    });
  }
  function ask(target, payload) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(token); reject(new Error("Frame unavailable")); }, 2000);
      pending.set(token, { resolve, reject, timer });
      target.postMessage({ aeSmoke: true, token, ...payload }, "*");
    });
  }
  addEventListener("message", async ({ data, source }) => {
    if (!data?.aeSmoke) return;
    if (data.kind === "response") {
      const p = pending.get(data.token);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(data.token);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.value);
      }
      return;
    }
    let promise;
    if (topFrame && data.kind === "request") {
      children.set(data.sender.documentId, source);
      promise = invoke(backgroundListeners, data.message, data.sender);
    } else if (!topFrame && data.kind === "delivery" && data.documentId === documentId) {
      promise = invoke(listeners, data.message, { id });
    } else { return; }
    try {
      source.postMessage({ aeSmoke: true, kind: "response", token: data.token, value: await promise }, "*");
    } catch (error) {
      source.postMessage({ aeSmoke: true, kind: "response", token: data.token, error: error.message }, "*");
    }
  });
  const runtime = {
    id, onMessage: event(listeners), getURL: (path) => "/" + path,
    sendMessage: (message) => topFrame
      ? invoke(backgroundListeners, message, { ...sender, url: location.href })
      : ask(window.top, { kind: "request", message, sender: { ...sender, url: location.href } }),
  };
  window.chrome = {
    runtime,
    storage: { local: {
      get: async () => {
        if (!topFrame) throw new Error("Child frame must not read site storage");
        return JSON.parse(localStorage.getItem("__ae_store") || "{}");
      },
      set: async (value) => {
        if (!topFrame) throw new Error("Child frame must not write site storage");
        const stored = JSON.parse(localStorage.getItem("__ae_store") || "{}");
        localStorage.setItem("__ae_store", JSON.stringify({ ...stored, ...value }));
      },
    } },
  };
  if (topFrame) {
    const deliver = (doc, message) => {
      const child = children.get(doc);
      if (!child) return Promise.reject(new Error("No document"));
      return ask(child, { kind: "delivery", documentId: doc, message });
    };
    window.__aeBackgroundChrome = {
      runtime: { id, onMessage: event(backgroundListeners) },
      action: { onClicked: event(actionListeners), setBadgeText: async () => {}, setTitle: async () => {} },
      commands: { onCommand: event([]) },
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (tabId, message, target) => {
          if (target?.frameId === 0) return invoke(listeners, message, { id });
          if (target?.documentId) return deliver(target.documentId, message);
          await Promise.allSettled([
            invoke(listeners, message, { id }),
            ...[...children.keys()].map((doc) => deliver(doc, message)),
          ]);
        },
      },
    };
    window.__aeTestToggle = () => actionListeners.forEach((fn) => fn({ id: 1 }));
  }
  window.__aeTestErrors = [];
  addEventListener("error", (event) => window.__aeTestErrors.push(event.message));
  addEventListener("unhandledrejection", (event) => window.__aeTestErrors.push(String(event.reason)));
})();
