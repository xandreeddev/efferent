# Efferent

**Compose the agent. Own the harness.**

An Effect-native agent framework for Node 24 and Bun. A small kernel holds
what every agent has (a journal, sessions and events), and every other part
is a plain Effect layer you can replace: memory, tools, approvals, skills,
background tasks, a workspace with a shell and a search, knowledge kept by a
curator and recalled by words and by meaning, model providers that charge a
spend ledger, media and telemetry. There is no loop to configure: your
program is the loop, written over two functions that each store what they
produce, `modelAnswer` and `callTool`.

**[Documentation](https://xandreeddev.github.io/efferent/docs/)** · [Learn](https://xandreeddev.github.io/efferent/learn/) · [The guide](docs/kernel.md) · [The decisions](docs/adr/) · [Changelog](CHANGELOG.md)

## Install

```sh
npm install effect @xandreed/core @xandreed/sdk
```

`effect` (4.x) and `@xandreed/core` are peer dependencies: your code and the
packages share one copy of each. The browser-safe kernel is `@xandreed/core`
and `@xandreed/sdk`; the parts that need Node or Bun (journals on a disk,
model providers, a disk workspace and a shell, a media folder, OTLP export)
are on `@xandreed/sdk/node`.
Workspace packages share version `0.22.0`.

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
  // OpenAI's reasoning models take the cap as max_completion_tokens and refuse the older max_tokens.
  outputField: "max_completion_tokens",
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

Run it with the model's key in the environment, on Node 24 or Bun, from a
file of your own that ends with:

```ts
const reply = await Effect.runPromise(program(process.argv[2] ?? "What is 2 + 3?").pipe(Effect.provide(agent(".agent"))))
console.log(reply)
```

Each run takes the folder (one writer at a time), closes a turn a killed
run left open, and goes on with the same conversation: ask "And times 4?"
next and the model reads the first turn back. Every part is a layer you swap:
`sqliteJournal` for the folder, `anthropicModel` for the endpoint,
`summaryMemory` or `withKnowledge` for the window. A test runs the same
program over `scriptedModel`, which calls no provider.

## Learn more

- [Learn](https://xandreeddev.github.io/efferent/learn/): build an agent on the kernel, lesson by lesson, in your browser
- [The guide](docs/kernel.md): how a host writes its turn, every contract and stock plugin, and why each is shaped as it is
- [The decisions](docs/adr/): one record per architectural decision
- [Evaluations](docs/composable-evaluations.md): tasks, trials, graders and suites, with a CLI and exporters

## Packages

| Package | What it is |
| --- | --- |
| `@xandreed/core` | The kernel's core: ids, messages, events, the journal and sessions contracts, and the spend ledger, with their conformance kits |
| `@xandreed/sdk` | The workflow contracts and their stock plugins, each an Effect layer; `@xandreed/sdk/node` holds the parts that need Node or Bun |
| `@xandreed/evals` | Evaluations: tasks, trials, graders, gates and suites over one spend ledger |
| `@xandreed/evals-cli` | `efferent-eval`, the command that runs and reports them |
| `@xandreed/evals-langfuse`, `@xandreed/evals-langsmith` | Exporters of a run to Langfuse and LangSmith |

The engine of releases up to 0.22.0 (`Agent.define`, `@xandreed/runtime`,
`@xandreed/process-host` and the `@xandreed/plugin-*` packages) is no longer
published. Those packages stay on npm at 0.22.0;
[the changelog](CHANGELOG.md) and the docs site's
[list](https://xandreeddev.github.io/efferent/docs/no-longer-published/) say
what replaces each.

## Contributing

```sh
bun install
bun run verify
```

See [contributing](CONTRIBUTING.md) for the full checks and how releases work.

MIT · Xand Reed
