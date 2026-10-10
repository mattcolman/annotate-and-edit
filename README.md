# Annotate & Edit

A free Chrome extension that lets anyone **annotate** any website and **edit its
text live**, then copy a single structured prompt to paste into an AI coding
agent.

## The workflow this enables

1. I build a website for a client and deploy it to a **staging link**.
2. The client installs this extension (free, no account, no setup).
3. On the staging site the client:
   - **Annotates** — clicks any element and leaves a note ("remove this",
     "this heading should mention pricing", "photo feels too dark").
   - **Edits** — clicks into headings, paragraphs, buttons and other text,
     rewrites it in place, and sees the change immediately. Edits persist
     across reloads and navigation, so the client can keep refining until
     they're happy.
4. The client clicks **Copy for agent** and sends me the output.
5. I paste it into an AI coding agent, which has the repo, and it makes every
   requested change for real.

The extension never touches source code. It produces an *unambiguous
description* of every requested change, anchored to the exact DOM element, so
the agent can locate and apply each one without a follow-up call.

## Goals

- **Works on any URL** — localhost, staging, production, any framework, plain
  HTML. The client needs nothing installed except the extension.
- **Two modes, one toolbar:**
  - *Annotate mode* — click an element, type a note, optionally pick a
    category (Wording / Design / Photo / Broken / Question / Other).
  - *Edit mode* — click a text element, rewrite it inline (`contenteditable`),
    confirm or cancel. The DOM change applies instantly and is re-applied on
    every subsequent page load.
- **Persistence** — notes and edits are stored locally
  (`chrome.storage.local`), keyed by origin + path, and survive reloads,
  navigation, and browser restarts. Re-applied edits that no longer match the
  page are flagged as stale, not silently dropped.
- **One copy-paste export** — a single markdown document containing every
  annotation and every edit (old text → new text), each with a CSS selector,
  element description, page URL, and surrounding text context, so an agent can
  `grep` the codebase for the exact spot.
- **Free forever** — no accounts, no backend, no telemetry, no paywall. All
  data stays in the user's browser. Anyone can install and use it.
- **Client-proof UX** — designed for non-technical reviewers: obvious toolbar,
  hover highlighting, undo/cancel on edits, and an export button that explains
  what it does.

## Non-goals (v1)

- No writing back to source files (impossible for an arbitrary deployed site;
  that's the agent's job given the export).
- No multi-user sync, comments threads, or dashboards (requires a backend;
  breaks the free/no-account constraint).
- No screenshot capture in v1 (possible later via `chrome.tabs.captureVisibleTab`).
- No style/layout editing (colors, spacing). Text edits only; anything else is
  expressed as an annotation.
- No traversal into website shadow DOM. Iframes are supported through a
  separate extension content script in each eligible document.

## Feature spec

### Toolbar

Floating toolbar injected into every page via a content script, rendered inside
a **shadow root** so page CSS can never leak in or out (same isolation strategy
as the Tailwind review tool). Controls:

- Mode toggle: **Annotate** / **Edit** — modes are sticky toggles. While a mode
  is active every page click is captured (links won't follow); press Esc or
  click the mode again to browse normally. The crosshair cursor signals you're
  picking, not browsing.
- **Panel** — list of all notes and edits on this site, grouped by page
- **Copy for agent** — renders the markdown export to the clipboard
- **Clear page / Clear all**
- Keyboard shortcut to toggle the toolbar (`Cmd/Ctrl+Shift+.`)

### Annotate mode

- Hover highlights the element under the cursor; click pins a numbered marker
  and opens a small note box near the element.
- Each note captures: comment text, category, page URL, CSS selector, tag name,
  text excerpt, neighbouring text (for disambiguation), viewport width,
  timestamp.
- Markers re-render on revisit; clicking a marker re-opens the note (edit /
  resolve / delete).

### Edit mode

- Click a text element (whitelist: headings, `p`, `li`, `blockquote`, `a`,
  `span`, `label`, `td/th`, `button`, etc.) to make it `contenteditable`.
- Save (Enter / button) records `{ selector, tag, oldText, newText, prevText,
  nextText }` and keeps the change in the DOM. Cancel (Esc) restores it.
- Edits are re-applied on page load by selector + oldText match; if neither
  matches (page changed), the edit is marked stale in the panel rather than
  applied blindly.
- Edited elements get a subtle visual badge so the client can see what they've
  changed. A per-edit undo removes the stored edit and restores the original.

### Export format (what the agent receives)

```markdown
# Website review — https://staging.example.com
Generated <date> — 4 notes, 3 edits.

## Edits

### 1. /
Change `<h1>` text
- **From:** "We help businesses grow"
- **To:** "We help trade businesses grow"
- **Selector:** `main > section:nth-of-type(1) > h1`
- **Context:** after "Tailored support for…", before "Get started"

## Annotations

### 2. /about — Design / layout
This section feels cramped on mobile.
- **Element:** `<section>` "Meet the team"
- **Selector:** `main > section:nth-of-type(3)`
- **Seen at:** 390px wide
```

Selectors stop at the nearest `id` and otherwise use `nth-of-type` chains
(proven approach in the Tailwind tool); `prevText`/`nextText` and text excerpts
give the agent a second way to locate the spot when selectors are unstable.

## Prior art — why build this

The **annotate → agent-prompt** space is now crowded; the **live-edit →
diff** space has one close contender; **nothing free does both** in one
extension with a combined export.

| Tool | Annotate | Live text edit | Agent-ready export | Free / no account |
|---|---|---|---|---|
| [Agentation](https://www.agentation.com) (npm component; [unofficial ext forks](https://github.com/mwelche/agentation-extension)) | ✅ rich — selectors, React tree, MCP | ❌ (layout rearrange only) | ✅ markdown + MCP | ✅ OSS, but meant to be embedded in your own app |
| [Markagent](https://chromewebstore.google.com/detail/markagent-uiweb-feedback/hbmbjdgdofkpddalhjoapppnkoicpdjj) | ✅ + screenshots, journey recording | ❌ | ✅ tuned per agent | ✅ |
| [MarkUp](https://getmarkup.dev/docs) | ✅ drawing/callouts | ❌ | ✅ md + PNG | free in early access, no backend |
| [visual-annotator](https://github.com/wernerstrauch/visual-annotator), [annotator](https://github.com/AWhileLater/annotator), Element Select | ✅ | ❌ | ✅ | ✅ OSS |
| [Blip](https://chromewebstore.google.com/detail/blip/kngcenmicokfcpichmbonpmkdnigjjog) | ❌ | ✅ edit-in-place, autosaves, visual diffs | ✅ markdown diff | freemium (GitHub sync paid) |
| [ruttl](https://www.ruttl.com) | ✅ comments | ✅ text/image/CSS edits | ❌ SaaS dashboard | ❌ account required, paid tiers |
| Edit Anything / [goedit.me](https://goedit.me) / [web-edit](https://github.com/ryanlua/web-edit) | ❌ | ✅ | ❌ | ✅ |
| BugHerd, Marker.io, Usersnap, Pastel, Feedbucket, Simple Commenter, Leafy | ✅ | ❌ | partial (Leafy has agent export) | ❌ accounts, paid/freemium |

**Conclusion:** Blip is the closest on the edit side and Agentation on the
annotate side, but neither does both, several rely on embedding a component in
your own app (can't be used by a client on an arbitrary staging link), and the
SaaS feedback tools require accounts and subscriptions. A small purpose-built
extension is justified — and the two-mode design is already proven in the
Tailwind repo.

## What we reuse from the Tailwind review tool

(`tailwindeasydney`: `src/dev/review-client.js` + `scripts/review-notes-plugin.mjs`)

- Two-mode toolbar inside a shadow root — same UX, minus the dev-server backend.
- The editable-tag whitelist and "is this element safe to edit inline" checks.
- `selectorFor()` — id-anchored `nth-of-type` selector generation.
- Note categories, numbered markers, per-page grouping in the export.
- `prevText`/`nextText` context capture for disambiguating identical elements.
- The markdown export shape (adapted: selectors + context replace
  `sourceFile:line`, which doesn't exist on arbitrary sites).

## Technical notes

- **Manifest V3**, plain content script + vendored assets; no framework needed
  for the toolbar UI, no build step beyond bundling the content script.
- **Storage:** `chrome.storage.local`, keyed per origin; panel shows all pages.
- **Iframes:** one toolbar and review panel live in the top document. The
  background worker routes mode changes and saved feedback between content
  scripts, including cross-origin, nested, narrow and dynamically loaded
  frames. Highlights and editing stay inside each frame. No minimum size or
  additional permissions are required. Chrome must allow the extension to run
  on the frame's URL; browser-internal pages remain excluded.
- **Frame persistence:** the top document alone writes the review, under the
  containing site's origin. Each embedded page is keyed by containing page,
  frame URL and its chain of frame indexes, so two copies of the same URL do
  not share edits. If a site reorders its frames, old feedback remains in the
  panel/export but may no longer reattach. Exports include the frame URL,
  containing page and frame path alongside the element selector. Reviews from
  the earlier independent-frame prototype are not automatically migrated.
- **Edit re-application:** on `DOMContentLoaded` apply stored edits whose
  selector + oldText still match; re-try briefly for client-hydrated pages, and
  use a `MutationObserver` or settle-timer for SPA navigations
  (`history.pushState` / `popstate` listeners).
- **SPA navigation:** re-resolve markers and edits on URL change
  (`popstate`, `history` monkey-patch, or `navigation` API).
- **Safety:** `contenteditable` is only enabled on whitelisted inline/text
  elements; edits store both old and new text so nothing is lost; never inject
  HTML typed by the user as markup — set `innerText` only.
- **Privacy:** no network calls, no analytics. The permission set should be
  minimal: `storage`, `activeTab`/`scripting`, `clipboardWrite` (or use
  `navigator.clipboard` from the page context), and host access for content
  scripts on `http`/`https`.

## Open questions before building

- Name + icon for the Chrome Web Store listing.
- Export format toggle: always markdown, or offer a "detailed" mode (computed
  styles, tag path, screenshot) vs "simple" mode?
- Distribution: publish to the Chrome Web Store (easiest for clients) vs
  load-unpacked instructions. Web Store is the goal; review policies for
  extensions that modify pages need a clear privacy statement (easy — we collect
  nothing).

## Repo layout & development

- `extension/` — the unpacked extension (Manifest V3, no build step).
  - `manifest.json` — content script on `http(s)://*`, `Cmd/Ctrl+Shift+.` command.
  - `content.js` — everything: shadow-root toolbar, annotate/edit modes,
    `chrome.storage.local` persistence per origin+path, markdown export.
  - `background.js` — routes icon/shortcut requests to the top frame and relays
    frame messages using Chrome-provided tab and document identities.
- `tools/gen_icons.py` — regenerates `extension/icons/` (stdlib-only Python).
- `tools/smoke.mjs` — headless browser checks for annotation, editing,
  persistence, shared iframe controls, concurrent saves and combined export.
  Serve `demo/` on **both :8000 and :8001** to exercise cross-origin frames.
  The default uses a test-only Chrome API shim with the real background
  routing code. To verify actual manifest injection and Chrome messaging,
  run `AE_REAL_EXTENSION=1 AE_CHROME="/path/to/Chrome for Testing" node tools/smoke.mjs`.
  Standard branded Chrome cannot load unpacked extensions using these flags.
- `tools/background.test.mjs` — `node --test tools/background.test.mjs` checks
  that frame messages cannot escape their tab or spoof Chrome's identities.
- `demo/` — standalone multi-page site for manual testing.

### Load & test

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `extension/`.
2. Serve the demo page (`cd demo && python3 -m http.server 8000`) or open any
   site — the extension works on any `http(s)` URL.
3. Click the extension icon (or `Cmd/Ctrl+Shift+.`) to toggle the toolbar.
4. **Annotate** → click an element, type a note, save. **Edit** → click text,
   rewrite, Save. Reload the page — notes and edits should reappear.
5. **Notes** opens the per-site panel; **Copy for agent** copies the markdown.

Edits store both the rendered HTML (for faithful re-application) and normalized
plain text (for the export). The agent-facing prompt format is documented in
"Export format" above.

## License

MIT — see [LICENSE](LICENSE). Free for anyone to use.
