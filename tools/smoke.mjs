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

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9338;
const EXT_DIR = new URL("../extension/", import.meta.url).pathname;
const PAGE = "http://localhost:8000/index.html";

const contentSrc = readFileSync(join(EXT_DIR, "content.js"), "utf8");

/* Minimal chrome.* stub; storage backed by localStorage so it survives
   reloads like the real thing. */
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

const profile = mkdtempSync(join(tmpdir(), "ae-smoke-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let msgId = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, 10000);
  });

async function evalJs(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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

const HOST = `document.querySelector('annotate-edit')`;
const SHADOW = `${HOST}.shadowRoot`;
const clickSel = (sel) => `${SHADOW}.querySelector('${sel}').click()`;
const markerCount = `${SHADOW}.querySelectorAll('#overlay .marker').length`;
const badgeCount = `${SHADOW}.querySelectorAll('#overlay .ebadge').length`;

try {
  await connect();
  await send("Page.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${CHROME_STUB}\n${contentSrc}`,
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
  const stored = await evalJs(
    `JSON.parse(localStorage.getItem('__ae_store'))['ae:' + location.origin]`,
  );
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
  } catch {}
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
