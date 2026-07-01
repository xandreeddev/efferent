---
"@xandreed/sdk-core": patch
"efferent": patch
---

Research/prose swarm deliverables are now delivered-with-notes instead of fail-closed-looping to death.

The mandatory Opus gate treated a research/analysis deliverable (a report — no files changed) exactly like non-compiling code: a `needs_work` verdict re-ran the **entire fleet** with the reviewer's reasons, up to `maxLoopAttempts` (3), then stopped. For research there's no code "solution" to fix — the report *is* the deliverable, and a `needs_work` is the reviewer's opinion, not a hard failure. The result was a research run that got pushed back 3×, re-ran the whole fleet each time (minutes + tokens), and ended feeling like it "died" with nothing clean delivered.

Now, in the single shared gate decision (`gateOnce`), a deliverable that changed **no files** delivers immediately **with the reviewer's notes attached** (a new `advisory` flag on the `gate` event) and **never** enters the retry-to-cap loop. The fail-closed retry-to-cap is reserved for **file-changing (code)** deliverables, which genuinely either build or don't. One change covers both the root aggregate gate and the per-coordinator (research-coordinator) gate. The TUI renders an advisory verdict as `⚑ verifier notes (delivered)` rather than a red `✗ NEEDS WORK`. (Bonus: a coding fleet that lands *no* edits is likewise delivered-with-notes rather than re-run — don't loop a fleet that isn't landing changes.)
