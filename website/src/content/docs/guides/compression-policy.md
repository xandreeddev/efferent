---
title: Customize compression
description: Set a CompressionPolicy on your agent — use the defaults, disable it, or compose your own cache-safe tail compressor.
sidebar:
  label: Compression policy
  order: 4
---

[Context compression](/docs/concepts/headroom/) is a property of the agent: the optional
`compression` field on [`AgentConfig`](/docs/reference/agent-config/). Omit it and you get the
cache-safe default. Here's how to change it.

## Use the defaults (or turn it off)

```ts
import { Compression, Headroom } from "@xandreed/sdk-core"

const config = {
  key: "my-agent",
  prompt,
  toolkit,
  compression: Headroom.default(), // explicit — same as omitting the field
  // compression: Compression.none, // disable compression entirely
}
```

## Compose a custom policy

A policy has two independent moments:

```ts
interface CompressionPolicy {
  readonly tail?: TailCompressor       // append-time, per tool-result, PERSISTED — must be cache-safe
  readonly context?: ContextCompressor // in-memory, whole-buffer, per-turn — NOT persisted
}
```

Build the `tail` from the combinators and the headroom engine:

```ts
const compression: CompressionPolicy = {
  // Only clip when the per-result budget is tight; otherwise pass through.
  tail: Compression.when(
    (budget) => budget.maxChars < 20_000,
    Headroom.toolResults(),
  ),
  // Optionally also keep only the last N tool results full, in-memory, each turn.
  context: Headroom.keepRecentToolResults(5),
}
```

Other combinators: `Compression.pipeline(a, b, …)` runs tail compressors in sequence;
`Compression.passthroughTail` is the explicit no-op.

:::caution[The one rule]
A custom **tail** compressor must be **deterministic** and only touch the **new tail** — the provider
prompt cache keys on a byte-stable prefix, and rewriting history would blow the cache. (The `context`
moment *does* rewrite the in-memory buffer, which is why it's off by default: it trades cache hits for
headroom.)
:::

A custom compressor stays `R = never` by reaching optional services via `Effect.serviceOption(Tag)` (found
iff provided at the root, like `UtilityLlm`) or by closing over a pre-built client — so `AgentConfig`
never needs a requirements type parameter. The policy is **inherited by this agent's sub-agents**.

Runnable version: the [compression agent](/docs/examples/compression-agent/).
