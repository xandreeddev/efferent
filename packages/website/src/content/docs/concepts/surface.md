---
title: Surface — the UI substrate
description: The html template, the allowlist sanitizer as a security boundary, and validateUi as a feedback boundary.
---

`@xandreed/surface` is the pure UI substrate the browser-facing agents build
on — server-rendered strings, htmx for agent actions, no framework runtime.

## The sanitizer is the security boundary

Model-authored HTML crosses into markup at exactly one seam: `sanitizeHtml`,
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

[canvas](/docs/agents/canvas) renders every page through both boundaries;
[math](/docs/agents/math) uses the html template and `sanitizeMathml` for
its exercise cards. Both own their views end to end — surface stays pure and
imports nothing internal.
