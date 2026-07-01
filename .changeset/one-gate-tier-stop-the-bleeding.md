---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": patch
"efferent": patch
---

Stop the fleet bleeding: one gate tier, scoped interrupts, work-preserving watchdog, kimi thinking fix, uniform LLM timeouts.

Run forensics over ten days of fleet runs (376 sub-agent nodes, 29% error rate — 56% on the worst day) traced most failures to five mechanisms, all fixed here:

- **The per-coordinator gate tier is deleted.** A lead's structural gate ran settle polls plus a `claude -p` Opus subprocess (30-min cap) inside the sub-agent stall watchdog's 180s no-progress window, with no progress stamps — so finished leads were routinely killed mid-gate and recorded `[stalled]`, discarding completed, test-green work. Gating is now ONE tier, at the root (`driveLoop`), judging the aggregate deliverable; `isLead` and the lead-gate block are gone, and `gateOnce` is a pure decision requiring only `Verifier`.
- **The exit finalizer preserves produced work.** An interrupted/stalled run keeps its last assistant text, `filesChanged`, and usage instead of an empty `[stalled]`/`[interrupted]` error; a stall AFTER text is recorded as ok-with-note (the work survives, the caveat is attached).
- **Fleet kills are subtree-scoped.** New `AgentBus.interruptSubtree(parentKey)`: the headless deadline and Esc in the in-process TUI now interrupt only THAT run's descendants — `interruptAll` (which killed every fleet on the bus, 13/13 nodes `[interrupted]` in one forensic run) is reserved for process teardown. The headless fleet deadline default rises 6 → 20 minutes.
- **Kimi K2.7+ thinking 400 fixed.** Those models reject `thinking: { type: "disabled" }` outright; thinking-mode "off" now omits the param for them (K2.6/DeepSeek keep the explicit disable).
- **Every LLM request is time-bounded.** The router wraps `generateText`/`generateObject` in a 120s fiber-level timeout (the official Google/OpenAI/Anthropic paths had none), classified transient so it retries — a silently hung socket can no longer park the root turn forever.
- **Distill runs once per run.** `gateOnce` no longer mines the conversation on `needs_work`; the turn-boundary distill is the single invocation.
- The in-process TUI driver now wires `onBusEvent`, so bus-published events (inter-agent messages, and the upcoming health stream) reach its event queue at all.
