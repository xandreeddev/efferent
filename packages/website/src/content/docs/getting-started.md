---
title: Getting started
description: Install the Efferent kernel and write a first agent in Node, its loop your own program.
---

# Getting started

Efferent is an Effect-native agent framework for Node 24 and Bun. A small
kernel holds what every agent has (a journal, sessions and events), and every
other part is a plain Effect layer you can replace. There is no loop to
configure: your program is the loop.

## Install

```sh
npm install effect @xandreed/core @xandreed/sdk
```

Install `effect` (4.0.7 or a later 4.x) and `@xandreed/core` beside the sdk:
the packages and your code share one copy of each. `@xandreed/core` and
`@xandreed/sdk` run anywhere, a browser included; the parts that need Node or
Bun (journals on a disk, model providers, a disk workspace and a shell, a
media folder, OTLP export) are on `@xandreed/sdk/node`.

This guide follows version `0.22.0`.

## A first program

An agent that keeps its conversation in a folder, asks a model that charges a
ledger capped at ten cents, sends what fits a memory's budget, and runs a
tool when the model asks for one:

```ts
import { Config, Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { kernel, modelSpendMemory, Sessions, userMessage } from "@xandreed/core"
import type { SessionId } from "@xandreed/core"
import { callTool, Memory, modelAnswer, recoverTurns, sessions, windowMemory } from "@xandreed/sdk"
import { directoryJournal, openAiCompatibleModel } from "@xandreed/sdk/node"

// A tool: what it does, what it takes and what it gives. It is code, offered with every call and never stored.
const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

// The model, over any OpenAI-compatible endpoint, its key read from the environment. Each call holds its worst
// case in the ledger before it is sent and is settled at what it cost: together they stay under ten cents.
const MODEL = "gpt-5-mini"
const model = Layer.unwrap(Effect.map(Config.Redacted("OPENAI_API_KEY"), (apiKey) => openAiCompatibleModel({
  model: MODEL,
  baseUrl: "https://api.openai.com/v1",
  apiKey,
  maxOutputTokens: 1024,
  spend: { prices: { [MODEL]: { input: 0.25, output: 2 } }, caps: { total: 0.1 } },
})))

// One turn, the host's own loop: the message is stored, then the model answers or asks for tools, whose results are
// stored before it is asked again. `modelAnswer` and `callTool` each store what they produce.
const turn = (conversation: SessionId, message: string) => Effect.scoped(Effect.gen(function* () {
  const memory = yield* Memory
  const toolkit = yield* tools
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  for (let step = 1; step <= 4; step++) {
    const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...(yield* memory.context(session))])
    const stream = LanguageModel.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" })
    const answer = yield* modelAnswer(stream, session)
    if (answer.toolCalls.length === 0) return answer.text
    for (const call of answer.toolCalls) yield* callTool(toolkit, call, session)
  }
  return "I stopped after 4 steps."
}))

// The program: close a turn a killed run left open, then go on with the conversation the folder holds, or start one.
const program = (message: string) => Effect.gen(function* () {
  yield* recoverTurns
  const conversations = yield* Sessions
  const [first] = yield* conversations.list
  const conversation = first === undefined ? yield* conversations.create({ owner: "first-program" }) : first.id
  return yield* turn(conversation, message)
})

// The parts, each a layer whose type says what it needs. The journal is a folder, so the next run remembers.
const agent = (directory: string) => Layer.mergeAll(windowMemory({ budgetTokens: 8_000 }), toolsLive, model).pipe(
  Layer.provideMerge(sessions()),
  Layer.provideMerge(directoryJournal({ directory })),
  Layer.provideMerge(Layer.merge(kernel(), modelSpendMemory)),
)
```

Run it with the model's key in the environment (`OPENAI_API_KEY`), on Node 24
or Bun, from a file of your own that ends with:

```ts
const reply = await Effect.runPromise(program(process.argv[2] ?? "What is 2 + 3?").pipe(Effect.provide(agent(".agent"))))
console.log(reply)
```

What each part does:

- **The journal** (`directoryJournal`) keeps every session in the folder, a
  line per record, durable when an append returns. Its layer takes the folder
  as it is built and refuses it while another live process holds it.
- **Sessions** (`sessions()`) own turns: `open` starts one in the caller's
  scope and closes it with the scope's outcome. `recoverTurns` closes a turn a
  killed run left open, so the conversation goes on.
- **The model** (`openAiCompatibleModel`) is Effect AI's `LanguageModel`. It
  needs `ModelSpend`, the ledger, which `modelSpendMemory` provides: a call
  over the cap, or of a model with no price, is refused before it is sent.
- **The memory** (`windowMemory`) builds each request's messages from the
  journal, dropping whole turns, oldest first, past its budget. It stores
  nothing.
- **The loop** is `turn`: `modelAnswer` reads the model's stream and stores
  its answer with the tool calls it made; `callTool` runs one call and stores
  its result, a failure included, which the model reads and goes on from.

Each part is replaced by providing another layer: `sqliteJournal` for the
folder, `anthropicModel` for the endpoint, `summaryMemory` or `withKnowledge`
for the window, `autoApprove` before a tool that asks with `approve`. A test
runs the same program over `scriptedModel`, which calls no provider, and reads
what it did back with `turnsOf`.

## Where to go next

- **[The guide](/docs/guide/)**: how a host writes its turn, every contract
  and stock plugin, and why each is shaped as it is. Its examples are tests
  that run.
- **[The learn track](/learn/)**: a working agent built one lesson at a time,
  in your browser, with a model that runs on your own machine.
- **[The decisions](/docs/decisions/)**: one record per architectural
  decision.
- **[Evals](/docs/concepts/evals/)**: tasks, trials, graders and suites.

Coming from 0.22.0? The engine of earlier releases (`Agent.define`, the
runtime, the process host and the `@xandreed/plugin-*` packages) is no longer
published: [Packages that are no longer published](/docs/no-longer-published/)
says what replaces each.
