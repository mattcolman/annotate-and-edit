/**
 * Annotate & Edit — background service worker.
 * The top document owns the review. Relay messages using Chrome's trusted
 * tab/document identities, never page postMessage or caller-supplied tab IDs.
 * Only in-flight toolbar requests live here; suspension cannot lose a review.
 */
const opening = new Map();

async function actionStatus(tabId, error) {
  const title = error
    ? `Couldn't open Annotate & Edit. Refresh the page and try again.\n${String(error.message || error).slice(0, 300)}`
    : "Toggle Annotate & Edit toolbar";
  // A tab may close during startup. Status failures must not become another
  // unhandled error, or turn a successful toggle into a second toggle.
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: error ? "!" : "" }),
    chrome.action.setTitle({ tabId, title }),
  ]);
}

async function togglePage(tabId) {
  try {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "ae:toggle" }, { frameId: 0 });
      if (!response?.ok) throw new Error("The toolbar did not acknowledge the click.");
    } catch {
      // Static content scripts can be absent from already-open tabs after an
      // installation/update or a missed injection. activeTab grants access
      // only when the user invokes the icon/shortcut; browser restrictions
      // still apply. Recover the top document without requiring a reload.
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ["content.js"],
      });
      // Session storage may restore an already-visible toolbar on injection.
      // Explicitly show it so the first click never immediately hides it.
      const response = await chrome.tabs.sendMessage(tabId, { type: "ae:show" }, { frameId: 0 });
      if (!response?.ok) throw new Error("The page did not finish starting the toolbar.");
    }
    await actionStatus(tabId);
  } catch (error) {
    console.error("Annotate & Edit could not open:", error);
    await actionStatus(tabId, error);
  }
}

function toggle(tabId) {
  if (opening.has(tabId)) return opening.get(tabId);
  const request = togglePage(tabId).finally(() => opening.delete(tabId));
  opening.set(tabId, request);
  return request;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) return toggle(tab.id);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-toolbar") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) return toggle(tab.id);
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
