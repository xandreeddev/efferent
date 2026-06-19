---
title: Ports
description: Every Context.Tag service the domain depends on, with its key methods.
sidebar:
  label: Ports
  order: 5
---

Ports are `Context.Tag` services in `@xandreed/sdk-core/ports/`. The domain programs against these;
[adapters](/docs/reference/adapters/) provide them. Each port ships its tagged errors next to it.

| Port | Purpose | Key methods |
| --- | --- | --- |
| `ConversationStore` | Message-history persistence + handoff checkpoints. | `create`, `ensure`, `append`, `list`, `listActive`, `checkpoint`, `getLatestCheckpoint`, `setTitle`, `listByWorkspace` |
| `ContextTreeStore` | The branching [sub-agent](/docs/concepts/sub-agents/) tree. | `spawn`, `append`, `listMessages`, `recordReturn`, `get`, `listTree`, `drop` |
| `FileSystem` | Workspace file access. | `read`, `write`, `exists`, `list`, `glob` |
| `Shell` | Command execution. | `exec({ command, cwd, timeoutMs? })` |
| `Http` | HTTP GET (the `web_fetch` tool). | `get(url, options?)` |
| `WebSearch` | Provider-grounded search (`search_web`). | `search(query) → { answer, sources }` |
| `AuthStore` | Per-provider credentials. | `get`, `resolveKey`, `setApiKey`, `setOAuth`, `setLocal`, `remove`, `all` |
| `SettingsStore` | Layered config (defaults < global < local). | `get`, `global`, `update`, `load` |
| `ModelRegistry` | Live model selection + catalogue. | `current`, `list`, `select` |
| `LlmInfo` | Active-model metadata. | `metadata() → { modelId, contextWindow }` |
| `UtilityLlm` | Fast-tier one-shot completions. | `complete(prompt, { role? }) → { text, usage? }` |
| `Approval` | Bash-command approval gate. | `request(req) → { kind: "allow" \| "deny", scope?, reason? }` |
| `AuthFlow` | OAuth (PKCE) protocol. | `supportsOAuth`, `begin`, `exchange`, `parseRedirect` |

Programming against a port is just `yield* TheTag`:

```ts
const fs = yield* FileSystem
const { content } = yield* fs.read("README.md")
```

See [architecture](/docs/concepts/architecture/) for how ports, adapters, and use cases fit together.
