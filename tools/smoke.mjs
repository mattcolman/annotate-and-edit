/**
 * Headless smoke test for the Annotate & Edit extension.
 *
 * Chrome 137+ branded builds ignore --load-extension, so instead of loading
 * the real extension this injects content.js into the page via CDP's
 * addScriptToEvaluateOnNewDocument, behind a tiny chrome.* stub backed by
 * localStorage. That exercises the entire UI layer — annotate, edit, click
 * interception, persistence across reloads — in the real DOM.
 *
 * Usage: node tools/smoke.mjs   (expects demo server on :8000 — see README)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = process.env.AE_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REAL_EXTENSION = process.env.AE_REAL_EXTENSION === "1";
const PORT = 9338;
const EXT_DIR = new URL("../extension/", import.meta.url).pathname;
const PAGE = "http://localhost:8000/index.html";

const contentSrc = readFileSync(join(EXT_DIR, "content.js"), "utf8");
const backgroundSrc = readFileSync(join(EXT_DIR, "background.js"), "utf8");

/* Minimal chrome.* stub; storage backed by localStorage so it survives
   reloads like the real thing. */
const CHROME_STUB = readFileSync(new URL("chrome-test-shim.js", import.meta.url), "utf8") +
  `\nif (window === window.top) { ((chrome) => { ${backgroundSrc}\n })(window.__aeBackgroundChrome); }`;

const profile = mkdtempSync(join(tmpdir(), "ae-smoke-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...(REAL_EXTENSION ? [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`] : []),
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let workerWs;
let msgId = 0;
const pending = new Map();
const contexts = new Map();

const send = (method, params = {}, socket = ws) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 10000);
  });

async function evalJs(expression, contextId, socket = ws) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...(contextId ? { contextId } : {}),
  }, socket);
  if (res.result?.exceptionDetails) {
    throw new Error(
      `eval failed: ${JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text)}`,
    );
  }
  return res.result?.result?.value;
}

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) =>
        r.json(),
      );
      const page = targets.find((t) => t.type === "page");
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          if (m.method === "Runtime.executionContextCreated" && m.params.context.auxData?.isDefault) {
            contexts.set(m.params.context.auxData.frameId, m.params.context.id);
          }
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            m.error ? p.reject(new Error(m.error.message)) : p.resolve(m);
          }
        });
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error("could not connect to Chrome DevTools");
}

async function connectWorker() {
  for (let i = 0; i < 40; i++) {
    const targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
    const workers = targets.filter(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"));
    for (const worker of workers) {
      workerWs = new WebSocket(worker.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        workerWs.addEventListener("open", resolve, { once:true });
        workerWs.addEventListener("error", reject, { once:true });
      });
      workerWs.addEventListener("message", ({ data }) => {
        const m = JSON.parse(data);
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m); }
      });
      await send("Runtime.enable", {}, workerWs);
      const name = await evalJs(`chrome.runtime.getManifest().name`, undefined, workerWs);
      if (name === "Annotate & Edit") {
        console.log("Loaded extension:", name);
        return;
      }
      workerWs.close();
    }
    await sleep(100);
  }
  throw new Error("Extension service worker did not load; use Chrome for Testing with AE_CHROME");
}

const evalBackground = (expression) => evalJs(expression, undefined, workerWs);

const HOST = `document.querySelector('annotate-edit')`;
const SHADOW = `${HOST}.shadowRoot`;
const clickSel = (sel) => `${SHADOW}.querySelector('${sel}').click()`;
const markerCount = `${SHADOW}.querySelectorAll('#overlay .marker').length`;
const badgeCount = `${SHADOW}.querySelectorAll('#overlay .ebadge').length`;

async function evalFrame(name, expression) {
  const { result } = await send("Page.getFrameTree");
  function find(node) {
    if (node.frame.name === name) return node.frame.id;
    for (const child of node.childFrames || []) {
      const found = find(child);
      if (found) return found;
    }
  }
  const context = contexts.get(find(result.frameTree));
  if (!context) throw new Error(`No execution context for frame ${name}`);
  return evalJs(expression, context);
}

const addNote = (text) => `(() => {
  document.querySelector('h1').click();
  ${SHADOW}.querySelector('#note-text').value = ${JSON.stringify(text)};
  ${clickSel('[data-act="note-save"]')};
})()`;
const getStored = () => REAL_EXTENSION
  ? evalBackground(`chrome.storage.local.get('ae:http://localhost:8000').then(s => s['ae:http://localhost:8000'])`)
  : evalJs(`JSON.parse(localStorage.getItem('__ae_store'))['ae:' + location.origin]`);
const toggleExtension = () => REAL_EXTENSION
  ? evalBackground(`chrome.tabs.query({active:true,currentWindow:true}).then(tabs => toggle(tabs[0].id))`)
  : evalJs(`window.__aeTestToggle()`);

try {
  await connect();
  if (REAL_EXTENSION) await connectWorker();
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: REAL_EXTENSION
      ? `window.__aeTestErrors = []; addEventListener('error', e => window.__aeTestErrors.push(e.message));`
      : `${CHROME_STUB}\n${contentSrc}`,
  });
  if (REAL_EXTENSION) await send("Browser.grantPermissions", {
    origin: "http://localhost:8000", permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await send("Page.navigate", { url: PAGE });
  await sleep(2000);

  // 0. off by default: host exists but hidden until the user toggles on
  check(
    "UI hidden by default",
    (await evalJs(`${HOST} && ${HOST}.style.display`)) === "none",
  );
  await evalJs(`sessionStorage.setItem('__ae_ui','1')`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
  check(
    "UI visible after toggle-on survives reload",
    (await evalJs(`${HOST} && ${HOST}.style.display`)) === "contents",
  );

  // 1. toolbar injected
  check(
    "toolbar injected",
    await evalJs(`!!${SHADOW} && !!${SHADOW}.querySelector('#toolbar')`),
  );
  check(
    "toolbar logo is the icon img",
    await evalJs(
      `(() => { const l = ${SHADOW}.querySelector('#toolbar .logo'); return !!l && l.tagName === 'IMG' && l.src.includes('icons/icon48.png'); })()`,
    ),
  );

  // 2. annotate: pick h1, save a note, marker appears
  await evalJs(clickSel('[data-act="annotate"]'));
  await sleep(150);
  await evalJs(`(() => {
    const h1 = document.querySelector('h1');
    const r = h1.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+10, clientY:r.top+10}));
    h1.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10}));
  })()`);
  await sleep(150);
  check(
    "note editor opens on pick",
    await evalJs(`${SHADOW}.querySelector('#note-popup').style.display === 'block'`),
  );
  await evalJs(`(() => {
    ${SHADOW}.querySelector('#note-text').value = 'Smoke test note on the heading';
    ${clickSel('[data-act="note-save"]')}
  })()`);
  await sleep(300);
  check("note marker rendered", (await evalJs(markerCount)) === 1);

  // 3. click interception: on vs off.
  // A bubble-phase page listener records whether the click was already
  // preventDefault'ed by our capture handler (and itself prevents nav).
  await evalJs(`window.__clk = null;
    window.addEventListener('click', (e) => {
      window.__clk = { prevented: e.defaultPrevented };
      e.preventDefault();
    })`);

  // dispatchEvent returns false when preventDefault ran (stopPropagation means
  // the page listener may never even see the event, hence also check __clk).
  const clickLink = `(() => {
    const a = document.querySelector('nav a');
    const r = a.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+5, clientY:r.top+5}));
    window.__clk = null;
    const delivered = a.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+5, clientY:r.top+5}));
    return { delivered, saw: window.__clk };
  })()`;

  const blocked = await evalJs(clickLink);
  check(
    "clicks blocked while annotating",
    blocked.delivered === false || blocked.saw === null || blocked.saw?.prevented === true,
    JSON.stringify(blocked),
  );
  // dismiss the note editor that pick opened on the nav link
  await evalJs(clickSel('[data-act="note-cancel"]'));
  await sleep(100);
  await evalJs(clickSel('[data-act="annotate"]')); // toggle off
  await sleep(150);
  check(
    "clicks pass through when modes off",
    (await evalJs(clickLink))?.saw?.prevented === false,
  );

  // 4. edit mode: rewrite .lede, commit, verify badge
  await evalJs(clickSel('[data-act="edit"]'));
  await sleep(150);
  await evalJs(`(() => {
    const p = document.querySelector('.lede');
    const r = p.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+10, clientY:r.top+10}));
    p.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10}));
  })()`);
  await sleep(150);
  check(
    "edit makes element editable",
    await evalJs(`!!document.querySelector('.lede').getAttribute('contenteditable')`),
  );
  // a click inside the in-progress edit must be contained — links inside an
  // editable element would otherwise navigate away mid-edit
  const insideClick = await evalJs(`(() => {
    const el = document.querySelector('.lede');
    const r = el.getBoundingClientRect();
    window.__clk = null;
    const delivered = el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+12, clientY:r.top+12}));
    return { delivered, saw: window.__clk };
  })()`);
  check(
    "clicks inside active edit are contained",
    insideClick.delivered === false || insideClick.saw === null || insideClick.saw?.prevented === true,
    JSON.stringify(insideClick),
  );
  await evalJs(`(() => {
    document.querySelector('.lede').innerText = 'Smoke edited lede — replacement copy.';
    ${clickSel('[data-act="edit-save"]')}
  })()`);
  await sleep(300);
  check("edit badge rendered", (await evalJs(badgeCount)) >= 1);

  // 4a2. cancel restores the original text and records nothing
  const badgesBeforeCancel = await evalJs(badgeCount);
  await evalJs(`(() => {
    const h2 = document.querySelector('h2');
    const r = h2.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+10, clientY:r.top+10}));
    h2.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10}));
  })()`);
  await sleep(150);
  await evalJs(`document.querySelector('h2').innerText = 'CANCELLED EDIT TEXT'`);
  await evalJs(clickSel('[data-act="edit-cancel"]'));
  await sleep(200);
  check(
    "cancel restores original text",
    !(await evalJs(`document.querySelector('h2').innerText`)).includes("CANCELLED"),
  );
  check(
    "cancel records no edit",
    (await evalJs(badgeCount)) === badgesBeforeCancel,
  );

  // 4a3. mode hotkeys: a/e switch modes (ignored while typing), Esc exits
  const key = (k, target = "document.body") =>
    `${target}.dispatchEvent(new KeyboardEvent('keydown', {key:'${k}', bubbles:true, cancelable:true}))`;
  await evalJs(key("a"));
  await sleep(100);
  check(
    "hotkey a enables annotate",
    await evalJs(`${SHADOW}.querySelector('[data-act="annotate"]').classList.contains('on')`),
  );
  check(
    "mode button animates on toggle",
    (await evalJs(`getComputedStyle(${SHADOW}.querySelector('[data-act="annotate"]')).animationName`)).includes("aeBtnPop"),
  );
  await evalJs(key("e"));
  await sleep(100);
  check(
    "hotkey e switches to edit",
    await evalJs(`${SHADOW}.querySelector('[data-act="edit"]').classList.contains('on')`),
  );
  await evalJs(`(() => {
    const i = document.createElement('input');
    i.id = '__hotkeytest';
    document.body.appendChild(i);
    i.focus();
  })()`);
  await evalJs(key("a", "document.querySelector('#__hotkeytest')"));
  await sleep(100);
  check(
    "hotkey ignored while typing in input",
    await evalJs(`!${SHADOW}.querySelector('[data-act="annotate"]').classList.contains('on') && ${SHADOW}.querySelector('[data-act="edit"]').classList.contains('on')`),
  );
  await evalJs(`document.querySelector('#__hotkeytest').remove()`);
  await evalJs(key("Escape"));
  await sleep(100);
  check(
    "Esc exits pick mode",
    await evalJs(`!${SHADOW}.querySelector('[data-act="edit"]').classList.contains('on')`),
  );

  // 4b. markers visibility toggle hides/shows pins and badges
  await evalJs(clickSel('[data-act="marks"]'));
  await sleep(100);
  check(
    "markers toggle hides overlay",
    (await evalJs(`${SHADOW}.querySelector('#overlay').style.display`)) === "none",
  );
  check(
    "markers toggle shows off state",
    await evalJs(`${SHADOW}.querySelector('[data-act="marks"]').classList.contains('on')`),
  );
  await evalJs(clickSel('[data-act="marks"]'));
  await sleep(100);
  check(
    "markers toggle restores overlay",
    (await evalJs(`${SHADOW}.querySelector('#overlay').style.display`)) !== "none",
  );
  check(
    "markers toggle clears off state",
    !(await evalJs(`${SHADOW}.querySelector('[data-act="marks"]').classList.contains('on')`)),
  );

  // 4c. panel open shifts the toolbar clear of the drawer
  await evalJs(clickSel('[data-act="panel"]'));
  await sleep(150);
  check(
    "toolbar clears the panel",
    (await evalJs(`${SHADOW}.querySelector('#toolbar').style.right`)) === "346px",
  );
  check(
    "panel header buttons stay in bounds",
    await evalJs(`(() => {
      const p = ${SHADOW}.querySelector('#panel').getBoundingClientRect();
      const b = ${SHADOW}.querySelector('#panel .hbtns').getBoundingClientRect();
      return b.right <= p.right + 0.5 && b.left >= p.left;
    })()`),
  );
  await evalJs(clickSel('[data-act="panel-close"]'));
  await sleep(150);

  // 5. copy button down-state + toast anchored above the footer
  await evalJs(clickSel('[data-act="panel"]'));
  await sleep(150);
  await evalJs(clickSel('[data-act="copy"]'));
  await sleep(200);
  check(
    "copy button shows copied state",
    await evalJs(`${SHADOW}.querySelector('[data-act="copy"]').classList.contains('copied')`),
  );
  const toastBox = await evalJs(
    `(() => { const t = ${SHADOW}.querySelector('#toast'); return { right: t.style.right, bottom: parseFloat(t.style.bottom), shown: t.classList.contains('show') }; })()`,
  );
  check("toast anchored above panel footer", toastBox.right === "14px" && toastBox.bottom > 60);
  check("toast animates in", toastBox.shown);

  // 5b. per-note copy button toasts and doesn't disturb the copied gate state
  await evalJs(`${SHADOW}.querySelector('[data-act="note-copy"]').click()`);
  await sleep(250);
  check(
    "note copy button toasts",
    (await evalJs(`${SHADOW}.querySelector('#toast').textContent`)).includes("Note copied"),
  );
  await evalJs(clickSel('[data-act="panel-close"]'));
  await sleep(150);

  // 6. toolbar drag: pointerdown on the logo area, drag left 200px
  await evalJs(`(() => {
    const tb = ${SHADOW}.querySelector('#toolbar');
    const logo = tb.querySelector('.logo');
    const r = logo.getBoundingClientRect();
    logo.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:r.left+4, clientY:r.top+4}));
    window.dispatchEvent(new PointerEvent('pointermove', {clientX:r.left-200, clientY:r.top+4}));
    window.dispatchEvent(new PointerEvent('pointerup'));
  })()`);
  await sleep(150);
  check(
    "toolbar is draggable",
    parseFloat(await evalJs(`${SHADOW}.querySelector('#toolbar').style.right`)) >= 200,
  );

  // 7. persistence across a real reload
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);
  check(
    "toolbar survives reload",
    await evalJs(`!!${SHADOW} && !!${SHADOW}.querySelector('#toolbar')`),
  );
  check(
    "edit re-applied after reload",
    (
      (await evalJs(`document.querySelector('.lede')?.innerText || ''`)) || ""
    ).includes("Smoke edited lede"),
  );
  check(
    "note marker survives reload",
    (await evalJs(markerCount)) === 1,
  );

  // 8. complete review: gated until the latest changes are copied
  await evalJs(clickSel('[data-act="panel"]'));
  await sleep(200);
  // dirty the working set after the earlier copy — toggling a note resolved
  await evalJs(`${SHADOW}.querySelector('[data-act="note-done"]').click()`);
  await sleep(250);
  check(
    "complete review locked before copy",
    await evalJs(`${SHADOW}.querySelector('[data-act="complete-review"]').classList.contains('locked')`),
  );
  await evalJs(clickSel('[data-act="complete-review"]')); // blocked — nothing copied
  await sleep(150);
  await evalJs(clickSel('[data-act="copy"]'));           // copy unlocks it
  await sleep(200);
  check(
    "complete review unlocked after copy",
    !(await evalJs(`${SHADOW}.querySelector('[data-act="complete-review"]').classList.contains('locked')`)),
  );
  await evalJs(clickSel('[data-act="complete-review"]')); // single click archives
  await sleep(400);
  const stored = await getStored();
  check(
    "review archived with items",
    stored.reviews?.length === 1 &&
      stored.reviews[0].n === 1 &&
      stored.reviews[0].notes.length === 1 &&
      stored.reviews[0].edits.length === 1,
  );
  check("working set cleared after review", Object.keys(stored.pages).length === 0);
  check("next review numbered", stored.nextReview === 2);
  check(
    "header tally counts archived changes",
    (await evalJs(`${SHADOW}.querySelector('#tally-n').textContent`)) === "2 changes applied",
  );
  check(
    "copy locked when empty",
    await evalJs(`${SHADOW}.querySelector('[data-act="copy"]').classList.contains('locked')`),
  );
  await evalJs(clickSel('[data-act="history"]'));
  await sleep(200);
  // 8b. Shared toolbar, frame-local picking, storage and export.
  await send("Page.navigate", { url: "http://localhost:8000/frame-host.html" });
  await sleep(1500);
  check(
    "extension activates inside app-sized iframe",
    await evalJs(`!!document.querySelector('#app').contentDocument.querySelector('annotate-edit')`),
  );
  check(
    "small iframe activates without a duplicate toolbar",
    await evalFrame("embed", `!!${HOST} && getComputedStyle(${SHADOW}.querySelector('#toolbar')).display === 'none'`),
  );
  check("app iframe has no duplicate toolbar", await evalFrame("app",
    `getComputedStyle(${SHADOW}.querySelector('#toolbar')).display === 'none'`));
  await evalJs(clickSel('[data-act="annotate"]'));
  await sleep(150);
  await Promise.all([evalFrame("app", addNote("App iframe note")), evalFrame("embed", addNote("Small iframe note"))]);
  await sleep(400);
  let frameStore = await getStored();
  check("concurrent frame notes reach the shared panel", Object.values(frameStore.pages).flatMap(p => p.notes).length === 2);
  check("frame note stays out of the outer document", (await evalJs(markerCount)) === 0);
  check("frame has its own note marker", (await evalFrame("app", markerCount)) === 1);
  check("shared toolbar count includes both frames", (await evalJs(`${SHADOW}.querySelector('#count').textContent`)) === "2");

  // Added while Annotate is already active; a different port is cross-origin.
  await evalJs(`(() => {
    const frame = document.createElement('iframe');
    frame.name = 'cross'; frame.id = 'cross'; frame.src = 'http://localhost:8001/work.html';
    frame.style.cssText = 'width:390px;height:300px'; document.body.appendChild(frame);
  })()`);
  await sleep(700);
  check("cross-origin frame is isolated from parent DOM", await evalJs(`document.querySelector('#cross').contentDocument === null`));
  check("late narrow frame inherits active mode", await evalFrame("cross", `${SHADOW}.querySelector('[data-act="annotate"]').classList.contains('on')`));
  await evalFrame("cross", addNote("Cross-origin iframe note"));
  await evalFrame("app", `(() => {
    const frame = document.createElement('iframe'); frame.name = 'nested';
    frame.src = '/work.html'; frame.style.cssText = 'width:350px;height:240px'; document.body.appendChild(frame);
  })()`);
  await sleep(700);
  await evalFrame("nested", addNote("Nested iframe note"));
  await sleep(300);
  frameStore = await getStored();
  const allFrameNotes = Object.values(frameStore.pages).flatMap(p => p.notes);
  check("same URL in nested and sibling frames has separate storage", allFrameNotes.length === 4 && new Set(allFrameNotes.map(n => n.page)).size === 4);
  check("nested frame path is recorded", allFrameNotes.some(n => n.note === "Nested iframe note" && n.framePath === "0/0"));
  check("frame URL is recorded", allFrameNotes.some(n => n.frameUrl === "http://localhost:8001/work.html"));

  await evalFrame("cross", `document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`);
  await sleep(150);
  check("Escape in a frame exits mode in every document", await evalJs(`!${SHADOW}.querySelector('[data-act="annotate"]').classList.contains('on')`) && await evalFrame("app", `!${SHADOW}.querySelector('[data-act="annotate"]').classList.contains('on')`));
  await evalJs(clickSel('[data-act="edit"]'));
  await sleep(150);
  const originalFrameText = await evalFrame("app", `document.querySelector('.lede').innerText`);
  await evalFrame("app", `document.querySelector('.lede').click(); document.querySelector('.lede').innerText = 'Edited inside the iframe'`);
  if (!REAL_EXTENSION) await evalJs(`Object.defineProperty(navigator, 'clipboard', { configurable:true, value: {writeText: async (text) => {window.__aeCopied = text;}}})`);
  await evalJs(clickSel('[data-act="panel"]'));
  if (REAL_EXTENSION) {
    await send("Page.bringToFront");
    const point = await evalJs(`(() => { const r = ${SHADOW}.querySelector('[data-act="copy"]').getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
    await send("Input.dispatchMouseEvent", {type:"mousePressed", ...point, button:"left", clickCount:1});
    await send("Input.dispatchMouseEvent", {type:"mouseReleased", ...point, button:"left", clickCount:1});
  } else {
    await evalJs(clickSel('[data-act="copy"]'));
  }
  await sleep(400);
  const copiedFrames = await evalJs(REAL_EXTENSION ? `navigator.clipboard.readText()` : `window.__aeCopied || ''`);
  check("Copy for agent saves an unfinished frame edit", copiedFrames.includes("Edited inside the iframe"));
  check("shared export includes all four frame notes", allFrameNotes.every(n => copiedFrames.includes(n.note)));
  check("export includes frame URL and path", copiedFrames.includes("**Frame URL:** http://localhost:8001/work.html") && copiedFrames.includes("**Frame path:** 0/0"));

  await send("Page.reload", { ignoreCache: true });
  await sleep(1400);
  check("frame edit persists across outer-page reload", (await evalFrame("app", `document.querySelector('.lede').innerText`)) === "Edited inside the iframe");
  check("frame note persists across outer-page reload", (await evalFrame("app", markerCount)) === 1);
  await evalJs(clickSel('[data-act="panel"]'));
  await evalJs(`${SHADOW}.querySelector('[data-act="edit-revert"]').click()`);
  await sleep(300);
  check("Revert in shared panel restores the iframe DOM", (await evalFrame("app", `document.querySelector('.lede').innerText`)) === originalFrameText);
  const appNote = allFrameNotes.find(n => n.note === "App iframe note");
  await evalJs(`${SHADOW}.querySelector('[data-act="note-del"][data-id="${appNote.id}"]').click()`);
  await sleep(300);
  check("Delete in shared panel removes the iframe marker", (await evalFrame("app", markerCount)) === 0);
  await toggleExtension();
  await sleep(150);
  check("extension toggle hides top and child UI", (await evalJs(`${HOST}.style.display`)) === 'none' && (await evalFrame("app", `${HOST}.style.display`)) === 'none');
  await toggleExtension();
  await sleep(150);
  check("extension toggle restores one toolbar", (await evalJs(`${HOST}.style.display`)) === 'contents' && (await evalFrame("app", `getComputedStyle(${SHADOW}.querySelector('#toolbar')).display`)) === 'none');
  check("no runtime errors in top or frame", (await evalJs(`window.__aeTestErrors.length`)) === 0 && (await evalFrame("app", `window.__aeTestErrors.length`)) === 0);

  await evalJs(clickSel('[data-act="annotate"]'));
  await sleep(100);
  await evalFrame("app", `history.pushState({}, '', '/virtual-frame-route')`);
  await sleep(650);
  await evalFrame("app", addNote("Frame SPA route note"));
  await sleep(300);
  frameStore = await getStored();
  check("frame SPA navigation updates the saved URL", Object.values(frameStore.pages).flatMap(p => p.notes).some(n => n.note === "Frame SPA route note" && n.frameUrl.endsWith('/virtual-frame-route')));
  await evalFrame("app", `history.pushState({}, '', '/index.html')`);
  await sleep(650);
  check("frame SPA notes do not leak to its previous route", (await evalFrame("app", markerCount)) === 0);
  await evalJs(`(() => {
    const f = document.createElement('iframe'); f.name = 'inline';
    f.srcdoc = '<h1>Inline frame heading</h1>'; f.style.cssText = 'width:390px;height:300px';
    document.body.appendChild(f);
  })()`);
  await sleep(500);
  await evalFrame("inline", addNote("Srcdoc note"));
  await sleep(250);
  frameStore = await getStored();
  check("srcdoc frame is injected and can save a note", Object.values(frameStore.pages).flatMap(p => p.notes).some(n => n.note === "Srcdoc note" && n.frameUrl === 'about:srcdoc'));
  await evalJs(clickSel('[data-act="marks"]'));
  await sleep(150);
  check("shared marker visibility reaches frames", (await evalFrame("inline", `${SHADOW}.querySelector('#overlay').style.display`)) === 'none');
  await evalJs(clickSel('[data-act="marks"]'));

  // Clearing a review must discard open frame drafts, without recreating them
  // through a delayed frame save or mode change.
  await evalFrame("app", `document.querySelector('h1').click(); ${SHADOW}.querySelector('#note-text').value = 'Discard this draft'`);
  await evalJs(`${clickSel('[data-act="clear-all"]')}; ${clickSel('[data-act="clear-all"]')}`);
  await sleep(350);
  check("Clear all closes frame drafts", (await evalFrame("app", `${SHADOW}.querySelector('#note-popup').style.display`)) === 'none');
  check("Clear all removes saved frame notes", Object.values((await getStored()).pages).flatMap(p => p.notes).length === 0);
  await evalJs(clickSel('[data-act="edit"]'));
  await sleep(150);
  await evalFrame("app", `document.querySelector('.lede').click(); document.querySelector('.lede').innerText = 'Archived iframe edit'; ${clickSel('[data-act="edit-save"]')}`);
  await sleep(250);
  await evalJs(clickSel('[data-act="copy"]'));
  await sleep(200);
  await evalJs(clickSel('[data-act="complete-review"]'));
  await sleep(350);
  check("completed review archives frame feedback", (await getStored()).reviews.some(r => r.edits.some(e => e.newText === 'Archived iframe edit' && e.frameUrl)));
  check("completed review keeps the visible iframe edit", (await evalFrame("app", `document.querySelector('.lede').innerText`)) === 'Archived iframe edit');
  check("completed frame review starts with no markers", (await evalFrame("app", badgeCount)) === 0);
  await send("Page.navigate", { url: PAGE });
  await sleep(1500);

  // 9. XML documents (rss feeds etc.) must not crash the content script
  await send("Page.navigate", { url: "http://localhost:8000/feed.xml" });
  await sleep(1200);
  check(
    "skips XML documents without throwing",
    (await evalJs(`document instanceof HTMLDocument`)) === false &&
      (await evalJs(`!!document.querySelector('annotate-edit')`)) === false,
  );
  await send("Page.navigate", { url: PAGE });
  await sleep(1200);
  await evalJs(clickSel('[data-act="panel"]'));
  await sleep(200);
  await evalJs(clickSel('[data-act="history"]'));
  await sleep(200);

  check(
    "history lists completed review",
    (await evalJs(`${SHADOW}.querySelector('#panel-body').textContent`)).includes("Review #1"),
  );
} catch (err) {
  check("run completed", false, err.message);
} finally {
  try {
    ws?.close();
    workerWs?.close();
  } catch {}
  chrome.kill("SIGKILL");
  await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
