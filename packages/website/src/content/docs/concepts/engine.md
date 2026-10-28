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
`Tasks` and `ActionPolicy`.

The step loop is `stepLoopPlugin` from `@xandreed/plugin-agent-loop`.
`@xandreed/plugin-sessions` owns serialized turns, durable events and forks;
`Agent.turn` in the SDK composes one turn over them.

See [SDK and sessions](/docs/concepts/harness).
