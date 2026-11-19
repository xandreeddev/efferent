# ADR 0037: The window memory goes: a memory that slides one turn at a time misses the cache on every message

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk` (removed: `windowMemory`, `WindowOptions`, `windowDroppedEvent`,
  `windowPressureEvent`, `WindowDroppedData`, `WindowPressureData` and the `plugin.window.dropped` and
  `plugin.window.pressure` records; new: `flatMemoryWith`, `FlatOptions`)
- **Amends:** ADR 0001 (its example stack's memory is `flatMemory` or `summaryMemory` now), ADR 0003 (its two stock
  memories: `flatMemory` and `summaryMemory` now), ADR 0004 (one long tool turn over a budget: the summary memory's,
  which folds whole turns only), ADR 0008 (compaction is the bounded memory, not an alternative to a window), ADR 0011
  (the stock memories that point: `flatMemoryWith` and `summaryMemory`), ADR 0028 (what shortens a long result is
  `pointed`, through `flatMemoryWith` or `summaryMemory`), ADR 0030 (the span `window_memory.context` is gone), ADR 0036
  (its row for `@xandreed/plugin-memory-window` reads `summaryMemory` now, as `no-longer-published` says)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

`windowMemory` kept a conversation within a budget by dropping whole turns, oldest first, just enough to fit
(`fitToBudget`: while the estimate is over the budget, drop the oldest turn). It recorded how far it had dropped
(`plugin.window.dropped`), so a turn once dropped stayed dropped. That kept the start of the context stable only until
the conversation was full. From then on every new message pushes the estimate over the budget again, the window drops
one more turn, and the first message of the context changes. A provider's prompt cache keys on the start of the prompt,
so it misses on every message from then on: the memory that was meant to keep a long conversation cheap made each of its
requests pay for the whole context.

The summary memory (ADR 0008) keeps to a budget the other way: over it, it folds every closed turn but the latest into a
summary in one batch, and every later context starts with that summary until the next fold. The cached prefix holds
between folds, and folds are rare. The flat memory keeps everything and its prefix never changes.

## Decision

- **The window memory is removed, not deprecated.** `windowMemory`, its options, its two events and their data leave
  `@xandreed/sdk`; its folder, its layer in `foundry.config.ts` and its tests go. The kernel ships no memory that
  slides.
- **The bounded memory is `summaryMemory`.** The first program, the README and the guide use `flatMemory`, which keeps
  the whole conversation, and name `summaryMemory` as the one to use when a conversation must keep to a budget.
- **Pointers stay with the flat memory.** `flatMemoryWith({ pointers })` is the flat memory with each record read
  through `pointed` (ADR 0011), the same function the summary memory reads with, so the pointer's text is the same in
  both. `flatMemory` is unchanged.
- **Journals already written are read as they are.** A 0.23.0 host may have stored `plugin.window.dropped`. The flat
  and summary memories read through their own prefixes and the conversation's, so the record is another plugin's to
  them and is passed over (it was stored as skippable too). No format changes and nothing is migrated: the turns the
  window had dropped are sent again by whichever memory reads the journal now.

## Consequences

- A host that used `windowMemory` moves to `summaryMemory` over a `Summarizer`, or to `flatMemory` when its
  conversations fit the model. Its first request after the move sends the turns the window had left out.
- A host that wants a window still writes one (a memory is a few lines, `docs/kernel.md`), and pays a cache miss on
  every message once it is full.
- `unknown-records.test.ts` holds a journal with the record as 0.23.0 wrote it, read by both stock memories.
