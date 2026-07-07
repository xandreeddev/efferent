---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": minor
---

BREAKING — the old self-improving harness is excised (the `docs/agents/` R1
decision: an LLM judge where a deterministic gate belongs). Removed from
sdk-core: the `Verifier` port, `gateLoop`, the driveLoop post-run Opus gate,
`distill`/`autoDistill`/`efficiencyGate`/`persistArtifact`, the `Distillation`
and `Directive` entities, the `gate`/`learned` AgentEvents, the
`onGateResult` hook, `GateVerdictRecord` + the store's gate-verdict methods,
and the `autoLoop`/`autoDistill`/`maxLoopAttempts` settings. Removed from
adapters: `ClaudeHeadlessVerifierLive`/`UnavailableVerifierLive` (migrations
stay; `gate_verdicts` is read-only history). Removed from the CLI: `efferent
distill`, `:goal`/`:verify`, the directive plumbing (protocol + routes), and
the turn-boundary distiller on every mode. `.efferent/skills|memory|
CONSTRAINTS.md` still load — as user-curated assets. Deterministic
verification lives on the new agent line (foundry's forge — `bun run smith`).
