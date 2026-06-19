---
title: runAgent
description: The single entry point that drives the agent loop for one user prompt.
sidebar:
  label: runAgent
  order: 2
---

The one function that drives the whole interaction. From `@xandreed/sdk-core/usecases/runAgent.ts`.

```ts
const runAgent: <Tools extends Record<string, Tool.Any>, R>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  userPrompt: string,
  extraHooks?: AgentHooks<R>,
  workspaceDir?: string,
) => Effect.Effect<AgentResult, /* tagged errors */, /* ports + R */>
```

It appends the user message, loads history (applying the latest [handoff](/efferent/concepts/headroom/#handoff)
checkpoint), runs the [loop](/efferent/concepts/agent-loop/) until the model stops calling tools or
`maxSteps`, persists the new tail, and returns the result.

## Parameters

| Param | Type | Notes |
| --- | --- | --- |
| `config` | [`AgentConfig<Tools>`](/efferent/reference/agent-config/) | The agent definition (prompt + toolkit + optional compression). |
| `conversationId` | `ConversationId` | A branded UUID. `Schema.decodeUnknown(ConversationId)(crypto.randomUUID())` to mint one. |
| `userPrompt` | `string` | The user's message for this run. |
| `extraHooks?` | [`AgentHooks<R>`](/efferent/reference/hooks/) | Observe/steer the loop. Pass a typed value to pin `R`. |
| `workspaceDir?` | `string` | Workspace root (for staleness stamping / scope). Defaults to the process cwd. |

## Returns — `AgentResult`

```ts
const AgentResult = Schema.Struct({
  finalText: Schema.String,                  // the model's final answer
  messages: Schema.Array(AgentMessage),       // full conversation after the run
  newTail: Schema.Array(AgentMessage),        // only the messages this run appended
  stoppedAtMaxSteps: Schema.optional(Schema.Boolean),
})
```

## Requirements

The effect requires the ports the loop uses — `ConversationStore`, `LanguageModel`, `SettingsStore`,
`AuthStore`, plus whatever your tool handlers need — satisfied by your
[composition root](/efferent/guides/composition-root/). The toolkit's **handler layer** is provided
separately: `runAgent(...).pipe(Effect.provide(handlerLayer))`.
