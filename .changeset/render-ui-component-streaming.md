---
"@xandreed/sdk-core": minor
"efferent": minor
---

render_ui streams COMPONENTS, not whole pages — an edit swaps one region, not the tab.

`render_ui` gains an optional `region` (and `mode` gains `"remove"`): a page is now an ordered set of named components. Omit `region` to render/replace the whole page (byte-identical to before); pass one to add/edit/append/remove a single component. Re-render the same `id` + `region` and ONLY that node swaps — the sibling components, their already-rendered mermaid diagrams, the user's scroll, and any typed-in form state all stay put. That was the whole-page-clobber pain: every update outerHTML-replaced the entire `<section>`, forcing the model to re-emit the full page (the "it replaced with asian recipes" wipe), re-parsing every diagram and losing state each time.

It rides the existing keyed-OOB machinery — a new component appends into the page's keyed body (`beforeend:#uib-<page>`), an update outerHTML-replaces just its `uir-<page>␀<region>` node, a remove is an `hx-swap-oob="delete"` — so no morph/idiomorph and near-zero client change. The two-level fold (`mergeCanvasEntry`) and history replay (`canvasReplay`) share one code path, so `--resume` and reconnect reproduce the region structure. Focus for a region-only update rides the tab bar's `data-focus` (the section isn't re-shipped). A mis-addressed region degrades to an extra component (visible, recoverable) — strictly safer than the old whole-page wipe.

The `ui_render` AgentEvent carries `region?` and the widened `mode`; the web-agent prompt + kit doc teach the discipline (build from regions, reuse the EXACT name to edit, `mode:'remove'` to delete) at three salience levels. A `region_isolation` eval scorer + a component-streaming case lock the guarantee. Verified live in a real browser on kimi: new-page / new-region / update-region / rebuild / remove all swap exactly their addressed node, zero console errors.
