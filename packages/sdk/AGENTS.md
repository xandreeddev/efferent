# @xandreed/sdk

The composable agent: `Agent.define` builds an agent's plugin graph once (through runtime's `resolveGraph` and `activateGraph`) and `agent.turn` runs one turn over the turn engine, `TurnLive` (`src/turn/`), with the session, memory, registry and step loop its plugins provide. It re-exports, each by name, the part of core a host writes beside `Agent`, so defining an agent and running its turns imports one package; the rest of core is imported from `@xandreed/core`. Node 24 and Bun; layer `sdk` in `foundry.config.ts` (imports core and runtime); its tests are the `sdk-tests` layer, which may import every plugin.

## Rules

- The sdk owns no port: new behaviour goes in core or a plugin, and `agent.adapter.ts` only wires it. `task-executor.adapter.ts` (`agentTaskExecutor`) only wires `Agent.turn` (any `TurnRunner`) as core's `TaskExecutor`: the tasks plugin begins and ends the turns, the executor runs them, each with the host's `services` and the `Tasks` it is called with (the port requires it: the tasks plugin provides its own, a host draining a parent through `react` provides one), so the turns' `start_task` and `task_status` open. Hosts build `Tasks` beside the agent (`TasksLive(config).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`): a `tasksPlugin` among the agent's own plugins would need the executor before the agent exists.
- `src/turn/` is the turn engine, core's turn-scope ports as services: `TurnLive` (`turn.adapter.ts`, its state a `TurnPhase` with pure transitions, `turn-phase.entity.ts` and its functions), a run of the step loop (`turn-run.usecase.functions.ts`) and the lifecycle (`turn-lifecycle.usecase.functions.ts`). It builds the turn's bus with core's `makeTurnEvents` and `makeTurnTasks`, and reads what it needs of core's memory, journal and model requests from `@xandreed/core/internal`; what code beneath the sdk uses stays in core (`harnessDefectsAsFailures`, the bus).
- Tracing: `traceTurn` opens `agent.turn` and `traceTurnBegin` `agent.turn.begin`, its sibling, around a begin, with core's `turnAttributes` and `sessionAttributes`. Put no span between `traceTurn` and `guardTurn`: a failed turn's usage goes on the span current where `guardTurn` runs. The engine's own span is `turn.persist_reply` (`TurnLive`'s `persistReply`, under `agent.turn`); the views a turn's code works with (`turnOf`, `stepRequestOf`) and the step request's `dispatch` are `Effect.fnUntraced`.
- Fail at define time, not at the first turn: no `ConversationMemory`, `ToolRegistry` or `StepLoop` is `config.graph`, a bad `budgetTokens` is `config.budget`.
- A turn that cannot begin fails with its `TurnBeginError` as it is (a `Sessions.begin` refusal, or `AttachmentRejected`), never a `HarnessError` made from it: hosts match it by tag, and core's `turnBeginCodes` (checked against `TurnBeginError` there) gives its code.
- Any change to what the model or the journal sees shows in `golden/`: re-record only on purpose (`EFFERENT_UPDATE_MODEL_GOLDEN=1`, `EFFERENT_UPDATE_GOLDEN=1`) and review the diff in the PR.
- Normal memory appends flush before returning, so a tool result is durable before its optional digest runs. Closing drafts (the reply and later memory) stay held for the turn's end. The loop stores the assistant before handlers and each result on return; pending calls render as `ToolInterrupted` on resume, with exact state available through core's `toolCallStatesOf`.
- `TurnMemory.pendingSteers` is the writer's fresh probe; `steer(step, run)` prepares one exact inbox-marked user message per waiting input and uses memory's alternate commit with `writer.take`. Preserve the lock order: memory allocation, then the holding semaphore, then writer commit. Recheck the reply phase under the holding semaphore inside that commit callback, so steering cannot slip behind a recorded reply. A false take returns no entries or ids; an uncertain acknowledgment uses the memory log's fresh durable snapshot. Step requests forward probe/take and the run ordinal unchanged.
- `agentTaskExecutor` forwards its optional nondurable `steering` effect to both child and reaction turns. Durable steering comes from their prebegun writers through `TurnLive`; the executor neither begins another turn nor turns child input into a parent notice.
- `src/turn-composition.test.ts` rebuilds the golden agent by hand from the typed layers: a composition change keeps both it and `Agent.turn` byte-identical to the golden.
- Every `fixtures/journal-<version>.json` keeps decoding (`src/journal-compat.test.ts`); record one per release with `bun scripts/record-journal-fixture.ts`, never over a released one.
- `docs/events.md` quotes regions of `src/events-guide.test.ts`: edit the snippet there, then run `bun run docs:generate`.
- Keep test-only code out of `index.ts`: `src/testing.port.ts` (`Tally`, `Stamp`) serves the tests only, and the build leaves it out.

- `agentInboxRunner(agent, { services, use? })` captures the same Sessions as the drainer and runs a borrowed writer through Agent.turn. It neither begins nor ends; preserve the outcome and typed TurnError. Build it beside the agent to avoid a graph cycle. Its contract is pinned by the core InboxRunner kit and a real-agent queued journey.
- Runtime activity captures WaitingInput and DrainActivity alongside turn/task/shutdown probes. Installed queue failures stay SessionLogError. Shutdown waits only for inFlight, retaining queued input and using cached queue knowledge.

## Public surface

- `Agent` (`Agent.define`) and the types `AgentConfig` and `AgentPluginEntry` (`src/agent.adapter.ts`), and `agentTaskExecutor(agent, { services, steering?, child?, react? })` (`src/task-executor.adapter.ts`): a `Layer<TaskExecutor>` whose child and reaction turns run with `services` and the calling `Tasks`, and are, by default, the turn's skills selected, then one run of the step loop, its text the reply.
- The turn engine, for a host that composes a turn itself: `TurnLive`, `cacheKeyOf`, `runTurnLoop`, `stepRequestOf` (`TurnRunServices`), `finishTurn`, `guardTurn`, `openTurnTools`, `settleTurn`, `traceTurn`, `traceTurnBegin` (`TurnBeginTrace`, `TurnTraceOptions`), `turnOf` and `turnTools`.
- Core's host API, re-exported by name (`src/index.ts`) so that a host defining an agent and running its turns imports one package: a turn's input (`UserMessage`, `mediaFromBytes`, `mediaFromBase64`, `RunId`, `ConversationId`, `SessionAddress`, the types `TurnInput` and `NewTurn`); the turn and its result (the types `Turn`, `TurnPolicy`, `TurnOutcome`, `TurnResult`); the sessions turns begin in (`Sessions`, `SessionLog`, `SessionLogMemoryLive`, `TurnAdmission`, `TurnAdmissionOpen`, `TurnRefused`); the host's capabilities and plugins (`defineTool`, `defineSkill`, `definePromptSection`, `defineCapability`, the type `Capability`, `definePlugin`, `publishToolProgress`, `Failure`, `Media`, `SessionEnvironment`, `ActionPolicy`, `PermissionGrants`); the turn's events and the journal's records of its messages and end (`TurnEvent`, `TurnEvents`, the types `TurnEventOf` and `TurnEventsService`, `onEvent`, `onTool`, `subscribeAll`, `defineHostEvent`, `AssistantMessage`, `TurnEndedData`, `turnEndedOf`); what a turn fails with (`HarnessError`, `isHarnessError`, `harnessCodeOf`, `TurnBeginError`, `turnBeginCodes`, the type `TurnError`, `isTurnError`, `turnEndingOf`); and what the process has in flight and how it stops (`awaitIdle`, `processActivity`, `shutdownGracefully`, `DEFAULT_SHUTDOWN_DEADLINE`, `TurnShutdown`, `isShutdownRefusal`, the types `ShutdownOptions` and `ShutdownReport`). A port to implement and its entities, memory, model requests, stored payloads and References are imported from `@xandreed/core`, a kit from `@xandreed/core/conformance`: the sdk is the host's entry, not a second copy of core's surface. A name joins the list when a host writes it beside `Agent` in the common case, not because one test needs it.
- `quality/exports-have-consumers` runs on both entries (`CURATED_ENTRIES`): each export is imported from `@xandreed/sdk` (or `./conformance`) by another package, a script or a doc code block, or is tagged `@public`: the sdk's own declarations at the declaration, a re-export of core at its specifier in `src/index.ts`.
- `@xandreed/sdk/conformance` (`src/conformance/index.ts`): `toolRegistryConformance(make)` (`ToolRegistryLimits`), the `ToolRegistry` kit. It runs each check in a turn over `TurnLive` with a writer of its own that keeps the turn in memory: a kit ships in the build, which leaves test code out (`*.test.*`, `testing` modules and folders: `scripts/build-check.ts`), so it cannot import `recordingTurnWriter` (`src/turn/testing.ts`). It runs here, over the tool discovery plugin's registry, with its self-tests (`src/tool-registry.conformance.test.ts`).
- Plugins: none exported. `Agent.define` adds `@xandreed/sdk/host-contributions` (runtime, contributes `efferent/Capabilities`) for `AgentConfig.capabilities`.

## Model-facing text

None of its own: the system prompt prefix is the host's (`AgentConfig.system`, a turn's `system`). The sdk owns the pin of what a composed agent sends:

| Pinned text | Source | Pinned by |
|---|---|---|
| Every model request of the golden conversation: system prompts with the tool-discovery catalogue, tool descriptions and schemas (`load_skill`, `recall_context`, the host's), memory renderings (a `CompactViews` compaction, a digested result), seeded `load_skill` exchanges | `golden/agent-turn.model.json` | exact text, `src/agent.golden.test.ts:318`; over three storage backends, `src/agent.backends.test.ts` |
| Every model request of a streamed conversation: signed and redacted thinking sent back with its provider metadata, by the next request, the journal's rebuild of it and a second agent | `golden/agent-stream.model.json` | exact text, `src/agent.stream-golden.test.ts` |
| Every model and summarizer request of two compacting conversations: the window strategy's spill preview, the `recall_context` page that reads it back, and the host note and ledger of dropped turns; the summary strategy's summarizer prompt (default instructions, the data rule, the `<earlier-summary>` and `<conversation-transcript>` frames, a clipped tool result) and its handoff | `golden/agent-compaction.model.json` | exact text, `src/agent.compaction-golden.test.ts`; the journal's rebuild of each conversation's last request |

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/agent.adapter.ts` | `Agent.define`, `agent.turn`, the turn metrics |
| `src/task-executor.adapter.ts` | `agentTaskExecutor`: core's `TaskExecutor` over `Agent.turn` |
| `src/turn/turn.adapter.ts` | `TurnLive`: the turn as services over its writer |
| `src/turn/turn-phase.entity.ts`, `src/turn/turn-phase.entity.functions.ts` | where one turn stands in `TurnLive`, and its transitions |
| `src/turn/turn-run.usecase.functions.ts` | one run of the step loop: the step request, the cache key |
| `src/turn/turn-lifecycle.usecase.functions.ts` | the lifecycle: open the tools, settle, finish, guard, trace |
| `src/turn/tool-registry.conformance.ts` | the `ToolRegistry` kit |
| `src/index.ts` | the sdk's own exports and the core names it re-exports for hosts |
| `src/conformance/index.ts` | `@xandreed/sdk/conformance` |
| `src/testing.port.ts` | test-only services for the agent tests |
| `src/turn/testing.ts` | `recordingTurnWriter`: a writer that keeps the turn in memory, for the engine's tests |
| `golden/agent-turn.model.json`, `golden/agent-turn.journal.json` | the golden conversation: what the model and host see, and what is stored |
| `golden/agent-stream.model.json` | the streamed golden: what a streamed conversation sends and stores |
| `golden/agent-compaction.model.json` | the compaction golden: what a window and a summary conversation send, and the compactions they store |
| `fixtures/journal-<version>.json` | journals each release wrote |

## Tests

- Golden and composition: `agent.golden.test.ts`, `agent.stream-golden.test.ts`, `agent.compaction-golden.test.ts`, `agent.backends.test.ts`, `turn-composition.test.ts` (also runs core's `turnConformance`), `plugin-stack.test.ts`.
- Behaviour: `agent.adapter.test.ts`, `agent.trace.test.ts` (span nesting and ids), `activity.test.ts`, `models-plugin.test.ts`; the key-free journeys `resume.journey.test.ts` and `tasks.journey.test.ts` (a background task through `agentTaskExecutor`: start, the child's turn, delivery, `pending`, drain; the `Tasks` among each turn's services, a task's `start_task` refused for depth, a reaction starting a task).
- Queued input: `queued-input.journey.test.ts` runs a prebegun queued writer through `Agent.turn`, preserving normalized attachments and user provenance, and resumes an interrupted queued turn without draining the same input again.
- Durable steering: `durable-steering.journey.test.ts` covers final-response steering after a true completion verdict, restart before first dispatch, caps, post-probe arrivals, concurrent runs and refused/lost-acknowledgment commits.
- Host tool policy: `tool-policy.journey.test.ts` exercises real Agent per-run caps with exact run ordinals, per-tool concurrency shared across turns, interruption release, fair writer exclusion, nested calls across toolkit child fibers and queued breaker rechecks. The shipped registry kit includes policy and lane checks with careless adapters.
- The engine: `turn/turn.adapter.test.ts` (`TurnLive` over `recordingTurnWriter`), `turn/turn-lifecycle.usecase.functions.test.ts` (the begin and turn spans), `turn/turn-phase.entity.functions.test.ts`.
- Plugins tested inside a turn, here because the sdk lists them as devDependencies and a plugin the sdk lists never lists the sdk back: `tool-registry.conformance.test.ts` (the `ToolRegistry` kit over the tool discovery plugin's registry, and the kit's self-tests: careless registries that must fail), `tool-discovery-turn.test.ts` (that registry in turns over `TurnLive`: invocations and progress, subscriber failures, refusals and their journal, an open lacking declared services, defects, the matcher's choice, `load_skill` and `read_skill_reference`; the plugin's AGENTS.md pins its texts here), `sessions-begin-trace.test.ts` (the sessions plugin's spans under `traceTurnBegin`).
- Kits and compatibility: `memory.conformance.test.ts` (core's `memoryConformance` over the window and summary strategies and a test-only one), `journal-compat.test.ts`, `events-guide.test.ts`.
- Run: `bun test packages/sdk`.

See the root AGENTS.md for the enforced rules and the definition of done.
