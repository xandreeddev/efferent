---
title: Core contracts
description: Shared schemas and service ports, independent of providers and hosts.
---

# Core

`@xandreed/core` contains message schemas, plugin and configuration contracts,
session events and service ports. The runtime and concrete implementations live
in separate packages. `@xandreed/sdk` reexports the contracts for application authors.

The replaceable services include `StepLoop`, `ConversationMemory`,
`ResultDigester`, `ToolRegistry`, `Sessions`, `SessionLog`, `TurnAdmission`,
`Tasks` and `ActionPolicy`, and the optional busy-signal probes
`TurnActivity` and `TaskActivity`.

The step loop is `stepLoopPlugin` from `@xandreed/plugin-agent-loop`.
`@xandreed/plugin-sessions` owns serialized turns, durable events and forks;
`Agent.turn` in the SDK composes one turn over them.

Core also ships the port contracts as runnable checks, to run against your
own implementation, from `@xandreed/core/conformance`: see
[conformance kits](/docs/concepts/conformance).

## Entries

| Import | Holds | Semver |
| --- | --- | --- |
| `@xandreed/core` | entities, ports, events and journal kinds, `define*` helpers, errors, model-text frames, References, in-memory adapters (the turn's event bus and tasks among them) | yes |
| `@xandreed/core/conformance` | the port kits but the tool registry's, `ConformanceCheck`, `ConformanceFailure` and `check` | yes |
| `@xandreed/core/internal` | what the first-party packages share with core: the provider mapping, stream fold, tool schemas and id helper, and what the sdk's turn engine reads of core | no |

The root does not repeat what a subpath holds: import a kit from its entry.
The turn engine (`TurnLive` and the turn's lifecycle) is `@xandreed/sdk`'s,
and so is the tool registry's kit (`@xandreed/sdk/conformance`), which runs
its turns over it. The credential and settings stores (`AuthStore`,
`SettingsStore`) are the models plugin's own ports, exported by
`@xandreed/plugin-models`, with their kits in
`@xandreed/plugin-models/conformance`.

See [SDK and sessions](/docs/concepts/harness).
