---
"@xandreed/core": minor
"@xandreed/sdk": minor
---

The kernel, a small core with everything else a plugin, ships as two new entries beside the existing engine, which neither imports nor is imported by it: `@xandreed/core/kernel` (ids, `Message`, the event envelope, the `Storage`, `Sessions`, `Memory` and `Loop` contracts with a conformance kit each, the pure rules, `definePlugin`, and `Core`, which is events only: `publish`, `on` and `events`) and `@xandreed/sdk/kernel` (`Agent.define`, which returns `createSession`, `send`, `inspect`, `events` and `with`, the stock plugins `inMemoryStorage`, `sessions`, `windowMemory` and `stepLoop`, and `scriptedModel`, a model that follows a script and calls no provider). Events are named by the plugin that writes them and the set is open: a plugin defines its own with `storedEvent` and `liveEvent`. A request is stored as pointers into the journal, so each message's text is stored once. It is a first cut, with in-memory storage and no tool execution, and it will change as the parts it leaves out return; `docs/kernel.md` is its direction document. Neither entry imports a `node:` or `bun:` module.
