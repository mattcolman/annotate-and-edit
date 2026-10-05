/**
 * Capture Chrome Web Store screenshots (1280x800) of the extension UI on the
 * demo site. Uses the same CDP injection approach as tools/smoke.mjs — Chrome
 * 137+ ignores --load-extension, so content.js is injected with a chrome.* stub.
 *
 * Usage: node tools/screenshots.mjs   (expects demo server on :8000)
 * Output: screenshots/01-*.png … 05-*.png at exactly 1280x800.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9339;
const W = 1280;
const H = 800;
const EXT_DIR = new URL("../extension/", import.meta.url).pathname;
const OUT_DIR = new URL("../screenshots/", import.meta.url).pathname;
const PAGE = "http://localhost:8000/index.html";

const contentSrc = readFileSync(join(EXT_DIR, "content.js"), "utf8");
const logoDataUri =
  "data:image/png;base64," +
  readFileSync(join(EXT_DIR, "icons/icon48.png")).toString("base64");

/* Minimal chrome.* stub; storage backed by localStorage. getURL returns the
   real icon as a data URI since extension files aren't reachable from the page. */
const CHROME_STUB = `
window.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getURL: () => '${logoDataUri}',
  },
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

const profile = mkdtempSync(join(tmpdir(), "ae-shots-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const path = join(OUT_DIR, name);
  writeFileSync(path, Buffer.from(res.result.data, "base64"));
  console.log(`wrote ${path}`);
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
const pick = (sel) => `(() => {
  const el = document.querySelector('${sel}');
  const r = el.getBoundingClientRect();
  document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:r.left+10, clientY:r.top+10}));
  el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+10, clientY:r.top+10}));
})()`;

try {
  await connect();
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${CHROME_STUB}\n${contentSrc}`,
  });
  await send("Page.navigate", { url: PAGE });
  await sleep(2000);
  mkdirSync(OUT_DIR, { recursive: true });

  // --- stage 1: a saved pin on the h1, then the note editor open on the CTA
  await evalJs(clickSel('[data-act="annotate"]'));
  await sleep(150);
  await evalJs(pick("h1"));
  await sleep(150);
  await evalJs(`(() => {
    ${SHADOW}.querySelector('#note-text').value = 'Can we make this punchier? Shorter and more client-focused.';
    ${clickSel('[data-act="note-save"]')}
  })()`);
  await sleep(300);
  await evalJs(pick(".cta"));
  await sleep(200);
  await evalJs(
    `${SHADOW}.querySelector('#note-text').value = 'This button should be more prominent — maybe full width on mobile?'`,
  );
  await shot("01-annotate.png");

  // --- stage 2: live edit in progress on the h1 — outlined, new text,
  //     caret placed as if mid-typing
  await evalJs(clickSel('[data-act="note-cancel"]'));
  await sleep(150);
  await evalJs(clickSel('[data-act="annotate"]')); // annotate off
  await sleep(100);
  await evalJs(clickSel('[data-act="edit"]'));
  await sleep(150);
  await evalJs(pick("h1"));
  await sleep(200);
  await evalJs(`(() => {
    const el = document.querySelector('h1');
    el.innerText = 'We design websites clients actually love';
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  })()`);
  await sleep(200);
  await shot("02a-edit-typing.png");

  // --- stage 2b: save the h1 edit, edit the lede too — two EDITED badges
  await evalJs(clickSel('[data-act="edit-save"]'));
  await sleep(400);
  await evalJs(pick(".lede"));
  await sleep(200);
  await evalJs(
    `document.querySelector('.lede').innerText = 'We\\u2019re a small studio that designs and builds websites clients are proud to share.'`,
  );
  await evalJs(clickSel('[data-act="edit-save"]'));
  await sleep(400);
  await evalJs(clickSel('[data-act="edit"]')); // edit mode off
  await sleep(150);
  await shot("02b-edit-badges.png");

  // --- stage 2c: open the first badge — view popup shows the from/to diff
  await evalJs(`${SHADOW}.querySelectorAll('#overlay .ebadge')[0].click()`);
  await sleep(400);
  await shot("02c-edit-diff.png");
  await evalJs(clickSel('[data-act="view-close"]'));
  await sleep(150);

  // --- stage 3: saved markings — pin + edited badge + toolbar
  await shot("03-markings.png");

  // --- stage 4: notes panel with the note + edit listed
  await evalJs(clickSel('[data-act="panel"]'));
  await sleep(400);
  await shot("04-panel.png");

  // --- stage 5: copy for agent — copied state + toast
  await evalJs(clickSel('[data-act="copy"]'));
  await sleep(400);
  await shot("05-copy.png");
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
