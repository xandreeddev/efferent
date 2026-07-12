# @xandreed/ui-agent

The shared UI agent is a structured compiler client, never an HTML author.

- `domain/*.entity.ts` contains Schema contracts and derived types only.
- `*.functions.ts` contains domain behavior expressed with Effect/combinators.
- `ports/*.port.ts` contains Context contracts. Adapters provide Layers.
- Model tools accept page manifests and governed blocks only. Raw HTML, CSS,
  class names, HTMX attributes, Alpine expressions, SVG, and URLs are not part
  of the vocabulary.
- Persist an accepted event before publishing it to a browser.
- `profiles/streaming-ui-v1.json` is the reusable default execution profile.
  Hosts load and validate it; they configure tokens/capabilities, not prompts
  or ad-hoc model roles.
- The model planner owns recipe selection, manifest, information architecture,
  and first blocks. No page event may exist before an accepted `start_ui` tool
  call, and no local content fallback may mark a model failure successful.
- Model composition runs in one replaceable background fiber; follow-ups
  interrupt the prior attempt.
- Each composition attempt uses an isolated child conversation containing the
  exact request and accepted page. Never replay a cancelled partial attempt
  into a follow-up.
