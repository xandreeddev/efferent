# Framework guide

## Runtime model

`Agent.define(config)` (from `@xandreed/sdk`) is the entry point. The runtime
validates the plugin graph, acquires runtime plugins once in the caller's
scope and activates session plugins per turn. Finalizers release resources in
reverse dependency order; a failed activation closes its partially acquired
scope. See [Composable agents](#composable-agents-the-host-composes-the-turn).

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies. Two providers of a service
require a `bindings` entry selecting the instance id. Runtime plugins cannot
require session services. Dependencies are checked before activation.

```ts
import { Layer, Schema } from "effect"
import { definePlugin, SessionEnvironment } from "@xandreed/sdk"

export default definePlugin({
  id: "example/workspace",
  version: "1.0.0",
  config: Schema.Struct({ workspace: Schema.String }),
  defaults: { workspace: "." },
  provides: [SessionEnvironment],
  layer: ({ workspace }) => Layer.succeed(SessionEnvironment, { workspace }),
})
```

A plugin's options are given where the agent is defined, as
`{ plugin, options }` entries in `Agent.define({ plugins })`. They merge over
the plugin's defaults and decode through its schema; undeclared keys are refused.

The SQLite session store uses WAL and transactional sequence allocation. The
models plugin reads existing model settings and credentials as fallbacks by
default. Explicit plugin options and current credentials win. Set its
`inheritPrevious` option to `false` to use an independent setup; new logins and
refreshed inherited credentials are written to the current credential store.

## Evals

For typed datasets, reusable evaluators, task/journey composition and native prompt
examples, see [Composable evaluations](composable-evaluations.md).

A `Journey` is a fixture and an ordered list of actions whose payloads belong to
the application's codec. The application's runnable performs the actions against
a fresh, scoped environment and records each observation through the trial's
`TrialRecorder`; graders score the recorded outcome. Typed
`Dataset<Input, Reference>` cases become tasks (`tasksFromDataset`), with
reference labels kept out of execution and available only to evaluators.

`@xandreed/evals` supplies a generic Schema domain for tasks, trials, candidates, runnables, journeys, graders, grading contexts, outcomes, suites and grader calibrations. Apps implement execution adapters, scoped environments and per-grader evidence projections. The shared runner keeps references out of execution, persists partial transcripts and terminal outcomes, and grades stored evidence independently.

`@xandreed/evals-cli` is the local Node 24 command line. Langfuse and LangSmith are separate optional official SDK export packages; reports work without credentials or provider availability. Retrieval ranking and typed semantic graders are reusable. Ordinary model/prompt comparisons are suites; calibration specifically measures grader agreement.

See [evaluation-domain.md](evaluation-domain.md) for interfaces, lifecycle, commands and package ownership.

## Distribution

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`. `bun run verify:packages` packs them, installs them
in a temporary external project through a temporary local npm registry, and exercises
SDK sessions, replacement plugins, persistence, forks and custom evals on Bun,
then imports every Node-capable package on Node. Publishing is a separate release action:
`bun run publish:packages` checks the build stamp (`.artifacts/packages/build.json`)
against the current commit and a clean tree, then publishes in dependency order; it is a
dry run unless `--publish` is passed (see [publishing](../CONTRIBUTING.md#publishing)).

## Agent-loop trace content

The loop retains provider-neutral `engine.run` and `engine.turn` spans. Each step has its one-based `engine.step`, selected tool names, finish reason and measured token usage. `captureTraceContent: true` explicitly enables `engine.step.input` (the exact Effect prompt and active tools) and `engine.step.output` (model/tool response content and usage). Content capture is disabled by default; hosts own consent, masking and exporter retention, and can map these attributes into their observability backend without changing the loop protocol.

```ts
runLoop({
  system,
  messages,
  toolkit,
  captureTraceContent: true,
  maxSteps: 8,
})
```

The trace snapshots do not modify the message buffer, tool arguments, persistence callbacks or cancellation scopes. Exporters should preserve parent IDs when naming steps or grouping use cases. A timed-out evaluation awaits scoped cleanup; browser/provider adapters must bound their own finalizers rather than leave paid work running in disconnected fibers.

## Host-planned initial tool batch

`runLoop` accepts optional `initialStep: [{ name, params }]`. A host can classify
from a finite plan set or construct a structured plan, validate the whole batch
against its permissions and references, and persist its decision before calling
the loop. The loop uses an in-memory Effect AI response to dispatch the batch
through the ordinary argument decoder and instrumented toolkit without a provider
request. The initial batch counts as step zero; completion, concurrency, events,
errors and tail persistence follow the ordinary loop path.

```ts
const result = runLoop({
  system: instructions,
  messages: history,
  toolkit,
  initialStep: [{ name: "search", params: { query: "example" } }],
  maxSteps: 5,
  onTail: persistTail,
})
```

The host must reject unsupported calls, dependencies on future results and unsafe
publication before execution. Initial planning attempts are the host's provider
measurements. The dispatch span marks `engine.step.host_planned` and
`engine.step.usage_available=false`; it does not stamp invented provider usage onto
persisted messages. Omitting `initialStep` preserves ordinary loop behavior.

### Inspectable host decisions and continuation models

`@xandreed/core` exports `DecisionRecord` and `DecisionOutcome` schemas. A record
names the finite candidates, context/candidate hashes, policy version, provider
attempt IDs, selection, host validation, applied fallback and optional reported
probabilities. The outcome links the decision to a run's tool invocations, model
attempts and delivered journal sequences. Downstream links describe chronology;
they do not prove that a selector caused an improvement. Hosts own capture,
redaction, storage, candidate eligibility and validation.

`runLoop` accepts an optional `prepareModel` hook (a turn exposes it as the
`model` function of its `TurnPolicy`):

```ts
runLoop({
  system: baseInstructions,
  messages,
  toolkit,
  initialStep: acceptedCalls,
  prepareModel: ({ stepIndex, messages, activeTools }) =>
    chooseContinuation({ stepIndex, messages, activeTools }),
})
// chooseContinuation returns an Effect of
// { model: LanguageModel.LanguageModel, system: Prompt.Prompt }.
```

The hook runs at a provider step after any initial batch, with its actual tool
results in `messages`. It does not run when the batch completes the task. Both
settled and streaming execution use the selected model and native Effect prompt.
A host wanting one route per turn caches the result in its scoped service. The
loop still validates/adopts tools through its normal host-controlled toolkit.

`@xandreed/evals` provides `DecisionTrial`, `SelectionObservation`,
`compareDecisionTrials` and `selectionMetrics`. Comparisons pair case/repetition,
bootstrap scenario groups, preserve infrastructure failures, and leave missing
costs/intervals unavailable. Choice Brier scores require a unique categorical gold
label; multiple acceptable options support accepted-error metrics but have no
unique Brier target. These helpers return evidence for a host report; they do not
promote a model or apply application-specific quality/cost policy.

## Composable agents: the host composes the turn

A composable agent is a plugin graph built once and a turn the host writes
as ordinary Effect code. Mechanisms are plugins; meaning (tools, views,
skills, step context, completion) is the host's.

| Concern | Port | Plugins |
| --- | --- | --- |
| Session storage | `SessionLog` (the host provides it) | `SessionLogMemoryLive` (core), `SessionLogSqliteLive` (`@xandreed/plugin-session-sqlite`), or the host's own |
| Sessions, turns and the inbox | `Sessions` | `@xandreed/plugin-sessions` |
| Turn admission (budgets) | `TurnAdmission` | `TurnAdmissionOpen` (core), or the host's |
| Background tasks | `Tasks` (over the host's `TaskRunner` and `TaskExecutor`) | `@xandreed/plugin-tasks` |
| Memory strategy | `ConversationMemory` | `@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary` |
| Tool digests | `ResultDigester` (optional) | `@xandreed/plugin-memory-digest` |
| Tool registry and discovery | `ToolRegistry` | `@xandreed/plugin-tool-discovery` |
| Step iteration | `StepLoop` | `stepLoopPlugin` from `@xandreed/plugin-agent-loop` |
| Host definitions | `Capabilities` (multi-provider) | `AgentConfig.capabilities`, or any plugin that `contributes` |
| Pre-turn skill selection | `IntentMatcher` (optional, per turn) | any matcher service |

**Defining the agent.** `Agent.define(config)` (from `@xandreed/sdk`) resolves
the graph and activates its runtime plugins once, in the caller's scope.
Session plugins, if any, are activated per turn with the turn's services.
Session plugins requiring `RunContext`, `TurnEvents`, `TurnTasks`,
`TurnMemory`, `TurnPrompt` or `TurnToolbox` activate after `TurnLive`, in a
scope of their own, before the host's layer (which can use their services)
and before the user's message is taken by memory: a context entry they
record at activation (`TurnMemory.context`) waits for the message. Their
dependent plugins activate in the same phase. They finalize once the turn's
body and the host's layer are done, while the turn's services are still
open. On success, work from the body, its finalizers, the host's finalizers and
the plugins' finalizers settles at each dependency boundary before the final
reply is recorded. Memory, registry and loop providers activate first: a plugin
requiring the services of an already-open turn cannot also provide those
foundations. Runtime plugins cannot require turn services. This lets a
capability ship a session plugin that installs its reactions without coupling
the loop to the capability's domain.
Swapping a strategy is swapping one entry. The host builds one `Sessions`
(see [Sessions](#sessions-one-log-per-session)) and gives the agent the same
instance its own code uses, in `services`.

```ts
const sessions = yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(
  Layer.provide(Layer.merge(SessionLogSqliteLive(".efferent/runtime/sessions.db"), TurnAdmissionOpen)),
))
const agent = yield* Agent.define({
  services: sessions,                      // Sessions: where every turn is begun and written
  plugins: [
    { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } },
    { plugin: toolDiscoveryPlugin, options: { grants: ["public"], maxCallsPerRun: 16 } },
    stepLoopPlugin,
    memoryDigestPlugin,                      // session scope: digests on the turn's UtilityLlm
  ],
  capabilities: [appTools],               // tools + views + skills + prompt sections
  turnServices: [LanguageModel.LanguageModel, UtilityLlm],
  cacheKeyPrefix: "app",                   // prompt-cache key `app:<conversation>`
  budgetTokens: 24_000,
})
```

**One turn.** `agent.turn(input, use)` opens memory and tools for one admitted
turn and hands `use` a `Turn`: `userMessage`, `memory` (read-only), `events`,
`tasks`, `tools` (`match`, `apply`, `select`, `activate`, `active`),
`context(entry)`, `reply(text)`, `run(policy)`, `flush` and `write(op)`. The
turn is scoped: subscriptions and tasks end with it. On success, tasks and
background subscriptions settle before the reply is recorded. The reply is
recorded exactly once, with a `failed` outcome when `use` fails, is interrupted,
or finalizer work fails. On failure or interruption, the original cause is
preserved and pending tasks are interrupted when the turn's scope closes.

`input.turn` is either a turn the host already began (the `TurnWriter` from
`Sessions.begin`: the host ends it, after its own closing records) or a
`NewTurn` (`{ session, userMessage, runId, key?, command? }`) that the agent
begins through the `Sessions` in its services and ends with the outcome. A
turn that cannot begin fails with the reason as its code (`session.busy`,
`turn.duplicate`, `turn.key-conflict`, `turn.refused`; all of them are
`turnBeginCodes` from `@xandreed/sdk`, with suggested HTTP statuses in the
[event reference](event-reference.md#begin-codes)); a turn someone else
closes (a cancel, a reaped lease, a removed session) fails with
`turn.closed`.

A prompt is text sent to a model; the user's message is a `UserMessage` value
(`new UserMessage({ text })`, never blank), and every field or parameter holding
it is named `userMessage`. The memory log stores it as text under its original
`prompt` key, so existing logs decode and their fingerprints do not change.

**Per-turn host services.** `input.layer` is a layer the turn builds inside
its scope, after `RunContext`, `TurnEvents` and `TurnTasks` exist, so it may
require them. The turn provides the result to `use`, tool handlers, policy
callbacks, subscriptions and tasks: `yield* AnswerState` anywhere in the turn
gets the same per-turn instance. The type of `agent.turn` removes what the
turn provides from `use`'s requirements.

```ts
class AnswerState extends Context.Service<AnswerState, AnswerStateService>()("app/AnswerState") {}
const answerStateLayer = Layer.effect(AnswerState, RunContext.pipe(Effect.flatMap(makeAnswerState)))

const userMessage = new UserMessage({ text })
yield* agent.turn({ turn: { session, userMessage, runId }, services, layer: answerStateLayer }, (turn) => Effect.gen(function* () {
  const quick = yield* quickReply(turn.userMessage)              // no loop, still a recorded turn
  if (Option.isSome(quick)) return yield* turn.reply(quick.value)

  const state = yield* AnswerState                               // the same instance the tools see
  yield* subscribeAll(turn.events, [
    onTool(Search, ({ result }) => state.remember(result)),     // typed by the tool's own schemas
    onTool(Deliver, ({ input }) => state.deliver(input.text)),
  ])
  yield* turn.tools.select(turn.userMessage)                     // always-on skills + the matcher's choice
  const result = yield* turn.run({
    step: (step) => state.directive(step),                       // step context and tool choice
    completion: () => state.verdict,                             // { complete, awaiting, facts }
    limits: { maxSteps: 6, requireCompletion: true },
  })
  return { outcome: result.outcome, reply: yield* state.reply }
}))
```

`TurnPolicy` holds plain functions: `initial` (a host-planned first batch, run
without a provider call), `model` (a model and prompt variant per step),
`step`, `completion`, `limits`, `budgetTokens`, `stepContext` (`tail` or
`system`) and `correctives`. A verdict whose `awaiting` names task tags joins
those tasks and is evaluated once more. No provider call follows a complete
verdict.

**Events and tasks.** `TurnEvent` is one typed union: `turn.started`,
`step.started`, `tool.started`, `tool.completed` (decoded result and encoded
form), `step.ended` (the recorded results by entry id),
`completion.evaluated`, `skills.activated`, `context.built`,
`decision.recorded`, `assistant.message`, `assistant.delta` (transient),
`turn.ended`, and host events from `defineHostEvent`; the
[event reference](event-reference.md) lists each one's payload, who
publishes it and how it is stored. Publication is inline
and ordered, depth-first up to a cap: every subscriber runs before `publish`
returns, so state a subscriber changes is visible to the next step, and a
subscriber failure fails the turn. Within a step the order is `step.started`
< `tool.*` < `step.ended` < `completion.evaluated`. Background work goes to
`turn.tasks.fork(tag, effect)`.

A subscription can instead run in the background:
`subscribe(select, handle, { mode: "background" })`, or the same option on
`onEvent`, `onTool` and a host event's `on`. It gets its own bounded queue and
fiber. `publish` returns once the event is queued, and the handler sees events
in publication order. A failed background handler is latched: the next
delivery to it fails, and so does the drain before `turn.ended`, which fails
the turn. Use it for reactions whose effects the next step does not need.

**Where it is stored.** The turn's `TurnWriter` is the bus's first
subscriber: every event except transient deltas is stored in the session's
log under its own kind (see the vocabulary below), and `tool.completed` keeps
neither the input nor the result, which memory holds. Events and memory
entries go through the writer's one ordered write-behind queue. Producers
queue and go on; one writer fiber stores items strictly in queue order,
consecutive appends in one commit. The turn waits only at flushes:
`turn.flush` returns once everything queued before it is committed, and
`turn.write(op)` runs a host write in the same order and returns its result.
The first failed write is latched, so the turn fails at its next write.
Closing the turn's scope drains the queue before the writer stops, also on
interruption. Memory builds every request from the session's earlier turns
(read once, when the turn opens) and what this turn recorded, never by
reading the log back mid-turn.

**Memory.** Every message, tool result, turn context, step context, skill
activation, digest and compaction decision is an entry in the session's log
(a `memory.*` event, the turn's `turn.started` and its `turn.reply`) with its
own id (`<runId>:<n>`). Every request is a pure fold of that log, so
a request rebuilt later (another process, a restart) is byte-identical to the
one the model saw. A strategy decides compactions and digests (`maintain`)
and records them before they apply; it applies only its own compactions, so
a new strategy rebuilds from the full-fidelity entries.

- The window strategy keeps the current turn verbatim and shows earlier turns
  through each tool's compact view. Under budget pressure it spills the
  current turn's largest results to a preview plus a locator (read back with
  `recall_context`), then replaces the oldest turns with a ledger. It fails
  with `context.budget` only when the current turn alone does not fit.
- The summary strategy folds the oldest turns into one recorded summary once
  the render passes its trigger. It reads the `UtilityLlm` where its session
  is opened (the turn), so summaries run under the turn's budget, and fails
  with `memory.summary` without one.

Digests of several results run concurrently (`MemoryPolicy.digestConcurrency`,
four by default) and are recorded in the order of their results.

A tool owns how its result appears: `render`, `compact`, `subjects`,
`artifacts` (image and file references, rendered as references for now) and
an optional `digest`. A `Select` digest keeps whole items by key and
re-renders them, so every identifier an answer may cite survives. A
`Summarize` digest is accepted only when every `preserve`d identifier appears
in the summary. The strategy decides when (on write above a size, or at
compaction); the `ResultDigester` runs the tool's own prompt for the latest
`userMessage` (a log without one digests nothing); the outcome is
logged once as a `ToolDigest` entry and never recomputed on replay.

**Durable model requests.** Before each real provider step, the turn writes
and flushes `request.prepared`. This protocol record carries the complete
active tool declarations, tool choice, system text, public requested model
configuration, prompt cache key, call policy, the memory strategy's render
recipe/version and the build's memory cut (`through`, the last memory entry
the build folded). Messages remain in their original memory events. Each
header is self-contained, repeating the full system text and every active
tool's declaration at every step: a deliberate storage trade-off, so that one
header and the memory before it rebuild a request. A provider-defined tool's
args are kept only as their key names and the SHA-256 of their canonical
JSON, since they can carry credentials; a change of any value still
diverges. A dispatch reads what storage holds (the history memory was opened
over, then only the events stored since its last read, so a step's read
grows with that step, not the session), folds the memory entries up to the
cut with the saved recipe, and compares the resulting prompt and header with
the actual Effect AI request. A memory write after the build (a reaction to
`context.built`) is outside the cut: the next step sends it. Changes to the
system text, messages, schemas, tool choice or described model settings fail
with `request.diverged` before the provider runs; its message starts with the
first part that differs (`context`, `system`, `messages`, `tools`,
`toolChoice`, `model`, `cacheKey` or `callPolicy`). Prompt data is frozen; a
stream fallback checks the same contract again, and a failed check fails the
step, streamed or not, instead of falling back. Host-planned batches make no
provider request and create no request header.

`replayModelRequest(events, runId, step)` reconstructs one historical request
from the memory up to its header's cut, excluding later responses. It uses
recorded tool schemas and render options, so changing installed plugins does
not rewrite historical requests, and fails with `request.diverged`
(`context`) when the events do not rebuild the context the header was
prepared from (a fork's own log without its parent's history). Retention must
preserve `request.prepared` and the memory facts it references; removing
optional `context.built`, trace content or usage diagnostics does not affect
this contract. A host that redacts memory, or exports or streams session
events, handles `request.prepared` the same way: it holds the full system
text (step context included in `"system"` mode) and the tool declarations.
Earlier logs without a header remain readable but cannot reconstruct this
additional metadata.

Effect AI models hide provider configuration inside adapters. Efferent's
provider adapters and routers describe their public options with
`describeModel(model, { provider, model, settings })`; hosts should do the
same for custom models, preserving the descriptor when wrapping a model
(`modelRequestDescriptorOf` reads it). An undescribed model is recorded as
explicitly opaque: its prompt/tools are checked, but its private provider
settings cannot be validated. Credentials never belong in `settings`.
A model that reads its configuration per call, such as the settings-backed
router, is `resolvingModel(model, resolve)`: each step resolves it once
(`resolveModelRequest`), and the resolved model serves the step's header and
every attempt of the step, so a model switch applies from the next step.
The invariant covers the Effect AI request boundary; provider-specific HTTP
serialization, retry/fallback routing and transport transformations remain
adapter contracts. It does not claim to reproduce raw HTTP wire bytes.

`ConversationMemory.open({ conversation, runId, log })` opens a strategy over
the turn's `LogHandle` (the entries of earlier turns, and appends through the
turn's writer). It reads what a strategy
needs per turn (a `ResultDigester`, a summarizer's `UtilityLlm`) with
`Effect.serviceOption` from the environment it is opened in; provide them to
the open, not as an argument. `ToolRegistry.open(session)` requires
`RunContext` and a scope, and its handlers run with the services of where it
is opened (captured at open); the `IntentMatcher`, `ActionPolicy` and
`PermissionGrants` there are used when present.

`memoryConformance(memory, services)`, `stepLoopConformance(loop)`,
`turnConformance(runner, services)`, `sessionLogConformance(log)` and
`sessionLogRecoveryConformance(subject)` (from `@xandreed/core`) are the port
contracts as runnable checks: each returns `ConformanceCheck`s (`name`, and a
`run` effect that fails with a `ConformanceFailure` naming the broken check)
that any test runner can run. Run them against a new strategy, loop, turn
composition or session store.

**Tool discovery.** Hosts contribute tools (`defineTool`: handler, view,
annotations) and skills (`defineSkill`, or `skillsFromFiles` over
`<skill>/SKILL.md` and `<skill>/references/*.md`). The registry keeps a
grow-only active set in memory:

1. Tier 1: the skill catalogue is a static system-prompt section.
2. Tier 2: `load_skill` returns a skill's instructions and appends its tools
   to the active set from the next step.
3. Tier 3: `read_skill_reference` serves a loaded skill's references. It is
   registered only when some skill has references.

`turn.tools.select(userMessage)` activates the `always` skills and, when the
turn's services carry an `IntentMatcher`, the skills it selects (the matcher
receives `{ userMessage, skills, active, history }`). The choice is
recorded with `recordDecision` as a `skill-selection` decision; timeouts and
abstentions keep the always-on set. `select` is `match` then `apply`:
`turn.tools.match(userMessage)` only asks the matcher and returns a `SkillMatch`
(`userMessage`, `skills`, `probabilities`, a provisional `record`) without writing or
publishing anything. `turn.tools.apply(match)` activates the skills, records
and publishes the decision, and records the synthetic `load_skill` exchange.
A host can run the match alongside other work and apply it later, or drop
it. Probabilistic selection never
authorizes: `resolveCapabilities` checks every activation against the turn's
`PermissionGrants` (or the configured grants). Every call passes one wrapper
(active set, grants, `ActionPolicy`, per-turn budgets, read/write lanes) that
publishes `tool.started` and `tool.completed` before it returns.

Tools only grow within a conversation and are sent in activation order.
Restrict a step with a tool choice or a handler failure, never by removing a
schema: removing one rewrites the cached prefix.

**Capabilities and the system prompt.** `definePlugin({ contributes:
[Capabilities] })` marks a multi-provider key: the runtime concatenates every
contributor's array in graph order. A capability carries tools, skills and
prompt sections; per-turn host state comes from the turn's `layer`. The
system prompt is the configured prefix, then the `static`
sections, then the `session` sections, each tier by `order`. `turn` sections
are recorded as turn context when the first run starts.

### Typed plugin layers

`definePlugin` returns a `TypedPlugin`: the `Plugin` the graph loads, plus its
`config` schema, its typed `defaults` and `live(options?)`, the plugin's own
layer with the services it provides and requires in its type. Options merge
over the defaults and are decoded as the graph decodes them; an unknown key
fails with `config.options`. Each capability package exports its schema, its
defaults and its layer:

| Package | Layer | Provides | Requires |
| --- | --- | --- | --- |
| `@xandreed/plugin-sessions` | `SessionsPluginLive` | `Sessions` | `SessionLog`, `TurnAdmission` |
| `@xandreed/plugin-session-sqlite` | `SessionLogSqliteLive(path)` | `SessionLog` | — |
| `@xandreed/plugin-tasks` | `TasksPluginLive` | `Tasks`, `Capabilities` (with `tools`) | `Sessions`, `TaskRunner`, `TaskExecutor` |
| `@xandreed/plugin-memory-window` | `MemoryWindowLive` | `ConversationMemory`, `Capabilities` (recall) | — |
| `@xandreed/plugin-memory-summary` | `MemorySummaryLive` | `ConversationMemory` | — |
| `@xandreed/plugin-memory-digest` | `MemoryDigestLive` | `ResultDigester` (build it per turn) | `UtilityLlm` |
| `@xandreed/plugin-tool-discovery` | `ToolDiscoveryLive` | `ToolRegistry`, `Capabilities` (catalogue) | `Capabilities` |
| `@xandreed/plugin-agent-loop` | `StepLoopLive` | `StepLoop` | — |

The schemas are `SessionsConfig`, `TasksConfig`, `MemoryWindowConfig`,
`MemorySummaryConfig`, `MemoryDigestConfig` and `ToolDiscoveryConfig`, with
`sessionsDefaults` and so on; plugin-render exports `renderSurfaceDefaults` and `renderFeedDefaults`.

`stackPlugins(next)(base)` composes them the way the graph activates plugins:
`next` is built over everything `base` provides, the two `Capabilities`
arrays concatenate base first, and any other service of `next` wins.
`CapabilitiesLive(...bundles)` is the host's own bundle at the bottom of the
stack.

```ts
const plugins = CapabilitiesLive(appTools).pipe(
  stackPlugins(MemoryWindowLive({ digestOnWriteChars: 4_000 })), // + the recall tool
  stackPlugins(ToolDiscoveryLive({ grants: ["public"] })),       // registry over [app, recall]; + the catalogue
  stackPlugins(StepLoopLive),
)
```

The order is load-bearing, as in the graph: the registry is built over the
capabilities below it (the host's tools, then recall), while the system
prompt sees all three bundles, and that order is the order of the tools sent
to the model. Never combine layers that contribute with `Layer.merge` or
`Layer.mergeAll`: a merge keeps one `Capabilities` array and silently drops
the other's tools, skills and sections, and neither layer sees the other's.

### The turn as services

The steps of a turn are public, over typed services, so a host composes the
turn it needs; `Agent.turn` is one such composition. `TurnLive(input)` (from
`@xandreed/core`, requiring `ConversationMemory` and `ToolRegistry`) builds,
over the admitted turn's `TurnWriter`, in this order, the event bus and the
tasks, with the writer as the bus's first subscriber, then the memory
session (opened where the layer is built, over the session's earlier turns)
and `RunContext` (which carries the turn's `session`). It provides:

- `TurnMemory`: the session, the turn's `number`, `persistMessage` (the
  turn's TurnStarted, stored when the turn began, is shown to memory, then
  `turn.started` is published; once), `context(entry)` (before
  `persistMessage` it waits, and is recorded right after the message:
  memory records nothing of the turn before its message, `turn.unstarted`),
  `persistReply(outcome)` (`turn.reply`, then `turn.ended` is published;
  once, and a no-op when the message was never persisted). The stored
  `turn.ended` is the writer's `end`, the turn's closing commit;
- `TurnToolbox`: `open` (once; the handlers run with the opener's services)
  and `tools` (fails with `tools.unavailable` before `open`);
- `TurnPrompt`: `system(variant)` and `turnSections`;
- `RunContext`, `TurnEvents` and `TurnTasks`.

The lifecycle is functions over them: `openTurnTools`, `turnTools` (the
host's view), `settleTurn` (join the tasks, drain the reactions, until quiet),
`finishTurn(outcome)` (persist the reply, drain, flush), `guardTurn(body)`
(settle on success, else finish as failed keeping the cause), `turnOf(options)`
(the `Turn` a host's code gets), and `stepRequestOf(policy, options)` and
`runTurnLoop(policy, options)` for one run of the step loop. `cacheKeyOf(prefix,
conversation)` builds the prompt-cache key.

`Agent.turn` is, in order:

```ts
const body = Effect.gen(function* () {
  yield* (yield* TurnMemory).persistMessage       // 4. the user's message
  yield* openTurnTools                            // 5. inside the host layer: its services reach the handlers
  return yield* use(yield* turnOf(runOptions))    // 6. the host's code
})
body.pipe(
  Effect.tap(() => settleTurn),                   // body tasks finish before its scoped services close
  Effect.scoped,
  Effect.tap(() => settleTurn),                   // body finalizer work still has the host's services
  provideHostLayer(Option.fromNullishOr(input.layer)), // 3. built before the message; closes after the body
  Effect.tap(() => settleTurn),                   // host finalizer work still has its plugin dependencies
  provideTurnPlugins,                            // 2. turn-dependent plugins close next
  guardTurn,                                     // settle plugin finalizer work, then record the final outcome
  Effect.provide(TurnLive(live), { local: true }), // 1. writer first; stays open throughout teardown
  Effect.provideService(ConversationMemory, memory),
  Effect.provideService(ToolRegistry, registry),
  Effect.provideService(StepLoop, loop),
  Effect.provide(context),                        // the graph's services and the turn's
  untilClosed(writer),
)
```

The order matters. The message is persisted before the matcher runs, because
the matcher reads the reference transcript and a decision's context hash
includes its length. Anything built before `persistMessage` (the
turn-dependent plugins, the host's layer) sees only earlier turns. The
body closes before the host's layer, which closes before the turn-dependent
plugins. On success, tasks and background reactions settle before each
dependency scope closes; work forked by its finalizers settles before the next
scope closes. The outer `guardTurn` includes that teardown before recording
one final reply: a finalizer task failure produces a failed reply, rather than
following a completed reply. `TurnLive` remains open for that settlement and
flush, then closes; an agent-owned writer ends afterward.

Subscriptions owned by the body, host or turn-dependent plugin scopes have
already closed when the final `turn.ended` event is published. An observer that
needs the final outcome subscribes in the caller's outer scope, using
`Scope.provide(observerScope)`, and uses services that remain open there.
A host composing by hand uses the same pieces over a
`stackPlugins` stack instead of a graph, and builds session plugins such as
`MemoryDigestLive()` per turn over the turn's services. `turnConformance`
checks a composition: the writer first, the message before the matcher's
history, the reply and the turn's end exactly once on success, failure and
interrupt, tasks joined before the reply, and the host layer seeing only
earlier turns.

## Sessions: one log per session

A session is one conversation's append-only event log: every turn's
message, memory, events and host records, the inbox, and the records of
background tasks. Two layers split the work:

- **`SessionLog`, the storage a host provides** (a core port). It is dumb on
  purpose: per session a head (`header`, `seq`, `revision`, an opaque
  `state` the sessions plugin owns, `updatedAt`, and `now`, the storage's
  clock) and the events (`{ session, seq, turn, kind, at, data }`).
  `create`, `head`, `list` (an owner's sessions, newest first, keyset
  paged), `read` (after a cursor, by kinds), `remove` (with its children)
  and `commit`. A commit is one compare-and-swap: it applies only when
  `revision` still equals `expect` and, with `notAfter`, only while the
  storage's clock has not passed it; events get dense `seq`s and the
  storage's time; a commit may carry state and no events. The storage's
  clock is whatever the backend reads: the memory and SQLite logs read the
  committing process's Effect `Clock` (SQLite once it holds the write lock),
  so instances sharing them need clocks in step; a host's own store may read
  its database server's clock instead.
  `sessionLogConformance(log)` checks all of it, including that one of many
  concurrent commits wins. `sessionLogRecoveryConformance({ open,
  callerClock })` checks, inside one process, what must survive handles,
  reopening and interruption: `open` opens
  a new handle on the same data each time (scoped), and the kit checks that
  commits are there after closing and reopening, that two open handles see
  each other's commits and race with one winner per revision, that an
  interrupted commit is stored whole or not at all, and that a handle whose
  scope never closed blocks nobody; with `callerClock` (the backend stamps
  time with the caller's Effect `Clock`) a commit at exactly `notAfter` is
  accepted and one a millisecond later refused. An in-memory log passes only
  when every `open` returns the same store. Core ships `SessionLogMemoryLive`;
  `@xandreed/plugin-session-sqlite` ships `SessionLogSqliteLive(path)` and
  `makeSessionLogSqlite(path)` (the scoped log itself, a recovery subject's
  `open`); a host writes its own over its database. The SQLite log reads the
  clock once its transaction holds the write lock, so a commit that waited
  for another connection past its `notAfter` is refused and events carry the
  time they were written; a lock held past its 5 s busy timeout fails with
  `SessionLogError` code `store.busy`, and processes opening one new file at
  once wait for each other rather than fail.
- **`Sessions`, consumption through a plugin** (`@xandreed/plugin-sessions`,
  requiring `SessionLog` and `TurnAdmission`). Hosts and `Agent.turn` both
  read and write sessions only through it.

```ts
const view = yield* sessions.create({ owner })                 // SessionView: header, turns, title, open, pending
const address = { id: view.header.id, owner }                  // another owner's address finds nothing
yield* Effect.scoped(Effect.gen(function* () {
  const writer = yield* sessions.begin(address, { _tag: "User", userMessage, runId, key, command: {} })
  yield* agent.turn({ turn: writer, services }, use)              // the agent runs it; the host ends it
  yield* writer.append([{ kind: "answer.delivered", data: { text } }])
  const { pending } = yield* writer.end({ reason: "completed", failure: Option.none() })
  if (pending > 0) yield* sessions.drain(address, react)       // inbox items that arrived meanwhile
}))
```

**One turn at a time.** `begin` opens a turn with its `turn.started` (the
user's message, the host's `command`, the idempotency `key`) in one commit;
a second begin while a turn is open is `SessionBusy` (a host answers 409).
The same key again is `TurnDuplicate` with that turn, and the same key with
another message or command is `KeyConflict`: keys are found in the log, so
the check holds across restarts. The writer (`TurnWriter`) is the turn's one
way to write: `append`, `write(op)` in queue order, `transact(decide)`
(check, then append: decided again with the events others wrote when
someone commits first), `flush` (committed to storage), `end` (the closing
commit; it returns how many inbox items wait, and after a store failure a
later end tries again) and `closed` (completes when someone else closed the
turn). A writer whose scope closes unended ends the turn as failed, or
interrupted, and so does a begin interrupted after its opening commit. Outside a turn, `Sessions.transact(address,
decide)` is the same check-then-append (a page action, a setting); kinds only
the framework writes are refused there (`RESERVED_KINDS`; among them
`request.prepared` holds each request's full system text and tool
declarations, see durable model requests).

**Ownership** is configured:

- `{ mode: "lease", ttlMs, renew }`: several instances over one log. A turn
  is held until the storage's `now + ttlMs`; each of its commits carries that
  as `notAfter`, and the storage refuses a write that arrives later by its
  own clock. For the memory and SQLite logs that clock is the committing
  process's Effect `Clock`, read under the write lock, so instances sharing a
  lease over them need clocks in step; a host's store that reads its server's
  clock judges every instance by that one. `renew: "none"` fixes the lease
  at begin, `"on-commit"` extends it with each write, `{ everyMs }` also
  renews from a keep-alive (which notices a remote cancel within `everyMs`).
- `{ mode: "process" }`: a turn is held without expiry for as long as the
  process that began it runs. The turn names its holder's host, pid and
  start time: a turn left open by a process of this host that has stopped
  is closed as interrupted when this one next touches the session, and a
  live process's turn is busy to `begin` and shown open. A holder on another
  host cannot be asked and
  stays held, so several hosts over one log use a lease; a holder that
  names no process (an older version) is reaped as before. How a process is
  named and asked is `SessionsLive(config, { liveness })`'s. The default detects
  a reused pid when it is the inspecting process's own pid and the recorded
  start time differs. Other pids are checked only with `kill(pid, 0)` (EPERM
  counts as running), so another live process reusing a holder's pid can keep
  the turn held. Hosts needing stronger identity checks can supply `liveness`
  or use lease ownership.

A turn nobody holds any more reads as not open, and is closed as
`interrupted` by the next `begin`, `cancel`, `deliver` or `drain`: never by
a read, so loading or following a session runs nothing. `cancel(address,
turn)` ends exactly that turn as cancelled, durably: every reader sees
`turn.ended`, a holder on this instance is interrupted at once, and a
holder elsewhere is refused at its next commit. `fork(parent, { inherit })`
makes a child session (a background task's): with `inherit` its history is
the parent's up to its last closed turn, and its turns count on from there.
`changes(address)` signals each commit this instance makes (a feed polls
for the others), and `lookup(address, key)` finds a key's turn.

**Admission.** `TurnAdmission.admit(turn, open)` runs around the one commit
that opens every turn (a user's, the inbox's, a task's), never around the
turn's later writes, so a host can count and open in one transaction: a
duplicate or a busy session fails inside it and counts nothing, and a
refusal (`TurnRefused`) opens nothing. `TurnAdmissionOpen` admits all.

**The vocabulary.** Each kind has one durable producer (the generated
[event reference](event-reference.md) has every kind's payload, its
sensitive content, the exact `RESERVED_KINDS` and the begin codes;
`journalSchemaOf(kind)` gives each framework kind's schema):

| Kind | Written by |
| --- | --- |
| `turn.started` (`runId`, `key`, `origin`, `userMessage`, `command`, `claimed`) | `Sessions.begin`; memory reads it as the turn's TurnStarted |
| `turn.reply` | memory (`persistReply`) |
| `turn.ended` (`reason`: completed, partial, failed, cancelled, interrupted; `failure`) | the writer's `end`, a cancel or a reap |
| `memory.system`, `memory.section`, `memory.step`, `memory.message`, `memory.tool-result`, `memory.digest`, `memory.skills`, `memory.compaction` | memory (`{ entry, runId, step, at, body }`) |
| `step.started`, `step.ended`, `step.usage`, `tool.started`, `tool.completed`, `completion.evaluated`, `context.built`, `decision.recorded` | the turn's bus |
| `request.prepared` (the request's header: system text, tool declarations, model, cache key) | the turn, before each provider call (`TurnMemory.prepareRequest`) |
| `inbox.queued`, `inbox.dropped` | `deliver`; a claim that failed too often |
| `task.started`, `task.cancelled`, `task.result` | `@xandreed/plugin-tasks` |
| anything else | the host, through the writer or `transact` |

Memory is rebuilt from `MEMORY_KINDS` by `entriesOfEvents`, which reads JSON
back with sorted keys: the requests a model sees do not depend on the store
(a JSON column may reorder keys), and the SDK checks this over the memory,
SQLite and key-reordering stores against the golden requests.

**The inbox.** `deliver(address, { id, source, content })` puts an item in
the session's inbox, once per id, up to `inbox.maxPending` (20). Items wait
for the next inbox turn: `begin(address, { _tag: "Inbox", runId })` claims
every waiting item in its start commit (its `userMessage` is their contents)
and fails with `NothingPending` when there are none. An item is done when its
turn ends completed, partial or cancelled; a failed or interrupted claim
returns it, up to `inbox.attempts` (2), and then it is dropped
(`inbox.dropped`). A turn interrupted before it wrote anything through its
writer (no `append`, `write` or `transact`) never tried its items: they wait
again and no attempt is counted. A turn reaped because its holder stopped
counts. User messages never queue. `drain(address, run)` runs
inbox turns while items wait, the session is free and the host admits them,
at most three. Whoever closes a turn and whoever delivers drains: the
delivery either commits before the turn's closing commit (whose `pending`
counts it) or after it (and finds the session free), so nothing waits
unnoticed.

**Background tasks** (`@xandreed/plugin-tasks`). A task is one turn of a
child session, a fork of the conversation or an empty spawn, whose id is the
task's. `Tasks.start(parent, { instructions, mode })` records `task.started`
in the parent, checked against the tasks stored (a task does not start
tasks; a session runs `maxRunning`, two, at once), and hands the work to the
host's `TaskRunner`: `InProcessTaskRunnerLive` forks it on this process (its
own fiber, interrupted with the layer), and a serverless host registers it
with its `waitUntil`. The work begins the child's turn once (its key is the
task's), runs it through the host's `TaskExecutor.turn` until the runner's
deadline, records `task.result` before the turn closes, delivers the result
to the parent's inbox (`task:<id>`, once) and drains the parent, whose
`TaskExecutor.react` answers it after the turn in flight. The notice frames
the task's words:

```text
[Background task <taskId> completed]
<task-output>
…the task's reply…
</task-output>
```

The runner's absolute deadline bounds admission, reads, delivery and parent
reactions as well as the child model call. Execution stops `closingReserveMs`
(2 s, at most half the budget) before it, leaving that time to store the
child's result and ending, deliver it and close the parent's turn; work the
deadline itself cuts is logged with the task and how long it ran. A
finite-budget runner admits at most one parent reaction and interrupts it at
the execution cutoff: a reaction cut after it recorded its answer
(`turn.reply`) ends partial, so its notice is done and never answered twice,
and one cut before ends interrupted, so the notice waits again. A parent turn
admitted past the cutoff ends interrupted without reacting, and its notices
wait with no attempt counted. A notice whose reaction cannot begin stays in
the inbox; an undelivered result remains in the child for `reconcile`.
Serverless hosts also leave invocation headroom for interrupted scope
finalizers to close their writers.

The first of a child's `task.result` and `task.cancelled` ends the task.
`cancel` stops a waiting or running task (its turn is cancelled, nothing is
delivered); `status` and `list` read where tasks stand; `reconcile(parent)`
runs tasks a lost runner never ran and delivers results it never delivered
(its caller drains). A child the host will not admit fails with the host's
reason, a turn past its deadline ends interrupted, and an abandoned turn is
delivered as interrupted. With `tools`, the model gets `start_task` and
`task_status` (off by default).

**Following a session.** plugin-render's `SessionsJournalTailLive` is a
`JournalTail` over `Sessions`: the render feed replays a session's events
after a cursor, then follows `changes` and polls.
