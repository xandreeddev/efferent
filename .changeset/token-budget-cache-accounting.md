---
"@xandreed/sdk-core": patch
"efferent": patch
---

fix(budget): the sub-agent token budget no longer bills cached context at full price — and a research subtree can't bleed into implementation.

A real run (`investigate … and propose a plan to fix`) exhausted the 4M per-turn pool on ~500K of actual work, then the research-coordinator did the "fix" itself on inline coders that starved. Investigation traced it to three compounding bugs:

- **Accounting (root cause).** `usageCost = inputTokens + outputTokens` counted the *whole* re-sent prompt every turn, including the cached prefix. The run's recorded usage was **97.7% cache reads** — and a multi-turn fleet re-sends its (byte-stable, cached) context every turn, so the pool drained ~8× faster than the provider actually bills. efferent's cache-prefix design was being *penalized*. Now cache reads are billed at `CACHE_READ_COST_FACTOR` (0.1×, matching provider pricing): `usageCost = (input − cacheRead) + cacheRead×0.1 + output`. A genuine runaway (new context/fetches/output) still trips the brake; only efficient cache reuse stops being taxed.
- **Exhaustion message.** A drained pool told the model to *"do the remaining work yourself instead of spawning"* — which collapsed an entire fleet onto the root/coordinator. It now says to wrap up, return the best partial result, and note remaining work for the caller to pick up in a fresh turn (with its own budget) — never to switch to doing it inline.
- **Research role boundary.** A `research-coordinator` (read-only by design) could still spawn write-capable inline workers via `run_agent({ instructions, tools })` — or a bare `run_agent({ folder, task })`, which silently got the *full* coding toolkit. A research subtree is now marked on `RunContext`, and every spawn inside it is constrained to read-only (mutating tools stripped; a bare spawn becomes a read-only research worker) and a code-`coordinator` spawn is refused — so "fix the findings" returns as a recommendation for the root to implement.

The per-turn pool was already per-user-message (not per-conversation); the felt "ran out for the whole conversation" was the accounting bug exhausting the per-turn pool ~8× early.
