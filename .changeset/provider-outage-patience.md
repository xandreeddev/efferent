---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"efferent": minor
---

Survive provider outages like Claude Code: the patient retry ladder, empty-response rejection, and no-lost-work persistence.

The July 2 forensics: the opencode gateway melted for ~2.5h (429s, 503s, silent 120s hangs). A fleet finished all 7 audits — then the root's synthesis turn burned its 3 fast retries (4×120s timeouts, ~8 min) and died, so the deliverable was never shown; a manual node resume died the same way and lost its 2 completed turns; and two agents "completed" on HTTP-200-empty responses (`turn N: unknown · 0 tok`), recording mid-thought sentences as deliverables.

Four fixes:

- **The patient ladder** (`retryableLlm`): after the fast retries, a transient failure keeps retrying on slow rungs (15s → 30s → 60s…) bounded by the run's `interactionPolicy` — interactive 30 min (visible "provider down 6m — retrying" in the rail/health; Esc cancels), headless 10 min, bare calls (evals) unchanged. Helper tiers (titles, digests, approval judge, web search) use `retryableLlmFast` so a garnish can never park a turn.
- **Empty responses are errors**: the router rejects a response with no text, no tool call, no reasoning as a transient failure that rides the same ladder, instead of fake-completing the turn.
- **Failover on exhausted transients**: `withFailover` now also fires when the ladder runs dry (provider genuinely down) — one shot on the configured fallback selection, loudly annotated.
- **No lost work**: spawned/resumed sub-agent runs persist their tail incrementally per turn (`onTail`), so a run that dies mid-flight keeps every completed turn. Timeout errors name the `provider:model`.
