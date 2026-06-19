# efferent SDK examples

Minimal, single-file agents built on `@xandreed/sdk-core` + `@xandreed/sdk-adapters`. Each file is a
complete, runnable agent and backs a page on the [docs site](https://xandreeddev.github.io/efferent/).

| File | Shows |
| --- | --- |
| `diceAgent.ts` | The smallest real agent: one tool → toolkit → `AgentConfig` → `runAgent`. |
| `calcAgent.ts` | A multi-tool toolkit (`add`, `multiply`). |
| `fileAgent.ts` | A tool whose handler uses the `FileSystem` **port** — the dependency seam. |
| `hooksAgent.ts` | Observing and steering the loop with `AgentHooks` (incl. blocking a tool call). |
| `compressionAgent.ts` | Customizing context compression with a `CompressionPolicy`. |

## Run

From the repo root, `bun install` once. Running an example needs a provider credential in
`~/.efferent/auth.json` — install the CLI (`npm i -g efferent`), run `efferent`, and `:login` once.

```sh
bun examples/diceAgent.ts
# or, from this folder, via the scripts:
cd examples
bun run dice          # calc | file | hooks | compression
```

## Typecheck

No credential needed — this just type-checks every example against the SDK:

```sh
cd examples
bun run typecheck     # tsc -p tsconfig.json --noEmit
```
