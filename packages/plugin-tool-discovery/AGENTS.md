# @xandreed/plugin-tool-discovery

Core's `ToolRegistry` over every contributed capability: it registers the tools and skills once, keeps each turn's grow-only active set, runs the host's optional skill matcher, serves the skill tiers (the catalogue section, `load_skill`, `read_skill_reference`), checks every call centrally (active set, grants, action policy, call limits, concurrency lanes) and publishes `tool.*`, `skills.activated` and `decision.recorded`. Node 24 and Bun; layer `plugin-tool-discovery` in `foundry.config.ts` (imports core only).

## Rules

- `open` checks every registered tool's `requires` against the services it captures before it sets anything up: a missing one fails the open with `requires.missing`, naming each tool and service, so no handler finds one missing mid-turn.
- A call refused before its handler runs goes through `refuse`: it publishes `tool.refused` and returns `{ error, message }` as the call's result, for the model to correct.
- Only `skills.unknown` and `capability.forbidden` are refusals of an activation (`refusalCodes`); any other failure there, such as the store's, is the turn's.
- A handler's defect reaches the model as `ToolDefect` with the first line of its message (at most 300 characters); the whole cause goes to the log only.
- A `TurnError` a handler dies with (`isTurnError`: a subscriber failing on its event, the writer or the store failing an activation, `TurnClosed` included) fails the turn after `tool.completed`, never as the call's result.
- Activation is one `SynchronizedRef.modifyEffect`: record `ToolsActivated` before publishing `skills.activated`; the active set only grows within a turn.
- Read-only tools share `readConcurrency` permits; every other tool runs alone on the write lane.
- Always-on skills are never in the catalogue and their instructions never reach the model: guidance goes in tool descriptions or a prompt section.
- A text change updates its exact pin; text the sdk golden shows is re-recorded with `EFFERENT_UPDATE_MODEL_GOLDEN=1` and the diff reviewed.

## Public surface

- `toolDiscoveryPlugin` (also the default export) and `ToolDiscoveryLive` (its `.live` layer); `ToolDiscoveryConfig`, `toolDiscoveryDefaults`; `makeRegistry`, `catalogText`, `skillInstructions`; the type `DiscoveryConfig`.

| Plugin | Id | Scope | Provides | Contributes | Requires |
|---|---|---|---|---|---|
| `toolDiscoveryPlugin` | `@xandreed/plugin-tool-discovery` | runtime | `efferent/ToolRegistry` | `efferent/Capabilities` (the `tool-discovery.catalogue` section) | `efferent/Capabilities` |

## Model-facing text

| Text | Source | Pinned by |
|---|---|---|
| `load_skill` description | `src/registry.adapter.ts:72` | exact, `src/registry.adapter.test.ts:546`; sdk golden |
| `read_skill_reference` description | `src/registry.adapter.ts:80` | exact, `src/registry.adapter.test.ts:547` |
| Catalogue heading and lines (`catalogText`) | `src/registry.adapter.ts:117-122` | sdk golden |
| Skill instructions (`skillInstructions`: `## id`, `Tools:`, `References (read_skill_reference):`, `Now available:`), also for matcher-seeded exchanges | `src/registry.adapter.ts:109-115` | exact, `src/registry.adapter.test.ts:560`; sdk golden |
| `ToolInactive` messages: not loaded, not available | `src/registry.adapter.ts:309-310` | exact, `src/registry.adapter.test.ts:298`, `:349` |
| `ToolCallLimit` message | `src/registry.adapter.ts:321` | exact, `src/registry.adapter.test.ts:309` |
| `Forbidden`, `CallLimit` messages; `Denied` carries the policy's | `src/registry.adapter.ts:313`, `:319`, `:316` | exact, `src/registry.adapter.test.ts:299`, `:305`, `:301` |
| `ToolDefect` message | `src/registry.adapter.ts:338` | exact, `src/registry.adapter.test.ts:397` |
| `SkillLoadLimit`, `UnknownReference` messages; `load_skill`'s refusals: `Unknown skills: …; load_skill takes …` (`skills.unknown`) and core's `capability.forbidden` message | `src/registry.adapter.ts:277`, `:289`, `:259`, `:280` | exact, `src/registry.adapter.test.ts:521`, `:561`, `:514`, `:509` |
| `SkillNotLoaded` message | `src/registry.adapter.ts:288` | exact, `src/registry.adapter.test.ts:559` |
| `requires.missing` at open (`<tool> requires <key>, …; …`): fails the turn before any step, so a model reads it only as a failed turn's message, such as a background task's notice | `src/registry.adapter.ts:230`, `:232` | exact, `src/registry.adapter.test.ts:376` |

## Erasure files

None. The toolkit is built from tools known only at run time (`Toolkit.make` over the registered list), so it is typed over any tool (`Tool.Any`); its handlers, by name, are core's `ToolHandlers` as `toHandlers` returns them, with no cast.

## Layout

| File | Role |
|---|---|
| `src/plugin.adapter.ts` | config, the plugin, the catalogue capability |
| `src/registry.adapter.ts` | the registry: registration checks, tiers, activation, the call wrapper, the matcher, views |
| `src/index.ts` | the public exports |

## Tests

- `src/registry.conformance.test.ts` runs core's `toolRegistryConformance` against the plugin, with self-tests of careless registries that must fail.
- `src/registry.adapter.test.ts`: invocations and progress, subscriber failures, refusals, an open lacking declared services, defects, the matcher's choice, `load_skill` and `read_skill_reference` with their descriptions and refusals, image views, digest tasks.
- The sdk golden composes it; the workspace journey and skills tests drive `load_skill` and `read_skill_reference` end to end.
- Run: `bun test packages/plugin-tool-discovery packages/sdk/src/agent.golden.test.ts`.

See the root AGENTS.md for the enforced rules and the definition of done.
