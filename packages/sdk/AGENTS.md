# @xandreed/sdk

The composable agent: `Agent.define` builds an agent's plugin graph once (through runtime's `resolveGraph` and `activateGraph`) and `agent.turn` runs one turn over core's `TurnLive`, with the session, memory, registry and step loop its plugins provide. It re-exports all of core, so a host imports one package. Node 24 and Bun; layer `sdk` in `foundry.config.ts` (imports core and runtime); its tests are the `sdk-tests` layer, which may import every plugin.

## Rules

- The sdk composes and owns no port: new behaviour goes in core or a plugin, and `agent.adapter.ts` only wires it. Its one other adapter, `task-executor.adapter.ts` (`agentTaskExecutor`), only wires `Agent.turn` (any `TurnRunner`) as core's `TaskExecutor`: the tasks plugin begins and ends the turns, the executor runs them. Hosts build `Tasks` beside the agent (`TasksLive(config).pipe(Layer.provide(agentTaskExecutor(agent, { services })))`): a `tasksPlugin` among the agent's own plugins would need the executor before the agent exists.
- Fail at define time, not at the first turn: no `ConversationMemory`, `ToolRegistry` or `StepLoop` is `config.graph`, a bad `budgetTokens` is `config.budget`.
- A turn that cannot begin fails with its `TurnBeginError` as it is (a `Sessions.begin` refusal, or `AttachmentRejected`), never a `HarnessError` made from it: hosts match it by tag, and core's `turnBeginCodes` (checked against `TurnBeginError` there) gives its code.
- Any change to what the model or the journal sees shows in `golden/`: re-record only on purpose (`EFFERENT_UPDATE_MODEL_GOLDEN=1`, `EFFERENT_UPDATE_GOLDEN=1`) and review the diff in the PR.
- `src/turn-composition.test.ts` rebuilds the golden agent by hand from the typed layers: a composition change keeps both it and `Agent.turn` byte-identical to the golden.
- Every `fixtures/journal-<version>.json` keeps decoding (`src/journal-compat.test.ts`); record one per release with `bun scripts/record-journal-fixture.ts`, never over a released one.
- `docs/events.md` quotes regions of `src/events-guide.test.ts`: edit the snippet there, then run `bun run docs:generate`.
- Keep test-only code out of `index.ts`: `src/testing.port.ts` (`Tally`, `Stamp`) serves the tests only, and the build leaves it out.

## Public surface

- `export * from "@xandreed/core"` (`turnBeginCodes` among it), plus `Agent` (`Agent.define`) and the types `AgentConfig` and `AgentPluginEntry` (`src/agent.adapter.ts`), and `agentTaskExecutor(agent, { services, child?, react? })` (`src/task-executor.adapter.ts`): a `Layer<TaskExecutor>` whose child and reaction turns are, by default, the turn's skills selected, then one run of the step loop, its text the reply.
- Plugins: none exported. `Agent.define` adds `@xandreed/sdk/host-contributions` (runtime, contributes `efferent/Capabilities`) for `AgentConfig.capabilities`.

## Model-facing text

None of its own: the system prompt prefix is the host's (`AgentConfig.system`, a turn's `system`). The sdk owns the pin of what a composed agent sends:

| Pinned text | Source | Pinned by |
|---|---|---|
| Every model request of the golden conversation: system prompts with the tool-discovery catalogue, tool descriptions and schemas (`load_skill`, `recall_context`, the host's), memory renderings (a `CompactViews` compaction, a digested result), seeded `load_skill` exchanges | `golden/agent-turn.model.json` | exact text, `src/agent.golden.test.ts:317`; over three storage backends, `src/agent.backends.test.ts` |
| Every model request of a streamed conversation: signed and redacted thinking sent back with its provider metadata, by the next request, the journal's rebuild of it and a second agent | `golden/agent-stream.model.json` | exact text, `src/agent.stream-golden.test.ts` |

The golden has no spill, dropped-turn or summary scenario: those texts are pinned, or not, in their plugins.

## Erasure files

None.

## Layout

| File | Role |
|---|---|
| `src/agent.adapter.ts` | `Agent.define`, `agent.turn`, the turn metrics |
| `src/task-executor.adapter.ts` | `agentTaskExecutor`: core's `TaskExecutor` over `Agent.turn` |
| `src/index.ts` | core re-export and the sdk's own exports |
| `src/testing.port.ts` | test-only services for the agent tests |
| `golden/agent-turn.model.json`, `golden/agent-turn.journal.json` | the golden conversation: what the model and host see, and what is stored |
| `golden/agent-stream.model.json` | the streamed golden: what a streamed conversation sends and stores |
| `fixtures/journal-<version>.json` | journals each release wrote |

## Tests

- Golden and composition: `agent.golden.test.ts`, `agent.stream-golden.test.ts`, `agent.backends.test.ts`, `turn-composition.test.ts` (also runs core's `turnConformance`), `plugin-stack.test.ts`.
- Behaviour: `agent.adapter.test.ts`, `agent.trace.test.ts` (span nesting and ids), `activity.test.ts`, `models-plugin.test.ts`; the key-free journeys `resume.journey.test.ts` and `tasks.journey.test.ts` (a background task through `agentTaskExecutor`: start, the child's turn, delivery, `pending`, drain).
- Kits and compatibility: `memory.conformance.test.ts` (core's `memoryConformance` over the window and summary strategies and a test-only one), `journal-compat.test.ts`, `events-guide.test.ts`.
- Run: `bun test packages/sdk`.

See the root AGENTS.md for the enforced rules and the definition of done.
