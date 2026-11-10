---
title: Agent step loop
description: Run model and tool steps through the SDK's planning, recording and completion protocol.
pluginId: "@xandreed/plugin-agent-loop/steps"
---

`stepLoopPlugin` provides `StepLoop`, the implementation that turns a planned
model request into model/tool steps. The SDK supplies the conversation plan,
tool registry, journal callbacks, completion policy and steering for each run.

## When to use it

Use this plugin for the framework's standard iterative agent behavior:
ask the model, execute admitted tool calls, record their outcomes, then
continue until completion or a configured limit. Hosts can replace the
`StepLoop` port when they need a different execution algorithm.

This plugin does not select a model, store a session or define application
tools. Those services come from the rest of the graph and the turn's services.

## Install and compose

```sh
npm install effect @xandreed/plugin-agent-loop
```

```ts
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"

const plugins = [
  { plugin: stepLoopPlugin, options: {} },
]
```

Include this fragment in `Agent.define`'s `plugins` array alongside a
conversation memory strategy and [tool discovery](/docs/plugins/tool-discovery/).
Your host also supplies `Sessions` and a model, for example by declaring
`LanguageModel.LanguageModel` in `turnServices` and providing it to each turn.
The [getting started example](/docs/getting-started/) shows the full composition.

## Configure the agent, not the plugin

The plugin has an empty options schema. Set `limits.maxSteps`,
`limits.toolConcurrency`, `limits.streaming` and loop-protection options in
`Agent.define` instead. A turn's run policy can override the agent's defaults.

The step cap bounds the run even when the degenerate-loop breaker is disabled.
Tool-call admission also has separate limits in the registry; increasing
`maxSteps` does not bypass those policies.

## Execution and recording

The loop validates a whole model response before running its tool calls.
Calls left incomplete by a cut response are answered as cut and are not
executed. Malformed output has a bounded corrective path. Unrecoverable
provider failures remain failures rather than successful empty replies.

Each started step settles once. The SDK records the accepted response and
tool results through the turn's writer, then evaluates completion. Reaching
the step cap or progress breaker can produce a partial outcome; the host
should inspect the result rather than assume every run completed its work.

## Streaming, steering and lifecycle

A recoverable stream failure before its first part can fall back to a
non-streamed call. Once output has arrived, a stream failure fails the step;
known permanent model failures do not use the fallback path.

Durable queued steering is taken through the current writer before dispatch
and checked again after settlement. Input arriving beyond the final empty
probe waits for another turn. The host's optional in-memory steering effect
is separate and does not survive restart.

The plugin runs on Node and Bun and keeps no conversation store itself.
Journal persistence and turn cancellation belong to the surrounding session
and SDK lifecycle.

## Related guides

- [Tool discovery and admission](/docs/plugins/tool-discovery/)
- [Sessions](/docs/plugins/sessions/)
- [Core contracts](/docs/concepts/engine/)
- [SDK and turn composition](/docs/concepts/harness/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-agent-loop/steps` · Version **0.20.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/StepLoop` |
| Requires | none |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "not": {
    "type": "null"
  }
}
```

</details>

<!-- plugin-reference:end -->
