/**
 * Annotate & Edit — content script.
 *
 * Injected into every http(s) page. Adds a floating toolbar (all UI lives in a
 * single shadow root so page styles can't leak in or out) with two modes:
 *
 *   - Annotate: click an element, leave a note pinned to it.
 *   - Edit:     click a text element, rewrite it in place. Edits are stored
 *               locally and re-applied on every page load / SPA navigation.
 *
 * "Copy for agent" renders every note and edit for this origin as one markdown
 * document — selectors + quoted text let an AI coding agent find each spot in
 * the codebase. No network calls, no accounts, nothing leaves the browser.
 */
(() => {
  if (window.__annotateEditLoaded) return;
  window.__annotateEditLoaded = true;
  // Content scripts also run on XML feeds/SVG docs — no DOM to annotate there.
  if (!(document instanceof HTMLDocument)) return;
  // Every frame handles its own DOM; only the top document owns the toolbar,
  // panel and storage. Never infer eligibility from a frame's pixel size.
  const isTop = window === window.top;
  const session = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch {} },
  };
  const HOST_TAG = "annotate-edit";
  const STORE_PREFIX = "ae:";
  /* Tags whose text can be rewritten inline, and the inline children allowed
     inside one (anything nested deeper means "leave a note"). */
  const EDITABLE_TAGS = new Set([
    "H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "DT", "DD",
    "BLOCKQUOTE", "FIGCAPTION", "SPAN", "A", "EM", "STRONG", "B", "I",
    "TIME", "LABEL", "TH", "TD", "CAPTION", "BUTTON", "LEGEND", "SUMMARY",
  ]);
  const INLINE_OK = new Set([
    "A", "EM", "STRONG", "B", "I", "BR", "CODE", "SPAN", "SMALL",
    "SUP", "SUB", "U", "MARK", "TIME", "ABBR", "WBR", "S", "KBD", "Q",
  ]);
  const EDITABLE_SELECTOR = [...EDITABLE_TAGS].join(",");

  // ------------------------------------------------------------------ utils

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  /* Canonical page key: /index.html == /, and trailing slashes collapse, so
     the same document always maps to one bucket of notes/edits. */
  const canonPath = (p) =>
    p.replace(/\/index\.html?$/i, "/").replace(/(.+)\/$/, "$1") || "/";
  const localPageKey = () => canonPath(location.pathname) + location.search;
  let framePageKey = null;
  const pageKey = () => isTop ? localPageKey() : framePageKey || localPageKey();
  const canonicalKey = (key) => {
    if (key.startsWith("frame:")) return key;
    const i = key.indexOf("?");
    return i === -1
      ? canonPath(key)
      : canonPath(key.slice(0, i)) + key.slice(i);
  };
  const storeKey = () => STORE_PREFIX + location.origin;
  const uid = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  /**
   * Selector that survives a rebuild reasonably well: stops at the nearest id,
   * otherwise walks up using :nth-of-type.
   */
  function selectorFor(el) {
    if (!el || el === document.body) return "body";
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 8) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(
            (c) => c.tagName === node.tagName,
          )
        : [];
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`
          : tag,
      );
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  /** Neighbouring visible text, so identical elements can be told apart. */
  function contextFor(el) {
    const text = (n) => norm(n?.innerText || "").slice(0, 80);
    const sib = (n, dir) => {
      for (let s = n[dir]; s; s = s[dir]) {
        const t = text(s);
        if (t) return t;
      }
      return "";
    };
    const prevText =
      sib(el, "previousElementSibling") ||
      sib(el.parentElement || el, "previousElementSibling");
    const nextText =
      sib(el, "nextElementSibling") ||
      sib(el.parentElement || el, "nextElementSibling");
    return { prevText, nextText };
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const text = norm(el.innerText);
    if (tag === "img")
      return `image, ${el.getAttribute("alt") || "no alt text"}`;
    if (!text) return `<${tag}>`;
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }

  /** Only inline-safe subtrees may be edited — nested blocks need a note. */
  function inlineSafe(el) {
    if (!norm(el.innerText || el.textContent)) return false;
    for (const d of el.querySelectorAll("*")) {
      if (!INLINE_OK.has(d.tagName)) return false;
    }
    return true;
  }

  /** Topmost editable ancestor — clicking <strong> in a <p> edits the <p>. */
  function editableTarget(el) {
    let best = null;
    let n = el;
    while (n && n !== document.body && n !== document.documentElement) {
      if (EDITABLE_TAGS.has(n.tagName) && inlineSafe(n)) best = n;
      n = n.parentElement;
    }
    return best;
  }

  // ------------------------------------------------------------------ state

  let site = { v: 1, pages: {}, reviews: [], nextReview: 1, copied: false };
  let mode = "off"; // 'off' | 'annotate' | 'edit'
  // Off by default — the icon click / keyboard shortcut turns it on, and the
  // state persists per tab so a review session survives navigation + reloads.
  let toolbarVisible = isTop && session.get("__ae_ui") === "1";
  let panelOpen = false;
  let hoverEl = null; // element currently under the cursor (pick modes)
  let noteDraft = null; // { el, existing? } while the note editor is open
  let openView = null; // { kind:'note'|'edit', item, el } for popups
  let activeEdit = null; // { el, oldText, oldHTML, selector, ... }

  function pageData(key = pageKey()) {
    if (!site.pages[key]) site.pages[key] = { notes: [], edits: [] };
    return site.pages[key];
  }

  async function loadSite() {
    if (!isTop) return;
    try {
      const r = await chrome.storage.local.get(storeKey());
      const v = r[storeKey()];
      if (v && v.pages) site = v;
      // Older data predates review history.
      site.reviews ??= [];
      site.nextReview ??= site.reviews.length
        ? site.reviews[site.reviews.length - 1].n + 1
        : 1;
      site.copied ??= false;
    } catch {
      /* private mode etc. — session-only data */
    }
    // Merge buckets stored under non-canonical keys (e.g. /index.html vs /).
    let migrated = false;
    for (const [key, data] of Object.entries(site.pages)) {
      const c = canonicalKey(key);
      if (c === key) continue;
      const target = site.pages[c] || (site.pages[c] = { notes: [], edits: [] });
      target.notes.push(...(data.notes || []));
      target.edits.push(...(data.edits || []));
      delete site.pages[key];
      migrated = true;
    }
    if (migrated) save();
  }

  let saveTimer = null;
  function save() {
    if (!isTop) {
      saveFrameChanges();
      return;
    }
    publishFrames();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        chrome.storage.local.set({ [storeKey()]: site }).catch(() => {});
      } catch {
        /* storage unavailable — keep in-memory only */
      }
    }, 150);
  }

  // --------------------------------------------------------------- shadow UI

  const host = document.createElement(HOST_TAG);
  host.style.display = toolbarVisible ? "contents" : "none"; // markers anchor to the document, not us
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; }
  .ae {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #e8eaf0;
    --bg: #17191f;
    --bg2: #1f232b;
    --border: #2e3340;
    --text: #e8eaf0;
    --dim: #9aa3b2;
    --accent: #4f7cff;
    --amber: #f5a524;
    --danger: #e5484d;
    --ok: #30a46c;
  }
  /* Element-level reset stays below .btn specificity so .btn always wins. */
  .ae button {
    font: inherit; color: inherit; cursor: pointer;
  }
  .btn {
    padding: 6px 12px; border-radius: 7px; color: var(--text);
    background: var(--bg2); border: 1px solid var(--border);
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn svg { display: block; }
  .btn:hover { border-color: #475069; }
  .btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.on.amber { background: var(--amber); border-color: var(--amber); color: #17191f; }
  /* Attention pop when a mode activates (click or hotkey) — scales up and
     sheds a fading ring. Only on the mode buttons, not the marks toggle. */
  @keyframes aeBtnPop {
    0% { transform: scale(1); }
    40% { transform: scale(1.14); }
    100% { transform: scale(1); }
  }
  @keyframes aeBtnRing {
    from { box-shadow: 0 0 0 0 var(--ring, rgba(79,124,255,.55)); }
    to { box-shadow: 0 0 0 14px transparent; }
  }
  [data-act="annotate"].on, [data-act="edit"].on {
    animation: aeBtnPop .28s cubic-bezier(.34,1.4,.5,1), aeBtnRing .45s ease-out;
  }
  [data-act="edit"].on { --ring: rgba(245,165,36,.55); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  /* keycap-style shortcut hint inside mode buttons */
  .btn .key {
    font-size: 10px; font-weight: 700; line-height: 1; padding: 4px 5px 2px;
    border-radius: 4px; border: 1px solid var(--border); border-bottom-width: 2px;
    background: var(--bg2, #1e222b); color: var(--dim); text-transform: uppercase;
  }
  .btn.on .key {
    color: #fff; background: rgba(255,255,255,.16);
    border-color: rgba(255,255,255,.4); border-bottom-color: rgba(255,255,255,.55);
  }
  .btn.on.amber .key {
    color: #17191f; background: rgba(0,0,0,.1);
    border-color: rgba(0,0,0,.3); border-bottom-color: rgba(0,0,0,.4);
  }
  .btn.ok { background: var(--ok); border-color: var(--ok); color: #fff; }
  .btn.locked { opacity: .45; cursor: not-allowed; }
  .btn.copied { background: var(--ok); border-color: var(--ok); color: #fff; transition: background .15s; }
  .btn.danger { color: #ff8589; }
  .btn.small { padding: 3px 8px; font-size: 12px; }
  .btn.icon { padding: 6px 8px; display: inline-flex; align-items: center; align-self: stretch; }
  .btn.icon svg { display: block; }

  /* -------- toolbar -------- */
  #toolbar {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    transition: right .15s ease, bottom .15s ease;
    display: flex; align-items: center; gap: 4px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
    padding: 6px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
    cursor: grab; user-select: none;
  }
  #toolbar.dragging { transition: none; cursor: grabbing; }
  #toolbar img.logo {
    width: 22px; height: 22px; display: block;
    margin: 0 5px 0 3px; user-select: none;
  }
  #toolbar .count {
    min-width: 16px; text-align: center; background: var(--bg2);
    border-radius: 8px; padding: 1px 5px; font-size: 11px; color: var(--dim);
    margin-left: 2px;
  }

  /* -------- highlight + markers -------- */
  #highlight {
    position: fixed; pointer-events: none; z-index: 2147483646;
    border: 2px solid var(--accent); border-radius: 3px;
    display: none; transition: top .05s, left .05s, width .05s, height .05s;
  }
  #highlight.edit { border-color: var(--amber); }
  #highlight .tag {
    position: absolute; top: -20px; left: -2px; font-size: 10px;
    background: var(--accent); color: #fff; padding: 1px 6px; border-radius: 4px;
    white-space: nowrap;
  }
  #highlight.edit .tag { background: var(--amber); color: #17191f; }
  #overlay { position: absolute; top: 0; left: 0; pointer-events: none; }
  .marker {
    position: absolute; width: 20px; height: 20px; border-radius: 50%;
    background: var(--accent); color: #fff; font-size: 11px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer;
    border: 2px solid #fff2;
    font-family: -apple-system, system-ui, sans-serif;
  }
  .marker.done { background: #565d6b; opacity: .75; }
  .ebadge {
    position: absolute; transform: translate(-50%, -50%); pointer-events: auto;
    cursor: pointer; background: var(--amber); color: #17191f;
    font-size: 9px; font-weight: 800; letter-spacing: .04em; padding: 1px 5px;
    border-radius: 4px;
    font-family: -apple-system, system-ui, sans-serif; text-transform: uppercase;
  }

  /* -------- popups + pill -------- */
  .popup, #pill {
    position: fixed; z-index: 2147483647;
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px; width: 280px; max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px); overflow: auto;
    box-shadow: 0 10px 32px rgba(0,0,0,.5);
    display: none;
  }
  .popup .title { font-size: 11px; color: var(--dim); margin-bottom: 6px; }
  .popup textarea {
    width: 100%; min-height: 64px; resize: vertical; font: inherit;
    background: var(--bg2); color: var(--text); border: 1px solid var(--border);
    border-radius: 7px; padding: 7px 9px; margin-bottom: 8px;
  }
  .popup textarea:focus { outline: none; border-color: var(--accent); }
  .popup select {
    width: 100%; font: inherit; background: var(--bg2); color: var(--text);
    border: 1px solid var(--border); border-radius: 7px; padding: 5px 7px;
    margin-bottom: 8px;
  }
  .popup .row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
  .popup .note-text { white-space: pre-wrap; margin-bottom: 8px; }
  .popup .diff { font-size: 12px; margin-bottom: 8px; }
  .popup .diff .from { color: #ff9d9d; text-decoration: line-through; }
  .popup .diff .to { color: #8ee2b0; }
  .popup .meta { font-size: 11px; color: var(--dim); margin-bottom: 6px; word-break: break-all; }
  #pill { width: auto; padding: 6px 8px; display: none; align-items: center; gap: 6px; }
  #pill .hint { color: var(--dim); font-size: 12px; margin-right: 4px; }

  /* -------- panel -------- */
  #panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: 330px; z-index: 2147483647;
    background: var(--bg); border-left: 1px solid var(--border);
    display: none; flex-direction: column; box-shadow: -12px 0 40px rgba(0,0,0,.4);
  }
  #panel header {
    padding: 12px 14px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  #panel header > div:first-child { min-width: 0; flex: 1; }
  #panel header b { font-size: 13px; }
  #panel .sub { font-size: 11px; color: var(--dim); overflow-wrap: anywhere; }
  #panel .tally {
    display: flex; align-items: center; gap: 4px; margin-top: 3px;
    font-size: 11px; font-weight: 600; color: var(--ok);
  }
  #panel .hbtns { display: flex; gap: 6px; flex-shrink: 0; }
  #panel details.rev summary {
    cursor: pointer; display: flex; align-items: center; gap: 8px;
    list-style: none;
  }
  #panel details.rev summary::-webkit-details-marker { display: none; }
  #panel details.rev summary::before {
    content: "▸"; color: var(--dim); font-size: 10px; transition: transform .12s;
  }
  #panel details.rev[open] summary::before { transform: rotate(90deg); }
  #panel details.rev[open] summary { margin-bottom: 8px; }
  #panel .revitem { font-size: 12px; color: var(--dim); padding: 4px 0; border-top: 1px solid var(--border); }
  #panel .revitem b { color: var(--text); font-weight: 600; }
  #panel .revsum { font-size: 12px; color: var(--dim); margin-bottom: 10px; }
  #panel-body { flex: 1; overflow-y: auto; padding: 10px 14px 20px; }
  #panel-body h4 {
    margin: 14px 0 6px; font-size: 11px; color: var(--dim);
    text-transform: uppercase; letter-spacing: .06em; overflow-wrap: anywhere;
  }
  .item {
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 9px;
    margin-bottom: 6px; background: var(--bg2);
  }
  .item.done { opacity: .55; }
  .item .head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .item .cat { font-size: 10px; color: var(--accent); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .item .editcat { color: var(--amber); }
  .item .num { color: var(--dim); font-size: 11px; }
  .item .body { margin: 4px 0 6px; white-space: pre-wrap; word-break: break-word; }
  .item .diff { font-size: 12px; margin: 4px 0 6px; }
  .item .diff .from { color: #ff9d9d; text-decoration: line-through; display: block; }
  .item .diff .to { color: #8ee2b0; display: block; }
  .item .actions { display: flex; gap: 4px; }
  .item .stale { color: var(--danger); font-size: 11px; }
  #panel footer {
    padding: 10px 14px; border-top: 1px solid var(--border);
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  }
  #panel footer .full { flex: 1 1 100%; }
  #panel footer .grow { flex: 1; }

  .empty { color: var(--dim); font-size: 12px; padding: 8px 0; }

  /* -------- toast -------- */
  #toast {
    position: fixed; bottom: 70px; right: 16px; width: 302px;
    background: #f2f4f8; border: 1px solid #fff; color: #17191f; font-weight: 500;
    padding: 9px 14px; border-radius: 9px; z-index: 2147483647;
    box-shadow: 0 8px 28px rgba(0,0,0,.5); font-size: 13px;
    opacity: 0; transform: translateY(10px) scale(.96); transform-origin: bottom right;
    transition: opacity .18s ease, transform .18s cubic-bezier(.34,1.4,.5,1),
      right .15s ease, bottom .15s ease;
    pointer-events: none; display: none;
  }
  #toast.show { opacity: 1; transform: none; }
  [hidden] { display: none !important; }
</style>

<div class="ae" id="ui">
  <div id="overlay"></div>
  <div id="highlight"><span class="tag"></span></div>
  <div id="pill">
    <span class="hint"></span>
    <button class="btn small primary" data-act="edit-save">Save</button>
    <button class="btn small" data-act="edit-cancel">Cancel</button>
  </div>
  <div class="popup" id="note-popup">
    <div class="title" id="note-title">Note on <b></b></div>
    <textarea id="note-text" placeholder="What should change here?"></textarea>
    <div class="row">
      <button class="btn small" data-act="note-cancel">Cancel</button>
      <button class="btn small primary" data-act="note-save">Save note</button>
    </div>
  </div>
  <div class="popup" id="view-popup"></div>
  <aside id="panel">
    <header>
      <div>
        <b>Annotate &amp; Edit</b>
        <div class="sub" id="panel-sub"></div>
        <div class="tally" id="tally" style="display:none">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.5l3.5 3.5 7.5-8"/></svg>
          <span id="tally-n"></span>
        </div>
      </div>
      <div class="hbtns">
        <button class="btn small" data-act="history" id="hist-btn">History</button>
        <button class="btn small" data-act="panel-close">Close</button>
      </div>
    </header>
    <div id="panel-body"></div>
    <footer>
      <button class="btn primary full" data-act="copy" title="Copy all notes for a coding agent. Either paste them directly into your coding agent's chat, or send them to the web developer you're working with">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="5.3" y="5.3" width="9.3" height="9.3" rx="1.4"/>
          <path d="M2.7 10.7c-.7 0-1.4-.6-1.4-1.4V2.7c0-.7.6-1.4 1.4-1.4h6.6c.8 0 1.4.6 1.4 1.4"/>
          <path fill="currentColor" stroke="none" d="M10 8l.6 1.4L12 10l-1.4.6L10 12l-.6-1.4L8 10l1.4-.6z"/>
        </svg>
        Copy for agent
      </button>
      <button class="btn danger grow" data-act="clear-all" title="Discard all notes and edits (past reviews are kept)">Clear all</button>
      <button class="btn ok grow locked" data-act="complete-review" title="Copy for agent first — nothing is copied yet">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3v10M3 8h10"/>
        </svg>
        New review
      </button>
    </footer>
  </aside>
  <div id="toolbar">
    <img class="logo" src="${chrome.runtime.getURL("icons/icon48.png")}" alt="Annotate &amp; Edit" title="Annotate &amp; Edit">
    <button class="btn" data-act="annotate" title="Click elements to pin notes — press a to toggle, Esc to exit">Annotate <span class="key">a</span></button>
    <button class="btn" data-act="edit" title="Click text to rewrite it — press e to toggle, Esc to exit">Edit <span class="key">e</span></button>
    <button class="btn icon" data-act="marks" title="Hide note and edit markers">
      <svg id="eye-on" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M1.5 8s2.4-4.6 6.5-4.6S14.5 8 14.5 8s-2.4 4.6-6.5 4.6S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.1"/>
      </svg>
      <svg id="eye-off" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" hidden>
        <path d="M1.5 8s2.4-4.6 6.5-4.6c1.2 0 2.3.4 3.2 1M14.5 8s-2.4 4.6-6.5 4.6c-1.2 0-2.3-.4-3.2-1"/><line x1="2.5" y1="13.5" x2="13.5" y2="2.5"/>
      </svg>
    </button>
    <button class="btn primary" data-act="panel" title="Open notes and edits — copy them for your agent">Notes<span class="count" id="count">0</span></button>
  </div>
  <div id="toast"></div>
</div>`;

  const $ = (sel) => shadow.querySelector(sel);
  const overlay = $("#overlay");
  const highlight = $("#highlight");
  const toolbar = $("#toolbar");
  const panel = $("#panel");
  const notePopup = $("#note-popup");
  const viewPopup = $("#view-popup");
  const pill = $("#pill");
  const toastEl = $("#toast");
  const panelFooter = panel.querySelector("footer");

  // toolbar position — draggable anywhere, remembered for the session
  const pos = { right: 16, bottom: 16 };
  try {
    Object.assign(pos, JSON.parse(session.get("__ae_pos") || "{}"));
  } catch {}
  function applyPos() {
    const r = panelOpen ? Math.max(pos.right, 346) : pos.right;
    toolbar.style.right = r + "px";
    toolbar.style.bottom = pos.bottom + "px";
    if (panelOpen) {
      // snackbar sits inside the drawer, directly above the footer buttons
      toastEl.style.right = "14px";
      toastEl.style.bottom = panelFooter.offsetHeight + 8 + "px";
    } else {
      toastEl.style.right = r + "px";
      toastEl.style.bottom = pos.bottom + toolbar.offsetHeight + 12 + "px";
    }
  }

  let drag = null;
  toolbar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    drag = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom };
    toolbar.classList.add("dragging");
    e.preventDefault();
  });
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pos.right = Math.min(Math.max(drag.right - (e.clientX - drag.x), 0), innerWidth - toolbar.offsetWidth);
    pos.bottom = Math.min(Math.max(drag.bottom - (e.clientY - drag.y), 0), innerHeight - toolbar.offsetHeight);
    applyPos();
  });
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    toolbar.classList.remove("dragging");
    session.set("__ae_pos", JSON.stringify(pos));
  });
  applyPos();

  let toastTimer = null, toastHideTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.style.display = "block";
    applyPos();
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove("show");
      toastHideTimer = setTimeout(() => (toastEl.style.display = "none"), 200);
    }, 4200);
  }

  // ------------------------------------------------------------ positioning

  /** Fixed popup next to an element's viewport rect, clamped on screen. */
  function placeFixed(el, rect) {
    el.style.display = el === pill ? "flex" : "block";
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = rect.bottom + 8;
    if (top + h > innerHeight - 8) top = rect.top - h - 8;
    if (top < 8) top = Math.min(innerHeight - h - 8, 8);
    const left = Math.min(Math.max(8, rect.left), innerWidth - w - 8);
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(8, left)}px`;
  }

  const byId = (list, id) => list.find((n) => n.id === id);

  /** Document-coordinate marker positions; re-run on layout changes. */
  function renderMarkers() {
    overlay.innerHTML = "";
    const data = site.pages[pageKey()];
    if (!data) return;
    {
      data.notes.forEach((note, i) => {
        const el = safeQuery(note.selector);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const m = document.createElement("div");
        m.className = `marker${note.done ? " done" : ""}`;
        m.textContent = String(i + 1);
        m.dataset.id = note.id;
        m.style.left = `${r.left + scrollX}px`;
        m.style.top = `${r.top + scrollY}px`;
        m.title = note.note.split("\n")[0].slice(0, 80);
        overlay.appendChild(m);
      });
      data.edits.forEach((edit) => {
        const hit = locateEdit(edit);
        if (!hit) return;
        const r = hit.el.getBoundingClientRect();
        const b = document.createElement("div");
        b.className = "ebadge";
        b.textContent = "edited";
        b.dataset.id = edit.id;
        b.style.left = `${r.right + scrollX}px`;
        b.style.top = `${r.top + scrollY}px`;
        overlay.appendChild(b);
      });
    }
  }

  function safeQuery(sel) {
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  /** Viewport-anchored bits: highlight box and any open popup. */
  function reposition() {
    if (hoverEl && mode !== "off") {
      const r = hoverEl.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.top = `${r.top - 2}px`;
      highlight.style.left = `${r.left - 2}px`;
      highlight.style.width = `${r.width + 4}px`;
      highlight.style.height = `${r.height + 4}px`;
    } else {
      highlight.style.display = "none";
    }
    if (noteDraft?.el?.isConnected) {
      placeFixed(notePopup, noteDraft.el.getBoundingClientRect());
    } else if (noteDraft) {
      closeNoteEditor(false);
    }
    if (openView?.el?.isConnected) {
      placeFixed(viewPopup, openView.el.getBoundingClientRect());
    } else if (openView) {
      openView = null;
      viewPopup.style.display = "none";
    }
    if (activeEdit?.el?.isConnected) {
      placeFixed(pill, activeEdit.el.getBoundingClientRect());
    }
  }

  // ------------------------------------------------------------ note editor

  function openNoteEditor(el, existing) {
    closeViewPopup();
    noteDraft = { el, existing };
    $("#note-title").innerHTML = existing
      ? `Edit note on <b>${esc(describe(el))}</b>`
      : `Note on <b>${esc(describe(el))}</b>`;
    $("#note-text").value = existing?.note || "";
    placeFixed(notePopup, el.getBoundingClientRect());
    setTimeout(() => $("#note-text").focus(), 0);
  }

  function closeNoteEditor(saveIt) {
    if (!noteDraft) return;
    const { el, existing } = noteDraft;
    noteDraft = null;
    notePopup.style.display = "none";
    const text = $("#note-text").value.trim();
    if (!saveIt || !text) return;

    if (existing) {
      const current = byId(pageData().notes, existing.id);
      if (!current) return; // Deleted in the shared panel while this draft was open.
      current.note = text;
    } else {
      const { prevText, nextText } = contextFor(el);
      pageData().notes.push({
        id: uid(),
        note: text,
        done: false,
        page: pageKey(),
        selector: selectorFor(el),
        tag: el.tagName.toLowerCase(),
        text: norm(el.innerText).slice(0, 200),
        prevText,
        nextText,
        viewport: innerWidth,
        createdAt: new Date().toISOString(),
      });
    }
    site.copied = false;
    save();
    renderAll();
  }

  function openViewPopup(kind, item, el) {
    noteDraft && closeNoteEditor(true);
    openView = { kind, item, el };
    if (kind === "note") {
      const n = item;
      viewPopup.innerHTML = `
        <div class="title">${n.category ? `${esc(n.category)} · ` : ""}note</div>
        <div class="note-text">${esc(n.note)}</div>
        <div class="meta">${esc(n.selector)}</div>
        <div class="row">
          <button class="btn small danger" data-act="note-del" data-id="${n.id}">Delete</button>
          <button class="btn small" data-act="note-done" data-id="${n.id}">${n.done ? "Reopen" : "Resolve"}</button>
          <button class="btn small" data-act="note-edit" data-id="${n.id}">Edit</button>
        </div>`;
    } else {
      const e = item;
      viewPopup.innerHTML = `
        <div class="title">Edit · &lt;${esc(e.tag)}&gt;</div>
        <div class="diff"><span class="from">${esc(e.oldText)}</span><span class="to">${esc(e.newText)}</span></div>
        <div class="meta">${esc(e.selector)}</div>
        <div class="row">
          <button class="btn small danger" data-act="edit-revert" data-id="${e.id}">Revert</button>
          <button class="btn small" data-act="view-close">Close</button>
        </div>`;
    }
    placeFixed(viewPopup, el.getBoundingClientRect());
  }

  function closeViewPopup() {
    openView = null;
    viewPopup.style.display = "none";
  }

  // ------------------------------------------------------- markers visibility

  let marksVisible = session.get("__ae_marks") !== "0";

  function setMarks(v, remote = false) {
    if (!isTop && !remote) {
      requestTop({ action: "marks", value: v });
      return;
    }
    marksVisible = v;
    if (isTop) session.set("__ae_marks", v ? "1" : "0");
    overlay.style.display = v ? "" : "none";
    $("#eye-on").hidden = !v;
    $("#eye-off").hidden = v;
    const btn = toolbar.querySelector('[data-act="marks"]');
    btn.classList.toggle("on", !v); // lit = markers hidden
    btn.title = v
      ? "Hide note and edit markers"
      : "Show note and edit markers";
    if (isTop && !remote) publishFrames();
  }

  // ------------------------------------------------------------ edit session

  function startEdit(el) {
    const oldHTML = el.innerHTML;
    const { prevText, nextText } = contextFor(el);
    activeEdit = {
      el,
      oldHTML,
      oldText: norm(el.innerText),
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      prevText,
      nextText,
    };
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only" && el.contentEditable !== "true") {
      el.setAttribute("contenteditable", "true");
    }
    el.focus();
    try {
      const range = document.caretRangeFromPoint(lastMouse.x, lastMouse.y);
      if (range && el.contains(range.startContainer)) {
        const sel = getSelection();
        sel.setBaseAndExtent(
          range.startContainer,
          range.startOffset,
          range.startContainer,
          range.startOffset,
        );
      }
    } catch {
      /* caret placement is best-effort */
    }
    pill.querySelector(".hint").textContent = `Editing <${activeEdit.tag}> — ⌘⏎ saves, Esc cancels`;
    placeFixed(pill, el.getBoundingClientRect());
  }

  function teardownEdit(restore) {
    if (!activeEdit) return;
    const { el, oldHTML } = activeEdit;
    el.removeAttribute("contenteditable");
    if (restore) el.innerHTML = oldHTML;
    pill.style.display = "none";
    activeEdit = null;
  }

  function commitEdit() {
    if (!activeEdit) return;
    const { el, oldText, oldHTML, selector, tag, prevText, nextText } = activeEdit;
    const newText = norm(el.innerText);
    const newHTML = el.innerHTML;
    if (newText === oldText) {
      teardownEdit(false);
      return;
    }
    pageData().edits.push({
      id: uid(),
      page: pageKey(),
      selector,
      tag,
      oldText,
      oldHTML,
      newText,
      newHTML,
      prevText,
      nextText,
      viewport: innerWidth,
      createdAt: new Date().toISOString(),
    });
    site.copied = false;
    teardownEdit(false);
    save();
    renderAll();
    toast("Edit saved — persists on reload");
  }

  function revertEdit(id, key = pageKey()) {
    const data = site.pages[key];
    const edit = data && byId(data.edits, id);
    if (!edit) return;
    if (key === pageKey()) {
      const hit = locateEdit(edit);
      if (hit && norm(hit.el.innerText) === edit.newText) {
        hit.el.innerHTML = edit.oldHTML;
      }
    }
    data.edits = data.edits.filter((e) => e.id !== id);
    site.copied = false;
    closeViewPopup();
    save();
    renderAll();
  }

  /**
   * Finds the live element an edit applies to.
   * Returns { el, at:'old'|'new' } or null when nothing matches.
   */
  function locateEdit(edit) {
    const el = safeQuery(edit.selector);
    if (el) {
      const t = norm(el.innerText);
      if (t === edit.oldText) return { el, at: "old" };
      if (t === edit.newText) return { el, at: "new" };
    }
    // Selector failed (markup changed) — fall back to text. Prefer an
    // element still showing the original text; only then accept one already
    // showing the new text (i.e. the edit is applied).
    for (const cand of document.querySelectorAll(EDITABLE_SELECTOR)) {
      if (norm(cand.innerText) === edit.oldText) return { el: cand, at: "old" };
    }
    for (const cand of document.querySelectorAll(EDITABLE_SELECTOR)) {
      if (norm(cand.innerText) === edit.newText) return { el: cand, at: "new" };
    }
    return null;
  }

  /** Re-apply stored edits after load, hydration and SPA renders. */
  function applyEdits() {
    if (activeEdit) return;
    for (const edit of pageData().edits) {
      const hit = locateEdit(edit);
      if (hit && hit.at === "old") {
        hit.el.innerHTML = edit.newHTML ?? "";
        if (edit.newHTML == null) hit.el.innerText = edit.newText;
      }
    }
  }

  function editState(edit) {
    const hit = locateEdit(edit);
    if (!hit) return "stale";
    return hit.at === "new" ? "applied" : "pending";
  }

  // ------------------------------------------------------------------ modes

  const lastMouse = { x: 0, y: 0 };

  function setMode(next) {
    if (!isTop) {
      requestTop({ action: "mode", value: next });
      return;
    }
    applyMode(mode === next ? "off" : next);
    publishFrames();
  }

  function applyMode(next) {
    if (mode === next) return;
    if (activeEdit) commitEdit();
    if (noteDraft) closeNoteEditor(true);
    mode = next;
    hoverEl = null;
    highlight.style.display = "none";
    highlight.classList.toggle("edit", mode === "edit");
    toolbar.querySelector('[data-act="annotate"]').classList.toggle("on", mode === "annotate");
    const eb = toolbar.querySelector('[data-act="edit"]');
    eb.classList.toggle("on", mode === "edit");
    eb.classList.toggle("amber", mode === "edit");
    document.documentElement.style.cursor =
      mode === "off" ? "" : "crosshair";
  }

  function inUI(e) {
    return e.composedPath().includes(host);
  }

  function onMove(e) {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    if (mode === "off" || inUI(e)) {
      hoverEl = null;
      highlight.style.display = "none";
      return;
    }
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || t === host) {
      hoverEl = null;
      highlight.style.display = "none";
      return;
    }
    if (mode === "edit") {
      hoverEl = editableTarget(t);
      highlight.querySelector(".tag").textContent = hoverEl
        ? `<${hoverEl.tagName.toLowerCase()}> — click to edit`
        : "not editable — switch to Annotate";
    } else {
      hoverEl = t;
      highlight.querySelector(".tag").textContent = `<${t.tagName.toLowerCase()}>`;
    }
    reposition();
  }

  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /** While picking, swallow page clicks so links/buttons don't fire. */
  function onMouseBlock(e) {
    if (mode === "off" || inUI(e)) return;
    if (activeEdit && activeEdit.el.contains(e.target)) {
      // mousedown/up must pass through for caret placement, but middle-click
      // on a link still opens it — block auxclick during an edit.
      if (e.type === "auxclick") block(e);
      return;
    }
    block(e);
  }

  function onClickCapture(e) {
    if (mode === "off") return;
    if (inUI(e)) {
      const actBtn = e.composedPath().find(
        (n) => n instanceof HTMLElement && n.dataset?.act,
      );
      // Clicking UI commits an in-progress edit — except Cancel, whose own
      // handler restores the original text.
      if (activeEdit && actBtn?.dataset.act !== "edit-cancel") commitEdit();
      return;
    }
    if (activeEdit) {
      if (activeEdit.el.contains(e.target)) {
        // Caret placement already happened on mousedown — swallow the click
        // so links/handlers inside the editable element can't navigate away.
        block(e);
        return;
      }
      block(e);
      commitEdit();
      return;
    }
    block(e);
    if (noteDraft) closeNoteEditor(true);
    if (openView) closeViewPopup();
    if (mode === "annotate" && e.target instanceof Element) {
      openNoteEditor(e.target, null);
    } else if (mode === "edit") {
      const t = editableTarget(e.target);
      if (t) startEdit(t);
      else toast("That element can't be edited — leave a note instead");
    }
  }

  function onKeyCapture(e) {
    const ownUI = inUI(e);
    if (e.key === "Escape") {
      if (ownUI) {
        if (noteDraft) closeNoteEditor(false);
        else if (openView) closeViewPopup();
        return;
      }
      if (activeEdit) teardownEdit(true);
      else if (noteDraft) closeNoteEditor(false);
      else if (openView) closeViewPopup();
      else if (mode !== "off") setMode(mode);
      return;
    }
    if (ownUI) return;
    if (activeEdit) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      }
      return;
    }
    // Mode hotkeys: a = annotate, e = edit (press again to switch off, Esc too).
    // Plain keys only, and never while typing into a field or editable element.
    if (toolbarVisible && !e.metaKey && !e.ctrlKey && !e.altKey &&
        (e.key === "a" || e.key === "e")) {
      const t = e.target;
      const typing =
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
      if (!typing) {
        block(e);
        setMode(e.key === "a" ? "annotate" : "edit");
        return;
      }
    }
    if (mode !== "off") block(e);
  }

  // ------------------------------------------------------------------ panel

  let panelView = "current"; // "current" | "history"

  function renderHistory() {
    const body = $("#panel-body");
    const reviews = site.reviews || [];
    const total = reviews.reduce(
      (s, r) => s + r.notes.length + r.edits.length,
      0,
    );
    $("#panel-sub").textContent =
      `${location.host} — ${reviews.length} completed reviews, ${total} changes`;
    if (!reviews.length) {
      body.innerHTML = `<div class="empty">No completed reviews yet. Finish one with <b>Complete review</b>.</div>`;
      return;
    }
    const html = [`<div class="revsum">${reviews.length} reviews · ${total} changes completed</div>`];
    [...reviews].reverse().forEach((r) => {
      const date = new Date(r.endedAt).toLocaleDateString(undefined, {
        month: "short", day: "numeric",
      });
      html.push(`
        <details class="item rev">
          <summary><span class="cat">Review #${r.n}</span><span class="num">${esc(date)}</span></summary>
          <div class="revitem"><b>${r.notes.length} notes · ${r.edits.length} edits</b></div>
          ${r.edits
            .map(
              (e) =>
                `<div class="revitem"><b>edit &lt;${esc(e.tag)}&gt;</b> ${esc(e.page || "")} — "${esc((e.newText || "").slice(0, 70))}"</div>`,
            )
            .join("")}
          ${r.notes
            .map(
              (n) =>
                `<div class="revitem"><b>note</b> ${esc(n.page || "")} — "${esc((n.note || "").slice(0, 70))}"</div>`,
            )
            .join("")}
          <div class="actions">
            <button class="btn small" data-act="review-copy" data-id="${r.id}">Copy for agent</button>
            <button class="btn small danger" data-act="review-del" data-id="${r.id}">Delete</button>
          </div>
        </details>`);
    });
    body.innerHTML = html.join("");
  }

  function renderPanel() {
    const body = $("#panel-body");
    $("#hist-btn").textContent = panelView === "history" ? "Current" : "History";
    if (panelView === "history") {
      renderHistory();
      return;
    }
    const keys = Object.keys(site.pages).filter(
      (k) => site.pages[k].notes.length || site.pages[k].edits.length,
    );
    keys.sort((a, b) => (a === pageKey() ? -1 : b === pageKey() ? 1 : a.localeCompare(b)));

    let notes = 0;
    let edits = 0;
    keys.forEach((k) => {
      notes += site.pages[k].notes.length;
      edits += site.pages[k].edits.length;
    });
    $("#panel-sub").textContent = `${location.host} — review #${site.nextReview || 1} · ${notes} notes, ${edits} edits`;
    $("#count").textContent = String(notes + edits);

    if (!keys.length) {
      body.innerHTML = `<div class="empty">Nothing yet. Use <b>Annotate</b> to pin a note, or <b>Edit</b> to rewrite text in place.</div>`;
      return;
    }

    const html = [];
    for (const key of keys) {
      const data = site.pages[key];
      html.push(`<h4>${esc(pageLabel(key, data))}${key === pageKey() ? " · this page" : ""}</h4>`);
      data.edits.forEach((ed) => {
        const state = key === pageKey() ? editState(ed) : "applied";
        html.push(`
          <div class="item">
            <div class="head"><span class="cat editcat">edit &lt;${esc(ed.tag)}&gt;</span><span class="num">${state === "stale" ? '<span class="stale">not on page</span>' : ""}</span></div>
            <div class="diff"><span class="from">${esc(ed.oldText.slice(0, 140))}</span><span class="to">${esc(ed.newText.slice(0, 140))}</span></div>
            <div class="actions">
              <button class="btn small" data-act="edit-revert" data-id="${ed.id}" data-page="${esc(key)}">Revert</button>
            </div>
          </div>`);
      });
      data.notes.forEach((n, i) => {
        html.push(`
          <div class="item${n.done ? " done" : ""}">
            <div class="head"><span class="cat">${esc(n.category || "note")}</span><span class="num">#${i + 1}</span></div>
            <div class="body">${esc(n.note)}</div>
            <div class="actions">
              <button class="btn small icon" data-act="note-copy" data-id="${n.id}" data-page="${esc(key)}" title="Copy just this note for your agent">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.3" y="5.3" width="9.3" height="9.3" rx="1.4"/><path d="M2.7 10.7c-.7 0-1.4-.6-1.4-1.4V2.7c0-.7.6-1.4 1.4-1.4h6.6c.8 0 1.4.6 1.4 1.4"/></svg>
              </button>
              <button class="btn small" data-act="note-done" data-id="${n.id}" data-page="${esc(key)}">${n.done ? "Reopen" : "Resolve"}</button>
              <button class="btn small danger" data-act="note-del" data-id="${n.id}" data-page="${esc(key)}">Delete</button>
            </div>
          </div>`);
      });
    }
    body.innerHTML = html.join("");
  }

  function togglePanel(force) {
    panelOpen = force ?? !panelOpen;
    panel.style.display = panelOpen ? "flex" : "none";
    applyPos();
    if (panelOpen) renderPanel();
  }

  let confirmClear = null;
  function clearAll() {
    if (confirmClear !== "all") {
      confirmClear = "all";
      toast("Click Clear all again to confirm");
      return;
    }
    confirmClear = null;
    resetFrames("clear");
    site.pages = {}; // history survives — only the working set is cleared
    site.copied = false;
    save();
    renderAll();
    toast("Cleared all notes and edits on this site");
  }

  async function completeReview() {
    if (!await flushFrames()) {
      toast("A frame is still saving — try again in a moment");
      return;
    }
    const keys = Object.keys(site.pages).filter(
      (k) => site.pages[k].notes.length || site.pages[k].edits.length,
    );
    if (!keys.length) {
      toast("Nothing to complete — add notes or edits first");
      return;
    }
    if (!site.copied) {
      toast("Copy for agent first — your changes aren't copied yet");
      return;
    }
    const review = {
      id: uid(),
      n: site.nextReview,
      endedAt: new Date().toISOString(),
      notes: [],
      edits: [],
    };
    for (const k of keys) {
      review.notes.push(...site.pages[k].notes.map((n) => ({ ...n, page: n.page ?? k })));
      review.edits.push(...site.pages[k].edits.map((e) => ({ ...e, page: e.page ?? k })));
    }
    site.reviews.push(review);
    site.nextReview += 1;
    resetFrames("archive");
    site.pages = {};
    site.copied = false; // fresh review needs a fresh copy
    save();
    renderAll();
    const changes = review.notes.length + review.edits.length;
    toast(`Review #${review.n} complete — ${changes} changes archived`);
    confetti(panel.querySelector('[data-act="complete-review"]'));
  }

  // ----------------------------------------------------------------- export

  function clean(t) {
    return String(t ?? "").replace(/\r/g, "").trim();
  }

  function pageLabel(key, data) {
    const item = data?.notes?.[0] || data?.edits?.[0];
    return item?.frameUrl ? `${item.frameUrl} (embedded in ${item.hostPage})` : key;
  }

  function frameContext(item, indent = "") {
    return item.frameUrl ? [
      `${indent}- **Frame URL:** ${item.frameUrl}`,
      `${indent}- **Frame path:** ${item.framePath} (frame indexes from the outer page)`,
      `${indent}- **Containing page:** ${item.hostPage}`,
    ] : [];
  }

  function renderExport() {
    return renderExportFrom(
      site.pages,
      `Website review${site.nextReview > 1 ? ` #${site.nextReview}` : ""} — ${location.origin}`,
      new Date(),
    );
  }

  /** Export an archived review the same way — group its items back by page. */
  function renderReviewExport(review) {
    const pages = {};
    for (const n of review.notes)
      (pages[n.page] ||= { notes: [], edits: [] }).notes.push(n);
    for (const e of review.edits)
      (pages[e.page] ||= { notes: [], edits: [] }).edits.push(e);
    return renderExportFrom(
      pages,
      `Website review #${review.n} — ${location.origin}`,
      new Date(review.endedAt),
    );
  }

  function renderExportFrom(pages, heading, when) {
    const keys = Object.keys(pages).filter(
      (k) => pages[k].notes.length || pages[k].edits.length,
    );
    let notes = 0;
    let edits = 0;
    keys.forEach((k) => {
      notes += pages[k].notes.filter((n) => !n.done).length;
      edits += pages[k].edits.length;
    });

    const lines = [
      `# ${heading}`,
      "",
      `Generated ${when.toLocaleString()} — ${edits} text edits, ${notes} annotations.`,
      "Produced with the Annotate & Edit browser extension. Apply each change to the",
      "codebase that builds this site. Every item is anchored by a CSS selector and",
      "quoted on-screen text — grep for the quoted text if a selector doesn't resolve.",
      "",
    ];

    if (edits) {
      lines.push("## Text edits", "");
      for (const key of keys.sort()) {
        const list = pages[key].edits;
        if (!list.length) continue;
        lines.push(`### Page: ${pageLabel(key, pages[key])}`, "");
        list.forEach((ed, i) => {
          const stale = key === pageKey() && editState(ed) === "stale";
          lines.push(
            `${i + 1}. Change \`<${ed.tag}>\` text${stale ? " _(element not found on page at export time)_" : ""}`,
            "",
            `   - **From:** "${clean(ed.oldText)}"`,
            `   - **To:** "${clean(ed.newText)}"`,
            `   - **Selector:** \`${ed.selector}\``,
            ...frameContext(ed, "   "),
          );
          const ctx = [];
          if (ed.prevText) ctx.push(`after "${clean(ed.prevText).slice(0, 80)}"`);
          if (ed.nextText) ctx.push(`before "${clean(ed.nextText).slice(0, 80)}"`);
          if (ctx.length) lines.push(`   - **Context:** ${ctx.join(", ")}`);
          lines.push("");
        });
      }
    }

    const openKeys = keys.filter((k) => pages[k].notes.some((n) => !n.done));
    if (openKeys.length) {
      lines.push("## Annotations", "");
      for (const key of openKeys.sort()) {
        lines.push(`### Page: ${pageLabel(key, pages[key])}`, "");
        pages[key].notes.forEach((n, i) => {
          if (n.done) return;
          const [first, ...rest] = clean(n.note).split("\n");
          lines.push(`${i + 1}. ${n.category ? `**${n.category}** — ` : ""}${first}`, "");
          const body = rest.join("\n").trim();
          if (body) lines.push(`   ${body}`, "");
          lines.push(`   - **Element:** \`<${n.tag}>\`${n.text ? ` "${clean(n.text).slice(0, 120)}"` : ""}`);
          lines.push(`   - **Selector:** \`${n.selector}\``);
          lines.push(...frameContext(n, "   "));
          const nctx = [];
          if (n.prevText) nctx.push(`after "${clean(n.prevText).slice(0, 80)}"`);
          if (n.nextText) nctx.push(`before "${clean(n.nextText).slice(0, 80)}"`);
          if (nctx.length) lines.push(`   - **Context:** ${nctx.join(", ")}`);
          if (n.viewport) lines.push(`   - **Seen at:** ${n.viewport}px wide`);
          lines.push("");
        });
      }
    }

    const done = keys.flatMap((k) =>
      pages[k].notes.filter((n) => n.done).map((n) => ({ ...n, page: k })),
    );
    if (done.length) {
      lines.push("---", "", "## Resolved (no action needed)", "");
      for (const n of done) {
        lines.push(`- ~~${clean(n.note).split("\n")[0]}~~ (${n.page})`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Copy a single annotation as the same markdown block the full export uses. */
  async function copyNote(id, key = pageKey()) {
    const n = byId(pageData(key).notes, id);
    if (!n) return;
    const [first, ...rest] = clean(n.note).split("\n");
    const lines = [`### Annotation — ${pageLabel(key, { notes: [n] })}`, "", first];
    const body = rest.join("\n").trim();
    if (body) lines.push("", body);
    lines.push(
      "",
      `- **Element:** \`<${n.tag}>\`${n.text ? ` "${clean(n.text).slice(0, 120)}"` : ""}`,
      `- **Selector:** \`${n.selector}\``,
      ...frameContext(n),
    );
    const ctx = [];
    if (n.prevText) ctx.push(`after "${clean(n.prevText).slice(0, 80)}"`);
    if (n.nextText) ctx.push(`before "${clean(n.nextText).slice(0, 80)}"`);
    if (ctx.length) lines.push(`- **Context:** ${ctx.join(", ")}`);
    if (n.viewport) lines.push(`- **Seen at:** ${n.viewport}px wide`);
    await writeClipboard(lines.join("\n"));
    toast("Note copied");
  }

  async function writeClipboard(md) {
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
    }
  }

  function syncFooter() {
    const copy = panel.querySelector('[data-act="copy"]');
    const done = panel.querySelector('[data-act="complete-review"]');
    const empty = !Object.values(site.pages).some(
      (p) => p.notes.length || p.edits.length,
    );
    copy.classList.toggle("locked", empty);
    copy.title = empty
      ? "Nothing to copy yet — add notes or edits first"
      : "Copy all notes for a coding agent. Either paste them directly into your coding agent's chat, or send them to the web developer you're working with";
    const locked = !site.copied;
    done.classList.toggle("locked", locked);
    done.title = locked
      ? "Copy for agent first — nothing is copied yet"
      : "Archive this review and start a new one";
  }

  /** Confetti burst from a spot on screen (e.g. the complete button). */
  function confetti(fromEl) {
    const r = fromEl.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height / 2;
    const colors = ["#4f7cff", "#f5a524", "#30a46c", "#e8eaf0", "#ff8589"];
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    for (let i = 0; i < 30; i++) {
      const p = document.createElement("i");
      const s = 4 + Math.random() * 6;
      p.style.cssText =
        `position:fixed;left:${ox}px;top:${oy}px;width:${s}px;height:${s}px;` +
        `background:${colors[i % colors.length]};` +
        `border-radius:${Math.random() > 0.5 ? "50%" : "2px"}`;
      wrap.appendChild(p);
      const ang = Math.random() * Math.PI * 2;
      const dist = 55 + Math.random() * 130;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist - 60; // bias upward
      p.animate(
        [
          { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(${dx}px,${dy + 90}px) rotate(${(Math.random() - 0.5) * 540}deg)`,
            opacity: 0,
          },
        ],
        {
          duration: 750 + Math.random() * 550,
          easing: "cubic-bezier(.2,.7,.3,1)",
          fill: "forwards",
        },
      );
    }
    shadow.appendChild(wrap);
    setTimeout(() => wrap.remove(), 1500);
  }

  async function copyAll() {
    if (!await flushFrames()) {
      toast("A frame is still saving — try again in a moment");
      return;
    }
    const empty = !Object.values(site.pages).some(
      (p) => p.notes.length || p.edits.length,
    );
    if (empty) {
      toast("Nothing to copy yet — add notes or edits first");
      return;
    }
    const md = renderExport();
    await writeClipboard(md);
    site.copied = true;
    save();
    syncFooter();
    const btn = shadow.querySelector('[data-act="copy"]');
    if (btn && !btn.classList.contains("copied")) {
      const orig = btn.innerHTML;
      btn.classList.add("copied");
      btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.4 3.4L13.5 5"/></svg> Copied!';
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = orig;
      }, 1800);
    }
    toast("Copied — paste it into your AI agent");
  }

  // ------------------------------------------------------------- UI actions

  shadow.addEventListener("click", (e) => {
    const btn = e.composedPath().find(
      (n) => n instanceof HTMLElement && n.dataset?.act,
    );
    if (!btn) {
      const m = e.composedPath().find(
        (n) => n instanceof HTMLElement && n.dataset?.id && (n.classList?.contains("marker") || n.classList?.contains("ebadge")),
      );
      if (m) {
        e.stopPropagation();
        const data = pageData();
        if (m.classList.contains("marker")) {
          const note = byId(data.notes, m.dataset.id);
          const el = note && safeQuery(note.selector);
          if (note && el) openViewPopup("note", note, el);
        } else {
          const edit = byId(data.edits, m.dataset.id);
          const hit = edit && locateEdit(edit);
          if (edit && hit) openViewPopup("edit", edit, hit.el);
        }
      }
      return;
    }
    e.stopPropagation();
    const { act, id, page } = btn.dataset;
    const data = pageData(page || pageKey());
    switch (act) {
      case "annotate": setMode("annotate"); break;
      case "edit": setMode("edit"); break;
      case "panel": togglePanel(); break;
      case "panel-close": togglePanel(false); break;
      case "copy": copyAll(); break;
      case "clear-all": clearAll(); break;
      case "complete-review": completeReview(); break;
      case "history":
        panelView = panelView === "history" ? "current" : "history";
        renderPanel();
        break;
      case "review-copy": {
        const r = byId(site.reviews || [], id);
        if (r) {
          writeClipboard(renderReviewExport(r));
          toast(`Review #${r.n} copied — paste it into your AI agent`);
        }
        break;
      }
      case "review-del":
        site.reviews = (site.reviews || []).filter((r) => r.id !== id);
        save();
        renderPanel();
        break;
      case "note-save": closeNoteEditor(true); break;
      case "note-cancel": closeNoteEditor(false); break;
      case "note-edit": {
        const note = byId(pageData().notes, id);
        const el = note && safeQuery(note.selector);
        if (note && el) openNoteEditor(el, note);
        break;
      }
      case "note-copy": copyNote(id, page); break;
      case "note-done": {
        const note = byId(data.notes, id);
        if (note) {
          note.done = !note.done;
          site.copied = false;
          save();
          renderAll();
        }
        break;
      }
      case "note-del": {
        data.notes = data.notes.filter((n) => n.id !== id);
        site.pages[page || pageKey()] = data;
        site.copied = false;
        closeViewPopup();
        save();
        renderAll();
        break;
      }
      case "marks": setMarks(!marksVisible); break;
      case "edit-save": commitEdit(); break;
      case "edit-cancel": teardownEdit(true); break;
      case "edit-revert": revertEdit(id, page); break;
      case "view-close": closeViewPopup(); break;
    }
  });

  shadow.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && noteDraft) {
      e.preventDefault();
      closeNoteEditor(true);
    }
  });

  // ----------------------------------------------------- frame coordination
  // The top document is the only writer to chrome.storage. Children send
  // item-level changes, not whole-site snapshots, so concurrent frame saves
  // cannot overwrite one another. A child receives only its own page's data.
  const frames = new Map();
  let revision = 0;
  let epoch = uid();
  let resetReason = "";
  let finishReady;
  const ready = new Promise((resolve) => { finishReady = resolve; });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const emptyPage = () => ({ notes: [], edits: [] });
  let baseline = emptyPage();
  let frameRevision = -1;
  let frameEpoch = null;
  let pendingPatches = [];
  let draining = null;
  let retryTimer = null;
  let connecting = false;

  async function relay(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return { unavailable: true }; }
  }

  function sendFrame(entry, message) {
    return relay({ type: "ae:frame-send", documentId: entry.documentId, message });
  }

  function stateFor(entry) {
    return {
      type: "ae:frame-state", revision, epoch, resetReason,
      visible: toolbarVisible, mode, marks: marksVisible,
      page: entry.key, data: site.pages[entry.key] || emptyPage(),
    };
  }

  function publishFrames() {
    if (!isTop) return;
    revision++;
    for (const entry of frames.values()) {
      sendFrame(entry, stateFor(entry)).then((reply) => {
        if (reply?.unavailable && frames.get(entry.documentId) === entry) {
          frames.delete(entry.documentId);
        }
      });
    }
  }

  function resetFrames(reason) {
    epoch = uid();
    resetReason = reason;
    for (const entry of frames.values()) entry.seen.clear();
  }

  // WindowProxy frame indexes are readable across origins. No child DOM or
  // parent location is accessed. The path distinguishes duplicate frame URLs.
  function framePath() {
    const path = [];
    for (let child = window; child !== child.top; child = child.parent) {
      const parent = child.parent;
      let index = 0;
      while (index < parent.length && parent[index] !== child) index++;
      path.unshift(index);
    }
    return path.join("/");
  }

  async function handleFrameRequest(msg) {
    await ready;
    const request = msg.request || {};
    let entry = frames.get(msg.documentId);
    if (request.action === "hello") {
      if (!msg.documentId || !/^\d+(\/\d+)*$/.test(request.path)) return;
      // MessageSender.url can retain the document's original URL after a
      // same-document navigation. Accept the content script's current route
      // only within that verified origin (history cannot change origins).
      const sourceUrl = new URL(msg.url);
      const currentUrl = new URL(request.url || msg.url);
      const url = currentUrl.origin === sourceUrl.origin ? currentUrl : sourceUrl;
      url.hash = "";
      const frameUrl = url.href;
      const key = "frame:" + JSON.stringify([localPageKey(), request.path, frameUrl]);
      entry = { documentId: msg.documentId, key, seen: new Set(),
        metadata: { frameUrl, framePath: request.path,
          hostPage: location.origin + localPageKey() } };
      frames.set(msg.documentId, entry);
    }
    if (!entry) return { reconnect: true };
    if (request.action === "patch" && request.epoch === epoch && request.page === entry.key) {
      if (!entry.seen.has(request.id)) {
        const data = pageData(entry.key);
        applyPatch(data, request.changes, entry.metadata);
        entry.seen.add(request.id);
        site.copied = false;
        save();
        renderAll();
      }
    } else if (request.action === "mode" && ["off", "annotate", "edit"].includes(request.value)) {
      setMode(request.value);
    } else if (request.action === "marks" && typeof request.value === "boolean") {
      setMarks(request.value);
    }
    return stateFor(entry);
  }

  function applyPatch(data, changes, metadata = {}) {
    for (const kind of ["notes", "edits"]) {
      const change = changes?.[kind];
      if (!change) continue;
      const removed = new Set(change.remove || []);
      const upserts = new Map((change.upsert || []).map((item) => [item.id, { ...item, ...metadata }]));
      data[kind] = data[kind].filter((item) => !removed.has(item.id)).map((item) => {
        const next = upserts.get(item.id) || item;
        upserts.delete(item.id);
        return next;
      });
      data[kind].push(...upserts.values());
    }
  }

  function saveFrameChanges() {
    if (!framePageKey) return;
    const data = pageData();
    const changes = {};
    for (const kind of ["notes", "edits"]) {
      const previous = new Map(baseline[kind].map((item) => [item.id, item]));
      const current = new Set(data[kind].map((item) => item.id));
      const upsert = data[kind].filter((item) => JSON.stringify(item) !== JSON.stringify(previous.get(item.id)));
      const remove = baseline[kind].filter((item) => !current.has(item.id)).map((item) => item.id);
      if (upsert.length || remove.length) changes[kind] = { upsert: clone(upsert), remove };
    }
    if (!Object.keys(changes).length) return;
    pendingPatches.push({ action: "patch", id: uid(), epoch: frameEpoch,
      page: framePageKey, changes });
    baseline = clone(data);
    drainPatches();
  }

  function drainPatches() {
    if (draining) return draining;
    draining = (async () => {
      while (pendingPatches.length) {
        const patch = pendingPatches[0];
        const response = await relay({ type: "ae:frame-request", request: patch });
        if (!response || response.unavailable || response.reconnect) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => response?.reconnect ? connectFrame() : drainPatches(), 1000);
          return false;
        }
        pendingPatches = pendingPatches.filter((p) => p !== patch);
        receiveFrameState(response);
      }
      return true;
    })().finally(() => { draining = null; });
    return draining;
  }

  function restoreRemovedEdits(before, after) {
    const remaining = new Set(after.edits.map((item) => item.id));
    for (const edit of [...before.edits].reverse()) {
      if (remaining.has(edit.id)) continue;
      const hit = locateEdit(edit);
      if (hit?.at === "new") {
        if (edit.oldHTML != null) hit.el.innerHTML = edit.oldHTML;
        else hit.el.innerText = edit.oldText;
      }
    }
  }

  function receiveFrameState(state) {
    if (state?.type !== "ae:frame-state" || state.revision < frameRevision) return;
    const samePage = state.page === framePageKey;
    const reset = frameEpoch !== null && state.epoch !== frameEpoch;
    if (!samePage || reset) {
      closeNoteEditor(false);
      teardownEdit(true);
      closeViewPopup();
      pendingPatches = [];
    }
    const before = framePageKey ? pageData() : emptyPage();
    frameRevision = state.revision;
    frameEpoch = state.epoch;
    framePageKey = state.page;
    const data = clone(state.data);
    for (const patch of pendingPatches) applyPatch(data, patch.changes);
    if (!(reset && state.resetReason === "archive")) restoreRemovedEdits(before, data);
    site.pages = { [framePageKey]: data };
    if (openView && !byId(data[openView.kind === "note" ? "notes" : "edits"], openView.item.id)) closeViewPopup();
    if (noteDraft?.existing && !byId(data.notes, noteDraft.existing.id)) closeNoteEditor(false);
    baseline = clone(data);
    toolbarVisible = state.visible;
    host.style.display = toolbarVisible ? "contents" : "none";
    setMarks(state.marks, true);
    applyMode(toolbarVisible ? state.mode : "off");
    if (!toolbarVisible) closeViewPopup();
    applyEdits();
    renderAll();
  }

  async function requestTop(request) {
    const response = await relay({ type: "ae:frame-request", request });
    if (response?.reconnect) connectFrame();
    else receiveFrameState(response);
  }

  async function connectFrame() {
    if (isTop || connecting) return;
    connecting = true;
    const response = await relay({ type: "ae:frame-request", request: {
      action: "hello", path: framePath(), url: location.href,
    } });
    connecting = false;
    if (!response || response.unavailable) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connectFrame, 1000);
      return;
    }
    receiveFrameState(response);
    drainPatches();
  }

  async function flushFrames() {
    if (!isTop) return true;
    if (activeEdit) commitEdit();
    if (noteDraft) closeNoteEditor(true);
    const replies = await Promise.all([...frames.values()].map(async (entry) => {
      let timeout;
      const reply = await Promise.race([
        sendFrame(entry, { type: "ae:flush" }),
        new Promise((resolve) => { timeout = setTimeout(() => resolve({ saved: false }), 3000); }),
      ]);
      clearTimeout(timeout);
      return reply;
    }));
    return !replies.some((reply) => reply?.saved === false);
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (isTop && msg?.type === "ae:frame-request") {
      handleFrameRequest(msg).then(respond, () => respond({ unavailable: true }));
      return true;
    }
    if (isTop && msg?.type === "ae:toggle") {
      toolbarVisible = !toolbarVisible;
      session.set("__ae_ui", toolbarVisible ? "1" : "0");
      if (!toolbarVisible) applyMode("off");
      host.style.display = toolbarVisible ? "contents" : "none";
      publishFrames();
    } else if (!isTop && msg?.type === "ae:frame-state") {
      receiveFrameState(msg);
      respond({ ok: true });
    } else if (!isTop && msg?.type === "ae:hello") {
      ready.then(connectFrame);
    } else if (!isTop && msg?.type === "ae:flush") {
      if (activeEdit) commitEdit();
      if (noteDraft) closeNoteEditor(true);
      drainPatches().then((saved) => respond({ saved }));
      return true;
    }
  });

  // ------------------------------------------------------------- lifecycle

  function renderAll() {
    renderMarkers();
    if (panelOpen) renderPanel();
    const keys = Object.keys(site.pages);
    let count = 0;
    keys.forEach((k) => {
      count += site.pages[k].notes.length + site.pages[k].edits.length;
    });
    $("#count").textContent = String(count);
    // Running tally across completed reviews + current working set — the
    // "you've shipped N changes" reminder.
    const archived = (site.reviews || []).reduce(
      (s, r) => s + r.notes.length + r.edits.length,
      0,
    );
    const total = archived + count;
    $("#tally").style.display = total ? "flex" : "none";
    $("#tally-n").textContent = `${total} change${total === 1 ? "" : "s"} applied`;
    syncFooter();
  }

  let repositionQueued = false;
  function scheduleReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      reposition();
    });
  }

  let mutateTimer = null;
  const observer = new MutationObserver(() => {
    if (activeEdit) return;
    clearTimeout(mutateTimer);
    mutateTimer = setTimeout(() => {
      applyEdits();
      renderMarkers();
      scheduleReposition();
    }, 200);
  });

  /* SPA navigation: re-key storage to the new path and reapply everything. */
  let lastKey = localPageKey();
  function onNav() {
    if (localPageKey() === lastKey) return;
    setTimeout(() => {
      if (localPageKey() === lastKey) return;
      lastKey = localPageKey();
      closeNoteEditor(false);
      teardownEdit(true);
      closeViewPopup();
      if (!isTop) { connectFrame(); return; }
      frames.clear();
      relay({ type: "ae:discover" });
      applyEdits();
      renderAll();
    }, 0);
  }
  addEventListener("popstate", onNav);
  window.navigation?.addEventListener("navigatesuccess", onNav);
  // The site's history methods live in a different JS world, and Navigation
  // API events are not available in every content-script context. This cheap
  // URL comparison also catches pushState routes that don't mutate the DOM.
  setInterval(onNav, 500);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function (...args) {
      const r = orig.apply(this, args);
      onNav();
      return r;
    };
  }

  document.addEventListener("mousemove", onMove, { capture: true, passive: true });
  document.addEventListener("click", onClickCapture, true);
  for (const ev of ["mousedown", "mouseup", "dblclick", "pointerdown", "contextmenu", "auxclick"]) {
    document.addEventListener(ev, onMouseBlock, true);
  }
  document.addEventListener("keydown", onKeyCapture, true);
  document.addEventListener("scroll", scheduleReposition, {
    capture: true,
    passive: true,
  });
  addEventListener("resize", () => {
    renderMarkers();
    scheduleReposition();
  });

  // ---- init
  function init() {
    document.documentElement.appendChild(host);
    if (!isTop) toolbar.style.display = "none";
    setMarks(marksVisible, true);
    loadSite().then(() => {
      finishReady();
      if (isTop) relay({ type: "ae:discover" });
      else connectFrame();
      applyEdits();
      renderAll();
      // A few extra passes for client-hydrated pages.
      setTimeout(() => { applyEdits(); renderMarkers(); }, 800);
      setTimeout(() => { applyEdits(); renderMarkers(); }, 2500);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
    });
  }
  if (document.documentElement) init();
  else document.addEventListener("DOMContentLoaded", init, { once: true });
})();
