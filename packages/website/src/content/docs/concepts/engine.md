---
title: Core contracts
description: Shared schemas and service ports, independent of providers and terminal clients.
---

# Core

`@xandreed/core` contains message schemas, plugin and configuration contracts,
session events and service ports. The runtime and concrete implementations live
in separate packages. `@xandreed/sdk` reexports the contracts for application authors.

The replaceable services include `AgentLoop`, `AgentTools`, `ContextManager`,
`Memory`, `SessionStore`, `ActionPolicy`, `Approval` and `TurnHooks`.

The default model/tool loop is `@xandreed/plugin-agent-loop`. The SDK owns
serialized turns, cancellation, durable event delivery, replay and forks.

See [SDK and sessions](/docs/concepts/harness).
