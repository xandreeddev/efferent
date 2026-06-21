# Branded Types — Phased Roadmap

Execution roadmap for extending Effect `Schema` branded types across
`@xandreed/sdk-core`, so domain primitives (ids, model refs, paths, tokens, secrets)
stop being interchangeable bare `string`/`number`.

**Status:** Phase 1 shipped (branch `brand/contextnodeid-reclaim`, commit
`7ff61bc`). Phases 2–4 are unstarted — pick up here if/when it's worth it.

This is the *execution* view. The original field-by-field inventory (a more maximalist plan) is archived and no longer maintained.
**This doc is authoritative** — it reconciles that plan against a construction/decode audit
(see "Deltas" below), and where the two disagree this doc wins.

## Why brand at all

Make illegal states unrepresentable at the type level: you can't pass a `folder`
where a `modelRef` is expected, can't add `inputTokens` to a `messagePosition`,
can't leak an un-redacted API key, can't hand a raw user string into a function
expecting a validated id. Brands erase to their base type on `Schema.encode`, so
**no JSON/DB shape change and no migration** — only added `decode` calls on read
paths, and compile errors at every newly-typed call site (that's the point).

## House style — Mixed (`Schema.brand` + `Brand.nominal`)

- **`Schema.brand`** (over `Schema.UUID`/`String`/`Number`) for anything that
  decodes at a boundary — DB rows, user/model input, tool I/O. Matches the two
  existing ids (`ConversationId`, `ContextNodeId`).
- **`Brand.nominal<T>()`** (zero runtime cost) for pure intra-core type brands
  that never need runtime validation and never cross a decode boundary.
- **Refined** (`Schema.brand` + a filter: UUID, `provider:modelId`, non-empty,
  `NonNegativeInt`, http(s)) where there's a real invariant worth enforcing;
  **nominal** where the only goal is confusability protection.

## Rubric — brand a primitive when it scores high on

1. **Confusability** — could it be swapped with another same-typed value at a
   call site and still compile? (`folder`/`displayRoot`/`path`; `inputTokens`/
   `messagePosition`.)
2. **Reach** — how many signatures pass it around.
3. **Invariant worth enforcing** — favors a *refined* brand; pure confusability
   favors a *nominal* one.
4. **Boundary clarity** — few mint/decode points = cheap to adopt.
5. **Security signal** — secrets benefit from a brand paired with `Redacted`.

Skip when the value is free-form (`summary`, `content`, `query`, prompt text),
provider-opaque passthrough (`providerOptions`), or used in one place.

---

## Phase 1 — `ContextNodeId` reclaim — DONE

Pure type-level reclaim of a brand that was already minted but silently widened
back to `string`. Zero new brands, zero runtime change.

- `entities/AgentHooks.ts` — `subAgentNodeId` / `nodeId` / `parentNodeId` on the
  sub-agent + tool hook events: `string` → `ContextNodeId`.
- `usecases/buildScopeRuntime.ts` — the actual bug: `ScopeRuntime.resumeNode`'s
  return type widened a real `ContextNodeId` to `string`. Fixed, plus
  `makeInnerHooks`/`RunSpawnedArgs.parentNodeId` params and the `run_agent`
  tool's `success.nodeId` schema (now a branded UUID; `seedFromNode` input is
  still decoded at its boundary).
- `ports/ConversationStore.ts` / `ports/ContextTreeStore.ts` — error `.id`
  fields → `ConversationId` / `ContextNodeId` (every constructor already passed a
  branded value).

**Two deliberate deviations from the original plan:**

1. **`AgentEvent.nodeId` (cli/events.ts) stays `string`.** It's the cross-mode
   *wire* vocabulary (serialized to JSONL in json mode). Branding it would force
   ~4 test files to brand `"n1"` literals for zero production gain — production
   builds these events only in `makeEventHooks`, copying already-branded core
   values. The brand now widens *explicitly and documented* there, instead of
   *silently* in a return-type annotation. Boundary documented in the file.
2. **The two TUI casts** (`tui-solid/keys/dispatch.ts`, `keys/overlay.ts`) left
   as-is. They're `ConversationId` casts (orthogonal to this reclaim), the nav
   rows genuinely carry `id: string` (`contextTreeView.ts`), and the values are
   safe-by-contract (sourced from a decoded `listByWorkspace`). A runtime decode
   there would push Effect/failure-handling into synchronous key handlers for an
   "impossible" failure. Revisit if those handlers ever go effectful.

Gate: `bun run typecheck` (tsc + the no-try/catch AST ban) clean; `bun test`
459 pass.

---

## Phase 2 — `ModelRef` + sandbox `ScopeDir` (medium reach, medium risk)

The two highest-reach domain types.

- **`ModelRef`** — the `"<provider>:<modelId>"` string. Refined `Schema.brand`
  (validates the `p:m` shape). Mint in `entities/Model.ts`: `formatModel` returns
  `ModelRef`, `parseModel` consumes it. Threads through `Settings.model` /
  `fastModel` / `searchModel`, the router, and
  `ModelRegistry.select`.
- **`ScopeDir`** — the sandbox roots: `folder` / `displayRoot` / `rootDir` in
  `entities/Scope.ts`, `ScopeBinding`, `SpawnInput`, `AgentContextNode`. Nominal
  brand, minted at `ScopeBinding` construction. This is the *security-relevant*
  path (writes/bash confined here) — the one path type worth branding.
- **NOT** generic tool `path`/`dir` params (`read_file`, `grep`, `glob`, `ls`):
  too polymorphic (relative/absolute/glob/pattern) — one brand would lie. Stay
  `string`.

Risk: touches router + settings persistence; no DB migration. Gate: typecheck +
a property test that `parseModel ∘ formatModel` round-trips.

## Phase 3 — tokens + secrets + `ToolCallId` (viral/behavioral; isolate so revertible)

- **`TokenCount`** (refined `NonNegativeInt`) on `ContextUsage`, `TokenUsage`,
  budget Refs. Moved OUT of the original plan's Phase 1: it's arithmetic-viral
  (the `byRole` ledger, gauge math, budget draws all do `+`/comparisons), so it
  needs its own phase + small unwrap helpers. Revert in isolation if the unwrap
  noise outweighs the safety.
- **Secrets** — `ApiKey` / `AccessToken` / `RefreshToken` as branded
  **`Redacted`** on `AuthStore` credentials. The only candidate with behavioral
  value: prevents accidental key logging; unwrap with `Redacted.value` only at
  the HTTP call site in the router/registry.
- **`ToolCallId`** — nominal brand on the provider tool-call id (pairs
  `onBeforeToolCall` ↔ `onAfterToolCall`; ~20 uses). Provider-opaque → nominal.

## Phase 4 — optional deferred set (only if 2–3 pay off)

- **`MessagePosition`** (`Int`) on `Checkpoint` / store positions.
- **`SourceUrl` / `HttpUrl`** (refined http(s)) on `WebSearchSource`,
  `web_fetch`, `Http`.
- **`ToolName` as a literal union** of the toolkit's actual names — better
  encoding than a brand; separate task.
- Grab-bag from the original plan (`GitRef`, `DbUrl`, `BashRuleKey`,
  `PortNumber`, `HttpStatus`, `GlobPattern`, …) — pick by the rubric, don't bulk
  adopt.

---

## Deltas from the original plan

The archived original plan was a thorough *what/where* map but predated a construction
audit. This roadmap changes:

- **Adds Phase 1** (the `ContextNodeId` reclaim) — the original missed the
  silent brand-widening entirely; it only fixed the two error `.id` fields.
- **Mixed brand style** — the original was all `Schema.brand`; adds
  `Brand.nominal` for pure intra-core brands.
- **Moves `TokenCount` out of Phase 1** — it's not low-blast-radius (arithmetic
  viral).
- **Trims the count-brand zoo** — `LineCount` / `ByteCount` / `EditCount` /
  `Count` have near-zero confusability; pure ceremony. Dropped.
- **Narrows `FilePath`/`FolderPath`** — the original brands every `path`/`dir`
  everywhere; narrowed to sandbox roots (`ScopeDir`) only.
- **Adds secrets/`Redacted`** and **`ToolCallId`** — absent from the original.

## Process

- One branch + PR per phase; `main` is protected (CI required), so no direct
  pushes.
- `bun run typecheck` (tsc + `scripts/banTryCatch.ts`) is the primary gate —
  brands surface every mismatched call site as a compile error.
- `bun test` after each phase; property tests via `Arbitrary.make(schema)` for
  refined brands.
- No DB migration in any phase — brands erase on encode.
