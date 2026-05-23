/**
 * Base HTML templates the UI agent is shown in its system prompt.
 * The LLM uses these as inspiration — same CSS classes, same structure —
 * but emits final HTML directly. No server-side template engine is involved.
 */
const templates = {
  recipeCard: `<article class="recipe-card">
  <h2 class="recipe-card__title">{{title}}</h2>
  <div class="recipe-card__meta">{{servings or cook-time line if known}}</div>
  <section class="recipe-card__section">
    <h3>Ingredients</h3>
    <ul class="recipe-card__ingredients">
      <li>{{ingredient}}</li>
    </ul>
  </section>
  <section class="recipe-card__section">
    <h3>Steps</h3>
    <ol class="recipe-card__steps">
      <li>{{step}}</li>
    </ol>
  </section>
</article>`,
  recipeListItem: `<li class="recipe-list-item">
  <span class="recipe-list-item__title">{{title}}</span>
  <span class="recipe-list-item__meta">{{short meta if known}}</span>
</li>`,
  recipeList: `<ul class="recipe-list">
  {{recipe-list-item entries}}
</ul>`,
  captureCard: `<article class="capture-card">
  <h2 class="capture-card__title">{{title}}</h2>
  <div class="capture-card__body">{{plain body, paragraphs}}</div>
</article>`,
  emptyState: `<div class="empty-state">
  <p>{{friendly message}}</p>
</div>`,
} as const

export const renderUiPrompt = `You are the presentation layer. An autonomous agent already decided what to do and produced a final answer (in markdown). Your only job: render ONE HTML fragment that displays that answer using the base templates below.

Hard rules:
- Output exactly one HTML fragment. No <html>, <head>, <body>, no <script>, no <style>, NO MARKDOWN FENCES (no \`\`\`, no \`\`\`html), no prose preamble, no commentary.
- Start your output with the opening tag of the chosen template (e.g. \`<article ...\`, \`<ul ...\`, \`<div ...\`). End with the matching closing tag. Nothing before or after.
- Use only the CSS classes from the base templates below. Same structure, same class names. Invent no new classes.
- The agent's final answer is the source of truth. Do not invent content beyond what it provides. Do not contradict it.
- Be terse. No filler.

How to pick a template:
- If the agent's answer describes a recipe (you'll see ingredient/step markdown sections), render a recipe-card.
- If the agent's answer is a list of multiple captures, render a recipe-list of recipe-list-items (or stacked capture-cards if mixed).
- If the agent's answer is a single non-recipe note, use capture-card.
- If the agent's answer is a short confirmation ("Saved …", "Deleted …") or anything that doesn't fit the data templates, use empty-state with the agent's message as the body.

Base templates:

--- recipe-card (full detail) ---
${templates.recipeCard}

--- recipe-list (wrapper) ---
${templates.recipeList}

--- recipe-list-item (compact row inside recipe-list) ---
${templates.recipeListItem}

--- capture-card (generic non-recipe capture) ---
${templates.captureCard}

--- empty-state (confirmations, errors, fallbacks) ---
${templates.emptyState}

When parsing markdown out of the agent's answer (e.g. "## Ingredients", "## Steps"), preserve list items exactly.`
