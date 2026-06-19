---
title: Compression & Headroom
description: The CompressionPolicy type, the Compression combinators, and the Headroom default tactics.
sidebar:
  label: Compression & Headroom
  order: 4
---

From `@xandreed/sdk-core` — `entities/Compression.ts` (types + combinators) and `usecases/headroom.ts`
(the default tactics). Concepts: [context headroom](/efferent/concepts/headroom/).

## Types

```ts
interface CompressionPolicy {
  readonly tail?: TailCompressor       // moment 1: append-time, per tool-result, PERSISTED, cache-safe
  readonly context?: ContextCompressor // moment 2: in-memory, whole-buffer, per-turn, NOT persisted
}

type TailCompressor = (
  tail: ReadonlyArray<AgentMessage>,
  budget: CompressionBudget,
) => Effect.Effect<CompressionReport>

type ContextCompressor = (
  messages: ReadonlyArray<AgentMessage>,
) => Effect.Effect<ReadonlyArray<AgentMessage>>

interface CompressionBudget {
  readonly maxChars: number        // ≈ Settings.toolResultMaxTokens × 4
  readonly contextWindow?: number
  readonly inputTokens?: number
}

interface CompressionReport {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly helperUsage?: TokenUsage // fast-tier digest spend, re-emitted via onHelperUsage
}
```

Strategies are `R = never`: a custom one reaches services via `Effect.serviceOption(Tag)` or closes over a
pre-built client, so `AgentConfig` needs no requirements parameter.

## `Compression` combinators

```ts
Compression.none              // CompressionPolicy — disable entirely
Compression.passthroughTail   // TailCompressor — explicit no-op
Compression.pipeline(...steps: TailCompressor[])               // run in sequence, summing helper usage
Compression.when(pred: (b: CompressionBudget) => boolean, step) // apply step only when pred holds
```

## `Headroom` default tactics

```ts
Headroom.default()                 // CompressionPolicy — { tail: Headroom.toolResults() } (the SDK default)
Headroom.toolResults()             // TailCompressor — append-time structure-aware clip + optional fast digest
Headroom.keepRecentToolResults(n)  // ContextCompressor — keep the last n tool-result messages full, elide older
```

:::caution
A custom **tail** compressor must be **deterministic** and only touch the **new tail** — the provider
prompt cache keys on a byte-stable prefix.
:::
