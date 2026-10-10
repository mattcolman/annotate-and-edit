# Changelog

## 0.4.0 — Annotate inside iframes

The headline fix: **the extension now works on sites embedded in iframes** —
preview wrappers like Devin Apps, embedded docs, and any page that hosts the
real content in a frame.

### What was broken

The content script only ran in the top document (`all_frames: false`), so on
pages that wrap the actual app in an iframe — the shape of every hosted preview
tool — the extension could never reach the content. Toggling the toolbar did
nothing.

### How it works now

- **One script, every frame.** The content script injects into every frame in
  the tab (`all_frames`), at any size — no app-sized-only heuristics — and in
  `srcdoc`, `about:` and `blob:`/`data:` frames via `match_about_blank` and
  `match_origin_as_fallback`. Cross-origin, nested and dynamically-inserted
  frames are all covered.
- **One toolbar, one panel.** The top document owns the single toolbar, notes
  panel and storage. Frames never spawn duplicate toolbars — highlights and
  in-place editing stay local to each frame's DOM.
- **Background-routed messaging.** `background.js` relays mode changes, marker
  visibility and saved feedback between the top document and child frames using
  Chrome-provided tab and document identities — a frame can't spoof another
  frame or escape its tab. Unit-tested in `tools/background.test.mjs`.
- **Frame-aware persistence.** Only the top document writes, under the
  containing site's origin. Embedded pages are keyed by containing page + frame
  URL + chain of frame indexes, so two copies of the same URL don't share edits.
  Exports carry the frame URL and path alongside each element selector.
- **Graceful limits.** Browser-internal pages remain excluded. If a site
  reorders its frames between sessions, old feedback stays in the panel and
  export but may not reattach to the live frame.

### Test coverage

73 headless smoke checks, including cross-frame notes and edits, shared export,
frame SPA navigation, srcdoc frames, outer-page reload persistence and review
archival with frame feedback.

## 0.3.0

- Keycap-style a/e shortcut chips on mode buttons; pop + ring animation on
  activation; Esc exits mode.
- Copy for agent tooltip explains both handoff paths.
- Panel header buttons stay in bounds on long hostnames.

## 0.2.0

- Numbered completed reviews: copy-gated **New review**, history view,
  per-review export/delete, header tally of applied changes, confetti.
- Off-by-default UI persisted per tab; a/e mode hotkeys (typing-safe).
- Per-note copy buttons; toolbar dragging; animated toasts.
- Fixes: edit Cancel no longer auto-commits; clicks inside an active edit can't
  navigate away; XML documents skipped.

## 0.1.0

Initial release: annotate any site, edit text live, local-first persistence,
Markdown export for AI coding agents.
