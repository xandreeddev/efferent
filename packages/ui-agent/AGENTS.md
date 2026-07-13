# @xandreed/ui-agent

The shared UI agent is a structured compiler client, never an HTML author.

- `domain/*.entity.ts` contains Schema contracts and derived types only.
- `*.functions.ts` contains domain behavior expressed with Effect/combinators.
- `ports/*.port.ts` contains Context contracts. Adapters provide Layers.
- Model output is a flat graph of catalog-backed component nodes and semantic
  theme deltas. Raw HTML, CSS, class names, arbitrary attributes, HTMX, Alpine,
  JavaScript, SVG, and URLs are never part of the vocabulary.
- `CORE_UI_COMPONENTS` is the stable base catalog. Retrieve a small relevant
  subset for each request. Reuse or add a variant before admitting a workspace
  component; new anatomy is a constrained template AST, validated and
  fingerprinted before persistence. Styling differences belong in themes.
- The trusted catalog is evolutionary but monotonic: never mutate a core
  definition in place, silently replace an admitted fingerprint, or let model
  output bypass prop/variant/behavior validation.
- `patch_ui_prop` is the smallest progressive paint operation. It must load an
  already accepted node, validate the resulting complete prop object against
  its component definition, then persist the normal block-upsert event.
- Persist an accepted event before publishing it to a browser.
- `profiles/streaming-ui-v1.json` is the reusable default execution profile.
  Hosts load and validate it; it pins models, effort, budgets, prompt/schema/
  recipe versions, fallback, and the incremental generation protocol. Hosts
  configure tokens/capabilities, not prompts or ad-hoc model roles.
- `compact-lines`, `a2ui-jsonl`, and `native-tools` are transport choices, not
  different products. Every decoded record invokes the same toolkit handler,
  validation, persistence, error conversion, and browser sink. A fast protocol
  may reduce provider buffering; it may not generate local substitute content.
- The model planner owns recipe selection, manifest, information architecture,
  and first blocks. No page event may exist before an accepted `start_ui` tool
  call, and no local content fallback may mark a model failure successful.
- Model composition runs in one replaceable background fiber; follow-ups
  interrupt the prior attempt.
- Each composition attempt uses an isolated child conversation containing the
  exact request and accepted page. Never replay a cancelled partial attempt
  into a follow-up.
- UI profile changes are accepted only with a real-model, real-Canvas browser
  matrix. Keep provider errors as semantic evidence, capture desktop/mobile
  screenshots and overflow, and use `--strict` only when failure should control
  the command exit code; exploratory matrices must still write every trial.
