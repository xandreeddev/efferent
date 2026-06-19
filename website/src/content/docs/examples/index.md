---
title: Examples
description: Runnable, single-file agents that back the docs — each rendered from its real source in the repo's examples/ folder.
sidebar:
  label: Overview
  order: 0
---

Every example is **one runnable file** in the repo's
[`examples/`](https://github.com/xandreeddev/efferent/tree/main/examples) folder. The pages here render
the *actual* source, so what you read is what runs. Clone the repo, `bun install`, and go:

```sh
cd examples
bun install
bunx tsc -p tsconfig.json     # typecheck them all (no credential needed)
bun diceAgent.ts              # run one (needs a credential — see Getting started)
```

| Example | Shows | Page |
| --- | --- | --- |
| `diceAgent.ts` | The minimal agent: one tool → toolkit → `AgentConfig` → `runAgent`. | [Dice agent](/docs/examples/dice-agent/) |
| `calcAgent.ts` | A multi-tool toolkit (`add`, `multiply`). | [Calculator agent](/docs/examples/calc-agent/) |
| `fileAgent.ts` | A tool whose handler uses the `FileSystem` port — the dependency seam. | [File agent](/docs/examples/file-agent/) |
| `hooksAgent.ts` | Observing and steering the loop with `AgentHooks`. | [Hooks agent](/docs/examples/hooks-agent/) |
| `compressionAgent.ts` | Customizing context compression with a `CompressionPolicy`. | [Compression agent](/docs/examples/compression-agent/) |

:::tip
Running an example needs a provider credential in `~/.efferent/auth.json` — install the CLI, run
`efferent`, and `:login` once (see [Getting started](/docs/getting-started/)). Typechecking needs
nothing.
:::
