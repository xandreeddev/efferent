# Framework guide

## Runtime model

A host creates `Harness.make({ workspace, config, plugins })` inside
`Effect.scoped`. The runtime validates a dependency graph, acquires runtime
plugins once, and acquires session plugins for each open session. Finalizers
release resources in reverse dependency order. A failed activation closes its
partially acquired scope.

Each plugin has a stable `id`, `version`, `apiVersion`, `scope`, Effect Schema,
default options, required service tags, provided service tags, and Layer factory.
A plugin receives only its declared dependencies. Two providers of a service
require a `bindings` entry selecting the instance id. Runtime plugins cannot
require session services. Dependencies are checked before activation.

```ts
import { Effect, Layer, Schema } from "effect"
import { AgentLoop, definePlugin } from "@xandreed/sdk"

export default definePlugin({
  id: "example/echo",
  version: "1.0.0",
  config: Schema.Struct({ prefix: Schema.String }),
  defaults: { prefix: "Echo: " },
  provides: [AgentLoop],
  layer: ({ prefix }) => Layer.succeed(AgentLoop, {
    run: (input) => Effect.succeed({
      text: prefix + input.userMessage.text,
      outcome: "completed",
    }),
  }),
})
```

This plugin replaces the complete agent loop. No model credentials, coding
tools, or terminal library are needed to run it. `scripts/verify-packages.ts`
executes an equivalent external plugin against packed SDK artifacts.

## Configuration

Base names are `efferent.config.json` and `efferent.config.ts`; having both in
one directory is an error. Global bases live in `~/.efferent/`. TypeScript
exports a default configuration and may export `plugins: Plugin[]` containing
local definitions. JSON resolves `use: "./my-plugin.ts"` or an installed package.
Only trusted configuration modules should be loaded: TypeScript executes code.

The merge order is preset, global base, workspace base, selected profile,
`.efferent/overrides.json`, then invocation. Plugin entries merge by instance
`id`; options merge by key. Changing `use` replaces the prior instance options.
Profile maps and bindings merge by key. An unknown profile is an error.

`config explain` reports source layers and selected providers, redacting common
credential keys. `plugin inspect ID` emits the plugin schema. `plugin add PACKAGE`
installs into `~/.efferent/plugins` with install scripts disabled, validates the
graph, then writes the workspace override. Removing a required provider fails
validation until its dependants are changed too.

`harness.reconfigure(config, plugins?)` validates and stages the next graph before
making it available. An optional registry introduces newly loaded implementations;
successful reconfiguration retains that registry for later changes. Idle sessions refresh; active sessions refresh before their next
turn. A changed runtime graph returns `restart-required`. The CLI saves the
configuration and tells the user to restart. Source TypeScript is never rewritten
by the terminal editor.

## Harness sessions

The `Harness` and composable agents share the configured `SessionLog` and
`Sessions` lifecycle (see [Sessions](#sessions-one-log-per-session)). The
historical `SessionStore` API is a deprecated event projection over that log;
it owns no separate tables. A harness graph composes `sessionSqlitePlugin`
(storage, compatibility projection and open admission) with `sessionsPlugin`
(turn ownership). Process-owned CLI hosts configure the latter with
`{ ownership: { mode: "process" } }`, under which a second process on the same
host finds a live process's turn busy; hosts sharing a database across hosts
use lease ownership. `Harness.make` requires `Sessions`: a graph without
`sessionsPlugin` fails with `service.missing` naming it. In-turn events are
written through the turn's `TurnWriter` to the `SessionLog` and read back
through `SessionStore`, so a custom `SessionStore` must be the projection over
that same log (`SessionStoreProjectionLive`); one that does not read what the
writer wrote fails the turn with `session.store` instead of losing its events.

- `create`, `resume`, `list`, and `fork` operate on the same session heads and
  immutable fork boundaries as the unified log. `fork(id, through)` inherits
  exactly the events up to `through` (and that turn's `turn.ended` when no
  harness event comes between), its turns count on from every turn it
  inherits, and `fork(id, -1)` inherits nothing. A cut within inherited history
  copies that exact prefix while retaining the logical parent and turn counter.
- `send` journals input, admits through `Sessions.begin` and writes through its
  `TurnWriter` before ending the turn; `steer` queues input for a loop's
  next admission boundary; `continue` resumes the pending queue. Input
  submitted while a turn is ending is recorded on its own, and `busy` holds
  until the turn's writer is released. A steer that another instance's turn
  claimed is not begun again as a turn.
- `use(Service, callback)` accesses a selected domain service while holding the
  session gate; resource disposal waits until the callback completes.
- `interrupt` cancels the active fiber. The run settles once as cancelled. A
  turn closed elsewhere (cancelled or reaped by another instance) still gets
  its run's settlement, `run.cancelled`, recorded outside the closed writer:
  the durable ending takes precedence even if the loop returns successfully
  without another write. `send` returns after a cancel and fails with
  `turn.closed` after a reap.
- `events(after)` replays durable events after an exclusive cursor, then follows
  the journal. Notifications can coalesce; journal entries are not dropped.
- `transient` carries bounded, disposable text deltas. It is not replay storage.
- A reopened unfinished run is marked cancelled. Tools are never rerun merely
  because a client reconnects. A run still held (by its lease, or by a process
  that still runs) is left alone. A fork
  requires a settled event boundary. A refused begin leaves the queued input
  unclaimed so the caller can continue it once the session is free.

Session plugins can require `SessionEnvironment` to access the workspace and
current session record. `domainLoop` and `domainSession` bridge an existing domain
event protocol to SDK lifecycle and replay; optional snapshots restore domain
state when a session is forked. When the host provides a `ConversationStore`,
`domainLoop` binds the domain session's writes to its conversation to the
harness run through a token inherited by its fibers. A write from an earlier
run fails with `StoreError` even while a later run is active; writes after the
run ends or its external closure is noticed also fail. These
writes are recorded beside the turn rather than through its writer, so a turn
closed on another instance is noticed during execution at the writer's next
commit. Settlement also checks the durable ending when the loop returns.

The SQLite plugin uses WAL and transactional sequence allocation. The memory
plugin uses a workspace-scoped append-only JSONL ledger. The default new data
namespace is `.efferent/runtime`; historical data is retained without migration.
The models plugin reads existing model settings and credentials as fallbacks by
default. Explicit plugin options and current credentials win. Set its
`inheritPrevious` option to `false` to use an independent setup; new logins and
refreshed inherited credentials are written to the current credential store.

## Coding and policy

Smith composes models, tools, memory, context, policy, sessions, MCP and telemetry.
The default loop is a configurable plugin. Workspace file operations and
sandboxed Bash run autonomously. Bubblewrap mounts the workspace writable and
restricts network access. Timeouts and cancellation kill the process group.
Outside-workspace operations, host commands and MCP tool calls go through the
host Approval service; headless hosts deny by default.

`/plan` removes mutation and shell tools. `/spec idea` drafts a specification
through the configured coding loop using read-only tools. `/lock` records the
user's acceptance as a durable event. `/forge` implements that locked version
under Foundry gates; it rejects missing or superseded locks. Host verification
requires approval before implementation begins. The workflow delegates to the
configured loop, so model, context and memory plugins remain in use. Its limits
and gate configuration are plugin options. The historical workflow driver
remains available as `bun run smith:workflow` for old specs.

## Terminal host

`runTui` consumes an SDK harness and session, an approval channel, and optional
commands and event renderers. Smith-specific commands belong in the CLI. The terminal
supports multiline input, bracketed paste, session switching, transcript search,
explicit follow mode, expandable tool details, and dark/light/mono themes.
Typing `/` opens inline suggestions without moving focus out of the composer.
Typing filters names; arrows select, Tab completes for arguments, Enter runs,
and Escape dismisses while preserving the draft. Ctrl+P opens the full palette.
The CLI opens `/setup` automatically if no model is configured; it links provider
login, model selection, and plugin configuration. Existing users can run `/setup`.
`/plugins` offers **Replace plugin…** for every instance, with compatible loaded
implementations and a local-path/installed-package entry. The host loads and
validates the proposed graph before persisting it. Invalid replacements leave the
saved and active configuration intact; runtime changes explicitly require restart.

Credential input stays outside the text renderer; only mask characters render.
`/login` offers API keys and OpenAI/Anthropic subscription authorization with
PKCE, callback state checks, a masked manual fallback, and scoped cancellation.

A transcript mounts at most 60 blocks, keyed by durable IDs so streaming updates retain their native markdown renderers. Settling a message preserves its position. Durable event and transient delta batches
update the UI at most once per batch.
Transient text arriving before its durable run start is buffered for the selected
session, up to 128 deltas. Assistant and tool blocks follow their logical turn
order even when transient text precedes earlier durable blocks across batches;
durable settlement remains authoritative. Session switches clear
the buffer, and late deltas from settled runs or previous sessions are discarded.
The terminal tests exercise 10,000 events and assert p95 input-to-frame time
below 50 ms on the test machine. The PTY fixture checks rendering and shutdown. `python scripts/verify-tmux.py`
launches the actual CLI in an isolated tmux server and checks first-run setup,
model selection, slash filtering/completion, draft preservation, resizing, plugin edits and replacement, streamed output sampled across 50 deltas,
tool expansion, cancellation, and clean exit without provider credentials.
The model picker uses the configured model catalog. Ctrl+O expands tool details.

## Evals and reference applications

For typed datasets, reusable evaluators, task/journey composition and native prompt
examples, see [Composable evaluations](composable-evaluations.md).

`@xandreed/evals` exports `scenario`, `runPack`, `evaluate`, campaign persistence,
statistics, evidence checks and baseline comparison. A scenario supplies its
own scoped fixture, actions, checks and judges. `evaluate` accepts arbitrary
packs and reporters; the library has no application registry. Hard failures and
infrastructure failures cannot be hidden by a high average score.

Application packs remain in `packages/scenarios`. Canvas, Math and Social now
enter through their own `defineAgent` presets and `Harness.make`. Their model,
domain loop, persistence and host services are replaceable graph nodes. The SDK
bridges domain events to each application's existing browser or review protocol.
Canvas page state and Math message state are snapshotted into the journal and
restored for forks. Math rebuilds its served-exercise set from persisted history.
Social retains its draft-only tools and human review queue; its domain workspace
service is replaceable. Foundry remains independent of the SDK.

The Canvas profile plugin accepts versioned model/effort/protocol configuration.
The shipped default is unchanged; schema, recipe and prompt compatibility are
still checked. New profiles require live browser evidence before promotion.

## Distribution

`bun run build:packages` creates JavaScript, declarations and versioned manifests
under `.artifacts/packages`. `bun run verify:packages` packs them, installs them
in a temporary external project through a temporary local npm registry, and exercises
SDK sessions, replacement plugins, persistence, forks, custom evals, versioned
prompts with a checked decision (`@xandreed/ai`) and CLI startup, followed by
the packed terminal in a real PTY. Publishing is a separate release action.

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
// { model: LanguageModel.Service, system: Prompt.Prompt }.
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
`turn.duplicate`, `turn.key-conflict`, `turn.refused`); a turn someone else
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
`turn.ended`, and host events from `defineHostEvent`. Publication is inline
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

`memoryConformance(memory, services)`, `stepLoopConformance(loop)` and
`turnConformance(runner, services)` (from `@xandreed/core`) are the port
contracts as runnable checks. Run them against a new strategy, loop or turn
composition.

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
are recorded as turn context when the first run starts. The `Harness` remains
the self-contained session host for applications that do not compose turns.

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
  storage's time; a commit may carry state and no events.
  `sessionLogConformance(log)` checks all of it, including that one of many
  concurrent commits wins. Core ships `SessionLogMemoryLive`;
  `@xandreed/plugin-session-sqlite` ships `SessionLogSqliteLive(path)`; a
  host writes its own over its database.
- **`Sessions`, consumption through a plugin** (`@xandreed/plugin-sessions`,
  requiring `SessionLog` and `TurnAdmission`). Hosts and `Agent.turn` both
  read and write sessions only through it.

### Existing SQLite journals

SQLite opens the unified `session_heads` and `session_log_events` tables. On
the first open it imports existing `harness_sessions`/`harness_events` and
`conversations`/`messages`/`checkpoints`/`run_outcomes` into those tables in one
IMMEDIATE transaction. The original rows, event ids, message positions,
checkpoints, timestamps and `user_version` are preserved. Corrupt legacy
message rows retain their positions and are skipped by the compatibility
reader, as before; a harness session or event row that does not decode is
skipped and logged, and the rest of the source imports. A failed import rolls
back all imported rows and can be retried after repairing the source.

`SessionLogSqliteLive(path, { legacyPaths: [...] })` and the storage plugin's
`legacyPaths` option import older files through read-only connections into the
configured destination. An orphan historical message row (written under a
harness id without a conversation row) joins the session stored under that id
and keeps its owner; an orphan without one is created under the storage
plugin's `SessionEnvironment.workspace` (standalone adapters may name
`legacyOwner`, and otherwise isolate it under the compatibility owner).
Existing sources are left intact; absent optional sources are skipped.
Sessions are matched by id, not by the source's path: events a session
already holds are not imported again, and removing or pruning a session
leaves a tombstone, so a moved, renamed or copied source neither duplicates
records nor brings a removed session back. An owner, identity or
historical-position conflict refuses the whole source. Stop older application versions before migrating: the
import is a snapshot, and subsequent writes by an old version are not mirrored.

`SessionStoreProjectionLive` and `ConversationStoreProjectionLive` are the
explicit deprecated compatibility surfaces. Both require the host's
`SessionLog`; their writes append `harness.event` or `conversation.*` records
with revision checks, and positional batches stay atomic. A read after a
cursor and an append find their place by a binary search over the log's
cursor, so they cost what they return rather than the history. The
positional listing shows conversation sessions only (not harness or task
sessions sharing the log) and reads an unknown outcome as none; over the
SQLite log it is one query, and `prune` removes old conversations in one
transaction, leaves tombstones and truncates the write-ahead log. The convenience
`SessionStoreLive(path)` and `SqliteConversationStoreLive(path)` compose these
projections over SQLite without creating the former storage tables. Math and
Canvas compose the message projection over their harness log with
`ConversationStoreProjectionLive({ legacy: { paths, owner } })`, which imports
the host plugin's configured message database (its `file` option) into that
log once; domain page/catalog/theme stores continue to own their product data. New hosts use `Sessions`, `TurnWriter` and
`ConversationMemory` directly.

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
  as `notAfter`, so a late write is refused by the storage's clock whatever
  the instances' clocks say. `renew: "none"` fixes the lease at begin,
  `"on-commit"` extends it with each write, `{ everyMs }` also renews from a
  keep-alive (which notices a remote cancel within `everyMs`).
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

**The vocabulary.** Each kind has one durable producer:

| Kind | Written by |
| --- | --- |
| `turn.started` (`runId`, `key`, `origin`, `userMessage`, `command`, `claimed`) | `Sessions.begin`; memory reads it as the turn's TurnStarted |
| `turn.reply` | memory (`persistReply`) |
| `turn.ended` (`reason`: completed, partial, failed, cancelled, interrupted; `failure`) | the writer's `end`, a cancel or a reap |
| `memory.system`, `memory.section`, `memory.step`, `memory.message`, `memory.tool-result`, `memory.digest`, `memory.skills`, `memory.compaction` | memory (`{ entry, runId, step, at, body }`) |
| `step.started`, `step.ended`, `step.usage`, `tool.started`, `tool.completed`, `completion.evaluated`, `context.built`, `decision.recorded` | the turn's bus |
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

## Versioned prompts: `@xandreed/ai`

`@xandreed/ai` gives prompts an identity on top of `effect/ai`, and records
it on every call.

**Model prompts.** `definePrompt({ id, version, render, variants?, output? })`
renders an input into a native `Prompt`. A variant has a `shared` fragment and
optional fragments per provider and per model; for a `ModelTarget` (`{ model:
"provider/model", variant }`) the most specific applies:
`models[model] ?? providers[provider] ?? shared`. An unknown variant fails; a
prompt without variants accepts any. The fragment goes after the prompt's
system messages (`composeVariant`).

```ts
const summary = definePrompt({
  id: "app.summary",
  version: "summary-v2",
  render: (input: { readonly text: string }) => [
    { role: "system", content: "Summarize the text for a reader in a hurry." },
    { role: "user", content: input.text },
  ],
  variants: {
    baseline: { shared: [] },
    concise: {
      shared: [{ role: "system", content: "Keep it short." }],
      models: { "vendor/small-model": [{ role: "system", content: "One sentence." }] },
    },
  },
  output: () => ({ name: "summary", schema: Schema.Struct({ summary: Schema.String }) }),
})

const reply = yield* generateObject(summary, { text }, { target: { model: "vendor/small-model", variant: "concise" } })
```

`renderPrompt(prompt, input, target?)` returns the composed prompt and its
`PromptProvenance`: id, version, variant, the override that applied (the
model or the provider) and a hash, the SHA-256 hex of `JSON.stringify` of the
encoded composed prompt. `generateText` and `generateObject` call the
`LanguageModel` inside `withProvenance`, which sets the
`CurrentPromptProvenance` model adapters read. Without an explicit target a
prompt reads `CurrentModelTarget`, and renders for `{ model: "unknown",
variant: "baseline" }` without one. `promptSection(prompt, { id, version,
tier, order })` turns a prompt over the `PromptContext` into a system-prompt
section; the variant string a policy's `model` choice passes is
`encodeTarget(target)`.

**Decision prompts.** `defineDecisionPrompt({ id, version, family, state,
questions, variants? })` asks an `EvaluationModel` choice questions (`{ type:
"choice", instructions, criteria }`) and boolean questions (`{ type:
"boolean", instructions }`) about a state, which is data, never instructions.
A variant rewords questions and describes their choices; it cannot add a
question or a choice. `renderDecision` hashes `JSON.stringify({ state,
questions })`. `evaluateDecision(prompt, input)` returns answers typed per
question, and `validateAnswers` holds every answer to the questions asked:
all of them, nothing else, and only offered choices. `makeEvaluationModel({
model, transport, timeoutMs?, maxInputBytes? })` (or `EvaluationModelLive`)
bridges a host transport with a byte budget and a deadline, and
`scriptedEvaluationModel` answers from a script under the same checks. Every
failure is an `EvaluationError` (`unavailable`, `timeout`, `invalid` or
`budget`).

`PromptId`, `PromptProvenance` and `CurrentPromptProvenance` stay in
`@xandreed/core`, where transports read them; `@xandreed/ai` re-exports them.
