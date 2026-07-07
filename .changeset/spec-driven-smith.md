---
"@xandreed/sdk-core": minor
---

The spec-driven pipeline's shared core: `SpecDoc` (Schema.Class — branded
slug, draft|locked, limits, gate overrides, machine-checkable checks) with a
deterministic markdown codec (`decodeSpecDocText`/`encodeSpecDocText` over the
shared flat frontmatter parser + a strict section grammar, typed
`SpecDocParseError`), `renderSpecSection`, and the spec REFINER agent core:
`propose_spec` (the only way a draft changes), `specRefinerToolkit`
(read-only workspace tools + the one write), `makeSpecRefinerHandlers`
(session-stable slug identity), `specRefinerAgentConfig`, and the refiner
prompt. Consumed by `@xandreed/smith` v2 (`smith spec` → `:lock` →
`smith forge`) and, next, the CLI's `:spec` sessions.
