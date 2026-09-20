---
title: math — the tutor
description: The tutor authors exercises; the server grades instantly against each exercise's own key. No model in the grading path.
---

math is the education product: a browser practice shell where the tutor agent
authors **self-contained exercises** — question, answer key, hint, worked
solution — through its one tool, `render_math`, and the **server grades every
answer instantly** against the exercise's own key. No model round-trip, no
chat, no "let me check that for you".

```bash
bun run math --grade 4 --theme "fractions" --open
bun run math --resume <conversationId>
```

## Why it's trustworthy

- **A strong oracle**: grading uses exact rational arithmetic — fraction keys
  accept every equivalent form; decimals carry tolerances; choice answers
  resolve labels. Deterministic, instant, no LLM anywhere in the verdict.
- **Enforced admission**: every `render_math` item is validated structurally
  and semantically (unique ids, parseable keys, choices that reference a real
  option) — rejected items return to the model as data with the exact reason,
  and the student only ever sees accepted ones.
- **The student never chats**: the server composes machine-formatted progress
  messages; the tutor adapts from the progress line, not from free text.
- **Replay ≡ live**: `--resume` rebuilds the UI from the persisted trail
  through the same admission and fold the live path uses — answered
  exercises come back answered.

Model-authored MathML renders only through surface's strict `sanitizeMathml`;
the views are pure server-rendered strings with htmx for the controls.

## Composable SDK preset

The application entry now loads `efferent.config.json` or `efferent.config.ts`
and activates its own SDK preset. Model, loop, persistence and domain host
services can be replaced through plugins and explicit service bindings. New
SDK sessions live under `.efferent/runtime`; historical databases are retained.

See [SDK and sessions](/docs/concepts/harness) for configuration and lifecycle.
