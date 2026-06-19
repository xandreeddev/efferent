---
title: AgentHooks
description: The optional callback surface for observing and steering the agent loop.
sidebar:
  label: AgentHooks
  order: 3
---

From `@xandreed/sdk-core/entities/AgentHooks.ts`. Every hook is optional and returns an `Effect`. `R` is
the union of port requirements your hooks need; it flows up through `runAgent`.

```ts
interface AgentHooks<R = never> {
  readonly onTurnStart?:        (e: AgentTurnStartEvent)        => Effect.Effect<void, never, R>
  readonly onAssistantMessage?: (e: AgentAssistantMessageEvent) => Effect.Effect<void, never, R>
  readonly onBeforeToolCall?:   (e: AgentBeforeToolCallEvent)   => Effect.Effect<BeforeToolCallDecision, never, R>
  readonly onAfterToolCall?:    (e: AgentAfterToolCallEvent)    => Effect.Effect<void, never, R>
  readonly onTransformContext?: (m: ReadonlyArray<AgentMessage>) => Effect.Effect<ReadonlyArray<AgentMessage>, never, R>
  readonly onShouldStopAfterTurn?: (e: AgentShouldStopEvent)    => Effect.Effect<boolean, never, R>
  readonly onAgentEnd?:         (e: AgentEndEvent)              => Effect.Effect<void, never, R>
  readonly onSubAgentStart?:    (e: AgentSubAgentStartEvent)    => Effect.Effect<void, never, R>
  readonly onSubAgentEnd?:      (e: AgentSubAgentEndEvent)      => Effect.Effect<void, never, R>
  readonly onSkillLoad?:        (e: AgentSkillLoadEvent)        => Effect.Effect<void, never, R>
  readonly onHelperUsage?:      (e: AgentHelperUsageEvent)      => Effect.Effect<void, never, R>
}

type BeforeToolCallDecision =
  | { readonly action: "continue" }
  | { readonly action: "block"; readonly reason: string }
```

## Event payloads (selected)

| Event | Key fields |
| --- | --- |
| `AgentTurnStartEvent` | `turnIndex`, `messages` |
| `AgentAssistantMessageEvent` | `turnIndex`, `text`, `reasoning?`, `toolCalls`, `usage?`, `subAgentNodeId?` |
| `AgentBeforeToolCallEvent` | `turnIndex`, `toolCallId`, `toolName`, `args`, `subAgentNodeId?` |
| `AgentAfterToolCallEvent` | `toolCallId`, `toolName`, `args`, `ok`, `result`, `subAgentNodeId?` |
| `AgentShouldStopEvent` | `turnIndex`, `finishReason` |
| `AgentEndEvent` | `messages`, `finalText` |
| `AgentSubAgentStartEvent` | `name`, `task`, `nodeId?`, `parentNodeId?` |
| `AgentSubAgentEndEvent` | `name`, `nodeId?`, `ok`, `summary`, `filesChanged`, `usage?` |
| `AgentHelperUsageEvent` | `role: "fast"`, `usage` |

See the [hooks guide](/efferent/guides/hooks/) for usage and the runnable
[hooks agent](/efferent/examples/hooks-agent/).
