---
title: Surface — the UI substrate
description: The trusted token-and-recipe compiler, escaped HTML substrate, legacy sanitizer, and deterministic UI feedback boundaries.
---

`@xandreed/surface` is the trusted compiler used by browser-facing hosts. For
the UI agent it converts a catalog-backed component graph into escaped semantic
HTML, registered HTMX actions, fixed CSP-Alpine behaviors, scoped token CSS,
and accessible server-rendered diagrams. The model never authors markup.

Validated DesignTokensV2 can change semantic colors and derived shades,
registered font stacks, type scale, spacing, border weight, density, radii,
elevation, contrast, and motion. Themes are scoped by fingerprint so multiple
surfaces can coexist without global CSS mutation.

Core layout, navigation, primitive, form, application, marketing, document,
and feedback components map to trusted renderer categories. Workspace
components use a bounded flat template AST containing only safe semantic tags,
roles, literal/prop text bindings, and child references. Surface—not the
model—chooses classes and behavior. Cycles, missing nodes, and invalid
definitions become visible governed findings.

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
