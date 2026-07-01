---
"@xandreed/sdk-core": minor
"efferent": minor
"@xandreed/sdk-adapters": patch
"@xandreed/evals": patch
---

Make the swarm verify its own work before delivering, instead of shipping non-compiling code.

The multi-agent fleet could report a coding task "done" on code that didn't even type-check: the project's own conventions (`AGENT.md`, e.g. "run the project's checks") only reached the ROOT prompt, never the sub-agents that write code; the specialists' instructions made verification optional ("run the checks you can"); and the independent Opus verifier ran read-only (`--permission-mode plan`) so it structurally couldn't run a build, rubber-stamping a prose summary.

- **Sub-agents inherit the project's conventions.** The pre-rendered instruction files (`AGENT.md` / `CONSTRAINTS.md`) now thread into every spawned sub-agent's prompt, so a coder learns *this* project's build/verify command and hard rules — the general mechanism (à la injecting the repo's guidance into every agent), project-specific content, no hardcoded command.
- **"Done" means verified working.** The sub-agent return contract and the specialist/coordinator/architect prompts now require running the project's own checks and fixing failures before returning; the architect must actually run the checks for a `SOUND` verdict.
- **The verifier can actually verify.** The Opus deliverable gate now runs the repo's read-only checks (Bash allowed, edits denied) instead of judging prose in read-only mode, and the per-coordinator gate aggregates its whole subtree's changed files so a nested writer is seen as code, not prose.
- **A new `swarm-compile` eval** type-checks the fleet's produced code in-process (`runScenario`'s `typecheck` option), the discriminator `bun test` can't provide.
