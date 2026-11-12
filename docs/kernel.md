# The kernel: a small core, everything else a plugin

This is a direction document. It describes the kernel, a second and much
smaller way to build an agent that ships beside the existing engine, and
where it goes next. The entries are `@xandreed/core/kernel` (what every part
agrees on) and `@xandreed/sdk/kernel` (the wiring and four stock plugins).

## What it is, and why it sits beside the engine

The existing engine (`Agent.define` of `@xandreed/sdk`, described in the
[framework guide](framework.md)) is complete: tools, skills, tasks, durable
sessions, several memory strategies. Its turn is spread over many modules,
and replacing one part of it, the loop for instance, means knowing most of
the others.

The kernel starts from the other end. It asks what the smallest set of
agreements is that lets the parts of an agent be written, replaced and
tested apart:

- **Core is what everything agrees on, plus events.** Ids, a message, an
  event's envelope, four contracts, a handful of pure rules, and `Core`:
  publish, on, events. Core stores nothing and runs no turn.
- **Everything else is a plugin**, the loop included. A plugin is an Effect
  layer with a name. It declares the contracts it needs and the one it
  provides, and its name is the prefix of the events it writes.
- **The function you read from top to bottom is the loop plugin's.** It
  composes the other plugins through their contracts.

So a host can rebuild the loop and keep storage, sessions and memory, or add
an event to a memory's compression check and have another plugin react to
it, without a change in core. Both are tests of the kernel
(`packages/sdk/src/kernel/plugins.test.ts`).

The kernel is additive. It imports nothing of the existing engine and the
engine imports nothing of it: the boundaries profile gives each kernel
folder its own layer and makes `./kernel` a restricted subpath of both
packages. Nothing in it imports a runtime module, so it runs in a browser
as it is. It is a first cut: [what it leaves out](#what-the-first-cut-leaves-out-and-the-order-it-returns)
is listed below, with the order it returns. The existing engine stays the
one to build on until the kernel has caught up.

## Core and plugins

| Part | Where | What it is |
|---|---|---|
| Vocabulary | core | `SessionId`, `Seq`, `TurnNumber`, `StepNumber`, `Tokens`; `Message`; `StoredEvent` and `KernelEvent` |
| Event definitions | core, and each plugin's own folder | a name, the schema of the data, stored or live, and for a stored one whether it may be skipped |
| `Core` | core | `publish`, `on`, `events` |
| Contracts | core | `Storage`, `Sessions`, `Memory`, `Loop`, each with a conformance kit |
| Pure rules | core | a session's two transitions and the fold of a journal to its state, reading a journal, resolving a request, the estimate, the order to build plugins in |
| `definePlugin` | core | a name, the contracts required, the contract provided, the effect that makes it; for a shipped plugin, its version |
| `inMemoryStorage` | sdk, `plugins/storage-memory` | keeps journals; knows nothing else |
| `sessions` | sdk, `plugins/session` | owns turns and the journal's order; stores, then publishes |
| `windowMemory` | sdk, `plugins/memory-window` | decides what the model is sent; owns the budget |
| `stepLoop` | sdk, `plugins/loop` | the main function; the model call lives with it |
| `Agent.define` | sdk | checks what the plugins declare, builds `Core` and every plugin in dependency order, and returns the handle |

A file's suffix says its role, as everywhere in this repository: `.entity.ts`
is data, `.entity.functions.ts` the pure rules of that data, `.port.ts` a
contract, `.usecase.ts` a main flow, `.usecase.functions.ts` its supporting
logic, `.adapter.ts` an implementation and its layer.

## Boot: what a host writes

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#boot -->

```ts
import { Agent, inMemoryStorage, sessions, stepLoop, windowMemory } from "@xandreed/sdk/kernel"

const agent = yield* Agent.define({
  model,                                        // Effect AI's model layer
  system: "You are a friendly tutor.",
  storage: inMemoryStorage(),
  sessions: sessions(),
  memory: windowMemory({ budgetTokens: 3000 }),
  loop: stepLoop(),
  plugins: [],                                  // anything extra: telemetry, later tools, UI
})

const session = yield* agent.createSession({ owner: "learner" })
const reply = yield* agent.send(session, "Hello")
```

`sessions`, `loop` and `plugins` may be left out: the stock session and loop
plugins are the defaults. A session is plain data, an id the host keeps. The
handle has five members: `createSession`, `send`, `inspect`, `events` and
`with`. `send` refuses a message of no text (`AgentRefused`, reason
`EmptyMessage`) before anything is stored.

`model` is any layer of Effect AI's `LanguageModel`. For a test or an
example, `scriptedModel(script)` of `@xandreed/sdk/kernel` is a model that
follows a script and calls no provider.

## The loop's main function

This is the whole of the stock loop plugin's flow, quoted from its source.
The plugin itself is one more call, in `step-loop.adapter.ts`:
`definePlugin` with the name `loop`, what it requires (`Core`, `Sessions`,
`Memory`, the model and `Settings`, the five lines the function starts
with), the contract `Loop` and `make: makeStepLoop`. A plugin a package
ships also states its version, the package's, which the release tooling
keeps in step.

<!-- pinned: packages/sdk/src/kernel/plugins/loop/step-loop.usecase.ts -->

```ts
export const makeStepLoop = Effect.gen(function* () {
  const core     = yield* Core
  const sessions = yield* Sessions
  const memory   = yield* Memory
  const model    = yield* LanguageModel.LanguageModel
  const settings = yield* Settings

  const run = (input: TurnInput) =>
    sessions.turn(input.session, (session) => Effect.gen(function* () {
      yield* session.append(userMessage(input.message))
      const context = yield* memory.open(session)

      let step = firstStep
      while (true) {
        const request  = yield* context.build(step)
        const messages = yield* resolve(session, request)                      // pointers → the exact messages; refused if one points nowhere
        yield* session.append(requestSent(step, settings.system, request))
        const message  = yield* callModel(model, settings.system, messages,
          (delta) => core.publish(assistantDelta(session, delta)))
        yield* session.append(assistantMessage(step, message))
        if (!wantsTools(message)) return replyOf(message)
        yield* toolsNotInThisCut(message)     // next cut: run the tools, append their results, next step
      }
    })).pipe(Effect.withSpan("kernel.loop.run"))

  return { run }
})
```

What one `send` does, line by line:

```
agent.send(session, "Hello")
└─ loop.run                              loop plugin
   ├─ sessions.turn opens                plugin.session.turn.started      stored
   ├─ session.append(user message)       plugin.loop.user.message         stored
   ├─ memory.open, context.build         memory plugin
   ├─ resolve(request)                   pointers → messages, or refused
   ├─ session.append(request)            plugin.loop.request.sent         stored
   ├─ model call                         plugin.loop.assistant.delta ×n   live only
   ├─ session.append(assistant message)  plugin.loop.assistant.message    stored
   └─ sessions.turn closes               plugin.session.turn.ended        stored
```

Three rules are visible in it.

- A stored fact is `session.append(...)` on the session plugin, which
  stores it through `Storage` and then publishes the stored event. A live
  fact is `Core.publish(...)`, which stores nothing.
- "A turn always closes" belongs to the session plugin's `turn`. A loop
  plugin that uses it gets that for every exit: the model's error, an
  interrupt, a request over the budget. The one exit it cannot close is its
  own store failing: a turn whose end cannot be stored stays open, as the
  journal says it is. A loop that does not use `turn` can leave a turn
  open, and core does not prevent it.
- A request is resolved before it is stored, and the model is sent what was
  resolved. A request that points at a record bearing no message is refused
  (`RequestRefused`) with nothing of it in the journal, so no stored request
  points nowhere, and `agent.inspect` shows of each request the messages the
  model was sent.

A model that fails fails the turn: with the model's own error when the call
fails, and with `ModelFailed` when its stream reports an error part-way
through an answer. The pieces that had streamed were published live; no
assistant message is stored for an answer that was cut.

## Events

### Who writes them

Events are named by the plugin that writes them.

| Event | Written by | Kept |
|---|---|---|
| `plugin.session.turn.started` | the session plugin, as a turn opens | stored |
| `plugin.session.turn.ended` | the session plugin, as a turn closes, with its outcome | stored |
| `plugin.loop.user.message` | the loop plugin | stored; bears the message |
| `plugin.loop.request.sent` | the loop plugin, before each model call | stored |
| `plugin.loop.assistant.message` | the loop plugin, after each model call | stored; bears the message |
| `plugin.loop.assistant.delta` | the loop plugin, as the answer streams | live only |
| `plugin.window.dropped` | the window memory, when whole turns leave the window | stored; may be skipped |
| `plugin.window.pressure` | the window memory, when a request came close to the budget | live only |
| `core.listener.failed` | core, when a listener fails where nothing can fail for it | live only |

Core defines the first six and the last: the facts other plugins rely on,
so a second loop plugin writes the same names and the other plugins keep
working. The two window events are defined in the window memory's own
folder. The type of an event is open: core holds no list of names, and no
function on the path of an event takes one.

A stored event is an envelope: its place in the journal (`seq`), when it was
stored, its name, its data as JSON, whether a reader that does not know it
may skip it, and, when the record bears one, a message. A message sits on
the envelope and nowhere else: `messageOf(stored)` reads it from any record
that bears one, whichever plugin wrote it.

### publish and on

`Core.publish(event)` does two things, in this order.

1. It runs the listeners registered with `{ wait: true }`, in the order
   they registered, one after another, and waits for each. If one fails,
   the publish fails with `ListenerFailed`, which names the listener and
   the event. Inside a turn that fails the turn, which still closes.
2. It hands the event to the background listeners and to the host's stream
   (`agent.events`). It does not wait for them.

The session plugin publishes a stored event after it stored it, so a
listener never hears of a fact the journal does not hold. A listener whose
plugin was closed while a publish was under way is passed over.

Background delivery is bounded and sliding: a listener or a host that reads
slower than events arrive loses the oldest ones it has not read. The
journal is what is complete. The capacity is `core: { capacity }` in the
agent's config, 256 when left out. A background listener that fails is
reported as `core.listener.failed`. That report is never waited for: a
listener registered for it with `{ wait: true }` is delivered in the
background like any other, so a report cannot hold up the publisher it
reports on.

`Core.on(definition, handler, options)` registers a listener for one
definition, in the scope of the plugin that calls it: when that plugin is
closed, its listeners are gone. A listener is named after its plugin. It
receives the event with its data decoded by the definition's schema. It may
publish live events. It cannot append to the journal in this cut: a plugin
writes to the journal through its contract, inside a turn.

The end of a turn is the one publish whose listeners cannot fail the
publisher. The session plugin stores `plugin.session.turn.ended`, announces
it on a fiber of its own, and frees the session only when the announcement
is done. So the events of one session reach listeners and the host's stream
in journal order: a turn's end is never heard after the next turn's start.
A listener that fails there does not fail the caller, and one that has not
returned after `closeWait` (5 seconds unless the session plugin is given
another) is cut short; either is reported as `core.listener.failed`. Until
the announcement is done or cut short the session is busy, and a `send` for
it is refused with `SessionBusy`: for at most `closeWait` after the end was
stored. A caller that is interrupted does not wait for those listeners.

A host follows events by running the stream. The stream has no replay, so
the host starts reading before the turn it wants to see:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#follow -->

```ts
import { assistantDeltaEvent } from "@xandreed/core/kernel"

const answer = yield* agent.events.pipe(
  Stream.filter((event) => event.name === assistantDeltaEvent.name),
  Stream.take(2),
  Stream.runCollect,
  Effect.forkScoped({ startImmediately: true }),      // reading before the turn starts: the stream has no replay
)
yield* agent.send(session, "Hello")
const shown = yield* Fiber.join(answer)
```

### A plugin's own events

A plugin defines its events in its own folder, with `liveEvent` or
`storedEvent`. The helper puts the plugin's name in front
(`plugin.<plugin name>.<event>`). `live(definition, origin, data)` makes an
event for `Core.publish`; `stored(definition, data)` makes a draft for
`session.append`. The kind is in the type: `session.append` takes a draft
and `Core.publish` an event, so a live event cannot be appended and a draft
cannot be published. The stored event a listener hears is published by the
session plugin after it stored the draft; `announced(origin, stored)` is the
helper a session plugin uses for that. Core does not check who calls it:
that a stored event is announced once, after it is stored, is the sessions
contract, and its kit checks it.

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#own-event -->

```ts
import { Core, definePlugin, live, liveEvent, originOf, requestSentEvent, Tokens } from "@xandreed/core/kernel"

// An event of the plugin's own, defined in the plugin's folder: its name, the schema of its data, live or stored.
const requestCounted = liveEvent("meter", "request.counted", { data: Schema.Struct({ requests: Schema.Int, tokens: Tokens }) })

const meter = definePlugin({
  name: "meter",
  requires: [Core],
  make: Effect.gen(function* () {
    const core = yield* Core
    const requests = yield* Ref.make(0)
    // React to a fact the loop plugin stores, and publish one of its own about the same turn.
    yield* core.on(requestSentEvent, (sent) => Effect.flatMap(Ref.updateAndGet(requests, (count) => count + 1), (count) =>
      core.publish(live(requestCounted, originOf(sent), { requests: count, tokens: sent.data.estimatedTokens }))), { wait: true })
  }),
})
```

An event's data is plain JSON: a schema whose decoded value is its own
encoding. A stored definition also says whether a reader that does not know
the record may skip it.

## Inside a session

A session has one phase, moved by two transitions.

| Transition | From `Free { turns }` | From `TurnOpen { turn }` |
|---|---|---|
| `beginTurn` | to `TurnOpen`, the next turn number | refused: `SessionBusy` |
| `endTurn` | refused: `NoOpenTurn` | to `Free` |

They are pure functions, tested as a table. The state is also the fold of
the journal (`sessionStateOf`), and the store is the truth. The session
plugin begins every turn by reading the journal: it folds it to the phase,
takes its last place, and appends `plugin.session.turn.started` at the next
one. That append is its claim on the turn. Storage refuses an append at a
place that is taken, so of two writers that begin a turn of one session at
once, one stores its start and the other is refused with `SessionBusy`.

What holds now: two session plugins over one store take turns on one
session, each from what the journal holds, and one refuses a turn while the
other's is open. What waits for a durable store: this cut's storage lives
in one process, so nothing here runs across processes yet. Each turn reads
the whole journal to begin. A turn whose end was never stored, because the
process stopped or the store failed, stays open in the journal and the
session refuses turns from then on; closing such a turn is crash recovery,
which returns with the durable stores. And the order of announcements (a
turn's end before the next turn's start) is kept by one session plugin, not
between two of them over one store.

The session plugin's two functions, quoted from its source:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
  if (yield* Ref.get(open.closed)) return yield* Effect.fail(new SessionRefused({ reason: "NoOpenTurn", message: `turn ${open.turn} of session ${open.id} has closed` }))
  const stored = yield* store(open, event)                        // in the journal first
  yield* core.publish(announced(open, stored))                    // then announced, same name
  return stored
})
```

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
turn: (id, body) => Effect.acquireUseRelease(
  begin(id),                                                    // Free → TurnOpen, or refused; stores plugin.session.turn.started
  (open) => Effect.andThen(core.publish(open.started), body(open.session)),   // announced inside the turn, so a listener that fails it still closes it
  (open, exit) => end(open, exit),                              // stores plugin.session.turn.ended with the outcome, announces it, frees the session; always runs
),
```

A turn's `append` refuses once the turn has closed (`SessionRefused`, reason
`NoOpenTurn`), so an open session kept past its turn writes nothing. When the
end of a turn cannot be stored, the caller gets the storage failure and the
turn stays open, as the journal says it is.

### What the model is sent

Memory owns the budget and decides what the model is sent.
`context.build(step)` returns a request whose messages are pointers, the
places (`seq`) of records of the journal that bear a message, never copies.
When memory writes text of its own for the model, a summary for instance,
it appends that text first, through the open session it was given, as its
own record bearing a message and naming the run of the journal it replaces,
and points at it.

`plugin.loop.request.sent` stores the system text, the pointers, memory's
estimate and the budget. One pure function, `resolveRequest(journal, request)`,
turns the pointers back into the messages, for the model call and for
`agent.inspect` alike, so what a reader sees of a past request is what the
model was sent. A pointer names a record that bears a message, once, and for
a stored request a record before it; any other is refused with
`RequestRefused`. The estimate is one pure function too, `estimateTokens`, a
quarter of the characters rounded up, and everything counts with it.

`windowMemory({ budgetTokens })` sends every message, and reads the system
text from the agent's settings so that its estimate covers what is really
sent. Over the budget it drops whole turns, oldest first, and records
`plugin.window.dropped`. When the current turn alone does not fit, it fails
with its own error, `OverBudget`, which carries `estimatedTokens` and
`budgetTokens` (`isOverBudget` tells it). A budget that is no finite number
of at least one token fails `Agent.define` with `InvalidBudget`.

### Records a reader does not know

A journal outlives the code that wrote it, and plugins come and go. A
reader answers for the records of the session and loop plugins and for
those under its own plugin's prefix (`readerFor`, `readJournal`). Of those,
a record it does not know is passed over when the record says it may be
skipped, and refused with `UnknownRecord` when it may not. A record under
another plugin's prefix is not its concern.

## Replacing a plugin, and writing one

A plugin is replaced where the agent is defined: pass another one for
`storage`, `sessions`, `memory` or `loop`. For an agent that is running,
`agent.with(changes)` gives a new agent over the same events, storage and
sessions:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#replace -->

```ts
const next = yield* agent.with({ memory: goldfish() })
const later = yield* next.send(session, "And now?")
```

`with` takes `model`, `system`, `memory`, `loop` and `plugins`. It builds
the settings, the model, memory, the loop and the extra plugins again,
because the loop holds the memory and the model it was built with. Then the
two agents switch in one step: the old handle refuses `send` from then on
(`AgentRefused`, reason `Replaced`) and the new one takes turns at once.

- `with` does not wait for a turn the old handle is running. That turn
  finishes on the old parts, which are closed after it, their listeners
  removed. While it runs, the extra plugins of both agents hear its events.
- Until the switch the old handle is fully usable. If `with` fails, with
  the error of a plugin that could not be built, or is interrupted, what
  was built is released and nothing has changed.
- Called from inside a turn of the handle it would replace, in a waiting
  listener for instance, `with` is refused at once with reason `InsideTurn`.

Storage and sessions are not `with`'s to change. Nothing is loaded or
unloaded inside a live agent.

Writing a plugin is listing what it needs and writing the effect that makes
its contract:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#memory-plugin -->

```ts
import { definePlugin, estimateRequest, Memory, messageOf, Settings, Tokens, userMessageEvent } from "@xandreed/core/kernel"

/** A memory that sends the message the turn answers and nothing before it. */
const goldfish = () => definePlugin({
  name: "goldfish",
  requires: [Settings],
  provides: Memory,
  make: Effect.gen(function* () {
    const settings = yield* Settings
    return Memory.of({
      open: (session) => Effect.succeed({
        build: () => Effect.map(session.journal, (journal) => {
          const asked = journal.filter((event) => event.name === userMessageEvent.name).slice(-1)
          return {
            messages: asked.map((event) => event.seq),          // pointers into the journal, never copies
            estimatedTokens: estimateRequest(settings.system, asked.flatMap((event) => Option.toArray(messageOf(event)))),
            budgetTokens: Tokens.make(1000),
          }
        }),
      }),
    })
  }),
})
```

Each contract ships with its kit: `storageConformance`,
`sessionsConformance`, `memoryConformance` and `loopConformance` are the
contracts as runnable checks, and a plugin is proved by running its kit.
The example above would not pass the memory kit as it stands: it keeps to
no budget and reads no record's flag. The kits say so, check by check: each
check has an id, and a failure names the check it came from. The loop kit
hands every check a script for the model, and `scriptedModel` is the model
that follows one, so a host proves its own loop plugin with what the sdk
ships.

## What a plugin needs, and what it provides

Every plugin declares the contracts it needs, in `requires`, and the one it
provides, in `provides`. A contract is a `Context.Service`: `Core`,
`Storage`, `Sessions`, `Memory`, `Loop`, `Settings`, the model's
(`LanguageModel.LanguageModel`), or one a plugin declares itself. A plugin
that needs none writes an empty list. The stock plugins declare theirs the
same way: storage needs nothing, sessions `Core` and `Storage`, the window
memory `Core` and `Settings`, and the loop `Core`, `Sessions`, `Memory`,
the model and `Settings`.

Any plugin may provide a contract for another. The contract is declared in
the providing plugin's own folder, in a `.port.ts` file, under a key named
after its package:

<!-- pinned: packages/sdk/src/kernel/testing.port.ts#contract -->

```ts
import { Context } from "effect"
import type { Effect } from "effect"
import type { Message } from "@xandreed/core/kernel"

/** What a summaries plugin gives the plugins that require it: one line that stands for a run of messages. */
export class Summaries extends Context.Service<Summaries, {
  readonly of: (messages: ReadonlyArray<Message>) => Effect.Effect<string>
}>()("@xandreed/sdk/kernel/testing/Summaries") {}
```

One plugin provides it, and another requires it. Here the one that requires
it is the agent's memory, and the one that provides it is an extra plugin:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#requires -->

```ts
import { definePlugin, estimateRequest, Memory, messageOf, Settings, stored, storedEvent, Tokens } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage } from "@xandreed/sdk/kernel"
import { Summaries } from "./summaries.port.js"

/** Provides `Summaries`. It needs no contract, and says so. */
const summaries = () => definePlugin({
  name: "summaries",
  requires: [],
  provides: Summaries,
  make: Effect.succeed(Summaries.of({
    of: (messages) => Effect.succeed(`Earlier: ${messages.map((message) => message.text).join(" / ")}`),
  })),
})

const summarized = storedEvent("compress", "summarized", { data: Schema.Struct({ of: Schema.Int }), skippable: true })

/** A memory that requires it: what was said before the turn's message reaches the model as one line. */
const compress = () => definePlugin({
  name: "compress",
  requires: [Settings, Summaries],
  provides: Memory,
  make: Effect.gen(function* () {
    const settings  = yield* Settings
    const summaries = yield* Summaries                    // declared above; a contract that is not declared does not compile here
    return Memory.of({
      open: (session) => Effect.succeed({
        build: () => Effect.gen(function* () {
          const said = (yield* session.journal).filter((event) => event.message !== undefined && event.name !== summarized.name)
          const asked = said.slice(-1)
          const earlier = said.slice(0, -1)
          const request = (records: typeof said) => ({
            messages: records.map((event) => event.seq),
            estimatedTokens: estimateRequest(settings.system, records.flatMap((event) => Option.toArray(messageOf(event)))),
            budgetTokens: Tokens.make(1000),
          })
          const [first, last] = [earlier[0], earlier.at(-1)]
          if (first === undefined || last === undefined) return request(asked)
          const text = yield* summaries.of(earlier.flatMap((event) => Option.toArray(messageOf(event))))
          const summary = yield* session.append(stored(summarized, { of: earlier.length }, {
            message: { _tag: "User", text },
            replaces: { from: first.seq, through: last.seq },
          }))
          return request([summary, ...asked])
        }),
      }),
    })
  }),
})

const agent = yield* Agent.define({
  model,
  system: "You are a friendly tutor.",
  storage: inMemoryStorage(),
  memory: compress(),                           // requires Summaries,
  plugins: [summaries()],                       // which an extra plugin provides: it is built before the memory
})
```

What a plugin declares is checked at two times.

**When the plugin is compiled.** `make` may use the contracts `requires`
lists, and no other: a `yield* Summaries` in a plugin whose list lacks
`Summaries` is a type error on that plugin, and the error names the
contract. The scope is not declared: a plugin may always register listeners
and acquire what its scope releases. Neither is a `Context.Reference`,
which has a default. A contract that is declared and never used compiles,
since the list says what `make` may use.

**When the agent is defined.** `Agent.define` reads every plugin's
`requires` and `provides` before it builds anything, and refuses the set
with `PluginRefused`, which names the plugin and the contract, when

- a plugin requires a contract nothing provides (`MissingProvider`). No
  plugin is added to fill the gap, a stock one neither: the message says
  what to add;
- two plugins provide the same contract, or a plugin provides what the
  wiring provides itself, `Core`, `Settings` or the model
  (`DuplicateProvider`);
- plugins require each other in a circle (`Cycle`);
- storage or sessions requires a part that `with` builds again: the
  settings, the model, memory, the loop or an extra plugin's contract
  (`LaterContract`).

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#refused -->

```ts
const refused = yield* Effect.flip(Agent.define({
  model,
  system: "You are a friendly tutor.",
  storage: inMemoryStorage(),
  memory: compress(),                           // nothing provides Summaries
}))
```

That one fails with `plugin compress requires
@xandreed/sdk/kernel/testing/Summaries, which no plugin provides: add a
plugin that provides it`. A set that is refused builds nothing: no plugin's
`make` has run, no listener is registered, and there is no agent to send
to. `agent.with` checks the changed set the same way before it builds the
successor, and a refusal leaves the agent as it was.

**The order plugins are built in** comes from the declarations. The parts
are listed: storage, sessions, memory, the loop, then the extras in the
order of `plugins`. Each is built at its listed place, and the providers it
requires that are listed after it are built just before it, in the order
they are listed. So a plugin is always built after the plugins that provide
what it requires, wherever the host lists them, plugins that are not moved
for one another are built in the order listed, and the order a plugin
writes its `requires` in changes nothing. Listeners register as plugins are
built, and the
listeners a publisher waits for run in the order they registered: the order
of `plugins` is the order the extras hear an event in, but for a provider
that was built ahead of its consumer.

The check and the order are one pure function over plain data
(`planPlugins`: each plugin's name, the keys it requires, the key it
provides). Underneath, a plugin is still an Effect layer, built by Effect in
the agent's scope and handed the contracts it declared and no others. The
`sessions` and `loop` slots take the stock plugins when a config leaves them
out; that is the config's default, and the check adds nothing to it.

## What the first cut leaves out, and the order it returns

This cut has in-memory storage, one session plugin, one memory, one loop
and no tool execution. What follows returns in this order.

1. **A selector for instructions.** Instructions chosen for each request by
   a small classifier model, and appended at the end of the request, so the
   prefix a provider cached stays as it was.
2. **Tools**, loading them on demand, messages that arrive while a turn
   runs, and recording to a session outside a turn.
3. **A UI rendering plugin**, whose client applies patches from the event
   stream. The framework owns the render language, the protocol and a
   minimal shell; applications bring their components.
4. **Durable stores and crash recovery**, on the seam the fold of the
   journal already gives.
5. **Sub-agents.**

## Keeping a tailored context cache-stable

A provider caches a request by its prefix, so a context tailored for each
request must not disturb what came before. Three rules keep it so, and each
later feature has to hold to them.

- What a turn's tailoring adds, it adds at the end.
- The system text is fixed for the agent. `agent.with({ system })` changes
  it, and with it the prefix a provider cached: the next request of every
  session starts a new one.
- Nothing earlier is rewritten until memory compacts.

The memory kit checks the last one as it applies to this cut: while nothing
presses, the next turn's request starts with this turn's.

## Ideas adopted, and one that was not

The kernel draws on earlier work on building agent runtimes out of parts
that compose, among it the paper *A Programming Paradigm for Spatiotemporal
Composability* (arXiv 2608.25512). Four ideas were adopted.

- **Requests as pointers.** A stored request points at records of the
  journal and never copies them, so a message's text is stored once.
- **The may-be-skipped flag.** A stored plugin record says whether a reader
  that does not know it may pass over it.
- **Scoped setup.** What a plugin registers and acquires while it is set up
  belongs to its scope, and is released when the scope closes.
- **Keyed registrations with a stable order.** Listeners are kept by key,
  in the order they registered, and the ones a publisher waits for run in
  that order.

One idea was not adopted: a runtime that loads and unloads plugins inside a
live process. A plugin here is an Effect layer, and what the kernel puts in
front of the layers is one pure check of what they declare, made when an
agent is defined. There is no separate plugin runtime, and replacing a part
is `agent.with(...)`: a new agent over the same storage and sessions,
effective from the next turn.
