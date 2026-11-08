---
title: Background tasks
description: Run helper work in child sessions and deliver durable results or questions to the parent.
pluginId: "@xandreed/plugin-tasks"
---

`tasksPlugin` provides `Tasks`: helper work represented by child sessions,
with durable starts, results, cancellations and parent questions. The host
chooses the `TaskRunner` that schedules work and the `TaskExecutor` that
executes a child turn and reacts to its result.

## When to use it

Use tasks when helper work should continue outside the parent's current
turn and its outcome should enter the parent's inbox. A task can start
fresh or fork eligible conversation history. A task cannot start a nested
task; the parent may start another after a result arrives.

## Install and configure

```sh
npm install effect @xandreed/plugin-tasks
```

```ts
import { tasksPlugin } from "@xandreed/plugin-tasks"

const plugins = [
  {
    plugin: tasksPlugin,
    options: {
      maxRunning: 2,
      tools: true,
      replyChars: 12_000,
      closingReserveMs: 2_000,
    },
  },
]
```

This is an `Agent.define` plugin-array fragment for hosts that can supply
`Sessions`, `TaskRunner` and `TaskExecutor` when building the graph. It does
not install a scheduler or model. With `tools: true`, the plugin contributes
its task capability; include [tool discovery](/docs/plugins/tool-discovery/)
to expose it to the model.

## Choose the service ownership

`InProcessTaskRunnerLive({ maxMs })` is the package's scoped fiber runner;
it also provides `TaskActivity`. A host may supply another `TaskRunner` for
its execution environment. A finite runner budget includes admission,
execution, delivery and parent reactions. `closingReserveMs` leaves time for
durable closing work, using at most half that finite budget.

For an executor backed by the same agent, `agentTaskExecutor(agent, options)`
from `@xandreed/sdk` needs that agent to exist first. In this arrangement,
build `TasksLive` beside the defined agent over the shared sessions, runner
and executor. Register `tasksCapability` in the agent's capabilities and pass
the built services to its turns. Avoid a circular graph in which the agent
needs its own executor before it can be defined.

## Tools and parent questions

The capability exposes `start_task`, `task_status`, `ask_parent`,
`steer_task`, `answer_task` and `cancel_task`. The `tools` option defaults to
false, so programmatic task use does not automatically add model tools.

A helper's question is recorded before notifying its parent. Its turn ends
waiting, without a terminal result; the accepted answer queues a later turn
on the same child. There is one outstanding question per task. Waiting tasks
count toward `maxRunning`, and waiting releases the writer and runner fiber.

## Delivery, restart and shutdown

The child records its result before closing. A stable delivery identifier
makes terminal delivery to the parent's inbox idempotent. Parent reactions
drain notices after the active turn; queued user input remains for the
host's ordinary input runner.

`Tasks.reconcile` repairs work left between durable transitions, including
delivery. The host decides when to reconcile and whether it has startup
takeover authority. Durable records do not turn an in-process fiber runner
into a process-independent worker queue.

The package runs on Node and Bun. Closing the in-process runner's Effect
scope interrupts its fibers. Keep the shared session storage across restarts
and include task activity when waiting for the host to become idle.

## Related guides

- [Sessions and inbox behavior](/docs/plugins/sessions/)
- [Tool discovery](/docs/plugins/tool-discovery/)
- [SDK and task execution](/docs/concepts/harness/)
- [Context, memory and the journal](/docs/concepts/context-journal/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-tasks` · Version **0.19.2** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/Tasks` |
| Requires | `efferent/Sessions`, `efferent/TaskRunner`, `efferent/TaskExecutor` |
| Uses when available | none |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "maxRunning": 2,
  "tools": false,
  "replyChars": 12000,
  "closingReserveMs": 2000
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "maxRunning": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    },
    "tools": {
      "type": "boolean"
    },
    "replyChars": {
      "type": "integer",
      "minimum": 100,
      "maximum": 100000
    },
    "closingReserveMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 600000
    }
  },
  "required": [
    "maxRunning",
    "tools",
    "replyChars",
    "closingReserveMs"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
