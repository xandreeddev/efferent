# The kernel: a small core, every other part a layer

This is a direction document. It describes the kernel, a second and much
smaller way to build an agent that ships beside the existing engine, and
where it goes next. The entries are `@xandreed/core/kernel` (what every
agent has, whatever its workflow) and `@xandreed/sdk/kernel` (the workflow
contracts and the stock plugins). What the journal holds, why records carry
tags and why the kernel has no loop are recorded in
[ADR 0003](adr/0003-journal-holds-the-conversation.md); how tool calls and
their results are stored and sent, in
[ADR 0004](adr/0004-tool-traffic-is-conversation.md); why the line between
core and plugins runs where it does, in
[ADR 0002](adr/0002-core-owns-state-plugins-own-workflows.md); how plugins
compose, in [ADR 0001](adr/0001-kernel-plugin-composition.md).

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

- **Core holds what every agent has, whatever its workflow.** Ids, the
  message vocabulary and the conversation's records, an event's envelope,
  sessions and their journal (two contracts with a conformance kit each),
  reading a journal, and `Core`: publish, on, events. Core stores nothing,
  runs no turn, and names no loop, memory, system text or request to a model.
- **The loop is the host's own program.** The kernel ships no loop and no
  contract for one. A host writes what a turn does, in a few lines over the
  contracts, and that program is the agent.
- **Every other part is a plugin.** A contract a workflow needs lives in a
  contract folder of the sdk (`contracts/<name>`: its entities, events,
  pure rules and kit), and its stock plugin in a plugin folder
  (`plugins/<name>`). A plugin imports contracts and core, never another
  plugin; a contract imports core and other contracts, never a plugin. The
  boundaries gate refuses either import.
- **Every part is an Effect `Layer`.** What a plugin needs is in its layer's
  type, and a host gives its program the layers it asks for. There is no
  plugin runtime and no wiring of the kernel's own.

| Part | Where | What it is |
|---|---|---|
| Vocabulary | core | `SessionId`, `Seq`, `TurnNumber`, `Tag`; `Message`; `StoredEvent` and `KernelEvent` |
| The conversation's records | core | `conversation.user.message` and `conversation.assistant.message`, `userMessage(text)` and `assistantMessage(text, meta?)`, `CONVERSATION_READER` |
| Event definitions | core for its own, and the folder of each contract or plugin for theirs | a name, what the event is for (its tags), the schema of the data, stored or live, and for a stored one whether it may be skipped |
| Contracts | core | `JournalStorage`, `Sessions`, each with a kit |
| Pure rules | core | a session's two transitions and the fold of a journal to its state, reading a journal |
| `kernel({ capacity? })` | core | the layer that provides `Core`, and nothing of a workflow |
| The memory contract | sdk, `contracts/memory` | `Memory` with its kit; `promptMessage`, `estimateTokens`, `estimateContext`, `Tokens` |
| The inbox contract | sdk, `contracts/inbox` | `Inbox`, its ticket, refusals and event; `InboxTurn`, the host's turn it runs |
| `inProcessJournal()` | sdk, `plugins/journal-in-process` | keeps journals in the process; knows nothing else |
| `sessions()` | sdk, `plugins/session` | owns turns and the journal's order; stores, then publishes |
| `flatMemory` | sdk, `plugins/memory-flat` | every message of the conversation, oldest first |
| `windowMemory({ budgetTokens })` | sdk, `plugins/memory-window` | the conversation within a budget; drops whole turns, oldest first |
| `inbox(turn)` | sdk, `plugins/inbox` | queues messages per session and answers them in order, through the host's `turn` |
| `scriptedModel(script)` | sdk, `plugins/model-scripted` | a model that follows a script and calls no provider, for tests and examples |

A file's suffix says its role, as everywhere in this repository: `.entity.ts`
is data, `.entity.functions.ts` the pure rules of that data, `.port.ts` a
contract, `.usecase.ts` a main flow, `.adapter.ts` an implementation and its
layer.

The parts compose the way an editor's plugins do around a small core:

| An editor with a small core | The kernel |
|---|---|
| a plugin's setup, run once at start | a module's layer, built once when the program is given it: it registers its handlers and returns its API |
| an autocommand event | an event: a record appended to the journal and announced under its name, or a live event `Core.publish` announces |
| registering an autocommand | `core.on(definition, handler)`, in the scope of the layer that registers it |
| calling a plugin's function from a key binding | the program calling a module's API on an action: a message arrives, and the turn asks memory for the context |
| overriding a plugin's handler | wrapping a contract: a layer that takes the one below and provides the same contract again |

## The program is the loop

A host's program is its loop. This one runs as long as messages come, one
turn per message, in order; the lesson that teaches the kernel starts from
it. One turn, quoted from the test that runs it:

<!-- pinned: packages/sdk/src/kernel/lesson.test.ts#turn -->

```ts
import { Effect, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { Memory } from "@xandreed/sdk/kernel"

// The system text: code, sent first in every prompt, never stored.
const system = "You are a friendly tutor. Keep answers short."

// One turn: what the agent does with one message.
const turn = (conversation: SessionId, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel

      // Open a turn. It closes when this scope ends: answered, failed or stopped.
      const session = yield* sessions.open(conversation)

      // Store the message. The journal holds the conversation, and only that.
      yield* session.append(userMessage(message))

      // Ask memory for the context: what of the conversation the model sees.
      const history = yield* memory.context(session)

      // The prompt: the system text first, then the context. Built fresh every time, never stored.
      const prompt = Prompt.make([{ role: "system", content: system }, ...history])

      // Call the model. Show each piece as it streams in, and join them into the answer.
      const answer = yield* model.streamText({ prompt }).pipe(
        Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
        Stream.filter((part) => part.type === "text-delta"),
        Stream.map((part) => part.delta),
        Stream.tap((piece) => show(piece)),
        Stream.mkString,
      )

      // Store the answer, so the next turn's context has it. Return it.
      yield* session.append(assistantMessage(answer))
      return answer
    }),
  )
```

- **A turn is a scope.** `sessions.open(id)` opens the session's next turn
  and closes it when the scope ends, however it ends: completed, failed or
  interrupted. Only a turn writes: `append` exists on the open session alone.
- **The journal holds the conversation, and only that.** The turn stores the
  user's message and the model's answer. The system text is code: the program
  sends it first in every prompt and never stores it, so changing it changes
  the next prompt and leaves nothing stored stale.
- **Memory builds the context.** `memory.context(session)` reads the journal
  and returns the messages that follow the system text, ready for the prompt.
- **The model is Effect AI's `LanguageModel`.** The turn calls it directly.
  An error part in the stream fails the turn, so a cut answer is never
  stored as a whole one.

The program, and how it is run:

<!-- pinned: packages/sdk/src/kernel/lesson.test.ts#program -->

```ts
import { Core, kernel, Sessions, turnStartedEvent } from "@xandreed/core/kernel"
import { flatMemory, inProcessJournal, sessions } from "@xandreed/sdk/kernel"

// The program: one conversation, one turn per message, in order.
const program = Effect.scoped(
  Effect.gen(function* () {
    const core = yield* Core
    const sessions = yield* Sessions
    const conversation = yield* sessions.create({ owner: "learner" })

    // On boot: hook an event, as an editor's autocommand would.
    yield* core.on(turnStartedEvent, (started) => show(`(turn ${started.data.turn})`), { name: "lesson", wait: true })

    // Then, for each message: one turn, in order. One that arrives mid-turn waits for its own.
    const replies = yield* Stream.runCollect(Stream.mapEffect(messages, (message) => turn(conversation, message)))
    return { replies, journal: yield* sessions.read(conversation) }
  }),
)

// Run it: give the program the modules it asks for. Each can use the ones given after it.
const main = program.pipe(
  Effect.provide(flatMemory),           // what of the journal the model sees
  Effect.provide(sessions()),           // conversations and their turns
  Effect.provide(inProcessJournal()),   // where every record is kept
  Effect.provide(kernel()),             // events every module can hook
  Effect.provide(model),                // any LanguageModel layer; scriptedModel(...) in tests
)
```

`main` gives the program the layers it asks for, one `Effect.provide` each.
A layer given later is built first and is what the ones before it see, so
memory reads the sessions, the sessions use the journal, and every layer
shares the one `Core`. `model` is any layer of Effect AI's `LanguageModel`;
for a test or an example, `scriptedModel(script)` follows a script and calls
no provider. A layer the program asks for and is not given is a compile
error where the program is run: its requirements must be `never` there
(`packages/sdk/src/kernel/composition.test.ts` writes the type out on a
stack, so the error lands on that line).

A session is plain data, an id the host keeps. `sessions.create` decodes
what it is given and refuses an empty owner, or a parent that is no session
id, with `InvalidSession`. A host that wants to see a session as its journal
tells it reads it and calls `inspectionOf(journal)`: its header, state and
events.

## Tools: the turn becomes a loop

A turn that uses tools is a loop over steps: the model answers, or asks for
tools; the turn runs each call, stores the call and its result, and asks
again, until the model answers without a call or a step limit is reached.
The kernel adds no tool runtime. The tools are Effect AI's own `Toolkit`,
declared in code like the system text, offered in every call and never
stored, and the turn calls them through their handlers as it calls the
model. The tools, quoted from the test that runs them:

<!-- pinned: packages/sdk/src/kernel/tools.test.ts#tools -->

```ts
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"

// The tools: what each does, what it takes, and what it returns. Code, offered in every call, never stored.
const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const Divide = Tool.make("divide", {
  description: "Divide a by b.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
  failure: Schema.String,
  // A failure is returned to the model as the tool's answer, not raised.
  failureMode: "return",
})
const tools = Toolkit.make(Add, Divide)

// What each tool does when it is called.
const toolsLive = tools.toLayer({
  add: ({ a, b }) => Effect.succeed(a + b),
  divide: ({ a, b }) => (b === 0 ? Effect.fail("cannot divide by zero") : Effect.succeed(a / b)),
})
```

And the turn:

<!-- pinned: packages/sdk/src/kernel/tools.test.ts#turn -->

```ts
import { Effect, Option, Stream } from "effect"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import { assistantMessage, Sessions, toolResult, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { Memory } from "@xandreed/sdk/kernel"

// Run one call. A tool that fails, or a call the model got wrong, is an answer too: the model reads it and goes on.
// The call is what the model sent, untyped: its name and parameters are checked by the toolkit, not here.
const runTool = (toolkit: Toolkit.WithHandler<typeof tools.tools>, call: { readonly id: string; readonly name: string; readonly params: unknown }) =>
  toolkit.handle(call.name as keyof typeof tools.tools, call.params as never).pipe(
    Effect.flatMap(Stream.runLast),
    Effect.map(Option.match({
      onNone: () => toolResult(call, null),
      onSome: (last) => toolResult(call, last.encodedResult, last.isFailure),
    })),
    // A failure (the tool's own, an unknown tool, wrong parameters), or a bug in a tool: an answer marked failed.
    Effect.catch((error) => Effect.succeed(toolResult(call, error.message, true))),
    Effect.catchDefect((defect) => Effect.succeed(toolResult(call, String(defect), true))),
  )

// One turn: the model answers, or asks for tools; their results are stored, and the model is asked again.
const turn = (conversation: SessionId, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel
      const toolkit = yield* tools

      const session = yield* sessions.open(conversation)
      yield* session.append(userMessage(message))

      for (let step = 1; step <= MAX_STEPS; step++) {
        const history = yield* memory.context(session)
        const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...history])

        // Offer the tools, but run none: the turn runs the calls itself. A call the model got wrong comes through
        // as it is ("deferred"), so it can be answered as a failure.
        const parts = yield* model.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(
          Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
          Stream.runCollect,
        )
        const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
        const calls = parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

        // Store the model's answer with the calls it made, then run each call and store its result.
        yield* session.append(assistantMessage(text, { toolCalls: calls }))
        if (calls.length === 0) return text
        for (const call of calls) {
          yield* session.append(yield* runTool(toolkit, call))
        }
      }
      return `I stopped after ${MAX_STEPS} steps.`
    }),
  )
```

- **The turn runs the calls, not the model.** `streamText` is given the
  toolkit with `disableToolCallResolution: true`: the model sees the tools,
  and its `tool-call` parts come back unrun. With `toolCallValidation:
  "deferred"` a call the model got wrong (a tool that does not exist,
  parameters that do not decode) comes through as it is; the default would
  fail the stream, and with it the turn.
- **Failures are data.** A tool that fails with `failureMode: "return"`
  answers with its failure; an unknown tool or bad parameters fail
  `toolkit.handle`, and the turn stores that as a failed result. Either way
  the model reads the failure as the answer to its call, and the turn goes
  on. The failure text comes from Effect AI's toolkit, not from the kernel.
- **Every call and result is a record.** The model's answer is stored with
  the calls it made (`assistantMessage(text, { toolCalls })`, which takes the
  stream's `tool-call` parts as they came), and each result as
  `conversation.tool.result` (`toolResult(call, result, isFailure)`), both
  tagged `conversation`. `promptMessage` sends a call as a part of the
  model's message and a result as a tool message that answers it.
- **A step limit ends a model that keeps asking.** Its last results are
  stored; what the turn returns then is the program's own words, not the
  model's, and is not stored.

A turn stopped while a tool ran leaves a call with no result in the journal,
and a memory that cuts the conversation can split a call from its result. A
provider refuses a call nothing answers, so every memory sends its messages
through `paired`: a call goes only with its result, a result only with its
call, and an answer left with neither text nor a call is dropped. The
journal keeps every record; `paired` decides only what is sent. The memory
kit holds a memory to it (`pairs`): an answered call is sent with its result
right after it, and an unanswered one not at all. The window memory drops
whole turns only, so one long tool turn can go over its budget: it fails
with `OverBudget` like any turn that alone does not fit (ADR 0004).

Between steps a host may take messages that arrived meanwhile into the open
turn, so a long run can be steered; the second lesson's chat does this
with the messages waiting in its queue (`chat.drain`). That is the host's choice, not the
kernel's.

## A plugin of your own

A plugin takes part in the ways ADR 0001 lists: it replaces a contract, wraps
one, hooks an event, or records a fact in the journal under its own name.
Two of them are enough for most of what a host adds, and the third lesson
of the learn pages builds both.

An **event plugin** sets up on boot and hooks events with `Core.on`, as a
Neovim autocmd does. It observes: it stores nothing, and changes no turn.
This one counts what each answer cost and shows it when the turn ends:

<!-- pinned: packages/sdk/src/kernel/own-plugin.test.ts#meter -->

```ts
/**
 * An event plugin. On boot it hooks two events, as a Neovim autocmd does: each
 * answer stored, and each turn's end. It stores nothing and changes no turn:
 * it counts, and shows the count. Its listeners go with its layer's scope.
 */
const meter = (show: (line: string) => Effect.Effect<void>) =>
  Layer.effectDiscard(Effect.gen(function* () {
    const core = yield* Core
    const spent = yield* Ref.make({ turn: 0, total: 0 })

    // Each answer: what the provider says it cost, else an estimate of its text. `wait: true`, so the
    // count is in before the turn goes on, and so before its end is announced.
    yield* core.on(assistantMessageEvent, (event) => {
      const said = "message" in event && event.message !== undefined ? messageText(event.message) : ""
      const tokens = event.data.usage?.outputTokens ?? estimateTokens(said)
      return Ref.update(spent, ({ turn, total }) => ({ turn: turn + tokens, total: total + tokens }))
    }, { name: "meter", wait: true })

    // Each turn's end: show what it cost, and start the next turn's count at zero.
    yield* core.on(turnEndedEvent, (event) =>
      Effect.flatMap(Ref.getAndUpdate(spent, (count) => ({ ...count, turn: 0 })), ({ turn, total }) =>
        show(`turn ${event.data.turn}: ${turn} tok, ${total} in all`)), { name: "meter" })
  }))
```

Its listeners belong to its layer's scope: a host that builds the stack again
(the lesson's Rebuild) closes it, and the old meter hears nothing more.

A **wrapper** is a higher-order plugin: given a plugin of a contract, it
returns a plugin of the same contract, the inner one hidden. A wrapper of
`Memory` asks the memory below for the context, then adds what this request
needs after it (ADR 0005). What it adds is code's, like the system text:
never stored, so it is not sent again in later requests, and the cached
prefix up to the conversation's end still holds.

<!-- pinned: packages/sdk/src/kernel/own-plugin.test.ts#clock -->

```ts
/**
 * A wrapper of `Memory`, written as a higher-order plugin: given the memory it
 * wraps, it returns a memory. It asks the one below for the context, then adds
 * one message after it, for this request only. The time is computed here, like
 * the system text, and never stored: the next request has its own, and the
 * cached prefix up to the conversation's end still holds.
 */
const withClock = <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>
  Layer.effect(Memory, Effect.gen(function* () {
    const memory = yield* Memory // the memory it wraps
    return Memory.of({
      context: (session) => Effect.gen(function* () {
        const context = yield* memory.context(session)
        const now = new Date(yield* Clock.currentTimeMillis).toISOString().slice(11, 16)
        return [...context, { role: "user" as const, content: `[Host note: it is ${now} UTC.]` }]
      }),
    })
  })).pipe(Layer.provide(inner))
```

`memoryWrapperConformance` holds a wrapper to that rule: the wrapped context
starts with the inner memory's, whole and in its order
(`starts-with-inner`), and what the wrapper appends while it builds is under
its own prefix, never a record of the conversation (`own-records`). Stored
as a user message instead, the time would be sent in every later request,
one more copy each turn; stored as the plugin's own record, no memory sends
it, since a memory reads the conversation's records only.

## Records and tags

A stored event is an envelope: its place in the journal (`seq`), when it was
stored (`at`), the turn it was stored in (`turn`), its name, what it is for
(`tags`), its data as JSON, whether a reader that does not know it may skip
it, and, when the record bears one, a message. The session plugin stamps the
turn; the storage, the place and the time. A message sits on the envelope and
nowhere else; what it stands for (a summary of earlier turns, say) is in the
data of the plugin that wrote it.

A definition declares its tags once, and every event of it carries them. The
reserved tags:

| Tag | What it marks |
|---|---|
| `conversation` | what memory builds the context from: the user's and the model's messages, the tools' results, and a memory's own record that stands for some of them |
| `turn` | the session's own structure: a turn's start and end |
| `memory` | a memory's own state, derived from the conversation and rebuildable from it |
| `ui` | what a client draws |
| `trace` | side work that is not the conversation |

A plugin's own tags are named `<plugin>.<tag>`. `taggedWith(tag)` tells a
record by its tags, and `messageOf` reads a message only from a record tagged
`conversation`: text a record of another use bears never reads as part of
the conversation. Token usage is metadata in a record's data, not a tag: the
assistant message stores the model and what the provider reported it cost,
when its writer has them.

| Event | Written by | Kept | Tags |
|---|---|---|---|
| `core.session.turn.started` | the session plugin, as a turn opens | stored | `turn` |
| `core.session.turn.ended` | the session plugin, as a turn closes, with its outcome | stored | `turn` |
| `conversation.user.message` | whoever runs the turn | stored; bears the message | `conversation` |
| `conversation.assistant.message` | whoever runs the turn | stored; bears the message (its text and the tool calls it made), its data the model and the usage | `conversation` |
| `conversation.tool.result` | whoever runs the turn, after running a call | stored; bears the result, or the failure, and the call it answers | `conversation` |
| `plugin.window.dropped` | the window memory, when whole turns leave the window | stored; may be skipped | `memory` |
| `plugin.window.pressure` | the window memory, when a context came close to the budget | live only | `memory` |
| `plugin.inbox.queued` | the inbox, as it queues a message, with its ticket | live only; about the session, no turn | `ui` |
| `core.listener.failed` | core, when a listener fails where nothing can fail for it | live only | `trace` |

An event is named by the owner of the vocabulary that defines it: core's
session contract names its own `core.`, the conversation's records are
core's `conversation.`, and a plugin's are `plugin.<plugin name>.`. The type
of an event is open: core holds no list of names. Core's own records are the
session plugin's to write: a turn's body that appends a record named under
`core.` is refused (`SessionRefused`, `ReservedName`) and nothing is stored.
Nothing about a request is stored: what a model was shown is rebuilt from the
conversation's records, and a host that wants to see it watches its model.

## Events

### publish and on

`Core.publish(event)` first runs the listeners registered with
`{ wait: true }`, in the order they registered, one after another; if one
fails, the publish runs none after it and fails with `ListenerFailed`, which
names the listener and the event, and inside a turn that fails the turn.
Then it hands the event to the background listeners and to the host's
stream, the `events` of `Core`, without waiting for them. A publisher whose
listeners must all hear the event and none may fail it asks
`Core.publish(event, { listenerFailures: "report" })`: every waiting
listener runs whatever the others did, each failure is reported as
`core.listener.failed` once the event was handed over, and the publish
cannot fail. Background delivery is bounded and sliding (`capacity`,
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

The end of a turn is announced that way, and so is a message the inbox
queues. The session plugin stores `core.session.turn.ended`, announces
it, and frees the session once the listeners the announcement waits for are
done or cut short after `closeWait` (5 seconds when left out), just before
the end is handed to the background and the stream. A turn interrupted as
it opened, its start stored but its body never begun, has its start
announced there first, so no listener hears an end without its start; that
announcement has a `closeWait` of its own, so a listener that holds it
cannot keep the end from being announced. So the events of one
session, appended one after another, arrive in journal order, and whoever
hears of the end in the background finds the session free. Until then the session is busy, and a
turn asked for it is refused with `SessionBusy`.

A host follows events by running the stream, which has no replay, so it
starts reading before the turn it wants to see:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#follow -->

```ts
const answered = yield* core.events.pipe(
  Stream.filter((event) => event.name === assistantMessageEvent.name),
  Stream.take(1),
  Stream.runCollect,
  Effect.forkScoped({ startImmediately: true }),      // reading before the turn starts: the stream has no replay
)
yield* send(session, "Hello")
const shown = yield* Fiber.join(answered)
```

### A plugin's own events

A plugin defines its events with `liveEvent` or `storedEvent`, which put
the plugin's name in front (`plugin.<plugin name>.<event>`) and take its
tags. `live(definition, origin, data)` makes an event for `Core.publish`;
`stored(definition, data)` a draft for `session.append`. The kind is in the
type: a live event cannot be appended and a draft cannot be published.

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#own-event -->

```ts
import { assistantMessageEvent, Core, live, liveEvent, originOf } from "@xandreed/core/kernel"

// An event of the plugin's own, defined in the plugin's folder: its name, what it is for, the schema of its data, live or stored.
const answerCounted = liveEvent("meter", "answer.counted", { tags: ["trace"], data: Schema.Struct({ answers: Schema.Int, outputTokens: Schema.Int }) })

// A plugin that provides no contract and only listens: a layer that registers its listener in its own scope.
const meter = Layer.effectDiscard(Effect.gen(function* () {
  const core = yield* Core
  const answers = yield* Ref.make(0)
  // React to a record of the conversation, and publish one of its own about the same turn.
  yield* core.on(assistantMessageEvent, (answered) => Effect.flatMap(Ref.updateAndGet(answers, (count) => count + 1), (count) =>
    core.publish(live(answerCounted, originOf(answered), { answers: count, outputTokens: answered.data.usage?.outputTokens ?? 0 }))), { name: "meter", wait: true })
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
folding it to the phase and appending `core.session.turn.started` at the
next place. That append is its claim: the store refuses an append at a
place that is taken, so of two writers that begin a turn of one session at
once, one is refused with `SessionBusy`. A write whose store did not report
success, because its caller was interrupted while the store had not
answered or because the store failed after it had kept the event (an
uncertain acknowledgement, as a remote store may give), leaves the turn's
place unknown: the next write, the end's included, reads the last place
from the store before it stores. Such an event may be in the journal and
never announced. So a turn stays open in the journal only when its end
could not be stored, or when the store kept its start and reported a
failure; closing such a turn is crash recovery, which returns with the
durable stores. Inside a turn, the writes take one lock
in turn: two appends made at once are stored one after the other, and the
end, once the body has returned, waits for an append still being stored
and is stored after it. An append made after the end began is refused
with `NoOpenTurn`. The lock holds the store, not the announcement: each
event is announced after its own store, so the announcements of appends
made at once can reach a listener that suspends in another order than the
journal's. A stored fact is `session.append(...)`, which stores it through
`JournalStorage` and then publishes the stored event; a live fact is
`Core.publish(...)`, which stores nothing:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
  if (reserved(event)) return yield* Effect.fail(new SessionRefused({ reason: "ReservedName", message: `${event.name} is core's to write, not a turn's body` }))
  const stored = yield* open.writes.withPermits(1)(Effect.gen(function* () {   // one write at a time, the end's included
    if (yield* Ref.get(open.closed)) return yield* Effect.fail(new SessionRefused({ reason: "NoOpenTurn", message: `turn ${open.turn} of session ${open.id} has closed` }))
    return yield* store(open, event)                              // in the journal first
  }))
  yield* core.publish(announced(open, stored))                    // then announced, same name
  return stored
})
```

A turn opens one of two ways. `open` opens it in the current scope and closes
it with the scope's exit; `turn` runs a body in a scope of its own. A scope's
close cannot fail, so an end that cannot be stored is a defect of the scope
under `open`, and the storage failure itself under `turn`; either way the
turn stays open, as the journal says:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
open: (id) => Effect.flatMap(
  Effect.acquireRelease(begin(id), (open, exit) => Effect.orDie(end(open, exit))),   // Free → TurnOpen, or refused; the end stores core.session.turn.ended with the scope's outcome
  announceStart,
),
```

## What the model is sent

Memory is the layer between what is stored and what goes into a prompt. It
keeps nothing by contract: `memory.context(session)` reads the session's
journal and returns the messages that follow the system text, ready for the
prompt. It reads the conversation's records and its own; what it stores of
its own (a cut, a summary, an index) is tagged `memory`, derived from the
conversation and rebuildable from it, never a copy of it. A budget, when a
memory has one, is its own option, and covers the history: the system text
is the program's. The flat memory, quoted from its source:

<!-- pinned: packages/sdk/src/kernel/plugins/memory-flat/flat.adapter.ts -->

```ts
export const flatMemory: Layer.Layer<Memory> = Layer.succeed(
  Memory,
  Memory.of({
    context: Effect.fn("kernel.flat.context")(function* (session: OpenSession) {
      // Only the conversation's records and its own; a record it cannot read and may not skip is refused.
      const conversation = yield* Effect.fromResult(readJournal(FLAT_READER)(yield* session.journal))
      // A tool call goes only with its result: a turn stopped while a tool ran leaves a call nothing answers.
      return paired(conversation.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage)
    }),
  }),
)
```

Each context starts with the one before it, so a provider's prompt cache
reuses all of it, until the conversation outgrows the model. The window
memory keeps to a budget: over it, it drops whole turns, oldest first, and
records how far it dropped (`plugin.window.dropped`), so a turn once dropped
stays dropped and the start of every later context holds. When the current
turn alone does not fit, it fails with `OverBudget` (`isOverBudget` tells
it). The estimate is one pure function, `estimateTokens`, a quarter of the
characters rounded up:

<!-- pinned: packages/sdk/src/kernel/plugins/memory-window/window.adapter.ts -->

```ts
export const windowMemory = (options: WindowOptions): Layer.Layer<Memory, InvalidBudget, Core> => Layer.effect(Memory, Effect.gen(function* () {
  const core   = yield* Core
  const budget = yield* Effect.fromResult(budgetOf(options.budgetTokens))   // InvalidBudget fails the layer

  return Memory.of({
    // Nothing is kept between turns: each context is built from the journal as it stands.
    context: Effect.fn("kernel.window.context")(function* (session: OpenSession) {
      const journal = yield* Effect.fromResult(readJournal(WINDOW_READER)(yield* session.journal))
      const fitted  = yield* Effect.fromResult(fitToBudget(journal, budget))   // whole turns, oldest dropped first
      if (Option.isSome(fitted.dropped)) yield* session.append(windowDropped(fitted.dropped.value))
      // React: announce pressure, so any plugin can act on it.
      if (nearlyFull(fitted, options.pressureAt)) yield* core.publish(windowPressure(session, fitted))
      return paired(fitted.messages).map(promptMessage)
    }),
  })
}))
```

A memory written in a few lines:

<!-- pinned: packages/sdk/src/kernel/guide.test.ts#memory-plugin -->

```ts
import { messageOf, userMessageEvent } from "@xandreed/core/kernel"
import { Memory, promptMessage } from "@xandreed/sdk/kernel"

/** A memory that sends the message the turn answers and nothing before it. */
const goldfish = Layer.succeed(Memory, Memory.of({
  context: (session) => Effect.map(session.journal, (journal) =>
    journal.filter((event) => event.name === userMessageEvent.name).slice(-1)
      .flatMap((event) => Option.toArray(messageOf(event))).map(promptMessage)),
}))
```

The strategies to come sit behind the same call: a summary of old turns and
the recent ones, results replaced by pointers with a tool that reads them
back, or facts retrieved from an index built from the journal.

A journal outlives the code that wrote it. A reader answers for core's
records (`core.`, `KERNEL_READER`) and for those under its own prefix
(`readerFor`, `readJournal`); a memory reads the conversation through the
conversation's reader (`readerFor(name, own, CONVERSATION_READER)`). A record
it does not know is passed over when the record says it may be skipped, and
refused with `UnknownRecord` when it may not. A record under another
plugin's prefix is not its concern. The memory kit holds a memory to the
conversation's reader: an unknown record of the conversation that may not be
skipped is refused (`unknown-conversation-refused`), which a memory reading
its own prefix alone would pass.

## The inbox: queueing messages for a turn

The inbox is a plugin over the host's own turn, and the proof that a plugin
can be added without touching core: its contract, `Inbox`, lives in a
contract folder of the sdk (`contracts/inbox`), under a key named after its
package, and its plugin in `plugins/inbox`. `inbox(turn)` is given the turn
it runs for each message, and needs what that turn needs.

<!-- pinned: packages/sdk/src/kernel/contracts/inbox/inbox.port.ts -->

```ts
export class Inbox extends Context.Service<Inbox, {
  /** Queue a message for the session. Returns at once, in call order, with its ticket and its reply. */
  readonly enqueue: (session: SessionId, message: string) => Effect.Effect<Queued, InboxRefused>
}>()("@xandreed/sdk/kernel/Inbox") {}
```

A program that reads messages from a stream needs no inbox: the stream is
its queue. The inbox is for more than one sender: messages from several
places, or replies a caller waits for one by one. Its rules:

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
- **One worker per session**, forked in the plugin's scope, runs one turn
  at a time and stops when nothing waits. It takes the next message in one
  transition, then waits for that message's own announcement, so the
  message's turn starts after the listeners its announcement waits for
  heard of it. Starting and stopping are decided in the same transitions as
  queueing and taking, so no message is ever left without a worker. A
  session has a queue only while its worker runs: the transition that stops
  the worker removes it, so the inbox keeps nothing of a session it is not
  serving. The queues are a persistent map (`HashMap`), so a transition
  copies no other session's queue.
- **A failed turn** fails that message's reply only; the next message runs.
  Interrupting whoever waits on a reply does not cancel the turn.
- **When the inbox's scope closes**, every reply not given yet fails with
  `InboxClosed`, the running turn's included, and a message queued after is
  refused (`InboxRefused`, `Closed`). None hangs.
- **The next message waits for the session to be free.** A turn returns only
  once the session plugin has freed the session, so a slow listener of
  `core.session.turn.ended`, bounded by `closeWait`, delays the next queued
  message instead of failing it with `SessionBusy`.
- **Capacity:** a session's queue holds 64 waiting messages unless
  `inboxOf(turn, { capacity })` says otherwise; a full one refuses with
  `InboxRefused` (`Full`), and nothing of the message is stored.
- **`plugin.inbox.queued`** is published for each message queued, live,
  about the session and no turn, on a fiber of the plugin: `enqueue`
  returns its ticket and reply whatever becomes of the announcement, and a
  listener of it that does not suspend has heard it by then, unless the
  session's message before it is still being announced. One session's
  announcements are published in ticket order: each follows the session's
  announcement before it, whether that message waits, was taken or runs.
  Each reaches every listener the publisher waits for before its
  message's turn starts; one that fails is reported
  (`core.listener.failed`), holds back none after it, and the turn runs. An
  announcement cut short by the close of the inbox's scope starts no turn,
  and its reply fails with `InboxClosed`.
- **Do not mix the inbox and direct turns on one session.** A queued
  message whose turn is refused because a direct turn holds the session
  fails with `SessionBusy`.
- **In the process only.** Queued messages do not survive the process.

## Replacing a part

A part is replaced by giving the program a different layer for it: the
memory or the store, the rest as it was. The kernel's tests run a turn of
their own over the stock journal, session and memory layers, and a memory of
their own that announces an event of its own on a compression check, which
another plugin reacts to, with nothing under core changed
(`packages/sdk/src/kernel/plugins.test.ts`). Core needs no workflow at all: a
stack of the kernel, the journal, the session plugin and one plugin that
opens a turn and appends its own records runs and stores the turn, with no
memory or model in it (`packages/sdk/src/kernel/no-loop.test.ts`).

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
- Each upper stack (`Upper`: the inbox over a turn, a memory and whatever
  else listens) is built in a child scope of its own.
- The old stack's scope is closed before the new one takes a turn, so no
  event reaches the listeners of both: the test checks that the old
  memory's listener hears nothing after the swap, and that the session goes
  on with its earlier messages.

Each contract ships with its kit: core's `journalStorageConformance` and
`sessionsConformance`, and the sdk's `memoryConformance`, are the contracts
as runnable checks, each check with an id that its failures name.

## What the first cut leaves out, and the order it returns

This cut keeps journals in the process, and has one session plugin and two
memories. A host's turn runs tools itself, through Effect AI's `Toolkit`
(see "Tools: the turn becomes a loop"). What follows returns in this order.

1. **Sub-agents.** A turn that hands a task to an agent of its own, in a
   child session.
2. **Compaction memories.** A summary of old turns, results replaced by
   pointers with a tool that reads them back, behind `memory.context`.
3. **A UI rendering plugin**, whose client applies patches from records and
   events tagged `ui`.
4. **Durable stores and crash recovery**, on the seam the fold of the
   journal already gives.

## Keeping a tailored context cache-stable

A provider caches a prompt by its prefix, so a context tailored for each
turn must not disturb what came before. What a turn's tailoring adds, it
adds at the end. The system text is the program's, sent first: changing it
starts a new prefix. Nothing earlier is rewritten until memory compacts. The
memory kit checks the last rule as it applies to this cut: while nothing
presses, the next turn's context starts with this turn's.

## Ideas adopted, and one that was not

The kernel draws on earlier work on building agent runtimes out of parts
that compose, among it the paper *A Programming Paradigm for Spatiotemporal
Composability* (arXiv 2608.25512). Four ideas were adopted.

- **One source of truth.** The journal holds the conversation and a
  memory's derived state, and a message's text is stored once. What a model
  was shown is rebuilt from it, never stored beside it.
- **The may-be-skipped flag.** A stored plugin record says whether a reader
  that does not know it may pass over it.
- **Scoped setup.** What a plugin registers and acquires while it is set up
  belongs to its layer's scope, and is released when the scope closes.
- **Keyed registrations with a stable order.** The listeners a publisher
  waits for run in the order they registered.

One idea was not adopted: a runtime that loads and unloads plugins inside a
live process. A plugin here is an Effect layer, and there is nothing in
front of the layers: replacing a part is providing a different stack.
