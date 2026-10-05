/**
 * Annotate & Edit — background service worker.
 * Forwards toolbar-toggle requests (extension icon click, keyboard shortcut)
 * to the content script in the active tab.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "ae:toggle" }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-toolbar") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "ae:toggle" }).catch(() => {});
  }
});
