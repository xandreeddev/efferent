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
  layer with a name. What it needs and what it provides is the layer's
  type, and its name is the prefix of the events it writes.
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
| Pure rules | core | a session's two transitions and the fold of a journal to its state, reading a journal, resolving a request, the estimate |
| `definePlugin` | core | a name, the contract provided, the effect that makes it; for a shipped plugin, its version |
| `inMemoryStorage` | sdk, `plugins/storage-memory` | keeps journals; knows nothing else |
| `sessions` | sdk, `plugins/session` | owns turns and the journal's order; stores, then publishes |
| `windowMemory` | sdk, `plugins/memory-window` | decides what the model is sent; owns the budget |
| `stepLoop` | sdk, `plugins/loop` | the main function; the model call lives with it |
| `Agent.define` | sdk | builds `Core` and every plugin in dependency order, and returns the handle |

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
`with`.

## The loop's main function

This is the whole of the stock loop plugin's flow, quoted from its source.
The plugin itself is one more line, in `step-loop.adapter.ts`: a
`definePlugin` call with the name `loop`, the contract `Loop` and
`make: makeStepLoop`. A plugin a package ships also states its version, the
package's, which the release tooling keeps in step.

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
        const request = yield* context.build(step)
        yield* session.append(requestSent(step, settings.system, request))
        const message = yield* callModel(model, session, settings.system, request,
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
   ├─ session.append(request)            plugin.loop.request.sent         stored
   ├─ model call                         plugin.loop.assistant.delta ×n   live only
   ├─ session.append(assistant message)  plugin.loop.assistant.message    stored
   └─ sessions.turn closes               plugin.session.turn.ended        stored
```

Two rules are visible in it.

- A stored fact is `session.append(...)` on the session plugin, which
  stores it through `Storage` and then publishes the stored event. A live
  fact is `Core.publish(...)`, which stores nothing.
- "A turn always closes" belongs to the session plugin's `turn`. A loop
  plugin that uses it gets that for every exit: the model's error, an
  interrupt, a request over the budget. A loop that does not use it can
  leave a turn open, and core does not prevent it.

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

A stored event reaches `publish` after it is in the journal, so a listener
never hears of a fact the journal does not hold.

Background delivery is bounded and sliding: a listener or a host that reads
slower than events arrive loses the oldest ones it has not read. The
journal is what is complete. The capacity is `core: { capacity }` in the
agent's config, 256 when left out. A background listener that fails is
reported as `core.listener.failed`.

`Core.on(definition, handler, options)` registers a listener for one
definition, in the scope of the plugin that calls it: when that plugin is
closed, its listeners are gone. A listener is named after its plugin. It
receives the event with its data decoded by the definition's schema. It may
publish live events. It cannot append to the journal in this cut: a plugin
writes to the journal through its contract, inside a turn.

The end of a turn is the one place where the order differs. The session
plugin stores `plugin.session.turn.ended`, frees the session, and only then
publishes. A listener that fails there, or that has not returned after
`closeWait` (5 seconds unless the session plugin is given another), cannot
keep the session busy or fail the caller: it is cut short and reported as
`core.listener.failed`.

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
`session.append`. The kind is in the type: a live definition cannot be
appended, and a stored one cannot be published without being stored.

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#own-event -->

```ts
import { Core, definePlugin, live, liveEvent, originOf, requestSentEvent, Tokens } from "@xandreed/core/kernel"

// An event of the plugin's own, defined in the plugin's folder: its name, the schema of its data, live or stored.
const requestCounted = liveEvent("meter", "request.counted", { data: Schema.Struct({ requests: Schema.Int, tokens: Tokens }) })

const meter = definePlugin({
  name: "meter",
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
the journal (`sessionStateOf`), so it can be rebuilt from storage alone: a
session plugin that meets a session it did not run reads its phase and its
last place from the journal. That is the seam for crash recovery and for
several processes over one store.

The session plugin's two functions, quoted from its source:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
const append = (session: Origin) => (event: StoredDraft) => Effect.gen(function* () {
  const stored = yield* store(session.id, event)                  // in the journal first
  yield* core.publish(announced(session, stored))                 // then announced, same name
  return stored
})
```

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
turn: (id, body) => Effect.acquireUseRelease(
  begin(id),                                                    // Free → TurnOpen, or refused; stores plugin.session.turn.started
  (open) => Effect.andThen(core.publish(open.started), body(open.session)),   // announced inside the turn, so a listener that fails it still closes it
  (open, exit) => end(open, exit),                              // stores plugin.session.turn.ended with the outcome, frees the session, announces it; always runs
),
```

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
model was sent. The estimate is one pure function too, `estimateTokens`, a
quarter of the characters rounded up, and everything counts with it.

`windowMemory({ budgetTokens })` sends every message, and reads the system
text from the agent's settings so that its estimate covers what is really
sent. Over the budget it drops whole turns, oldest first, and records
`plugin.window.dropped`. When the current turn alone does not fit, it fails
with its own error, `OverBudget`, which carries `estimatedTokens` and
`budgetTokens` (`isOverBudget` tells it).

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
because the loop holds the memory and the model it was built with. It
replaces: the old handle refuses `send` from then on, a turn it was running
finishes, and then its parts are closed and their listeners removed.
Storage and sessions are not `with`'s to change. Nothing is loaded or
unloaded inside a live agent.

Writing a plugin is writing the effect that makes its contract:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#memory-plugin -->

```ts
import { definePlugin, estimateRequest, Memory, messageOf, Settings, Tokens, userMessageEvent } from "@xandreed/core/kernel"

/** A memory that sends the message the turn answers and nothing before it. */
const goldfish = () => definePlugin({
  name: "goldfish",
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
no budget and reads no record's flag. The kits say so, check by check.

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
- The system text is fixed for the session.
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
live process. The plugin graph here is Effect's own. There is no separate
plugin runtime, and replacing a part is `agent.with(...)`: a new agent over
the same storage and sessions, effective from the next turn.
