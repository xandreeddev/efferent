# The kernel: a small core, every other part a layer

This is a direction document. It describes the kernel, a second and much
smaller way to build an agent that ships beside the existing engine, and
where it goes next. The entries are `@xandreed/core/kernel` (what every part
agrees on) and `@xandreed/sdk/kernel` (the stock plugins).

The existing engine (`Agent.define` of `@xandreed/sdk`, described in the
[framework guide](framework.md)) is complete: tools, skills, tasks, durable
sessions, several memory strategies. The kernel starts from the other end:
the smallest set of agreements that lets the parts of an agent be written,
replaced and tested apart. It imports nothing of the engine and the engine
imports nothing of it; nothing in it imports a runtime module, so it runs
in a browser as it is. It is a first cut: [what it leaves out](#what-the-first-cut-leaves-out-and-the-order-it-returns)
is listed below. The engine stays the one to build on until the kernel has
caught up.

## Core, and plugins as layers

- **Core holds contracts, events and pure rules.** Ids, a message, an
  event's envelope, four contracts with a conformance kit each, a handful of
  pure rules, and `Core`: publish, on, events. Core stores nothing and runs
  no turn.
- **Every other part is a plugin, and a plugin is an Effect `Layer`**, the
  loop included. What a plugin needs is in its layer's type, and a host
  composes the layers with `Layer.provideMerge`. There is no plugin runtime
  and no wiring of the kernel's own.

| Part | Where | What it is |
|---|---|---|
| Vocabulary | core | `SessionId`, `Seq`, `TurnNumber`, `StepNumber`, `Tokens`; `Message`; `StoredEvent` and `KernelEvent` |
| Event definitions | core, and each plugin's own folder | a name, the schema of the data, stored or live, and for a stored one whether it may be skipped |
| Contracts | core | `JournalStorage`, `Sessions`, `Memory`, `Loop`, each with a kit; `Settings`, the system text |
| Pure rules | core | a session's two transitions and the fold of a journal to its state, reading a journal, resolving a request, the estimate |
| `kernel({ system, capacity? })` | core | the layer that provides `Core` and `Settings` |
| `inProcessJournal()` | sdk, `plugins/journal-in-process` | keeps journals in the process; knows nothing else |
| `sessions()` | sdk, `plugins/session` | owns turns and the journal's order; stores, then publishes |
| `windowMemory({ budgetTokens })` | sdk, `plugins/memory-window` | decides what the model is sent; owns the budget |
| `stepLoop` | sdk, `plugins/loop` | the main function; the model call lives with it |
| `inbox` | sdk, `plugins/inbox` | queues messages per session and answers them in order, over `Loop`; its contract, `Inbox`, is its own |

A file's suffix says its role, as everywhere in this repository: `.entity.ts`
is data, `.entity.functions.ts` the pure rules of that data, `.port.ts` a
contract, `.usecase.ts` a main flow, `.adapter.ts` an implementation and its
layer.

This is the whole of the window memory, quoted from its source. What it
needs, `Core` and `Settings`, is in its type, and a budget that is no finite
number of at least one token fails the layer with `InvalidBudget`:

<!-- pinned: packages/sdk/src/kernel/plugins/memory-window/window.adapter.ts -->

```ts
export const windowMemory = (options: WindowOptions): Layer.Layer<Memory, InvalidBudget, Core | Settings> => Layer.effect(Memory, Effect.gen(function* () {
  const core     = yield* Core
  const settings = yield* Settings
  const budget   = yield* Effect.fromResult(budgetOf(options.budgetTokens))   // InvalidBudget fails the layer

  // React: announce pressure, so any plugin can act on it.
  yield* core.on(requestSentEvent, (sent) =>
    nearlyFull(sent.data, options.pressureAt) ? core.publish(windowPressure(sent)) : Effect.void,
    { name: "window" })

  return Memory.of({
    // Nothing is kept between requests: each is built from the journal as it stands.
    build: Effect.fn("kernel.window.build")(function* (session: OpenSession) {
      const journal = yield* Effect.fromResult(readJournal(WINDOW_READER)(yield* session.journal))
      const fitted  = yield* Effect.fromResult(fitToBudget(settings.system, journal, budget))   // whole turns, oldest dropped first
      if (Option.isSome(fitted.dropped)) yield* session.append(windowDropped(fitted.dropped.value))
      return fitted.request                                                      // pointers into the journal
    }),
  })
}))
```

What a plugin registers with `Core.on` and what it acquires belong to its
layer's scope, and go when that scope closes.

## What the host writes

<!-- pinned: packages/sdk/src/kernel/lesson.test.ts#agent -->

```ts
import { Core, kernel, Sessions } from "@xandreed/core/kernel"
import type { JournalStorage, Loop, Memory, Settings } from "@xandreed/core/kernel"
import { Inbox, inbox, inProcessJournal, sessions, stepLoop, windowMemory } from "@xandreed/sdk/kernel"
import type { InvalidBudget } from "@xandreed/sdk/kernel"

const AgentLive: Layer.Layer<Inbox | Loop | Memory | Sessions | JournalStorage | Core | Settings | LanguageModel.LanguageModel, InvalidBudget> = inbox.pipe(
  Layer.provideMerge(stepLoop),
  Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
  Layer.provideMerge(sessions()),
  Layer.provideMerge(inProcessJournal()),
  Layer.provideMerge(kernel({ system: "You are a friendly tutor." })),   // Core + Settings
  Layer.provideMerge(model),                                             // any LanguageModel layer; scriptedModel(...) in tests
)
```

`Layer.provideMerge` builds the layer it is given first and keeps what both
provide, so the stack reads from the top down and builds from the bottom
up: the kernel first, the inbox last. A program run with
`Effect.provide(AgentLive)` takes each part as a service: `yield* Loop`,
`yield* Inbox`, `yield* Sessions`. `model` is any layer of Effect AI's
`LanguageModel`; for a test or an example, `scriptedModel(script)` is a
model that follows a script and calls no provider.

The type written on `AgentLive` is what makes a missing part a compile
error on that line: a stack that leaves out `sessions()` still needs
`Sessions`, and a layer that needs something is not a
`Layer<…, InvalidBudget>`; so is a part placed below what it needs
(`packages/sdk/src/kernel/composition.test.ts`). A stack whose type is left to inference
compiles as it is, with what it lacks among its requirements, and the error
lands further away: where the program it is provided to is run, the first
place its requirements must be `never`. What plain layers give up is the
other refusal:
two layers that provide one contract do not refuse each other, and the one
composed above silently wins.

A session is plain data, an id the host keeps. `sessions.create` decodes
what it is given and refuses an empty owner, or a parent that is no session
id, with `InvalidSession`. The stock loop refuses a message of no text with
`EmptyMessage` before the turn opens, so nothing is stored for it. A host
that wants to see a session as its journal tells it, every request resolved,
reads it and calls `inspectionOf(yield* sessions.read(id))`.

## The loop's main function

This is the whole of the stock loop plugin's flow, quoted from its source.
The plugin itself is one more line, in `step-loop.adapter.ts`:
`Layer.effect(Loop, makeStepLoop)`, whose type says that it needs `Core`,
`Sessions`, `Memory`, the model and `Settings`, the five lines the function
starts with.

<!-- pinned: packages/sdk/src/kernel/plugins/loop/step-loop.usecase.ts -->

```ts
export const makeStepLoop = Effect.gen(function* () {
  const core     = yield* Core
  const sessions = yield* Sessions
  const memory   = yield* Memory
  const model    = yield* LanguageModel.LanguageModel
  const settings = yield* Settings

  const run = (input: TurnInput) => isEmpty(input.message) ? emptyMessage :   // refused before the turn opens: nothing is stored
    sessions.turn(input.session, (session) => Effect.gen(function* () {
      yield* session.append(userMessage(input.message))

      let step = firstStep
      while (true) {
        const request  = yield* memory.build(session, step)
        const messages = yield* resolve(session, request)                      // pointers → the exact messages; refused if one points nowhere
        yield* session.append(requestSent(step, settings.system, request))
        const message  = yield* callModel(model, settings.system, messages,
          (delta) => core.publish(assistantDelta(session, delta)))
        yield* session.append(assistantMessage(step, message))
        if (!wantsTools(message)) return replyOf(message)
        yield* toolsNotInThisCut(message)     // next cut: run the tools, append their results, next step
      }
    })).pipe(Effect.withSpan("kernel.loop.run"))

  return Loop.of({ run })
})
```

One turn stores five events, in this order: `plugin.session.turn.started`
as the session plugin opens the turn, `plugin.loop.user.message`,
`plugin.loop.request.sent` before the model call,
`plugin.loop.assistant.message` after it, and `plugin.session.turn.ended`
as the turn closes. While the answer streams, each piece is published live
as `plugin.loop.assistant.delta`. Three rules are visible in the function.

- A stored fact is `session.append(...)` on the session plugin, which
  stores it through `JournalStorage` and then publishes the stored event. A
  live fact is `Core.publish(...)`, which stores nothing.
- "A turn always closes" belongs to the session plugin's `turn`: every exit
  closes it, the model's error, an interrupt, a request over the budget.
  The one exit it cannot close is its own store failing: a turn whose end
  cannot be stored stays open, as the journal says it is.
- A request is resolved before it is stored, and the model is sent what was
  resolved. A request that points at a record bearing no message is refused
  (`RequestRefused`) with nothing of it in the journal.

A model that fails fails the turn: with the model's own error when the call
fails, and with `ModelFailed` when its stream reports an error part-way
through an answer. No assistant message is stored for an answer that was cut.

## Events

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
| `plugin.inbox.queued` | the inbox, as it queues a message, with its ticket | live only; about the session, no turn |
| `core.listener.failed` | core, when a listener fails where nothing can fail for it | live only |

Core defines the first six and the last: the facts other plugins rely on,
so a second loop plugin writes the same names. A plugin's own events are
defined in its own folder. A live event names its session, and its turn
when it happens inside one: an event about the session and no turn of it,
a message queued before its turn opens, names none. The type of an event is open: core holds no list
of names. A stored event is an envelope: its place in the journal (`seq`),
when it was stored, its name, its data as JSON, whether a reader that does
not know it may skip it, and, when the record bears one, a message. A
message sits on the envelope and nowhere else.

### publish and on

`Core.publish(event)` first runs the listeners registered with
`{ wait: true }`, in the order they registered, one after another; if one
fails, the publish fails with `ListenerFailed`, which names the listener and
the event, and inside a turn that fails the turn. Then it hands the event to
the background listeners and to the host's stream, the `events` of `Core`, without
waiting for them. Background delivery is bounded and sliding (`capacity`,
256 when left out): a reader slower than the events loses the oldest ones it
has not read. The journal is what is complete. A background listener that
fails is reported as `core.listener.failed`, which is never waited for.

`Core.on(definition, handler, { name, wait? })` registers a listener for one
definition, in the scope it is called in, before it returns, so it misses
nothing published after. `name` is how a failure of it is reported. A
publisher waits for its listeners for as long as it is not interrupted
itself; each listener runs on a fiber of its own, so a limit on the wait,
or the close of a scope, holds whatever the listener does. Whatever a
handler ends with is its own failure, an interrupt it was not sent
included (`Effect.interrupt`, a join of a fiber that was interrupted): it
fails the publish with `ListenerFailed`, or, in the background, is
reported and the listener goes on. Only the interruption of whoever waits
cuts a listener short. A background listener and the stream hear of an
event only once it was handed over, on fibers of their own, after the
waiting listeners and the publisher's own step.

The end of a turn is the one publish whose listeners cannot fail the
publisher. The session plugin stores `plugin.session.turn.ended`, announces
it, and frees the session once the listeners the announcement waits for are
done or cut short after `closeWait` (5 seconds when left out), just before
the end is handed to the background and the stream. So the events of one
session, appended one after another, arrive in journal order, and whoever
hears of the end in the background finds the session free. Until then the session is busy, and a
turn asked for it is refused with `SessionBusy`.

A host follows events by running the stream, which has no replay, so it
starts reading before the turn it wants to see:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#follow -->

```ts
const answer = yield* core.events.pipe(
  Stream.filter((event) => event.name === assistantDeltaEvent.name),
  Stream.take(2),
  Stream.runCollect,
  Effect.forkScoped({ startImmediately: true }),      // reading before the turn starts: the stream has no replay
)
yield* loop.run({ session, message: "Hello" })
const shown = yield* Fiber.join(answer)
```

### A plugin's own events

A plugin defines its events with `liveEvent` or `storedEvent`, which put
the plugin's name in front (`plugin.<plugin name>.<event>`).
`live(definition, origin, data)` makes an event for `Core.publish`;
`stored(definition, data)` a draft for `session.append`. The kind is in the
type: a live event cannot be appended and a draft cannot be published.

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#own-event -->

```ts
import { Core, live, liveEvent, originOf, requestSentEvent, Tokens } from "@xandreed/core/kernel"

// An event of the plugin's own, defined in the plugin's folder: its name, the schema of its data, live or stored.
const requestCounted = liveEvent("meter", "request.counted", { data: Schema.Struct({ requests: Schema.Int, tokens: Tokens }) })

// A plugin that provides no contract and only listens: a layer that registers its listener in its own scope.
const meter = Layer.effectDiscard(Effect.gen(function* () {
  const core = yield* Core
  const requests = yield* Ref.make(0)
  // React to a fact the loop plugin stores, and publish one of its own about the same turn.
  yield* core.on(requestSentEvent, (sent) => Effect.flatMap(Ref.updateAndGet(requests, (count) => count + 1), (count) =>
    core.publish(live(requestCounted, originOf(sent), { requests: count, tokens: sent.data.estimatedTokens }))), { name: "meter", wait: true })
}))
```

## Inside a session

A session has one phase, moved by two transitions, pure functions tested as
a table.

| Transition | From `Free { turns }` | From `TurnOpen { turn }` |
|---|---|---|
| `beginTurn` | to `TurnOpen`, the next turn number | refused: `SessionBusy` |
| `endTurn` | refused: `NoOpenTurn` | to `Free` |

The state is also the fold of the journal (`sessionStateOf`), and the store
is the truth. The session plugin begins every turn by reading the journal,
folding it to the phase and appending `plugin.session.turn.started` at the
next place. That append is its claim: the store refuses an append at a
place that is taken, so of two writers that begin a turn of one session at
once, one is refused with `SessionBusy`. A turn whose end was never stored
stays open in the journal; closing such a turn is crash recovery, which
returns with the durable stores. Inside a turn, the writes take one lock
in turn: two appends made at once are stored one after the other, and the
end, once the body has returned, waits for an append still being stored
and is stored after it. An append made after the end began is refused
with `NoOpenTurn`. The lock holds the store, not the announcement: each
event is announced after its own store, so the announcements of appends
made at once can reach a listener that suspends in another order than the
journal's. The session plugin's two functions:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
  const stored = yield* open.writes.withPermits(1)(Effect.gen(function* () {   // one write at a time, the end's included
    if (yield* Ref.get(open.closed)) return yield* Effect.fail(new SessionRefused({ reason: "NoOpenTurn", message: `turn ${open.turn} of session ${open.id} has closed` }))
    return yield* store(open, event)                              // in the journal first
  }))
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

## The inbox: queueing messages

The inbox is a plugin over the loop, and the proof that a plugin can be
added without touching core: its contract, `Inbox`, lives in its own
folder, under a key named after its package.

<!-- pinned: packages/sdk/src/kernel/plugins/inbox/inbox.port.ts -->

```ts
export class Inbox extends Context.Service<Inbox, {
  /** Queue a message for the session. Returns at once, in call order, with its ticket and its reply. */
  readonly enqueue: (session: SessionId, message: string) => Effect.Effect<Queued, InboxRefused>
}>()("@xandreed/sdk/kernel/Inbox") {}
```

The first lesson's chat queues three messages at once, as a test does, with
`AgentLive` as above and `show` whatever the host shows text with:

<!-- pinned: packages/sdk/src/kernel/lesson.test.ts#program -->

```ts
import { assistantDeltaEvent, turnEndedEvent } from "@xandreed/core/kernel"
import { inboxQueuedEvent } from "@xandreed/sdk/kernel"

const program = Effect.gen(function* () {
  const core     = yield* Core
  const sessions = yield* Sessions
  const inbox    = yield* Inbox

  const session = yield* sessions.create({ owner: "learner" })

  // Follow the session: answers as they stream, each turn as it ends, and each message as it is queued.
  // A listener is registered before this line returns, so nothing is missed.
  yield* core.on(assistantDeltaEvent, (delta) => show(delta.data.text), { name: "lesson" })
  yield* core.on(turnEndedEvent, (ended) => show(`(turn ${ended.turn} done)`), { name: "lesson" })
  yield* core.on(inboxQueuedEvent, (queued) => show(`(queued ${queued.data.ticket})`), { name: "lesson", wait: true })

  // Queue three messages without waiting. Each is answered in a turn of its own, in order,
  // and each turn sees the turns before it.
  const queued = yield* Effect.forEach(
    ["Hi, I'm Ana.", "What's my name?", "Spell it backwards."],
    (message) => inbox.enqueue(session, message),
    { concurrency: 1 },
  )
  const replies = yield* Effect.forEach(queued, (entry) => entry.reply, { concurrency: "unbounded" })
  return { session, replies, journal: yield* sessions.read(session) }
}).pipe(Effect.provide(AgentLive))
```

It follows events with `on` of `Core`, not with the stream: a listener is
registered before `on` returns, so it cannot miss the first turn, while a
stream starts reading only when it is scheduled. The inbox's rules:

- **One state, pure transitions.** The next ticket, and per session
  whether a worker runs and the messages waiting behind it, are one state
  (`Open` or `Closed`), in one `Ref` with the replies waiting to be given.
  Three pure functions move it (`enqueue`, `take`, `finish`), tested as a
  table.
- **The ticket** is the inbox's: one number that only grows, 1, 2, 3,
  whatever the session, taken in the step that queues the message. Call
  order is queue order, whatever the workers have done meanwhile, and no
  ticket is given twice in one inbox; a session's tickets grow, with gaps
  where another session's messages came between.
- **One worker per session**, forked in the plugin's scope, runs one
  `loop.run` at a time and stops when nothing waits. Starting and stopping
  are decided in the same transitions as queueing and taking, so no message
  is ever left without a worker. A session has a queue only while its
  worker runs: the transition that stops the worker removes it, so the
  inbox keeps nothing of a session it is not serving. The queues are a
  persistent map (`HashMap`), so a transition copies no other session's
  queue.
- **A failed turn** fails that message's reply only; the next message runs.
  Interrupting whoever waits on a reply does not cancel the turn.
- **When the inbox's scope closes**, every reply not given yet fails with
  `InboxClosed`, the running turn's included, and a message queued after is
  refused (`InboxRefused`, `Closed`). None hangs.
- **The next message waits for the session to be free.** `loop.run`
  returns only once the session plugin has freed the session, so a slow
  listener of `plugin.session.turn.ended`, bounded by `closeWait`, delays
  the next queued message instead of failing it with `SessionBusy`.
- **Capacity:** a session's queue holds 64 waiting messages unless
  `inboxOf({ capacity })` says otherwise; a full one refuses with
  `InboxRefused` (`Full`), and nothing of the message is stored.
- **`plugin.inbox.queued`** is published for each message queued, live,
  about the session and no turn, on a fiber of the plugin: `enqueue`
  returns its ticket and reply whatever becomes of the announcement, and a
  listener of it that does not suspend has heard it by then, unless the
  session's message before it is still being announced. One session's
  announcements are published in ticket order, and each reaches the
  listeners the publisher waits for before its message's turn starts; one
  that fails is reported (`core.listener.failed`) and the turn runs.
- **Do not mix the inbox and direct calls on one session.** A queued
  message whose turn is refused because a direct `loop.run` holds the
  session fails with `SessionBusy`.
- **In the process only.** Queued messages do not survive the process.

## What the model is sent

Memory owns the budget and decides what the model is sent, and it keeps
nothing: `memory.build(session, step)` reads the session's journal and
returns a request whose messages are pointers, the places (`seq`) of records
that bear a message, never copies. When it compacts, it appends its own
record first, through the open session it was given, bearing the text it
wrote and naming the run of the journal it replaces, and points at that. A
memory written in a few lines:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#memory-plugin -->

```ts
import { estimateRequest, Memory, messageOf, Settings, Tokens, userMessageEvent } from "@xandreed/core/kernel"

/** A memory that sends the message the turn answers and nothing before it. */
const goldfish = () => Layer.effect(Memory, Effect.gen(function* () {
  const settings = yield* Settings
  return Memory.of({
    build: (session) => Effect.map(session.journal, (journal) => {
      const asked = journal.filter((event) => event.name === userMessageEvent.name).slice(-1)
      return {
        messages: asked.map((event) => event.seq),          // pointers into the journal, never copies
        estimatedTokens: estimateRequest(settings.system, asked.flatMap((event) => Option.toArray(messageOf(event)))),
        budgetTokens: Tokens.make(1000),
      }
    }),
  })
}))
```

`plugin.loop.request.sent` stores the system text, the pointers, memory's
estimate and the budget. One pure function, `resolveRequest`, turns the
pointers back into messages, for the model call and for `inspectionOf`
alike. The estimate is one pure function too, `estimateTokens`, a quarter of
the characters rounded up. `windowMemory` sends every message and counts the
system text the settings hold; over the budget it drops whole turns, oldest
first, and records `plugin.window.dropped`. When the current turn alone does
not fit, it fails with `OverBudget` (`isOverBudget` tells it).

A journal outlives the code that wrote it. A reader answers for the records
of the session and loop plugins and for those under its own prefix
(`readerFor`, `readJournal`): a record it does not know is passed over when
the record says it may be skipped, and refused with `UnknownRecord` when it
may not. A record under another plugin's prefix is not its concern.

## Replacing a part

A part is replaced by providing a different layer for it: the loop, the
memory or the store, the rest of the stack as it was. The kernel's tests
run a loop written in a few lines over the stock journal, session and
memory layers, and a memory of their own that announces an event of its
own on a compression check, which another plugin reacts to, with nothing
under core changed (`packages/sdk/src/kernel/plugins.test.ts`).

There is no API for replacing a part while an agent runs. A host that keeps
sessions going across the change builds the base once and swaps the stack
above it, as this test does:

<!-- pinned: packages/sdk/src/kernel/swap.test.ts#swap -->

```ts
const scope = yield* Effect.scope
const base = yield* Layer.buildWithScope(Base, scope)        // kernel + journal + sessions, built once
const session = yield* Context.get(base, Sessions).create({ owner: "learner" })

const first  = yield* Scope.fork(scope)
const agentA = yield* Layer.buildWithScope(Upper(noting("A", 200)), first).pipe(Effect.provide(base))
const before = yield* ask(agentA, session, "Hi, I'm Ana.")

yield* Scope.close(first, Exit.void)                           // the old stack's listeners are removed here
const second = yield* Scope.fork(scope)
const agentB = yield* Layer.buildWithScope(Upper(noting("B", 3000)), second).pipe(Effect.provide(base))
const after  = yield* ask(agentB, session, "What's my name?")   // the same session goes on under the other memory
```

- The base (`Base`: the kernel, the journal and the session plugin) is
  built once in a scope, so there is one journal and one `Core`.
- Each upper stack (`Upper`: the inbox, the loop, a memory and whatever
  else listens) is built in a child scope of its own.
- The old stack's scope is closed before the new one takes a turn, so no
  event reaches the listeners of both: the test checks that the old
  memory's listener hears nothing after the swap, and that the session goes
  on with its earlier messages.

`Effect.provide(AgentLive)` around one program is the short form; this
long-lived one is what a host that edits its configuration while sessions
go on needs.

Each contract ships with its kit: `journalStorageConformance`,
`sessionsConformance`, `memoryConformance` and `loopConformance` are the
contracts as runnable checks, each check with an id that its failures name.
The loop kit hands every check a script for the model, and `scriptedModel`
follows one, so a host proves its own loop with what the sdk ships.

## What the first cut leaves out, and the order it returns

This cut keeps journals in the process, and has one session plugin, one
memory, one loop and no tool execution. What follows returns in this order.

1. **A selector for instructions.** Instructions chosen for each request by
   a small classifier model, appended at the end of the request, so the
   prefix a provider cached stays as it was.
2. **Tools**, loading them on demand, messages that arrive while a turn
   runs, and recording to a session outside a turn.
3. **A UI rendering plugin**, whose client applies patches from the event
   stream.
4. **Durable stores and crash recovery**, on the seam the fold of the
   journal already gives.
5. **Sub-agents.**

## Keeping a tailored context cache-stable

A provider caches a request by its prefix, so a context tailored for each
request must not disturb what came before. What a turn's tailoring adds, it
adds at the end. The system text is fixed for a stack: one built with
another `kernel({ system })` starts a new prefix. Nothing earlier is
rewritten until memory compacts. The memory kit checks the last rule as it
applies to this cut: while nothing presses, the next turn's request starts
with this turn's.

## Ideas adopted, and one that was not

The kernel draws on earlier work on building agent runtimes out of parts
that compose, among it the paper *A Programming Paradigm for Spatiotemporal
Composability* (arXiv 2608.25512). Four ideas were adopted.

- **Requests as pointers.** A stored request points at records of the
  journal and never copies them, so a message's text is stored once.
- **The may-be-skipped flag.** A stored plugin record says whether a reader
  that does not know it may pass over it.
- **Scoped setup.** What a plugin registers and acquires while it is set up
  belongs to its layer's scope, and is released when the scope closes.
- **Keyed registrations with a stable order.** The listeners a publisher
  waits for run in the order they registered.

One idea was not adopted: a runtime that loads and unloads plugins inside a
live process. A plugin here is an Effect layer, and there is nothing in
front of the layers: replacing a part is providing a different stack.
