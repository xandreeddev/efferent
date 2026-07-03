/**
 * The agent-facing UI-kit documentation. The cli's web driver injects this as
 * an instruction-file section so the model knows the page vocabulary when it
 * calls `render_ui`. Keep it tight: every class listed here exists in
 * assets/kit.css (or app.css), and everything not listed is subject to the
 * sanitizer. The behavioral rule (pages, never punt to disk) also lives in
 * the system prompt (`prompts/web.ts`) and the tool description — repeated
 * on purpose.
 */
export const RENDER_UI_KIT_DOC = `# Web UI kit (render_ui) — you build pages

\`render_ui\` builds full PAGES in the user's browser: each \`id\` is a page (a tab they
navigate), \`title\` is its tab label. Re-render the SAME id to update that page in place;
\`mode:'append'\` streams a long page section by section. Build one coherent page per
artifact — an architecture overview, a landing page, a comparison, a data breakdown, a
lesson — not a scatter of cardlets.

## When to render (the rule)

When the user asks to see, understand, explore, compare, analyze, or learn anything, the
answer IS a page. NEVER write an .md/.html file to disk as a way to show the user
something, and never tell them to open a file in another viewer — they are looking at a
browser you control. A follow-up about what's on screen (the message may carry
\`[viewing:<page-id>]\`) updates THAT page; a genuinely distinct artifact gets a new id.

## Compose a PAGE, not a flat list

A page is NOT a vertical stack of heading→paragraph→heading. Real pages are built from
full-bleed BANDS stacked top to bottom, and WITHIN a band the content goes side by side —
columns, a diagram beside its explanation, an article with a facts sidebar. If your output
is one narrow column of prose, you have failed the task. Reach for a multi-column layout in
every page.

**The page is a stack of bands.** A direct child of your HTML that is an \`ef-hero\` or an
\`ef-band\` spans the full width of the stage; alternate plain and tinted bands for rhythm.
Everything inside a band lays out horizontally:

- **Hero band** (the opener): \`<div class="ef-hero"><p class="ef-eyebrow">…</p><h1 class="ef-hero-title">…</h1><p class="ef-hero-sub">…</p><div class="ef-hero-actions"><button class="ef-btn ef-btn--primary">…</button></div></div>\`
- **Band**: \`<div class="ef-band">…</div>\` — full-bleed row. \`ef-band--panel\` / \`ef-band--raised\` tint it (alternate for the page rhythm); \`ef-band--tight\` for shorter padding.
- **Split** (main + sidebar): \`<div class="ef-split"><div>…main content…</div><aside class="ef-aside">…facts / links / a stat…</aside></div>\`. \`ef-split--rev\` puts the aside first, \`ef-split--even\` makes it 50/50.
- **Media** (diagram beside text): \`<div class="ef-media"><figure class="ef-figure"><pre class="ef-mermaid">…</pre></figure><div>…explanation…</div></div>\`. \`ef-media--rev\` flips the sides — alternate down the page.
- **Columns**: \`ef-cols-2\` / \`ef-cols-3\` / \`ef-cols-4\` (grid children; \`ef-span-2\` widens one). \`ef-grid-2\` / \`ef-grid-3\` for tighter card grids.
- **Feature grid**: \`<div class="ef-features"><div class="ef-feature"><p class="ef-title">…</p><p class="ef-text">…</p></div>…</div>\`
- **Stats row**: \`<div class="ef-stats"><div class="ef-stat"><div class="ef-stat-value">1.2k</div><div class="ef-stat-label">downloads</div></div>…</div>\`
- **Sections** (a titled block inside a band): \`<section class="ef-section"><div class="ef-section-head"><p class="ef-eyebrow">…</p><h2>…</h2></div>…</section>\` — headings h1–h3 encouraged.
- **Steps / derivations**: \`<ol class="ef-steps"><li class="ef-step">…</li>…</ol>\` — auto-numbered; how-tos and math derivations.
- **Typography**: \`ef-display\` (huge), \`ef-lede\` (intro line), \`ef-eyebrow\` (small-caps kicker).

Worked example — a landing page as a stack of bands, each with side-by-side content:

\`\`\`html
<div class="ef-hero">
  <p class="ef-eyebrow">open source</p>
  <h1 class="ef-hero-title">Driftline</h1>
  <p class="ef-hero-sub">Flight tracking for people who read the sky.</p>
  <div class="ef-hero-actions"><button class="ef-btn ef-btn--primary">Get started</button></div>
</div>
<div class="ef-band">
  <div class="ef-features">
    <div class="ef-feature"><p class="ef-title">Live</p><p class="ef-text">…</p></div>
    <div class="ef-feature"><p class="ef-title">Light</p><p class="ef-text">…</p></div>
    <div class="ef-feature"><p class="ef-title">Open</p><p class="ef-text">…</p></div>
  </div>
</div>
<div class="ef-band ef-band--panel">
  <div class="ef-media">
    <figure class="ef-figure"><pre class="ef-mermaid">graph LR
  Plane["ADS-B feed"] --> Driftline --> You["Your map"]</pre></figure>
    <div>
      <h2>How it works</h2>
      <p class="ef-text">Driftline ingests raw ADS-B and streams clean tracks to your app…</p>
    </div>
  </div>
</div>
<div class="ef-band">
  <div class="ef-split">
    <div>
      <h2>Get started</h2>
      <ol class="ef-steps"><li class="ef-step">Install the package.</li><li class="ef-step">Point it at a feed.</li></ol>
    </div>
    <aside class="ef-aside">
      <div class="ef-stats"><div class="ef-stat"><div class="ef-stat-value">4.8k</div><div class="ef-stat-label">stars</div></div></div>
    </aside>
  </div>
</div>
\`\`\`

## Diagrams & charts (Mermaid)

Author Mermaid SOURCE — never draw diagrams with divs or SVG (SVG is stripped):

\`\`\`html
<pre class="ef-mermaid">graph TD
  CLI["efferent CLI"] --> Core["sdk-core"]
  CLI --> Adapters["sdk-adapters"] --> Core</pre>
\`\`\`

The client renders it to a themed diagram. One diagram per pre block; quote node labels
containing spaces/punctuation. Flowcharts (\`graph TD/LR\`), \`sequenceDiagram\`,
\`classDiagram\`, \`erDiagram\`, \`stateDiagram-v2\` all work — and for data, \`pie\` and
\`xychart-beta\` give you charts. In chat prose, \\\`\\\`\\\`mermaid fences render too.

## Data & math pages

For a breakdown of numbers the user gave you: an \`ef-table\` with the actual figures, an
\`ef-stats\` row for the headline numbers, an \`ef-steps\` list showing the derivation
(so the arithmetic is checkable), and a mermaid \`pie\`/\`xychart-beta\` for the shape of
the data. Never invent data — compute from what they provided.

## Components (CSS classes — these are the ONLY classes that exist)

Avoid inventing utility classes: Tailwind-style spacing/typography names
(\`ef-text-xl\`, \`ef-py-6\`, \`ef-mb-4\`, \`ef-w-full\`, \`ef-uppercase\`…) style NOTHING
and just bloat the page — use the components below for text and spacing. (Layout
names \`ef-grid\`, \`ef-grid-cols-2/3/4\`, \`ef-col\`, \`ef-flex\`, \`ef-container\`,
\`ef-section-alt\`/\`ef-section-dark\` DO work as aliases, but the named recipes above
— \`ef-band\`, \`ef-split\`, \`ef-media\`, \`ef-cols-2/3\` — are clearer.)

- Page layout: \`ef-band\` (+\`--panel\` / \`--raised\` / \`--tight\`), \`ef-split\` (+\`--rev\` / \`--even\`), \`ef-aside\`, \`ef-media\` (+\`--rev\`), \`ef-cols-2\`/\`-3\`/\`-4\` (+\`ef-span-2\`)
- Layout: \`ef-stack\` (vertical), \`ef-row\` (horizontal), \`ef-grid-2\`, \`ef-grid-3\`, density \`ef-tight\` / \`ef-loose\`
- Surfaces: \`ef-card\` (padded panel), \`ef-divider\` (hr), \`ef-callout\` / \`ef-callout--info\` / \`ef-callout--warn\`, \`ef-figure\` (on <figure>, with <figcaption>)
- Text: \`ef-title\`, \`ef-text\`, \`ef-muted\`, \`ef-kbd\` (keyboard key), \`ef-code\` (inline code on <code>)
- Buttons: \`ef-btn\`, \`ef-btn--primary\` (one per form), \`ef-btn--ghost\`
- Forms: \`ef-field\` (label+input column), \`ef-label\`, \`ef-input\`, \`ef-textarea\`, \`ef-select\`, \`ef-choice\` (a <label> wrapping a radio/checkbox + text)
- Status: \`ef-badge\`, \`ef-badge--ok\` / \`--warn\` / \`--err\`, \`ef-progress\` (on <progress>)
- Media: \`ef-img\` (https images only); tables: \`ef-table\`

## Interactive forms — how input reaches you

Give every form: \`hx-post="/action/ui" hx-swap="none"\` and a hidden field
\`<input type="hidden" name="ui-id" value="<your render_ui id>" />\`.
When the user submits, the fields arrive as your next user message:
\`[ui:<id>] fieldname="value" …\`. Respond in prose and/or re-render the same page id
with feedback.

Example (a quiz inside a lesson page):

\`\`\`html
<form class="ef-stack" hx-post="/action/ui" hx-swap="none">
  <input type="hidden" name="ui-id" value="lesson-1" />
  <p class="ef-text">What is 1/2 + 1/4?</p>
  <label class="ef-choice"><input type="radio" name="answer" value="a" /> 2/6</label>
  <label class="ef-choice"><input type="radio" name="answer" value="b" /> 3/4</label>
  <button class="ef-btn ef-btn--primary" type="submit">Check</button>
</form>
\`\`\`

## Sanitizer rules (violations are silently stripped)

- No <script>, <style>, <iframe>, <svg>, inline \`style\`, or \`on*\`/\`hx-on\` handlers.
- Forms may ONLY post to \`/action/…\`; links must be https or relative
  (external links open in a new tab); images https only.
- Input types: text, number, hidden, radio, checkbox, range, email, submit, button, date, color, time.
- Your element ids must not start with \`ef-\`, \`blk-\`, \`ws-\` or \`ui-\`.

## Page discipline

- Give every page a \`title\` on its first render (it's the tab label).
- Update in place for feedback and refinements (same id); open a second page only for a
  genuinely distinct artifact. Pages persist across the session.
- Keep one render_ui call under ~128KB; stream longer pages with \`mode:'append'\` rather
  than one giant call, and split into a second page past ~200KB total.`
