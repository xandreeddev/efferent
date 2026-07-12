---
title: Surface — the UI substrate
description: The trusted token-and-recipe compiler, escaped HTML substrate, legacy sanitizer, and deterministic UI feedback boundaries.
---

`@xandreed/surface` is the trusted compiler used by browser-facing hosts. For
the UI agent it converts typed blocks into escaped semantic HTML, registered
HTMX actions, fixed CSP-Alpine behaviors, precompiled recipe CSS, and
accessible server-rendered diagrams. The model never authors markup.

Validated JSON tokens can change semantic colors, registered font stacks,
density, radii, shadows, and motion. Layout remains inside the versioned
landing, application, and architecture-document recipes.

## The sanitizer is the security boundary

Legacy model-authored HTML crosses into markup at exactly one seam: `sanitizeHtml`,
a strict **allowlist** (elements, attributes, URL schemes) whose attack tests
are the spec. Chrome ids and classes live on prefixes the sanitizer forbids
in agent content, so a page can never spoof its own shell. An opt-in
**alpine mode** admits `x-*`/`@*`/`:*` directives for page-local state —
but never `x-html`, never teleports, never URL-bearing binds; a strict CSP
on the shell is the browser-side backstop. `sanitizeMathml` does the same
for the math tutor's presentation MathML: one well-formed `<math>`,
presentation elements only, anything else simply doesn't render.

## validateUi is the feedback boundary

Where the sanitizer silently strips, `validateUi` **reports** — deterministic
findings (dangerous vocabulary, broken htmx wiring, missing accessibility
minimums, arbitrary utility values, self-triggering poll loops, foreign APIs
in Alpine expressions) that the calling agent returns to the model as data.
That is the [harness doctrine](/docs/concepts/harness) applied to UI: the
gate names exactly what is wrong, and the model fixes exactly that, in the
same run.

## Who builds on it

[canvas](/docs/agents/canvas) uses the structured compiler for every new page
and the sanitizer only for read-only legacy history;
[math](/docs/agents/math) uses the html template and `sanitizeMathml` for
its exercise cards. Surface imports only the UI-agent's data contracts; the
agent cannot import the renderer back.
