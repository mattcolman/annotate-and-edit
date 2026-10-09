/* Reproduce: do edits apply live on the real Astro dev site (:4322)? */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9340;
const EXT_DIR = new URL("../extension/", import.meta.url).pathname;
const PAGE = "http://localhost:4322/services";
const contentSrc = readFileSync(join(EXT_DIR, "content.js"), "utf8");

const CHROME_STUB = `
window.chrome = {
  runtime: { onMessage: { addListener() {} }, getURL: (p) => '/' + p },
  storage: { local: {
    get: (k) => Promise.resolve(JSON.parse(localStorage.getItem('__ae_store') || '{}')),
    set: (o) => {
      const cur = JSON.parse(localStorage.getItem('__ae_store') || '{}');
      Object.assign(cur, o);
      localStorage.setItem('__ae_store', JSON.stringify(cur));
      return Promise.resolve();
    },
  }},
};`;

const profile = mkdtempSync(join(tmpdir(), "ae-dbg-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
   "--no-first-run", "--no-default-browser-check", "about:blank"],
  { stdio: "ignore" },
);

let ws; let msgId = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); } }, 15000);
});
async function evalJs(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails)
    throw new Error(`eval failed: ${JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text)}`);
  return res.result?.result?.value;
}
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = targets.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m); }
        });
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("no CDP");
}

const SHADOW = `document.querySelector('annotate-edit').shadowRoot`;
const clickSel = (sel) => `${SHADOW}.querySelector('${sel}').click()`;

try {
  await connect();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_STUB + "\n" + contentSrc });
  await send("Page.navigate", { url: PAGE });
  await sleep(3500);

  // enable UI (off by default)
  await evalJs(`sessionStorage.setItem('__ae_ui','1'); location.reload()`);
  await sleep(3500);

  // find an editable target and its text
  const target = await evalJs(`(() => {
    const cands = [...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.trim().length > 20);
    const el = cands[0];
    if (!el) return null;
    return { tag: el.tagName, text: el.innerText.trim().slice(0, 80) };
  })()`);
  console.log("target:", JSON.stringify(target));
  if (!target) throw new Error("no target");

  // measure mutation rate for 3s BEFORE any edit
  const mutations = await evalJs(`new Promise((res) => {
    let n = 0;
    const o = new MutationObserver((l) => { n += l.length; });
    o.observe(document.documentElement, { childList:true, subtree:true, characterData:true, attributes:true });
    setTimeout(() => { o.disconnect(); res(n); }, 3000);
  })`);
  console.log(`mutations over 3s: ${mutations}`);

  // enter edit mode, pick the target, change it, save
  await evalJs(clickSel('[data-act="edit"]'));
  await sleep(200);
  const picked = await evalJs(`(() => {
    const cands = [...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.trim().length > 20);
    const el = cands[0];
    const r = el.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+10, clientY:r.top+10}));
    el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10}));
    return el.getAttribute('contenteditable');
  })()`);
  await sleep(300);
  console.log("contenteditable set:", picked);
  await evalJs(`(() => {
    const cands = [...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.trim().length > 20);
    cands[0].innerText = cands[0].innerText.trim() + ' [AE-EDIT]';
    ${clickSel('[data-act="edit-save"]')}
  })()`);
  await sleep(500);
  const storedInfo = await evalJs(`(() => {
    const site = JSON.parse(localStorage.getItem('__ae_store'))['ae:' + location.origin];
    const keys = Object.keys(site.pages);
    const edits = keys.flatMap(k => site.pages[k].edits);
    return { keys, editCount: edits.length, firstSelector: edits[0]?.selector, oldText: edits[0]?.oldText?.slice(0,60) };
  })()`);
  console.log("stored:", JSON.stringify(storedInfo));
  const textAfter = await evalJs(`(() => {
    const cands = [...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.includes('[AE-EDIT]'));
    return cands.length;
  })()`);
  console.log("elements showing edit now:", textAfter);

  // reload — does the edit reapply?
  await send("Page.navigate", { url: PAGE });
  await sleep(4000);
  const afterReload = await evalJs(`(() => ({
    applied: [...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.includes('[AE-EDIT]')).length,
    uiOn: ${SHADOW} ? ${SHADOW}.querySelector('#toolbar') !== null : false,
  }))()`);
  console.log("after reload:", JSON.stringify(afterReload));

  // wait 3 more seconds in case the observer is just starved/slow
  await sleep(3000);
  const later = await evalJs(`[...document.querySelectorAll('h1,h2,p')].filter(e => e.innerText.includes('[AE-EDIT]')).length`);
  console.log("applied after +3s:", later);

  // mutations per 3s on idle page (is the observer starved?)
  const churn = await evalJs(`new Promise((res) => {
    let n = 0;
    const o = new MutationObserver((l) => { n += l.length; });
    o.observe(document.documentElement, { childList:true, subtree:true, characterData:true, attributes:true });
    setTimeout(() => { o.disconnect(); res(n); }, 3000);
  })`);
  console.log(`idle mutation churn over 3s: ${churn}`);
} catch (e) {
  console.error("ERROR:", e.message);
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
