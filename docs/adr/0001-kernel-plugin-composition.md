# ADR 0001: How the kernel's plugins compose

- **Status:** accepted, 12 November 2026
- **Applies to:** `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and every plugin written for them
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The kernel's parts are plugins: journal storage, sessions, memory, the loop, the inbox.
Each is an Effect layer, and a host composes them. Many later needs change what a part
owned by another plugin does:

- compression for memory, or pointers to files in place of old turns;
- guardrails and compression on tool results;
- tools, instructions and skills chosen per request by a small classifier model;
- loading a skill, rendering UI, fetching context data, the file system as context;
- recovering from errors;
- a memory kept between sessions.

The question is how a plugin adds such behaviour without core, the loop or memory
predicting it, and without a second extension mechanism beside the ones Effect gives.

## Decision

A plugin takes part in four ways, and no fifth.

| Way | What it is | Use it when |
| --- | --- | --- |
| **Replace** | Another implementation of a contract | You want different behaviour of the whole part: another loop, another memory |
| **Wrap** | A layer that requires a contract, provides the same contract, and calls the one below | You add to a part: a guard, a selection, a retry, extra tools, context data |
| **Event** | `Core.on` on an event another part publishes | You observe, or act in the background. Nobody waits for an answer, and a turn's behaviour does not change, with one exception: a listener registered with `{ wait: true }` is waited for, and its failure fails the publishing turn |
| **Journal** | An entry appended through the open session | A fact other parts must see later: a summary, a loaded skill, a decision |

The rule for choosing:

1. If a method of a contract sees the value at the right moment, with the session in hand, **wrap** that contract.
2. If the moment sits between two calls inside the loop, it is the loop's decision: **replace** the loop.
3. If nobody needs an answer back, use an **event**.
4. If other parts must see it later, append it to the **journal**.

## Higher-order plugins

A wrapper is written as a **higher-order plugin**: a function from a plugin of a contract
to a plugin of the same contract. It wraps the plugin it is given and hides it with
`Layer.provide`, so only the wrapped one leaves.

```ts
// Given a plugin of Memory, it returns a plugin of Memory.
export const withUserData = (fetch: FetchUserData) =>
  <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const memory = yield* Memory                                   // the one it wraps
      return Memory.of({
        build: (session, step) => Effect.andThen(
          session.append(userData(fetch, session)),                  // append first,
          memory.build(session, step),                               // then delegate
        ),
      })
    })).pipe(Layer.provide(inner))
```

Each contract's stack is the contract's plugin with its wrappers applied, innermost first:

```ts
const MemoryLive = windowMemory({ budgetTokens: 60_000 }).pipe(
  selectInstructions(classifier),       // applied first: innermost, appends last
  withUserData(fetchProfile),           // applied last: outermost, appends first
)
const ToolsLive = fileTools(workspace).pipe(
  boundToolResults({ preview: 2_000 }),
  guardToolResults(rules),              // outermost: sees results after they are bounded
)
```

The plugin names are illustrations of later plugins. None of them exists yet.

**Order:**

- Within a contract's stack, the last wrapper applied is the outermost. It runs first on the way in and last on the way out. Applied the other way round, a guard sees results before they are bounded.
- **Memory wrappers append, then delegate**, so the outermost wrapper's entry lands first in the journal and the innermost's last. An entry that must come last, such as instructions chosen for this request (kept at the end so the cached prefix holds), belongs to the innermost wrapper.
- Wrappers of different contracts do not call each other, so their order does not matter.
- One thing does cross stacks: waiting listeners run in the order plugins are built. No test pins that order yet, so do not rely on it between plugins of different stacks.
- A wrapper that must sit at a fixed place, such as a guard after everything that changes results, says so in its doc comment.
- There are no priorities and no phase numbers.

**What the form guarantees:**

- **Guaranteed:** a wrapper cannot be misplaced relative to the part that uses the contract, because it is applied to the plugin, not placed in a list.
- **Not guaranteed:** the order among wrappers of one contract. That is read from the nesting.
- **Checked by the compiler:** a wrapper applied to another contract's plugin does not compile.
- **Compiles, and is lost:** a wrapper applied to a layer that provides more than its contract compiles, because a layer's provided services are contravariant, and the wrapper hides the rest.
- **The limit:** behaviour that spans two contracts is two wrappers that share through the journal.

`packages/sdk/src/kernel/wrapping.test.ts` pins all of this. It also pins why the plain
layer form is not used for wrappers: a plain wrapper composed above the part that uses the
contract wraps nothing for it, and nothing says so.

## Rules for wrappers

1. **One stack per contract**, built with higher-order plugins as above. The rest of the agent gets one layer per contract.
2. **A memory wrapper appends, then delegates.** It appends its own entry to the journal first, then calls the memory below, and never edits the request that memory returns. The memory below owns the budget and the estimate.
3. **A model wrapper cannot record.** It has no session, so a retry or a fallback that must show in the journal belongs to the loop's model call, not to a model wrapper.
4. **Adding tools goes through one helper** (`addTools`, with the tools cut), so a careless wrapper cannot drop the tools below it.

## Three cases, worked through

- **Instructions chosen per request by a small classifier model.** A wrapper of `Memory`.
  It asks the classifier, appends the chosen instructions as its own entry (with the
  decision), then delegates. The entry lands at the end of the journal, so the cached
  prefix holds. Whether a chosen instruction stays for later turns is decided with the
  selector cut.
- **Compression to pointers to files, cache-stable.** A memory implementation, replacing
  the window memory. It writes old turns to a file once and appends an entry that
  replaces them with a summary and the file's path; the run of the journal it replaces
  is in the entry's own data, not in core's envelope. Everything after only appends. A
  read tool brings a file back when the model asks.
- **Guardrails on tool results.** A wrapper of `Tools`. Its `execute` calls the one below
  and checks the result before the loop sees it.

## Costs

- **Replacing the loop copies it.** The loop's pieces stay exported so a custom loop stays
  short. When two custom loops copy the same block, that block becomes a contract.
- **Two layers providing the same contract do not refuse.** The one nearer the consumer
  wins, silently. Rule 1 keeps that from happening by accident.
- **Wrapping order lives in the composition.** It is explicit, but nothing checks it.

## Decided, not built yet

- **Memory sends every message-bearing entry of the journal, whichever plugin wrote it.**
  Today the window memory reads only the session and loop entries and its own. This must
  change before a wrapper can contribute through the journal. It changes what the memory
  kit's `foreign` check means, so it comes with the selector cut.
- **`addTools`**, with the tools cut.

## Proposed: context that lives for a turn or for a session

Not decided and not built. Recorded so the next cut starts from it.

**The case.** A host fetches data (a user's profile, an account's state) and wants the
model to have it for one turn, or for the whole session, kept through compaction.

**The shape.**

- **Where:** a higher-order memory plugin fetches and appends the data, then delegates. It is not in the loop: the moment, before the request is built, is one a memory method already sees with the session in hand.
- **No store beside the journal.** The data is an entry in the journal with a **lifetime**, and one pure reading rule of the loop contract, `visibleEntries(journal, turn)`, beside `LOOP_READER`, applies it for every memory. It reads what a memory sends, so it is the loop contract's, not core's (ADR 0002):

| Lifetime | Seen by the model | Under compaction | Cache |
| --- | --- | --- | --- |
| `turn` | in its turn only | not compacted; it stops being sent | later turns keep the cached prefix up to the turn's user message |
| `session` | every turn, right after the system text; the latest entry of a key replaces older ones | never compacted, even inside a range a summary replaces | stable while unchanged. A refresh, or a first entry after turn 1, invalidates the whole cached conversation once |
| `history` (the default) | as part of the conversation | compacted or dropped as usual | append-only |

- **When it fetches is separate from when it appends.** A wrapper cannot know data changed without fetching. Its `refresh` option decides when it fetches: never (the default), each turn, or every N turns. It appends only when what it fetched differs from the latest entry of that key.
- **Pointer order:** a request's pointers may be in any order (`resolveRequest` refuses only repeated, later or unknown places), so session entries first changes no rule of the loop contract, which owns `resolveRequest` (ADR 0002). The memory kit's `prefix` check must allow for a refreshed session entry.

**Open points:**

- **Framing.** Fetched data reaches the model as a message. It is untrusted text, so the model-text rules apply: frame it as host data, and pin the framing.
- **Budget.** Memory owns the budget. A session entry that alone exceeds it must be a typed error, not a silent drop.
- **Listener order across stacks.** Pin it with a test, or document it as not guaranteed.

## Rejected

- **Priority numbers or named phases on wrappers.** They make order implicit, and they are a registry again.

- **A config object with a dependency planner** (`Agent.define`, `requires`, a planner,
  `agent.with`). It re-implemented the layer graph, scoping and replacement by hand, and
  held most of the defects two reviews found.
- **Optional contracts a memory uses when present** (a compactor, a retriever). The
  memory's author must predict every helper.
- **A registry of steps for building a request.** An extension point invented before a
  need; wrapping covers the cases.
- **Hooks in core**, handlers that receive a value and return a changed one. A second
  mechanism beside events, which wrapping makes unnecessary.
- **Listeners that append to the journal during a turn.** It would make events change
  what a turn does, in an order that is hard to see.

## What would reopen this

- Two independent plugins that must both change one value at a moment no contract method
  sees, where wrapping a contract cannot reach.
- Wrapping order causing real defects that a check cannot catch.
- Loading or unloading a plugin inside a live process becoming a requirement.

A change to this decision is a new record that supersedes this one; this one is not edited.
