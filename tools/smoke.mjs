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
  await evalJs(`(() => {
    document.querySelector('.lede').innerText = 'Smoke edited lede — replacement copy.';
    ${clickSel('[data-act="edit-save"]')}
  })()`);
  await sleep(300);
  check("edit badge rendered", (await evalJs(badgeCount)) >= 1);

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
