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
      text: prefix + input.prompt,
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

## Sessions

- `create`, `resume`, `list`, and `fork` operate on the configured SessionStore.
- `send` journals input and serializes runs; `steer` queues input for a loop's
  next admission boundary; `continue` resumes the pending queue.
- `use(Service, callback)` accesses a selected domain service while holding the
  session gate; resource disposal waits until the callback completes.
- `interrupt` cancels the active fiber. The run settles once as cancelled.
- `events(after)` replays durable events after an exclusive cursor, then follows
  the journal. Notifications can coalesce; journal entries are not dropped.
- `transient` carries bounded, disposable text deltas. It is not replay storage.
- A reopened unfinished run is marked cancelled. Tools are never rerun merely
  because a client reconnects. A fork requires a settled event boundary.

Session plugins can require `SessionEnvironment` to access the workspace and
current session record. `domainLoop` and `domainSession` bridge an existing domain
event protocol to SDK lifecycle and replay; optional snapshots restore domain
state when a session is forked.

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
command and event-renderer contributions. Smith-specific commands belong in the CLI. The terminal
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
update the UI at most once per batch. The terminal tests exercise 10,000 events
and assert p95 input-to-frame time below 50 ms on the test machine. The PTY fixture checks rendering and shutdown. `python scripts/verify-tmux.py`
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
SDK sessions, replacement plugins, persistence, forks, custom evals and CLI
startup, followed by the packed terminal in a real PTY. Publishing is a separate release action.

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
| Memory storage | `MemoryLog` | `@xandreed/plugin-memory-log` (the host journal) |
| Memory strategy | `ConversationMemory` | `@xandreed/plugin-memory-window`, `@xandreed/plugin-memory-summary` |
| Tool digests | `ResultDigester` (optional) | `@xandreed/plugin-memory-digest` |
| Tool registry and discovery | `ToolRegistry` | `@xandreed/plugin-tool-discovery` |
| Step iteration | `StepLoop` | `stepLoopPlugin` from `@xandreed/plugin-agent-loop` |
| Host definitions | `Contributions` (multi-provider) | `AgentConfig.contributions`, or any plugin that `contributes` |
| Pre-turn skill selection | `IntentMatcher` (optional, per turn) | any matcher service |

**Defining the agent.** `Agent.define(config)` (from `@xandreed/sdk`) resolves
the graph and activates its runtime plugins once, in the caller's scope.
Session plugins, if any, are activated per turn with the turn's services.
Swapping a strategy is swapping one entry.

```ts
const agent = yield* Agent.define({
  plugins: [
    memoryLogPlugin,
    { plugin: memoryWindowPlugin, options: { digestOnWriteChars: 4_000 } },
    { plugin: toolDiscoveryPlugin, options: { grants: ["public"], maxCallsPerRun: 16 } },
    stepLoopPlugin,
    memoryDigestPlugin,                      // session scope: digests on the turn's UtilityLlm
  ],
  contributions: [appTools],               // tools + views + skills + sections
  turnServices: [LanguageModel.LanguageModel, UtilityLlm],
  cacheKeyPrefix: "app",                   // prompt-cache key `app:<conversation>`
  budgetTokens: 24_000,
})
```

**One turn.** `agent.turn(input, use)` opens memory and tools for one admitted
turn and hands `use` a `Turn`: `prompt`, `memory` (read-only), `events`,
`tasks`, `tools` (`select`, `activate`, `active`), `context(entry)`,
`reply(text)` and `run(policy)`. The turn is scoped: subscriptions and tasks
end with it. Tasks are joined before `turn.ended`, which is recorded exactly
once, with a `failed` outcome when `use` fails or is interrupted.

```ts
yield* agent.turn({ conversation, runId, prompt, services, journal }, (turn) => Effect.gen(function* () {
  const quick = yield* quickReply(turn.prompt)                   // no loop, still a recorded turn
  if (Option.isSome(quick)) return yield* turn.reply(quick.value)

  const state = yield* AnswerState.make
  yield* subscribeAll(turn.events, [
    onTool(Search, ({ result }) => state.remember(result)),     // typed by the tool's own schemas
    onTool(Deliver, ({ input }) => state.deliver(input.text)),
  ])
  yield* turn.tools.select(turn.prompt)                          // always-on skills + the matcher's choice
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
`turn.tasks.fork(tag, effect)`. The journal is the first subscriber: every
event except transient deltas is appended with its name, and
`tool.completed` keeps only the encoded result.

**Memory.** Every message, tool result, turn context, step context, skill
activation, digest and compaction decision is an entry in an append-only log
with its own id (`<runId>:<n>`). Every request is a pure fold of that log, so
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
  the render passes its trigger. It reads the `UtilityLlm` from the turn's
  services, so summaries run under the turn's budget.

A tool owns how its result appears: `render`, `compact`, `subjects`,
`artifacts` (image and file references, rendered as references for now) and
an optional `digest`. A `Select` digest keeps whole items by key and
re-renders them, so every identifier an answer may cite survives. A
`Summarize` digest is accepted only when every `preserve`d identifier appears
in the summary. The strategy decides when (on write above a size, or at
compaction); the `ResultDigester` runs the tool's own prompt; the outcome is
logged once as a `ToolDigest` entry and never recomputed on replay.

`memoryConformance(memory, services)` and `stepLoopConformance(loop)` (from
`@xandreed/core`) are the port contracts as runnable checks. Run them against
a new strategy or loop.

**Tool discovery.** Hosts contribute tools (`defineTool`: handler, view,
annotations) and skills (`defineSkill`, or `skillsFromFiles` over
`<skill>/SKILL.md` and `<skill>/references/*.md`). The registry keeps a
grow-only active set in memory:

1. Tier 1: the skill catalogue is a static system-prompt section.
2. Tier 2: `load_skill` returns a skill's instructions and appends its tools
   to the active set from the next step.
3. Tier 3: `read_skill_reference` serves a loaded skill's references. It is
   registered only when some skill has references.

`turn.tools.select(message)` activates the `always` skills and, when the
turn's services carry an `IntentMatcher`, the skills it selects. The choice is
recorded with `recordDecision` as a `skill-selection` decision; timeouts and
abstentions keep the always-on set. Probabilistic selection never
authorizes: `resolveCapabilities` checks every activation against the turn's
`CapabilityGrants` (or the configured grants). Every call passes one wrapper
(active set, grants, `ActionPolicy`, per-turn budgets, read/write lanes) that
publishes `tool.started` and `tool.completed` before it returns.

Tools only grow within a conversation and are sent in activation order.
Restrict a step with a tool choice or a handler failure, never by removing a
schema: removing one rewrites the cached prefix.

**Contributions and the system prompt.** `definePlugin({ contributes:
[Contributions] })` marks a multi-provider key: the runtime concatenates every
contributor's array in graph order. A contribution carries tools, skills,
prompt sections and a per-run layer (host run state, built after
`RunContext`). The system prompt is the configured prefix, then the `static`
sections, then the `session` sections, each tier by `order`. `turn` sections
are recorded as turn context when the first run starts. The `Harness` remains
the self-contained session host for applications that do not compose turns.
