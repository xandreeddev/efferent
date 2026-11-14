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
| The conversation's records | core | `conversation.user.message` and `conversation.assistant.message`, `userMessage(text)` and `assistantMessage(text, meta?)`, `CONVERSATION_VOCABULARY` |
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
import { Effect } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { callTool, Memory, modelAnswer } from "@xandreed/sdk/kernel"

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
        // as it is ("deferred"), so it can be answered as a failure. `modelAnswer` reads the stream in this turn and
        // stores the answer: its text, the calls it made, and what the provider said it cost.
        const answer = yield* modelAnswer(model.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
        if (answer.toolCalls.length === 0) return answer.text
        // Each call runs in this turn (a tool that declares CurrentTurn reaches the session from its handler), and its
        // result is stored. A tool that fails, or a call the model got wrong, is an answer too: the model reads it and goes on.
        for (const call of answer.toolCalls) {
          yield* callTool(toolkit, call, session)
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
- **`modelAnswer(stream, session, { onText })` reads one call's answer**
  from the model's stream, in the turn it belongs to, and stores it: the
  text, each piece handed to `onText` as it arrives, the calls the model
  made, and what the provider reported it cost and which model answered, as
  one `conversation.assistant.message`. The stream is the host's: it calls
  the model with its own prompt, tools and options. A stream that reports
  an error fails with `ModelAnswerFailed`, and nothing is stored.
- **`callTool(toolkit, call, session)` runs one call** in the turn it
  belongs to, through the toolkit's handlers, and stores its result. A
  result that is not stored answers nothing, so the function stores it, and
  gives back the stored record.
- **Both are functions, not services** (ADR 0004): every host's loop wrote
  the same two blocks, so the kernel holds each once, and the loop stays the
  host's. Lesson 2 writes both out by hand, to show what they do.
- **Both give the work its turn** (`CurrentTurn`, ADR 0007): a tool that
  declares it, and whatever runs while the model answers (a wrapper of the
  model), reach the open session as a `RunningTurn`, whose reads and writes
  cannot fail in their type. A write that fails in a tool is a defect of
  the handler, stored as a failed result; one that fails while the model
  answers fails the turn. The summary memory gives its summarizer its turn
  the same way.
- **Failures are data.** A tool that fails with `failureMode: "return"`
  answers with its failure; an unknown tool, bad parameters or a defect in a
  handler fail the call, and `callTool` stores that as a failed result.
  Either way the model reads the failure as the answer to its call, and the
  turn goes on. The failure text comes from Effect AI's toolkit, not from
  the kernel.
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

The loop runs each call in its turn: `CurrentTurn`, provided around the call,
is the open session it runs in (ADR 0007). A tool whose handler must reach
it (to append a record of its own, or to start a helper under it) declares
it in `dependencies` and reads it with `yield* CurrentTurn`; the compiler
refuses a loop that runs such a tool without providing it.

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
Neovim autocmd does. It observes: it stores nothing and says nothing to the
model, and only a listener registered with `wait: true` holds the turn. This
one counts what each answer cost and shows it when the turn ends:

<!-- pinned: packages/sdk/src/kernel/own-plugin.test.ts#meter -->

```ts
/**
 * An event plugin. On boot it hooks two events, as a Neovim autocmd does: each
 * answer stored, and each turn's end. It stores nothing and says nothing to the
 * model: it counts, and shows the count. The listener registered with
 * `wait: true` holds the turn until it returns, and its failure would fail the
 * turn; the other runs in the background. Its listeners go with its layer's scope.
 */
const meter = (show: (line: string) => Effect.Effect<void>) =>
  Layer.effectDiscard(Effect.gen(function* () {
    const core = yield* Core
    const spent = yield* Ref.make({ turn: 0, total: 0 })

    // Each answer: what the provider says it cost, else an estimate of its text. `wait: true`, so the
    // count is in before the turn goes on, and so before its end is announced.
    yield* core.on(assistantMessageEvent, (event) => {
      const said = event.message === undefined ? "" : messageText(event.message)
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
        return [...context, { role: "user" as const, content: hostNote(`it is ${now} UTC.`) }]
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

## Sub-agents: a session of its own

A turn can hand a task to an agent of its own, which works in a session of
its own and returns only its answer (ADR 0006). Nothing in the contracts is
new for it: the helper's session is created with the caller's as its
`parent`, its turn opens while the caller's is open, and the caller's model
reaches it through a tool. The tool's handler needs a helper, so the helper
is a contract the host provides:

<!-- pinned: packages/sdk/src/kernel/testing.port.ts#helper-contract -->

```ts
// What the delegate tool needs: a helper that takes a task and answers it, under the turn the call runs in.
// A contract, so the tool does not know how.
export class Helper extends Context.Service<Helper, {
  readonly ask: (task: string) => Effect.Effect<{ readonly answer: string; readonly session: string }, string, CurrentTurn>
}>()("@xandreed/sdk/kernel/testing/Helper") {}
```

The tool, and the helper the host provides:

<!-- pinned: packages/sdk/src/kernel/sub-agent.test.ts#helper -->

```ts
// The tool the parent's model calls. Its result names the helper's session: the stored link from the call to the child.
const Delegate = Tool.make("delegate", {
  description: "Hand a task to a helper. It works in a session of its own and returns only its answer.",
  parameters: Schema.Struct({ task: Schema.String }),
  success: Schema.Struct({ answer: Schema.String, session: Schema.String }),
  failure: Schema.String,
  failureMode: "return",
  dependencies: [CurrentTurn], // its handler reaches the turn the call runs in
})

// How deep helpers may go: the loop's step limit bounds one turn, not helpers calling helpers.
const MAX_DEPTH = 2

// The helper: an agent of its own, with its own system text and tools, in a session whose parent is the caller's.
const helperLive = Layer.effect(Helper, Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const toolkit = yield* helperTools
  const services = yield* Effect.context<Memory | LanguageModel.LanguageModel>()
  const helper = agentTurn("You are a helper. Answer the task in one sentence.", toolkit)
  // How many helpers deep a session is: its parents, read from the store, up to the root.
  const depthOf = (id: SessionId): Effect.Effect<number, JournalStorageError> => Effect.flatMap(sessionsOf.read(id), (journal) =>
    journal.header.parent === undefined ? Effect.succeed(0) : Effect.map(depthOf(journal.header.parent), (depth) => depth + 1))
  return Helper.of({
    ask: (task) => Effect.scoped(Effect.gen(function* () {
      const caller = yield* CurrentTurn // the turn the delegate call runs in: the chat's, or a helper's
      if ((yield* depthOf(caller.id)) >= MAX_DEPTH) return yield* Effect.fail("a helper this deep may not hand work further down")
      const session = yield* sessionsOf.create({ owner: "helper", parent: caller.id })
      const answer = yield* helper(yield* sessionsOf.open(session), task) // a turn of its own, while the caller's is open
      return { answer, session }
    })).pipe(Effect.provide(services), Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
  })
}))
```

The caller's journal holds the call and its result, which names the
helper's session; the helper's journal holds its whole turn. The helper's
first request holds its system text and the task, and the caller's next
request holds the call and the result, nothing of the helper's work.
`delegate` declares `CurrentTurn`, the turn its call runs in, which the
loop provides around each call (ADR 0007): the helper is created under
whichever session called it, so a helper's helper is filed under the helper,
and the depth, read from the `parent` chain, is bounded by the host
(`MAX_DEPTH`): the loop's step limit bounds one turn, not helpers calling
helpers.

## What the UI shows: a record tagged ui

An agent shows things, not only text: a table, a card, progress. What it
shows is the UI's, never the model's (ADR 0009). A view is one of four
shapes (`Text`, `List`, `Table`, `Card`), stored as `plugin.render.view`
under an id, tagged `ui`, with no message, so no memory sends it. A later
view under the same id replaces it. A client folds the journal's views with
`viewsOf`, the same fold live and after a reload. Progress is a live event,
`plugin.render.progress`, for whoever watches now; what stays is the view
the work ends with.

There is no render service. A tool that shows something appends its view
through the turn its call runs in (`CurrentTurn`, ADR 0007), and publishes
its progress through that turn too (`turn.publish`), so the turn is the one
thing it declares. What it returns to the model is a few words. A view
keeps out of the context what the tool worked out, not what the model
wrote: a call's parameters are the model's message and are sent with the
conversation, so the model asks in a few words and the tool makes the rows:

<!-- pinned: packages/sdk/src/kernel/render.test.ts#show-tool -->

```ts
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { CurrentTurn, progressEvent, showView, ViewId } from "@xandreed/sdk/kernel"

// A tool that works out a table and shows it. The model asks in a few words; the rows are the tool's own work.
const Squares = Tool.make("squares", {
  description: "Show the user the squares from 1 to upTo, as a table. Give it an id: showing again under that id replaces it.",
  parameters: Schema.Struct({ id: ViewId, upTo: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })) }),
  success: Schema.String,
  // The turn its call runs in: to append the view, and to publish its progress.
  dependencies: [CurrentTurn],
})
const tools = Toolkit.make(Squares)

const toolsLive = tools.toLayer({
  squares: ({ id, upTo }) => Effect.gen(function* () {
    const session = yield* CurrentTurn
    const rows: Array<ReadonlyArray<string>> = []
    for (let n = 1; n <= upTo; n++) {
      rows.push([String(n), String(n * n)])
      // How far it got: live, for whoever watches, never stored.
      yield* session.publish(progressEvent, { id, done: n, total: upTo })
    }
    // The table it worked out, stored as a view tagged ui. No memory sends it: the model never sees the rows.
    yield* session.append(showView(id, { _tag: "Table", title: "Squares", columns: ["n", "n²"], rows }))
    // What the model reads: a few words.
    return `shown as ${id}`
  }),
})
```

`render.test.ts` holds it: the view is stored between the call and its
result, no message of the next prompt holds the table (the call and "shown
as squares" do), and the same table returned as the tool's result instead
is sent in every later request.

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
| `conversation` | what memory builds the context from: the user's and the model's messages and the tools' results; a plugin may tag a record of its own that stands for some of them, for the plugins that read its vocabulary |
| `turn` | the session's own structure: a turn's start and end |
| `memory` | a memory's own state, derived from the conversation and rebuildable from it |
| `ui` | what a client draws |
| `trace` | side work that is not the conversation |

A plugin's own tags are named `<plugin>.<tag>`. A tag is checked where its
definition is made (`storedEvent`, `liveEvent`): a word that is not one of
the five, such as a misspelt `conversation`, does not type and throws there,
and so does another plugin's tag. `taggedWith(tag)` tells a
record by its tags, and `messageOf` reads a message only from a record tagged
`conversation`: text a record of another use bears never reads as part of
the conversation. The stock summary memory tags its summary `memory` and
sends its message itself (ADR 0008).

A record is appended as `stored(definition, data)` made it, from a
definition `storedEvent` made, and no other way: an object written by hand,
a copy of a draft with a field changed, or a record of a definition written
by hand is refused by the session (`SessionRefused`, `NotADraft`). So every
record a session stores carries the name, the tags and the skip flag of a
definition whose tags were checked. Token usage is metadata in a record's data, not a tag: the
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
nothing published after. `name` is how a failure of it is reported. The
handler is given what the definition's kind is delivered as: a stored
record, with its place and the message it bears, for a stored definition; a
live event for a live one. An event of the other kind under the same name is
not delivered. A
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

A journal's header names the format it was written in. A turn opens only on
a journal of this kernel's format (`JOURNAL_FORMAT`); another is refused
(`SessionRefused`, `FormatMismatch`) and nothing is stored, since old
journals are not migrated. `read` still gives such a journal, so a host can
say what it found and start a new session.

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
`Core.publish(...)`, which stores nothing. A part that holds the open
session, a tool or a memory, publishes a live fact about its turn with
`session.publish(definition, data)`, and needs no `Core` of its own:

<!-- pinned: packages/sdk/src/kernel/plugins/session/sessions.adapter.ts -->

```ts
const append = (open: Turn) => (event: StoredDraft) => Effect.gen(function* () {
  // Only what `stored` made, from a definition `storedEvent` made, is a record: an object written by hand, or a definition
  // written by hand, could carry a tag no part reads by, or another skip flag than its definition's.
  if (!isStoredDraft(event)) return yield* Effect.fail(new SessionRefused({ reason: "NotADraft", message: "this value is not a record `stored(definition, data)` made from a definition `storedEvent` made: build a record with `stored`, or with `userMessage`, `assistantMessage` or `toolResult`, never by hand or as a copy" }))
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
      const conversation = yield* Effect.fromResult(readJournal(FLAT_VOCABULARY)(yield* session.journal))
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
export const windowMemory = (options: WindowOptions): Layer.Layer<Memory, InvalidBudget> => Layer.effect(Memory, Effect.gen(function* () {
  const budget = yield* Effect.fromResult(budgetOf(options.budgetTokens))   // InvalidBudget fails the layer

  return Memory.of({
    // Nothing is kept between turns: each context is built from the journal as it stands.
    context: Effect.fn("kernel.window.context")(function* (session: OpenSession) {
      const journal = yield* Effect.fromResult(readJournal(WINDOW_VOCABULARY)(yield* session.journal))
      const fitted  = yield* Effect.fromResult(fitToBudget(journal, budget))   // whole turns, oldest dropped first
      if (Option.isSome(fitted.dropped)) yield* session.append(windowDropped(fitted.dropped.value))
      // React: announce pressure, so any plugin can act on it.
      if (nearlyFull(fitted, options.pressureAt)) yield* session.publish(windowPressureEvent, pressureOf(fitted))
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

### Compaction: a memory with state

The window forgets what it drops. The summary memory keeps it, in short:
over its budget, it folds the oldest closed turns, with the summary so far,
into a new summary, and stores it once as `plugin.summary.summarized`,
tagged `memory`, the summary its record's message and the place of the last
message it replaces (`through`) its data. Every later context starts with
that summary as a host note, then every message after `through`, so the
prefix a provider cached holds from one compaction to the next. It folds
whole turns only, never the open one, so a tool call stays with its result:
every closed turn but the latest (`keepTurns`, a preference: it folds that
too when it must), so the next compaction is as far off as it can be. The
summary is framed as data in a host note, which a copy of its tag inside
cannot close. No kernel plugin calls a model: the summary comes from a
`Summarizer` the host provides, over the model it picked or any other
(ADR 0008). One summary at most per context: a summary too long to fit
beside the turns that stay is not stored, and the context fails with
`OverBudget`, so the next one asks again; when even folding every closed
turn would not fit, it fails so without asking for one.

<!-- pinned: packages/sdk/src/kernel/plugins/memory-summary/summary.adapter.ts -->

```ts
return Memory.of({
  context: Effect.fn("kernel.summary.context")(function* (session: OpenSession) {
    const first = yield* planned(session)
    const fitted = yield* Match.valueTags(first, {
      Fits: (fits) => Effect.succeed(fits),
      Over: (it) => Effect.fail(over(it.estimatedTokens)),
      // Fold once: summarize, store the summary, and plan again from the journal as it now stands.
      Fold: (fold) => Effect.gen(function* () {
        // The summarizer works for this turn: what it calls (a model, through a wrapper) reaches the session as `CurrentTurn`.
        const summary = yield* summarizer.summarize({ earlier: fold.earlier, messages: fold.fold }).pipe(Effect.provideService(CurrentTurn, runningTurn(session)))
        // A summary stands for the turns it folds, for good: one that says nothing is not stored.
        if (summary.trim().length === 0) return yield* Effect.fail(new SummaryFailed({ message: "the summarizer answered with nothing, so no summary was stored" }))
        // A summary too long to fit beside what stays is not stored: the next context asks again.
        const estimated = estimateTokens(summaryNote(summary)) + fold.kept
        if (estimated > budget) return yield* Effect.fail(over(estimated, "with a summary too long to fit beside the turns that stay: it was not stored"))
        yield* session.append(summarized(fold.through, summary))
        const again = yield* planned(session)
        return yield* Match.valueTags(again, {
          Fits: (fits) => Effect.succeed(fits),
          Over: (it) => Effect.fail(over(it.estimatedTokens)),
          Fold: (it) => Effect.fail(over(it.estimatedTokens)), // one summary per context, never a second
        })
      }),
    })
    return paired(fitted.messages).map(promptMessage)
  }),
})
```

The strategies still to come sit behind the same call: results replaced by
pointers with a tool that reads them back, or facts retrieved from an index
built from the journal.

A journal outlives the code that wrote it. A plugin reads it with a
vocabulary: plain data, the prefixes it answers for and the record names it
knows. A vocabulary answers for core's records (`core.`,
`KERNEL_VOCABULARY`) and for those under its plugin's prefix (`vocabularyOf`,
`readJournal`); a memory reads the conversation through the conversation's
vocabulary (`vocabularyOf(name, own, CONVERSATION_VOCABULARY)`). A record
it does not know is passed over when the record says it may be skipped, and
refused with `UnknownRecord` when it may not. A record under another
plugin's prefix is not its concern. The memory kit holds a memory to the
conversation's vocabulary: an unknown record of the conversation that may not be
skipped is refused (`unknown-conversation-refused`), which a memory reading
its own prefix alone would pass.

A plugin that changes the shape of a record it stores gives the new shape a
new name. A journal written before then still holds the old name, which the
plugin's vocabulary no longer knows: it is refused, or passed over when it
may be skipped. That is the rule above, with nothing added; a plugin cannot
change the journal's format, which is core's.

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

A contract with rules a plugin can break ships with its kit: the contract as
runnable checks, each with an id that its failures name, and each shown to
fail on a careless plugin written for it.

| Contract | Kit | Or why none |
|---|---|---|
| `JournalStorage` | `journalStorageConformance` | |
| `Sessions` | `sessionsConformance` | |
| `Memory` | `memoryConformance`; a wrapper of it, `memoryWrapperConformance` | |
| `Summarizer` | `summarizerConformance` | |
| `Core` | none | core has one implementation, `kernel()`, held by its own tests |
| `Inbox` | none | one stock plugin, held by its own tests; a kit comes with a second plugin |
| `CurrentTurn` | none | a value the loop provides, with nothing to check beyond its type |
| render (`viewsOf`) and `callTool` | none | pure functions, not contracts a plugin implements: unit tests hold them |

## What the first cut leaves out, and the order it returns

This cut keeps journals in the process, and has one session plugin and three
memories. A host's turn runs tools itself, through Effect AI's `Toolkit`
(see "Tools: the turn becomes a loop"). What follows returns in this order.

1. **Pointer memories.** Results replaced by pointers with a tool that
   reads them back, behind `memory.context`. (A summary of old turns has
   returned: `summaryMemory`.)
2. **Views beyond the first four.** A client draws `Text`, `List`, `Table`
   and `Card`; a richer vocabulary, or one a host extends, returns when a
   client needs it. (What the UI shows has returned: a record tagged `ui`,
   `viewsOf`.)
3. **Durable stores and crash recovery**, on the seam the fold of the
   journal already gives.

## Open questions

Decisions not yet made, or that wait for a second use, recorded here so they
are not made by accident.

- **The view vocabulary** (ADR 0009). `Text`, `List`, `Table` and `Card`,
  closed. Open: whether hosts add shapes of their own, and whether a view
  bounds its size in its schema rather than in the tool that makes it.
- **Where `hostNote` and `framed` live.** They are the memory contract's,
  because a memory was the first kernel code to frame text; tools and hosts
  frame text too. They are copies of core's root helpers, which the kernel
  does not import.
- **What a draft's data holds is checked by the compiler alone.** Untyped
  code can append data its definition does not describe; it is found when
  the record is read (a listener fails, a fold passes over it).
- **`Core.publish` takes any event.** A plugin can publish a stored event
  that was never stored: only the session plugin should.
- **Who may write under a prefix.** Only `core.` is refused to a turn's
  body. A body can append under another plugin's prefix.
- **`PluginFailure` is any tagged error with a message**, so a host cannot
  handle a memory's or an inbox turn's failures exhaustively.
- **`paired` pairs by set, not by order.** A result stored before the
  message that asked for it is sent before its call.
- **Two `kernel()` layers give two cores**, silently: the one nearer the
  consumer wins.

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
