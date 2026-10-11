import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
function setup(fail = false, overrides = {}) {
  const handlers = {}, calls = [], injections = [], badges = [], titles = [], errors = [];
  const copy = value => JSON.parse(JSON.stringify(value));
  const event = name => ({ addListener: fn => { handlers[name] = fn; } });
  vm.runInNewContext(source, { console: { error: (...args) => errors.push(args) }, chrome: {
    runtime: { id: "extension", onMessage: event("message") },
    action: {
      onClicked: event("click"),
      setBadgeText: async value => badges.push(copy(value)),
      setTitle: async value => titles.push(copy(value)),
    },
    commands: { onCommand: event("command") },
    scripting: { executeScript: async value => {
      injections.push(copy(value));
      return overrides.executeScript?.(value);
    } },
    tabs: {
      query: async () => [{ id: 8 }],
      sendMessage: async (...args) => {
        calls.push(JSON.parse(JSON.stringify(args)));
        if (overrides.sendMessage) return overrides.sendMessage(...args);
        if (fail) throw new Error("Document gone");
        if (["ae:toggle", "ae:show"].includes(args[1].type)) return { ok: true };
        return { delivered: true };
      },
    },
  } });
  return { handlers, calls, injections, badges, titles, errors };
}
const sender = { id: "extension", tab: { id: 7 }, frameId: 3,
  documentId: "real-document", url: "https://frame.example/path" };

test("icon and shortcut target only the top frame", async () => {
  const { handlers, calls, injections } = setup();
  await handlers.click({ id: 7 });
  await handlers.command("toggle-toolbar");
  assert.deepEqual(calls.map(call => [call[0], call[2]]), [[7, { frameId: 0 }], [8, { frameId: 0 }]]);
  assert.equal(injections.length, 0);
});

function missingScript() {
  let loaded = false;
  return {
    executeScript: async () => { loaded = true; },
    sendMessage: async () => {
      if (!loaded) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true };
    },
  };
}

for (const trigger of ["icon", "shortcut"]) {
  test(`${trigger} recovers a missing content script and explicitly opens the toolbar`, async () => {
    const { handlers, calls, injections, badges, errors } = setup(false, missingScript());
    const tabId = trigger === "icon" ? 7 : 8;
    if (trigger === "icon") await handlers.click({ id: tabId });
    else await handlers.command("toggle-toolbar");
    assert.deepEqual(injections, [{ target: { tabId, frameIds: [0] }, files: ["content.js"] }]);
    assert.deepEqual(calls, [
      [tabId, { type: "ae:toggle" }, { frameId: 0 }],
      [tabId, { type: "ae:show" }, { frameId: 0 }],
    ]);
    assert.deepEqual(badges, [{ tabId, text: "" }]);
    assert.equal(errors.length, 0);
  });
}

test("browser-denied injection reports a failure without retrying indefinitely", async () => {
  const { handlers, calls, injections, badges, titles, errors } = setup(true, {
    executeScript: async () => { throw new Error("Cannot access contents of this page."); },
  });
  await handlers.click({ id: 7 });
  assert.equal(calls.length, 1);
  assert.equal(injections.length, 1);
  assert.deepEqual(badges, [{ tabId: 7, text: "!" }]);
  assert.match(titles[0].title, /Refresh the page.*\nCannot access contents/);
  assert.equal(errors.length, 1);
});

test("a script that never starts the toolbar is reported as a failure", async () => {
  let attempts = 0;
  const { handlers, badges } = setup(false, {
    sendMessage: async () => {
      if (++attempts === 1) throw new Error("No receiver");
      return undefined;
    },
  });
  await handlers.click({ id: 7 });
  assert.deepEqual(badges, [{ tabId: 7, text: "!" }]);
});

test("a missing acknowledgement also attempts recovery", async () => {
  let attempts = 0;
  const { handlers, injections, errors } = setup(false, {
    sendMessage: async () => ++attempts === 1 ? undefined : { ok: true },
  });
  await handlers.click({ id: 7 });
  assert.equal(injections.length, 1);
  assert.equal(errors.length, 0);
});

test("rapid repeated clicks share one recovery and do not hide the new toolbar", async () => {
  const { handlers, calls, injections } = setup(false, missingScript());
  await Promise.all([handlers.click({ id: 7 }), handlers.click({ id: 7 })]);
  assert.equal(injections.length, 1);
  assert.deepEqual(calls.map(call => call[1].type), ["ae:toggle", "ae:show"]);
});

test("a successful retry clears the previous failure badge and tooltip", async () => {
  let fail = true;
  const { handlers, badges, titles } = setup(false, {
    sendMessage: async () => { if (fail) throw new Error("No receiver"); return { ok: true }; },
    executeScript: async () => { throw new Error("No access"); },
  });
  await handlers.click({ id: 7 });
  fail = false;
  await handlers.click({ id: 7 });
  assert.deepEqual(badges.map(value => value.text), ["!", ""]);
  assert.equal(titles.at(-1).title, "Toggle Annotate & Edit toolbar");
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
