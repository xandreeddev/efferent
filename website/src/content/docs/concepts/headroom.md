---
title: Context headroom
description: Cache-safe context compression — four tactics that never rewrite the cached prefix, exposed as a customizable policy on the agent.
sidebar:
  label: Context headroom
  order: 5
---

Long agent runs blow past the context window. **Headroom** is efferent's compression — but with one
governing constraint: provider prompt caches key on a **byte-stable prefix**, so compression must
**never rewrite history**. The tactics live natively in `usecases/headroom.ts`.

## The four tactics

1. **Append-time tool-result compression.** When a step's new tail enters the buffer, any oversized
   tool-result string is compressed *on the way in* — the persisted record and every future prompt carry
   the compressed form from byte one, so nothing already sent is rewritten. It's structure-aware first
   (grep-shaped output grouped per file; bash output keeping head/tail + every error + a test summary),
   falling back to a blind head/tail clip.
2. **Reversible markers.** The clip names what it dropped and how to get it back
   (`[…headroom: ~4509 tokens of this Bash output omitted…]` → re-read with a narrower grep or
   offset/limit). Compression the model can *undo* on demand.
3. **Fast-tier middle digests.** When `UtilityLlm` is available and the dropped middle is big enough, the
   [fast role](/docs/concepts/providers/) writes a short summary into the marker.
4. **Threshold auto-fold.** When a finished turn crosses a percentage of the window, the driver folds the
   history into a [handoff summary](#handoff) — the one cache-safe way to actually shrink history.

## A policy, not a hardcoded step

Compression is a **property of the agent** — `AgentConfig.compression` — built from SDK primitives. Two
deliberately distinct moments:

```ts
interface CompressionPolicy {
  readonly tail?: TailCompressor      // moment 1: append-time, per tool-result, PERSISTED, cache-safe
  readonly context?: ContextCompressor // moment 2: in-memory, whole-buffer, per-turn, NOT persisted
}
```

Absent ⇒ the SDK default (`Headroom.default()`, today's behaviour). The building blocks:

```ts
Headroom.default()              // { tail: Headroom.toolResults() } — the default policy
Headroom.toolResults()         // the append-time engine, as a TailCompressor
Headroom.keepRecentToolResults(n) // a ContextCompressor: keep the last n tool results full
Compression.none               // disable entirely
Compression.pipeline(a, b)     // run tail compressors in sequence
Compression.when(pred, step)   // apply a compressor only when a budget predicate holds
```

A custom tail compressor **must be deterministic and only touch the new tail** (the cached prefix stays
byte-stable). It reaches optional services via `Effect.serviceOption`, so the public type stays
`R = never` and `AgentConfig` needs no requirements parameter. The policy is inherited by sub-agents.
See the [compression-policy guide](/docs/guides/compression-policy/) and the
[reference](/docs/reference/compression/).

## Handoff

A **handoff** replaces the *loaded* history with a model-generated summary while keeping the originals on
disk (a checkpoint at the current position). It's how a long session frees context without losing the
record — `createHandoff` summarizes the loaded view; the next load prepends the summary in place of the
folded messages. The threshold auto-fold (tactic 4) runs this automatically at a turn boundary.
