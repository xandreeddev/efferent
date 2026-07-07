# @xandreed/surface

The new line's UI substrate — the pieces every browser-facing agent shares.
Runtime dep: `effect` only (pure; the sanitizer's tokenizer folds through
`Effect.iterate` + `runSync`, no IO). Imports nothing internal; agents import
surface, never the reverse.

- `html.ts` — the `html` tagged template (auto-escape), `raw` (sanitizer
  output + vendored assets ONLY), `join`, `render`.
- `contract.ts` — `ACTION_PREFIX` + `UI_ID_FIELD`, the browser↔server
  protocol constants the sanitizer and validator both key on.
- `sanitize.ts` — the allowlist sanitizer for agent-authored HTML: the
  SECURITY boundary (silently repairs). Its attack-case tests are the spec,
  carried verbatim from the proven previous-line suite.
- `validate.ts` — the FEEDBACK boundary: deterministic hard gates
  (dangerous-vocabulary via a sanitizer dry-run, hx-wiring, a11y-min,
  no-arbitrary-value classes) that turn what the sanitizer would silently
  strip into typed findings the model must fix. Agents reject a `render_ui`
  call on any finding (`failureMode: "return"`).

ZERO-entry ratchet baseline; boundaries-gated. Page shells, kit CSS, and
vendored htmx assets belong to the consuming agent packages (canvas owns its
shell) — surface stays markup-substrate only.
