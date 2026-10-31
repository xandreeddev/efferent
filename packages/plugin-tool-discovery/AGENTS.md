# @xandreed/plugin-tool-discovery

Core's `ToolRegistry` over every contributed capability: it registers the tools and skills once, keeps each turn's grow-only active set, runs the host's optional skill matcher, serves the skill tiers (the catalogue section, `load_skill`, `read_skill_reference`), checks every call centrally (active set, grants, action policy, call limits, concurrency lanes) and publishes `tool.*`, `skills.activated` and `decision.recorded`. Node 24 and Bun; layer `plugin-tool-discovery` in `foundry.config.ts` (imports core only).

## Rules

- `open` checks every registered tool's `requires` against the services it captures before it sets anything up: a missing one fails the open with `requires.missing`, naming each tool and service, so no handler finds one missing mid-turn.
- A call refused before its handler runs goes through `refuse`: it publishes `tool.refused` and returns `{ error, message }` as the call's result, for the model to correct.
- The handler context's `toolCallId` reaches `CurrentToolInvocation` and every `tool.*` event, refusals included. A direct call without one never inherits an outer call's id. The sdk's `provider-call-id` conformance check pins this contract.
- Flush `tool.started` before entering a handler, including before waiting on its lane. A failed flush fails the turn and runs no handler; the sdk's `started-durable` kit check proves this boundary.
- Only `skills.unknown` and `capability.forbidden` are refusals of an activation (`refusalNames`); any other failure there, such as the store's, is the turn's. Those codes are the host's (`RunTools.activate` fails with them, and spans and logs keep them); `load_skill` returns a refusal to the model under its own name, `UnknownSkill` or `PermissionDenied`.
- Every failure the model reads is `{ error, message }` with a PascalCase `error` that says what is wrong; never pass a host's code (a `HarnessError`'s, a port's) through as the name: map it where the `Failure` is built. The sdk's `ToolRegistry` kit checks the refusals' and `load_skill`'s names.
- A handler's defect reaches the model as `ToolDefect` with the first line of its message (core's `messagesOf`: never its class name or tag; at most 300 characters); the whole cause goes to the log only.
- A `TurnError` a handler dies with (`isTurnError`: a subscriber failing on its event, the writer or the store failing an activation, `TurnClosed` included) fails the turn after `tool.completed`, never as the call's result.
- Activation is one `SynchronizedRef.modifyEffect`: record `ToolsActivated` before publishing `skills.activated`; the active set only grows within a turn.
- Read-only tools share `readConcurrency` permits within a turn; a writer excludes all readers and writers through a fair admission turnstile. Host `toolPolicy` concurrency permits live outside `open` and span turns on the same registry. Nested calls inherit a logical gate owner across toolkit child fibers and refuse occupied gates immediately rather than wait recursively.
- Top-level and annotation `maxCallsPerRun` remain per-turn budgets. `toolPolicy[name].maxCallsPerRun` and its consecutive-handler-failure breaker are per exact `CurrentAgentRun`; direct calls without that reference share a distinct turn-local bucket. All caps are atomic, and queued calls recheck a breaker under the execution permit. Framework errors and interruption never count as handler failures. Success resets a streak; typed failures are neutral under the default defects-only policy.
- Always-on skills are never in the catalogue and their instructions never reach the model: guidance goes in tool descriptions or a prompt section.
- A text change updates its exact pin; text the sdk golden shows is re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `toolDiscoveryPlugin` (also the default export) and `ToolDiscoveryLive` (its `.live` layer); `ToolDiscoveryConfig`, `toolDiscoveryDefaults`; `makeRegistry` (its options are the type `DiscoveryConfig`). The tier texts (`catalogText`, `skillInstructions`) stay inside the package.

The root names each export, and `quality/exports-have-consumers` checks each one: the sdk's tests and the scripts import `toolDiscoveryPlugin`, `ToolDiscoveryLive`, `toolDiscoveryDefaults`, `makeRegistry` and `DiscoveryConfig`, and the rest are tagged `@public` at their declarations (`toolDiscoveryPlugin`'s tag covers the default export).

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `toolDiscoveryPlugin` | `@xandreed/plugin-tool-discovery` | runtime | `efferent/ToolRegistry` | `efferent/Capabilities` (the `tool-discovery.catalogue` section) | `efferent/Capabilities` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `load_skill` description | `src/registry.adapter.ts:86` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:571`; sdk golden |
| `read_skill_reference` description | `src/registry.adapter.ts:94` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:572` |
| Catalogue heading and lines (`catalogText`) | `src/registry.adapter.ts:131-136` | sdk golden |
| Skill instructions (`skillInstructions`: `## id`, `Tools:`, `References (read_skill_reference):`, `Now available:`), also for matcher-seeded exchanges | `src/registry.adapter.ts:123-129` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:585`; sdk golden |
| `ToolInactive` messages: not loaded, not available | `src/registry.adapter.ts:337-338` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:308`, `:359` |
| `ToolCallLimit` message | `src/registry.adapter.ts:349` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:319` |
| Host per-run `ToolCallLimit` (including disabled), `ToolTripped` and nested `ToolConcurrency` messages; tool names stay in result metadata | `src/tool-policy.entity.functions.ts:35-39` | exact, `src/tool-policy.entity.functions.test.ts:35-39` |
| `PermissionDenied` (a permission the turn lacks), `CallLimit` messages; `PolicyDenied` carries the policy's | `src/registry.adapter.ts:341`, `:347`, `:344` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:309`, `:315`, `:311` |
| `ToolDefect` message: the defect's message alone (`messagesOf`), never its class name or tag | `src/registry.adapter.ts:410` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:407`, `:419` |
| `SkillLoadLimit`, `UnknownReference` messages; `load_skill`'s refusals, each under its name (`refusalNames`): `UnknownSkill`, `Unknown skills: …; load_skill takes …` (the code `skills.unknown`), and `PermissionDenied` with core's `capability.forbidden` message | `src/registry.adapter.ts:301`, `:313`, `:283`, `:79-82`, `:304` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:546`, `:586`, `:539`, `:534` |
| `SkillNotLoaded` message | `src/registry.adapter.ts:312` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:584` |
| `requires.missing` at open (`<tool> requires <key>, …; …`): fails the turn before any step, so a model reads it only as a failed turn's message, such as a background task's notice | `src/registry.adapter.ts:253`, `:255` | exact, `packages/sdk/src/tool-discovery-turn.test.ts:386` |

## Erasure files

None. The toolkit is built from tools known only at run time (`Toolkit.make` over the registered list), so it is typed over any tool (`Tool.Any`); its handlers, by name, are core's `ToolHandlers` as `toHandlers` returns them, with no cast.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, the plugin, the catalogue capability |
| `src/registry.adapter.ts` | the registry: registration checks, tiers, activation, the call wrapper, the matcher, views |
| `src/index.ts` | the public exports |

## Tests

- `src/registry.adapter.test.ts`: the views of a result holding images, and digest tasks.
- `src/tool-policy.entity.functions.test.ts`: bounded host limits, atomic cap decisions, breaker transitions and exact new refusal wording. SDK `tool-policy.journey.test.ts` exercises real Agent run budgets, agent-wide permits across turns, cancellation release, fair read/write exclusion and nested child-fiber calls. The shipped registry kit catches ignored host policy and careless read-only lanes.
- In the sdk, over its `TurnLive`, since the registry's contract holds inside a turn: `packages/sdk/src/tool-registry.conformance.test.ts` runs the sdk's `toolRegistryConformance` against the plugin, with self-tests of careless registries that must fail; `packages/sdk/src/tool-discovery-turn.test.ts` covers invocations and progress, subscriber failures, refusals, an open lacking declared services, defects, the matcher's choice, `load_skill` and `read_skill_reference` with their descriptions and refusals.
- The sdk golden composes it; the workspace journey and skills tests drive `load_skill` and `read_skill_reference` end to end.
- Run: `bun test packages/plugin-tool-discovery packages/sdk/src/tool-registry.conformance.test.ts packages/sdk/src/tool-discovery-turn.test.ts packages/sdk/src/agent.golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
