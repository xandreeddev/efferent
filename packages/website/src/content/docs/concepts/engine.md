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
| `@xandreed/core` | entities, ports, events and journal kinds, `define*` helpers, errors, model-text frames, References, in-memory adapters | yes |
| `@xandreed/core/conformance` | the port kits, `ConformanceCheck`, `ConformanceFailure` and `check` | yes |
| `@xandreed/core/engine` | the turn engine: `TurnLive` and the turn's lifecycle | no; moves into `@xandreed/sdk` in the next minor release |
| `@xandreed/core/internal` | the provider mapping, stream fold, tool schemas and id helper the first-party packages share | no |

The root does not repeat what a subpath holds: import a kit or an engine
function from its entry. The credential and settings stores (`AuthStore`,
`SettingsStore`) are the models plugin's own ports, exported by
`@xandreed/plugin-models`, with their kits in
`@xandreed/plugin-models/conformance`.

See [SDK and sessions](/docs/concepts/harness).
