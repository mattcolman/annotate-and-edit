/**
 * Real-extension startup recovery test. Requires recent Chrome for Testing.
 * Uses a disposable profile and a copy of the extension with static injection
 * removed, leaving the production permissions intact. Actual action clicks
 * must grant activeTab and load the UI; no shim or extra host access is used.
 *
 * AE_CHROME="/path/to/Chrome for Testing" node tools/startup-smoke.mjs [URL ...]
 * Default: the demo on localhost:8000. GitHub can be passed as an online check.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

if (!process.env.AE_CHROME) throw new Error("Set AE_CHROME to a recent Chrome for Testing executable.");
const urls = process.argv.slice(2);
if (!urls.length) urls.push("http://localhost:8000/index.html");
const root = mkdtempSync(join(tmpdir(), "ae-startup-"));
const extension = join(root, "extension"), profile = join(root, "profile");
cpSync(new URL("../extension/", import.meta.url), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
delete manifest.content_scripts;
writeFileSync(join(extension, "manifest.json"), JSON.stringify(manifest));
const chrome = spawn(process.env.AE_CHROME, [
  "--headless=new", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "about:blank",
], { stdio: "ignore" });
let launchError;
chrome.on("error", error => { launchError = error; });

async function until(test, label) {
  for (let i = 0; i < 150; i++) {
    if (launchError) throw launchError;
    try { const result = await test(); if (result) return result; } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

let browser, page, checks = 0;
function check(label, condition) {
  assert.ok(condition, label);
  checks++;
  console.log(`PASS  ${label}`);
}

try {
  const port = await until(() => readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0], "Chrome startup");
  const info = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
  browser = await connect(info.webSocketDebuggerUrl);
  const loaded = await until(async () => (await browser.send("Extensions.getExtensions")).extensions.find(e => e.name === manifest.name), "extension load");
  assert.equal(realpathSync(loaded.path), realpathSync(extension), "Only the disposable extension copy may be tested");
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  page = await connect(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  async function evaluate(expression) {
    const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function clickAction() {
    const { targetInfos } = await browser.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
    assert.equal(targetInfos.length, 1, "Only the disposable test tab may receive clicks");
    await browser.send("Extensions.triggerAction", { id: loaded.id, targetId: targetInfos[0].targetId });
    await sleep(100);
  }
  const host = "document.querySelector('annotate-edit')";
  const shadow = `${host}.shadowRoot`;
  for (const url of urls) {
    console.log(`Testing ${url}`);
    await page.send("Page.navigate", { url });
    await until(() => evaluate("document.readyState === 'complete'"), "page load");
    check("automatic injection is absent", await evaluate(`!${host}`));
    // Exercise the case that previously would immediately hide a recovered UI.
    await evaluate("sessionStorage.setItem('__ae_ui', '1')");
    await clickAction();
    await until(() => evaluate(`${host}?.style.display === 'contents'`), "recovered toolbar");
    check("icon click recovers and shows the toolbar", true);
    check("only one toolbar is installed", await evaluate("document.querySelectorAll('annotate-edit').length === 1"));
    await clickAction();
    await until(() => evaluate(`${host}?.style.display === 'none'`), "toggle off");
    check("next click hides the toolbar", true);
    await clickAction();
    await until(() => evaluate(`${host}?.style.display === 'contents'`), "toggle on");
    await evaluate(`${host}.remove()`);
    await clickAction();
    await until(() => evaluate(`${host}?.style.display === 'contents'`), "reattached toolbar");
    check("click restores UI removed by the page", true);
    await evaluate(`${shadow}.querySelector('[data-act="annotate"]').click();
      document.querySelector('h1').click();
      ${shadow}.querySelector('#note-text').value = 'Startup recovery test';
      ${shadow}.querySelector('[data-act="note-save"]').click();`);
    const origin = new URL(url).origin;
    let stored;
    await until(async () => {
      const { data } = await browser.send("Extensions.getStorageItems", { id: loaded.id, storageArea: "local", keys: [`ae:${origin}`] });
      stored = data;
      return Object.values(data[`ae:${origin}`]?.pages || {}).some(p => p.notes.some(n => n.note === "Startup recovery test"));
    }, "saved annotation").catch(error => { throw new Error(`${error.message}: ${JSON.stringify(stored)}`); });
    check("recovered toolbar persists an annotation", true);
  }
  console.log(`${checks}/${checks} checks passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  page?.close(); browser?.close();
  chrome.kill("SIGKILL");
  if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) await new Promise(resolve => chrome.once("exit", resolve));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
