---
title: Hooks — observe & steer
description: Watch and influence the agent loop with AgentHooks, without owning the loop. Block tool calls, transform context, decide when to stop.
sidebar:
  label: Hooks
  order: 3
---

`AgentHooks` is how a driver (the TUI, your app) observes and influences the loop **without owning it**.
Every hook is optional and returns an `Effect`; you pass the object as the 4th argument to
[`runAgent`](/docs/reference/run-agent/).

```ts
import { type AgentHooks } from "@xandreed/sdk-core"

const hooks: AgentHooks = {
  onTurnStart: (e) => Effect.log(`turn ${e.turnIndex}`),

  // Steer: veto a tool call. The reason is returned to the model as a tool result,
  // so it adjusts in the same turn.
  onBeforeToolCall: (e) =>
    e.toolName === "Bash" && /rm -rf/.test(String((e.args as any).command))
      ? Effect.succeed({ action: "block", reason: "Refusing destructive rm." } as const)
      : Effect.succeed({ action: "continue" } as const),

  onAfterToolCall: (e) => Effect.log(`${e.toolName} -> ${e.ok ? "ok" : "fail"}`),
  onAssistantMessage: (e) => (e.usage ? Effect.log(`${e.usage.totalTokens} tok`) : Effect.void),
}
```

## The surface

| Hook | Returns | Use it to |
| --- | --- | --- |
| `onTurnStart` | `void` | Log / inspect the buffer at the top of each turn. |
| `onBeforeToolCall` | `{ action: "continue" }` \| `{ action: "block", reason }` | **Gate** a tool call (approval, guardrails). |
| `onAfterToolCall` | `void` | React to a tool result (metrics, UI). |
| `onAssistantMessage` | `void` | Read assistant text + reasoning + token usage. |
| `onTransformContext` | `AgentMessage[]` | Rewrite the buffer before a turn (advanced). |
| `onShouldStopAfterTurn` | `boolean` | Stop early on a custom condition. |
| `onAgentEnd` | `void` | Final text + full message history. |
| `onSubAgentStart` / `onSubAgentEnd` | `void` | Track [sub-agent](/docs/concepts/sub-agents/) runs. |
| `onSkillLoad` | `void` | A [skill](/docs/concepts/skills/) body was lazy-loaded. |
| `onHelperUsage` | `void` | Account fast-tier helper spend (e.g. compaction digests). |

:::note[Type tip]
`AgentHooks` is generic in `R` (the union of port requirements your hooks need). With all-`Effect.log`
hooks, `R = never`. Passing a value typed as `AgentHooks` also pins `runAgent`'s requirements to `never`
even when you don't otherwise need hooks — see the [calculator example](/docs/examples/calc-agent/).
:::

Runnable version: the [hooks agent](/docs/examples/hooks-agent/).
