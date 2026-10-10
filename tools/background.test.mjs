import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function setup(fail = false) {
  const handlers = {}, calls = [];
  const event = name => ({ addListener: fn => { handlers[name] = fn; } });
  vm.runInNewContext(source, { chrome: {
    runtime: { id: "extension", onMessage: event("message") },
    action: { onClicked: event("click") },
    commands: { onCommand: event("command") },
    tabs: {
      query: async () => [{ id: 8 }],
      sendMessage: async (...args) => {
        calls.push(JSON.parse(JSON.stringify(args)));
        if (fail) throw new Error("Document gone");
        return { delivered: true };
      },
    },
  } });
  return { handlers, calls };
}
const sender = { id: "extension", tab: { id: 7 }, frameId: 3,
  documentId: "real-document", url: "https://frame.example/path" };

test("icon and shortcut target only the top frame", async () => {
  const { handlers, calls } = setup();
  handlers.click({ id: 7 });
  await handlers.command("toggle-toolbar");
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [[7, { frameId: 0 }], [8, { frameId: 0 }]]);
});

test("child cannot spoof its tab, document or URL when contacting the review owner", async () => {
  const { handlers, calls } = setup();
  const result = await new Promise(resolve => {
    assert.equal(handlers.message({ type: "ae:frame-request", tabId: 99,
      documentId: "spoof", url: "https://other.example", request: { action: "hello", path: "0" } }, sender, resolve), true);
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(calls[0][0], 7);
  assert.equal(calls[0][1].documentId, "real-document");
  assert.equal(calls[0][1].url, "https://frame.example/path");
  assert.deepEqual(calls[0][2], { frameId: 0 });
});

test("only top may send state, and it stays within the sender's tab", () => {
  const { handlers, calls } = setup();
  const message = { type: "ae:frame-send", tabId: 99, documentId: "child-document",
    message: { type: "ae:frame-state", visible: true } };
  assert.equal(handlers.message(message, sender, () => {}), undefined);
  handlers.message(message, { ...sender, frameId: 0 }, () => {});
  assert.deepEqual(calls, [[7, message.message, { documentId: "child-document" }]]);
});

test("foreign senders, missing tabs and child broadcasts are rejected", () => {
  const { handlers, calls } = setup();
  for (const from of [{ ...sender, id: "other" }, { ...sender, tab: undefined }]) {
    handlers.message({ type: "ae:frame-request", request: { action: "hello" } }, from, () => {});
  }
  handlers.message({ type: "ae:discover" }, sender, () => {});
  assert.equal(calls.length, 0);
});

test("a removed document returns an unavailable result instead of rejecting the message channel", async () => {
  const { handlers } = setup(true);
  const response = await new Promise(resolve => handlers.message({ type: "ae:frame-request",
    request: { action: "hello", path: "0" } }, sender, resolve));
  assert.equal(response.unavailable, true);
});
