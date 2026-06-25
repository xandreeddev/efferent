---
title: The bundled coding agent
description: How efferent assembles its batteries-included coding agent — coderAgentConfig + a scope runtime — and how to reuse the pattern.
sidebar:
  label: The coding agent
  order: 5
---

The [dice agent](/docs/your-first-agent/) shows the bare primitives. efferent's own coding agent is
the *batteries-included* counterpart — a full file/shell/web toolkit, a scoped sandbox, and sub-agents —
assembled from the **same `AgentConfig` shape**. The reusable scope machinery —
**`buildScopeRuntime`** and **`codingToolkit`** — now lives in **`@xandreed/sdk-core`**
(`sdk-core/usecases/`); only the driver-specific bundling (`coderAgentConfig`, the coder system prompt)
stays in the `@xandreed/code` package, where the runtime concerns belong. The pattern is worth knowing.

## Two pieces

**`buildScopeRuntime`** (`@xandreed/sdk-core`) stands up the toolkit and its handler layer for a
workspace scope:

```ts
const runtime = buildScopeRuntime(
  rootScope,                                   // the workspace root (a Scope)
  { skills, allowBash: true },
  hooks,
)
// runtime.toolkit       — base coding tools + the generic run_agent tool
// runtime.handlerLayer  — handlers wired to FileSystem / Shell / Http / WebSearch / ContextTreeStore / Approval
```

**`coderAgentConfig`** bundles that toolkit with the coder system prompt into an `AgentConfig`:

```ts
export const coderAgentConfig = (
  rootScope: Scope,
  runtime: ScopeRuntime,
  prompt?: Prompt,
  opts?: { readonly compression?: CompressionPolicy },
): AgentConfig<Record<string, Tool.Any>>
```

## Putting it together

```ts
const runtime = buildScopeRuntime(rootScope, { skills, allowBash }, hooks)
const prompt = coderPrompt(cwd, new Date(), skills)

const result = yield* runAgent(
  coderAgentConfig(rootScope, runtime, prompt),
  conversationId,
  userPrompt,
  hooks,
  cwd,
).pipe(Effect.provide(runtime.handlerLayer))   // <- the handler layer is the seam
```

The `handlerLayer` is where `FileSystem`, `Shell`, approval, and the context-tree store enter — provided
*alongside* your [composition root](/docs/guides/composition-root/). Because it's the same
`AgentConfig` contract, the coding agent runs identically in the TUI, in one-shot `print` mode, in `json`
mode, and in CI — only the driver around it differs.

The `Scope` (`rootDir` + `displayRoot` + `SCOPE.md` body + write-enforcement) is what confines tool writes
and powers the [sub-agent sandbox](/docs/concepts/sub-agents/).
