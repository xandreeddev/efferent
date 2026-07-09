---
title: Engine — the kernel
description: The pure agent kernel — the loop as an Effect.iterate fold, ports as Context.Tag services, one persisted session chassis.
---

`@xandreed/engine` is the agent kernel: pure Effect, runtime dependencies
`effect` + `@effect/ai` and **nothing else** — no provider SDKs, no IO, no
node builtins. Every capability an agent needs from outside is a port.

The division of labor with [foundry](/docs/concepts/foundry) is strict:
foundry is the **outer** harness (gates, the forge loop — it declares
victory); the engine is the **inner** agent (model interface, context, tools,
one run). No gates live inside the engine.

## The loop

`runLoop` is an `Effect.iterate` fold. Each turn maps the message buffer to a
prompt, calls the provider-agnostic `LanguageModel.generateText` (tool calls
resolve inside the step — their handlers are your Effects), appends the
response as the new tail, and re-enters until the model stops requesting
tools, the step cap is hit, or a breaker fires:

- **Malformed responses recover** — a hallucinated tool name or wrong-shaped
  params comes back as a bounded corrective turn, never a dead run.
- **The degenerate-loop breaker** — a turn whose tool results repeat with no
  progress gets one nudge, then a forced stop with a typed partial outcome.
- **Incremental persistence** — every turn's messages land in the store the
  moment they exist, so a crash loses nothing past the last completed turn.
- **Within-run compaction** — past a token threshold the buffer folds into a
  summary handoff plus the newest turns (the cut never splits a tool
  call/result pair), and the store checkpoints the covered position. Best
  effort: any failure just continues unfolded.

Every turn also persists **what produced it**: the resolved
`provider:modelId` and the token usage are stamped onto the assistant
message, and the reasoning the model emitted is kept as a first-class part —
the trail answers "which model said this, thinking what, at what cost"
from the database alone.

## Ports

`ConversationStore` · `SettingsStore` · `AuthStore` · `FileSystem` · `Shell` ·
`UtilityLlm` · `McpClient` — each a `Context.Tag` service with
`Schema.TaggedError` errors. [Providers](/docs/concepts/providers) implements
them; agents compose the layers at their `main.ts` edge.

## External tools — MCP by progressive disclosure

The kernel's MCP bridge turns any number of user-configured servers into a
**constant two-tool cost**: the prompt lists `server/tool — description`
(names only), `mcp_describe` reveals one tool's real input schema on demand,
and `mcp_call` invokes it. Tool-level failures, transport errors, and unknown
names all return as data the loop's corrective machinery handles — never a
dead turn. Configuration (`mcpServers` in `.efferent/config.json`) is the
consent boundary: no config, no processes.

## The session chassis

`makeSession` gives every agent the same spine: ONE persisted conversation,
an append-only sequence-numbered event ledger, serialized sends (a second
send while a turn runs is refused, not queued silently), interrupt, and a
replay-then-live subscribe — a client that connects mid-run folds the ledger
through the same reducer the live path uses, so replay ≡ live by
construction.
