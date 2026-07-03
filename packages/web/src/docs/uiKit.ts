/**
 * The agent-facing UI-kit documentation, injected as an instruction-file
 * section so the model knows how to style `render_ui` pages. The web UI ships
 * the Tailwind CSS runtime, so the agent styles pages with real Tailwind
 * utility classes — its native, expert output (the same way Vercel v0 and
 * Lovable produce polished UIs). No bespoke component kit to learn.
 */
export const RENDER_UI_KIT_DOC = `# Web UI kit (render_ui) — design beautiful pages with Tailwind

render_ui builds a PAGE in the user's browser and you style it with **Tailwind CSS**
utility classes (the full Tailwind runtime is loaded). Write pages the way a top
product designer using v0/Lovable would — modern, polished, and visually rich. Each
\`id\` is a page (a tab); \`title\` is its tab label. Re-render the same id to update it;
\`mode:'append'\` streams a long page in sections.

## Design bar (hit this every time)

- **A real page, not a flat column.** Open with a strong hero, then well-spaced
  sections. Lay content out in grids — \`grid grid-cols-1 md:grid-cols-3 gap-6\`,
  \`flex\` rows — never one narrow column of paragraphs.
- **Whitespace & rhythm:** \`max-w-6xl mx-auto px-6\`, section padding \`py-16\`,
  \`space-y-6\`. Let it breathe.
- **Type hierarchy:** headings \`text-4xl md:text-5xl font-bold tracking-tight\`,
  lead \`text-lg text-slate-300 leading-relaxed\`, labels \`text-sm uppercase
  tracking-widest text-slate-400\`.
- **Depth & polish:** subtle gradients (\`bg-gradient-to-br from-indigo-600 to-purple-600\`),
  soft shadows (\`shadow-lg\`, \`shadow-xl\`), rounded corners (\`rounded-2xl\`),
  borders (\`border border-white/10\`), hover/transition (\`hover:scale-[1.02]
  transition\`).
- **A committed palette.** Dark, sleek surfaces read premium — e.g. a page on
  \`bg-slate-950 text-slate-100\` with one accent colour (indigo / emerald / rose).
  Pick one and use it consistently.

## Page skeleton

Wrap the whole page in a full-bleed root that owns the background and fills the
height, then center the content:

\`\`\`html
<div class="min-h-full bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100">
  <!-- hero -->
  <header class="max-w-6xl mx-auto px-6 pt-20 pb-16">
    <p class="text-sm uppercase tracking-widest text-indigo-400 mb-3">Open source</p>
    <h1 class="text-5xl font-bold tracking-tight mb-4">Driftline</h1>
    <p class="text-xl text-slate-300 max-w-2xl mb-8">Flight tracking for people who read the sky.</p>
    <button class="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-semibold transition">Get started</button>
  </header>
  <!-- features -->
  <section class="max-w-6xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-3 gap-6">
    <div class="rounded-2xl border border-white/10 bg-white/5 p-6">
      <h3 class="text-lg font-semibold mb-2">Live</h3>
      <p class="text-slate-400">Real-time positions streamed to your app.</p>
    </div>
    <!-- …two more cards… -->
  </section>
  <!-- stats -->
  <section class="max-w-6xl mx-auto px-6 py-12 grid grid-cols-3 gap-6 text-center">
    <div><div class="text-4xl font-bold text-indigo-400">4.8k</div><div class="text-slate-400 mt-1">stars</div></div>
    <!-- … -->
  </section>
</div>
\`\`\`

## Diagrams & charts (Mermaid)

Author Mermaid SOURCE (never SVG — it's stripped). One diagram per block:

\`\`\`html
<pre class="mermaid">sequenceDiagram
  participant U as User
  participant C as Client
  participant A as Auth Server
  U->>C: click login
  C->>A: authorize request
  A-->>C: code
  C->>A: exchange code
  A-->>C: access token</pre>
\`\`\`

Flowcharts (\`graph TD/LR\`), \`sequenceDiagram\`, \`classDiagram\`, \`erDiagram\`,
\`stateDiagram-v2\`, and for data \`pie\` / \`xychart-beta\` all render. Put a diagram in a
styled card (\`rounded-2xl border border-white/10 bg-white/5 p-6\`) beside its
explanation. In chat prose, \\\`\\\`\\\`mermaid fences render too.

## Data & math pages

Build from the numbers the user gave you (never invent data): a Tailwind \`<table>\`
(\`w-full text-left\`, header row \`text-slate-400\`), big headline figures in a stats
grid, a short derivation, and a mermaid \`pie\`/\`xychart-beta\`. Show computed totals
and check the arithmetic.

## Interactive forms — how input reaches you

Style the form with Tailwind; give it \`hx-post="/action/ui" hx-swap="none"\` and a
hidden field \`<input type="hidden" name="ui-id" value="<your render_ui id>" />\`.
On submit the fields arrive as your next user message: \`[ui:<id>] field="value" …\`.
Respond in one line and/or re-render the same page id with feedback.

\`\`\`html
<form class="max-w-md space-y-4" hx-post="/action/ui" hx-swap="none">
  <input type="hidden" name="ui-id" value="quiz-1" />
  <p class="text-lg font-medium">What is 1/2 + 1/4?</p>
  <label class="flex items-center gap-2"><input type="radio" name="answer" value="a" /> 2/6</label>
  <label class="flex items-center gap-2"><input type="radio" name="answer" value="b" /> 3/4</label>
  <button type="submit" class="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-semibold transition">Check</button>
</form>
\`\`\`

## Rules

- Style with Tailwind utility classes ONLY. NO inline \`style\` attributes, NO
  \`<script>\`/\`<style>\`, NO \`on*\` handlers — all are stripped. Images are \`<img>\`
  with https URLs.
- Forms may only post to \`/action/…\`; links must be https or relative.
- Give every page a \`title\` on its first render. Update in place for feedback (same
  id); open a new id only for a genuinely distinct artifact.
- Keep one render_ui call under ~128KB; stream longer pages with \`mode:'append'\`.`
