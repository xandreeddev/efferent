---
title: Tools & toolkits
description: Tools are @effect/ai Tool.make definitions bundled into a Toolkit; their handlers are the seam where runtime dependencies enter.
sidebar:
  label: Tools & toolkits
  order: 3
---

A tool is a plain [`@effect/ai`](https://effect.website/docs/ai/introduction/) `Tool.make` definition;
a [`Toolkit`](https://effect.website) is a bundle of them. efferent adds no tool abstraction of its own —
your tools and the SDK's are the same kind of thing.

## The two halves of a tool

- **Definition** — pure data: a name, a description, a `parameters` schema, an object `success` schema,
  a shared `failure` schema, and `failureMode: "return"`. This is what the model sees.
- **Handler** — an `Effect`, bound to the tool's name in a `Layer`. This is the **dependency seam**:
  the handler resolves ports (`FileSystem`, `Shell`, …) — at *layer-build time*, since handlers
  themselves are `R = never` — and you provide that layer at the [composition
  root](/docs/guides/composition-root/).

```ts
const toolkit = Toolkit.make(ReadFile, Bash, Grep)   // bundle
const handlers = toolkit.toLayer(/* handlers, or an Effect that builds them */)
```

Because the handler resolves ports from context, the same tool definition runs with real IO in the app
and with stubs in a test — you change only the layer you provide. Full walkthrough:
[Define a tool](/docs/guides/define-a-tool/).

## The coding toolkit

The bundled coding agent ships a toolkit of `read_file`, `write_file`, `edit_file`, `Bash`, `grep`,
`glob`, `ls`, `web_fetch`, `search_web`, `run_agent`, and `update_plan`, backed by the `FileSystem`,
`Shell`, `Http`, and `WebSearch` ports. It's just an `AgentConfig` like any other —
see [the coding agent](/docs/guides/coding-agent/).

:::caution[Two rules providers enforce]
- **`success` must be an object** and **every tool needs ≥1 parameter** — a parameterless tool or a
  scalar success breaks Gemini.
- Some lowercase names (`bash`, `web_search`, `computer`) are **reserved** by Anthropic for built-in
  server-side tools and get rerouted away from your handler. efferent uses **`Bash`** and **`search_web`**
  to dodge this.
:::
