/**
 * Capture the Chrome Web Store promo tiles in headless Chrome.
 *
 * Usage: node tools/promo.mjs
 * Output: screenshots/promo-tile-440x280.png
 *         screenshots/promo-marquee-1400x560.png
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9340;

const root = new URL("..", import.meta.url).pathname;
const TILES = [
  { html: "assets/promo-tile.html", w: 440, h: 280, out: "screenshots/promo-tile-440x280.png" },
  { html: "assets/promo-marquee.html", w: 1400, h: 560, out: "screenshots/promo-marquee-1400x560.png" },
];

const profile = mkdtempSync(join(tmpdir(), "ae-promo-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--force-device-scale-factor=1",
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

try {
  await connect();
  await send("Page.enable");
  for (const t of TILES) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: t.w,
      height: t.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: "file://" + resolve(root, t.html) });
    await sleep(1200);
    const res = await send("Page.captureScreenshot", { format: "png" });
    const out = resolve(root, t.out);
    writeFileSync(out, Buffer.from(res.result.data, "base64"));
    console.log(`wrote ${out}`);
  }
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
