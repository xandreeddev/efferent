# ADR 0005: Context for one request is added after memory's, never stored

- **Status:** accepted, 13 November 2026
- **Applies to:** `@xandreed/sdk/kernel`'s memory contract and every wrapper of it
- **Supersedes:** in ADR 0001, rule 2 of "Rules for wrappers" ("a memory wrapper appends,
  then delegates") and the proposal "context that lives for a turn", for context of one
  request
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

ADR 0001 was written when memory built a whole request (`build`) and the journal held
copies of what was sent. Its rule for a memory wrapper was to append its entry to the
journal first, then delegate, and never edit the request memory returned: the only way to
add to a request was to store something.

ADR 0003 changed both. The journal holds the conversation and nothing derived from
configuration, and memory returns the context (`context(session)`), the messages that
follow the system text, which the program puts first. A wrapper that stores what it adds
for one request turns it into something said: it is sent again in every later request,
older copies pile up in the context, and the conversation's records hold text no one
said. The cases are common: the time, an instruction chosen for this request, data
fetched for this turn.

## Decision

Context for one request is code's, like the system text: computed when the request is
built, added by a wrapper of `Memory` **after** the context the memory below returned, and
never stored.

- A wrapper asks the memory below for the context first, then returns it **whole and in
  its order**, with what it adds after it. It never drops, reorders or edits a message
  of it.
- What it adds is not stored. A wrapper that also has a fact for later parts (a decision,
  a loaded skill) appends it under its own prefix (`plugin.<name>.`), never as a record
  of the conversation, and a memory that understands that record sends it.
- Its place at the end keeps the cache: the next request starts with this one's context
  up to the conversation's end, and only what was added for this request differs.
- `memoryWrapperConformance` (`@xandreed/sdk/kernel`) is the rule as checks:
  `starts-with-inner` and `own-records`. The memory kit (`memoryConformance`) keeps
  checking memories: its `prefix` rule is about what a memory returns, so a wrapped
  memory, whose last message changes with each request, answers to the wrapper kit.

The other ways a plugin takes part stay as ADR 0001 has them: replace a contract, wrap it,
hook an event with `Core.on`, or record a fact in the journal under its own name.

## Consequences

- A wrapper is a higher-order plugin, as ADR 0001 has it, written over today's names:
  `(inner: Layer<Memory, E, R>) => Layer<Memory, E, R>`, which provides `Memory`, requires
  the inner one, and hides it with `Layer.provide`.
- The Context view of the learn pages shows a row a wrapper added as code's, with no
  record behind it.
- Context that must outlive a request (for a session, kept through compaction) is not
  decided here. It needs a record and a reading rule, and returns with the compaction
  memories.

## What would reopen this

- A provider that refuses a message after the last user message, or a model that reads a
  trailing note worse than one placed before it, measured.
- Context for one request that must be replayed exactly later, which only a record can
  give.
