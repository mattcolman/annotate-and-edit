/**
 * Annotate & Edit — background service worker.
 * The top document owns the review. Relay messages using Chrome's trusted
 * tab/document identities, never page postMessage or caller-supplied tab IDs.
 * No state is kept here, so service-worker suspension cannot lose a session.
 */
function toggle(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "ae:toggle" }, { frameId: 0 }).catch(() => {});
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) toggle(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-toolbar") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) toggle(tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab?.id == null) return;
  let delivery;
  if (msg?.type === "ae:frame-request" && sender.frameId !== 0) {
    delivery = chrome.tabs.sendMessage(sender.tab.id, {
      type: "ae:frame-request",
      request: msg.request,
      documentId: sender.documentId,
      frameId: sender.frameId,
      url: sender.url,
    }, { frameId: 0 });
  } else if (msg?.type === "ae:frame-send" && sender.frameId === 0 &&
             typeof msg.documentId === "string") {
    delivery = chrome.tabs.sendMessage(sender.tab.id, msg.message, {
      documentId: msg.documentId,
    });
  } else if (msg?.type === "ae:discover" && sender.frameId === 0) {
    delivery = chrome.tabs.sendMessage(sender.tab.id, { type: "ae:hello" });
  } else {
    return;
  }
  delivery.then(respond, () => respond({ unavailable: true }));
  return true;
});
