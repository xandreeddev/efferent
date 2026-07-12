# @xandreed/engine

**The agent kernel of the new line** (the only substrate besides foundry that
new agents may build on — see the parent CLAUDE.md and `docs/agents/`). Pure
Effect: runtime deps are `effect` + `@effect/ai` (provider-agnostic) and
NOTHING else — no provider SDKs, no IO, no node builtins. Every capability an
agent needs from outside is a port.

The division of labor with foundry is strict: **foundry is the OUTER harness**
(the forge loop, gates, deterministic feedback — it declares victory), the
**engine is the INNER agent** (model interface, context, tools, one run). No
gates live inside the engine; a capable agent produces work, foundry verifies
it.

## Layout

```
src/
├── domain/    Message (AgentMessage/ConversationId/Checkpoint/AgentResult),
│              Failure (the failureMode:"return" shape), TokenUsage,
│              ModelSelection ("<provider>:<modelId>"), ModelCallPolicy
│              (agent-pinned effort/output budget), LoopEvent (the ONE
│              event union drivers render — no callback records)
├── ports/     Context.Tag services + their Schema.TaggedErrors:
│              ConversationStore · SettingsStore · AuthStore · FileSystem ·
│              Shell · UtilityLlm
├── loop/      mapping (AgentMessage ↔ @effect/ai encodings; provider-blob
│              round-trip, deterministic tool-call ids, the Anthropic usage
│              fold) · loop (runLoop — an Effect.iterate fold; malformed
│              responses — hallucinated names, wrong-shaped params — recover
│              via bounded corrective feedback; the degenerate-loop breaker) ·
│              runAgent (store-integrated turn: active window + fold summary,
│              incremental tail persistence; scopes CurrentModelCallPolicy so
│              dedicated profiles reach the provider wire)
└── session/   chassis (makeSession — ONE persisted conversation + an
│              append-only seq'd event ledger; serialized send; interrupt;
│              replay-then-live subscribe). Every driver uses this; no
│              hand-rolled copies.
```

## Rules

- ZERO-entry ratchet baseline: no `let`/loops/nullable-returns/tag-switches/
  `as any`/try-catch in `src/**` — state is a fold (`Effect.iterate`,
  `reduce`), absence is `Option`, errors are `Schema.TaggedError` values.
- Boundaries-gated: the engine imports NOTHING internal. Providers/agents
  import the engine, never the reverse.
- Tool failures are data: toolkits use the shared `Failure` struct with
  `failureMode: "return"`. A wrong-shaped call or hallucinated tool name is
  recovered by the loop (corrective feedback, bounded), never a dead turn.
- Events over callbacks: the loop takes ONE `onEvent` sink over the
  `LoopEvent` union; products extend the vocabulary with their own
  `{ type: ... }` events through the chassis.

## Tests

`bun test packages/engine` — key-free: the mapping round-trip, the loop
against a scripted `LanguageModel.make` provider (tool resolution, malformed
recovery, breaker, step cap), the chassis contract (serialized send,
replay-then-live dedup, error containment).
