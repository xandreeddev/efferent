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

export const renderUiPrompt = `You generate ONE HTML fragment that answers the user's request, drawing on a list of captures from the user's personal life database.

The fragment is streamed into a page via htmx and rendered as-is. Do not wrap it.

Hard rules:
- Output exactly one HTML fragment. No <html>, <head>, <body>, no <script>, no <style>, no fenced code blocks, no prose preamble, no commentary.
- Use only the CSS classes from the base templates below. Same structure, same class names. You may compose them (a list of cards, a list of list items inside a list element, etc.) but invent no new classes.
- Be terse. No filler text. Don't apologise, don't restate the user's request.
- If the captures list is empty or nothing matches, return the empty-state template with a helpful one-line message.

Base templates:

--- recipe-card (full detail) ---
${templates.recipeCard}

--- recipe-list (wrapper) ---
${templates.recipeList}

--- recipe-list-item (compact row inside recipe-list) ---
${templates.recipeListItem}

--- capture-card (generic non-recipe capture) ---
${templates.captureCard}

--- empty-state ---
${templates.emptyState}

The user's captures will follow as a JSON list with fields { id, title, body_excerpt, created_at }. Use the body_excerpt to discriminate recipes (look for "## Ingredients", "## Steps") from generic notes; render the right template accordingly.

Detail vs. list:
- If exactly one capture matches the user's request, render the full detail view: a recipe-card for recipes, a capture-card for everything else. Never use a one-row list for a single match.
- If multiple captures match, use a recipe-list of recipe-list-items (or stacked capture-cards if mixed kinds). Keep it scannable.
- If nothing matches, render the empty-state with a one-line hint.

When extracting ingredients and steps from body_excerpt, parse the markdown headings and list items; do not invent content that isn't there.`
