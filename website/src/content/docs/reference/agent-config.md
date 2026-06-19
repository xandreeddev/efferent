---
title: AgentConfig
description: The AgentConfig interface — the bundle of system prompt, toolkit, and compression policy that defines an agent.
sidebar:
  label: AgentConfig
  order: 1
---

An `AgentConfig<Tools>` is the bundle that *defines* an agent: a versioned system prompt plus an
`@effect/ai` `Toolkit`. `runAgent` is parameterized by it; the same shape powers the bundled coding
agent and your own.

```ts
interface AgentConfig<Tools extends Record<string, Tool.Any>> {
  /** Stable identifier for cache-key isolation across configs in a conversation. */
  readonly key: string
  /** The prompt (name/version + rendered text) this agent runs with. */
  readonly prompt: Prompt
  readonly toolkit: Toolkit.Toolkit<Tools>
  /**
   * How this agent keeps its context small. Absent ⇒ the SDK default
   * (Headroom.default()). Compression.none disables it; a custom policy replaces it.
   * Inherited by this agent's sub-agents.
   */
  readonly compression?: CompressionPolicy
}
```

From `@xandreed/sdk-core/usecases/agentConfig.ts`.

## Fields

| Field | Type | Notes |
| --- | --- | --- |
| `key` | `string` | Isolates prompt-cache keys across different configs in one conversation. Use something stable and descriptive (the coder uses `coder:<rootDir>`). |
| `prompt` | [`Prompt`](#prompt) | The system prompt — versioned so you can A/B prompt variants. |
| `toolkit` | `Toolkit.Toolkit<Tools>` | The `@effect/ai` toolkit. Its **handler `Layer`** is provided separately at the composition root (that's where runtime deps like `cwd`/`FileSystem` enter). |
| `compression?` | [`CompressionPolicy`](/efferent/reference/compression/) | Optional. Omit for the cache-safe default; see [context headroom](/efferent/concepts/headroom/). |

## Prompt

```ts
interface Prompt {
  readonly name: string
  readonly version: string
  readonly variant?: string | undefined
  readonly text: string
}
```

The `text` is the full system prompt. `name` / `version` / `variant` are metadata — useful for eval
matrices that compare prompt variants.

## Minimal example

```ts
const config: AgentConfig<Tools> = {
  key: "dice-agent",
  prompt: { name: "dice", version: "1.0.0", text: "You are a dice assistant." },
  toolkit,
}
```

See also: [`runAgent`](/efferent/reference/run-agent/) · [Your first agent](/efferent/your-first-agent/).
