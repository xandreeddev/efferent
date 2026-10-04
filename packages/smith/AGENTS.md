# @xandreed/smith

Smith is the direct coding preset on the configurable Efferent plugin graph.
`bun run smith` and `bun run efferent` open the same coding workspace. The
historical spec/forge driver remains available as `bun run smith:workflow`;
specification workflows are optional, never required before a direct edit.

The user's Smith revamp explicitly authorizes controller/editor delegation.
The controller inspects, decides, reviews, applies and verifies. A cheaper
editor gets one bounded work order in a child session and stages its changes
in an isolated overlay. It cannot mutate the actual workspace, run commands,
start more workers or apply proposals. Cancellation drops unapplied changes.
Application validates original file fingerprints and workspace containment;
stale edits fail as tool data. Preserve unrelated and concurrent user changes.

Use the modern SDK `Agent.define` with configurable `ConversationMemory`,
`ToolRegistry`, `StepLoop` and `Capabilities` services. Harness admits the turn
once and supplies its `ActiveTurnWriter`; Smith must use that same writer.
The native session journal is authoritative. Do not persist duplicate native
and historical message/tool events. Child editor sessions retain their own
request, usage, tool and failure evidence.

Jev decides whether each request needs an internal implementation plan.
Planning uses the recent conversation plus the current user message. A plan
is executed immediately and does not ask the user to lock a specification.
An unavailable decision is recorded and conservatively requests a plan.
Explicit read-only planning activates no edits or verification commands.

The driver model comes from the main model setting; the editor comes from
the fast model setting and inherits the driver when unset. Loop options
`driverModel`/`editorModel` can override them. Pin choices, selected modules,
reasoning policy and budgets for the turn. Defaults: 50 model steps across
controller and editor, 12 steps per editor attempt, two attempts, 15 minutes,
64000 shared tokens and 4096 output tokens per request, and four concurrent
reads. Editor sessions and mutations are serialized; reported usage from both
roles is charged to the same budget before the next request is admitted.

Effect expertise is optional prompt functionality, not repository docs.
Six independently selectable, versioned sections are foundations, schema,
services, concurrency, ai and architecture. The `effect` profile enables all;
the normal Smith profile enables none. Module selection is a per-turn loop
setting, so changes apply on the next turn without restarting the runtime.

Follow the repository's zero-baseline rules: Schema contracts and branded
identifiers, qualified entity/use-case pairs, Context.Service ports and Layer
adapters. Use Option, Match, immutable values and Effect-native concurrency;
no let/var, imperative loops, throw, try/catch, raw Promise orchestration in
domain code, nullable domain returns or unsafe type laundering. Foreign IO
belongs at adapter boundaries. TUI presentation belongs in `packages/tui`,
which must not import Smith.

Keep legacy public exports, stored specifications and Foundry artifacts.
New sessions use `.efferent/runtime`; never delete `.efferent/smith.db` or old
local state to reset a run. Publishing requires its existing repository rules;
this task does not authorize publication.

Validate the production controller/editor path, planning decisions, optional
modules, replay, cancellation, budgets and read-only restrictions. Test real
provider request/response adapters with injected transport for scripted evals;
provider-backed paid runs require explicit credentials/configuration.
New Smith evaluations use the native `@xandreed/evals` calibration API:
`defineCalibration` declares the dataset, candidate codec, isolated subject,
evaluators, gates and host selection policy; `runCalibration` executes it.
Build candidate services fresh for each case. Give the subject inputs only;
reference labels belong to evaluators. Retain production journal, transport,
diff, acceptance and architecture-check evidence. Hard or infrastructure
failures must fail blocking gates. Do not add new retired Pack/Scenario
definitions or legacy baselines for Smith. Scripted transport proves wiring,
not held-out model quality or cost; it must not recommend or promote a model.
`bun run evals:smith:check` runs both native regressions without provider
credentials. Finish with `bun run typecheck`; do not weaken
architecture or calibration gates.
