# Service generations and durable UI output

Capability modules expose domain schemas and Context.Tag ports. Live/test
adapters are Layers, selected at the composition edge. A running agent must pin
its selected service generation: replacing a module must not change the meaning
of a tool halfway through a run.

`makeLiveLayer` in `@xandreed/runtime` stages a replacement in its own Scope,
keeps the previous generation available if staging fails, and releases retired
resources after their last user finishes. Use `registry.use(program)` around a
single run; wrapping a perpetual worker pins that worker forever. The existing
SDK's session plugin refresh also applies changes between runs. Runtime storage
changes that require migration remain a separate restart/migration boundary.

The loop's `activeTools` callback is consulted at each turn. A capability
expansion tool can resolve approved recipes and update a Ref; the next request
then receives that exact tool subset. Tool handlers must still enforce their own
permissions. The `isComplete` callback lets a host end the loop after durable
tool delivery without paying for an unnecessary closing prose request.

## UI host plugin

Use the minimal `@xandreed/ui-agent/output` entrypoint. `UiOutput.emit` accepts a
structured proposal with exact release identifiers and source evidence IDs.
The admission port validates the catalog/schema and the journal port commits
an authorized, fenced, idempotent revision. The journal owns persistence before
publication. The framework never evaluates model-authored markup or code.

A release pins component version, definition hash, renderer release, token hash
and layout version. A host must retain historical renderers or provide a safe
read-only fallback. It must check revocation both when committing and replaying.
UI tools are provided separately from other AgentTools so the host can compose
its approved toolkit explicitly.

## Model and evaluation boundaries

`@xandreed/plugin-models/compat` provides the Effect LanguageModel port over a
compatible chat-completions endpoint. It supports structured-output schemas,
AbortSignal propagation through response consumption, and request hooks for
budget reservations/accounting. Provider-specific decisions stay in adapters.

`@xandreed/evals` defines journey actions, personas, tiers, expectations,
observations, trials, calibration cases and experiment candidates. A scoped
JourneyDriver invokes the real host transport. JourneyEvidence persists every
trial, including timeouts and unexpected driver defects. The library neither
assumes a browser implementation nor selects a tracing vendor. JSON artifacts
encode optional infrastructure errors as null/string and hydrate through Schema.

Selection scores include precision, recall, F2, Brier error and forbidden hits.
Exact selection is the blocking default; high recall cannot erase excess or
unauthorized capabilities. Aggregate denominators retain failures, and an empty
experiment never passes. Probabilities are inputs to calibration, not proof that
a judge is calibrated or that an answer is correct.
