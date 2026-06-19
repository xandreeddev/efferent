---
title: Define a tool
description: The Tool.make contract efferent expects — object success, shared failure, failureMode return — plus the provider naming gotchas and how handler failures stay graceful.
sidebar:
  label: Define a tool
  order: 1
---

Tools are plain [`@effect/ai`](https://effect.website/docs/ai/introduction/) `Tool.make` definitions.
efferent expects a specific shape so failures stay graceful and providers stay happy.

## The contract

```ts
import { Tool, Schema } from "@effect/ai"

const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

const ReadFile = Tool.make("read_file", {
  description: "Read a UTF-8 file and return its contents.",
  parameters: {
    path: Schema.String.annotations({ description: "Path relative to the workspace." }),
  },
  success: Schema.Struct({ content: Schema.String }), // MUST be an object/struct
  failure: Failure,                                    // a shared failure shape
  failureMode: "return",                               // failures → tool result, not a thrown turn
})
```

Three rules, learned the hard way against real providers:

- **`success` must be an object** (a `Schema.Struct`), not a bare scalar.
- **Every tool needs at least one parameter.** A parameterless tool breaks Gemini.
- **`failureMode: "return"`** makes a handler failure come back to the model as a *tool result*
  (`{ isFailure: true, … }`) instead of aborting the whole turn. The model reads the error and adjusts.

## Naming gotchas

Some lowercase names are **reserved by providers** for built-in server-side tools (Anthropic claims
`bash`, `web_search`, `computer`; the SDK reroutes them and your handler never runs). efferent sidesteps
this: its shell tool is **`Bash`** (capital B) and its search is **`search_web`** (reversed). Pick names
that don't collide.

:::caution
`@effect/ai` decodes a tool call's parameters **before** your handler runs. A wrong-shaped or
hallucinated call fails with `AiError.MalformedOutput`, which `failureMode` can't catch. The loop's
`recoverMalformedToolCalls` converts that into an ordinary tool result so the turn survives — but keep
your parameter schema permissive enough to decode, then validate inside the handler. (efferent's
`edit_file` accepts both an `edits: [...]` array and a flat single edit for exactly this reason.)
:::

## The handler is the dependency seam

A tool's *definition* is pure data; its *handler* is where runtime dependencies enter. You bind handlers
in a `Layer` and provide it at the composition root:

```ts
const handlers = toolkit.toLayer(
  toolkit.of({
    read_file: ({ path }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem        // a port — injected when the layer is provided
        const { content } = yield* fs.read(path)
        return { content }
      }).pipe(
        Effect.catchAll((e) => Effect.fail({ error: "ReadFailed", message: String(e) })),
      ),
  }),
)
```

Because the handler resolves ports from context, the *same* tool definition runs with real IO in the
app and with stubs in a test — you change only the layer you provide. See
[Your first agent](/efferent/your-first-agent/) for the end-to-end build and
[the composition root](/efferent/guides/composition-root/) for what to provide.
