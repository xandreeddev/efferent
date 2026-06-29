# efferent

## 0.5.0

### Minor Changes

- 434194b: Gate every swarm objective through the Opus verifier (mandatory, fail-closed).

  When a run uses sub-agents, the finished objective is now validated by the independent Opus gate in `driveLoop` — the single use case every mode funnels through — before the run is done, regardless of whether a coordinator was used or the model called a tool. On `needs_work` the loop distills reusable lessons, re-runs with the gate's reasons fed back, and re-gates, up to `maxLoopAttempts`; an unavailable verifier is surfaced loudly (a new `gate` `AgentEvent`), never a silent pass. Gated by the existing `autoLoop` setting (default on); a run with no sub-agents is unaffected.

- f03483e: Make the root a pure orchestrator: it routes all real work to a coordinator / research-coordinator and does no coding/research itself.

  - The root prompt is rewritten to "always orchestrate" (route code → coordinator, investigation → research-coordinator; only pure conversation stays direct).
  - Mechanical guarantees (a prompt rule alone didn't hold): when a fleet lead is in the roster the root gets an **orchestration-only toolkit** (no read/edit/write/grep/Bash/search tools), and its `run_agent` is **hard-railed** so it can only delegate to a coordinator/research-coordinator (no bare-worker spawn), with a runtime backstop.
  - New `orchestration` eval + `orchestratorPurityScore` assert the root delegates through a lead and keeps its hands off the work (the harness now captures root-only `rootTools` / `rootSpawnedAgents`).

- f03483e: Make the gate structural at both tiers, remove the gate tools, and add a Claude-style fleet UX.

  - **Coordinator-tier gate is now structural.** Each lead (coordinator / research-coordinator) validates its own subtree through the same independent Opus gate the root uses — extracted into one shared `gateOnce` helper (`core/usecases/gateLoop.ts`) used by both `driveLoop` (root aggregate pass) and `runSpawnedAgent` (per-lead, before it returns). On `needs_work` it distills + re-runs the lead's loop with the gate's reasons, to `maxLoopAttempts`. Gating no longer depends on the model remembering to call a tool.
  - **Gate tools removed.** Because gating/distilling/retrying is fully structural, `verify_with_gate` and `note_constraint` are gone from the root's orchestration toolkit and the coordinator/research-coordinator toolsets (defs + handlers deleted). The coordinator prompts drop the manual `GATE → LEARN → RETRY` phase; `autoLoop` only shapes whether DELIVER is gate-aware. The architect role stays as the in-fleet, fine-grained per-piece review.
  - **Claude-style fleet UX.** The running loader now shows `waiting for N agents` once the root's turn ends but background agents run on (not a dead idle screen), and each top-level lead gets one clean `✓ name — summary` / `✗ …` completion line on the root rail when it finishes. Sub-agent tool calls still never leak to the main rail (they route to the fleet tree / node log).

## 0.4.0

### Minor Changes

- 3dc24ae: shell: background processes + tmux interactive sessions, on a process-group-correct foundation.

  The `Shell` port was one-shot only (`exec` — blocking, pipes, no TTY), so nothing could outlive a tool call and an interactive program had no way to run. A research run that tried to "observe a TUI live" hacked `script -q -c '<tui>'` and hung the turn for 41 minutes: `exec` killed only the direct child on timeout, then blocked on `readAll` of a pipe a reparented orphan still held.

  - **Foundation — process-group correctness (`shell/local.ts`).** Commands now spawn in their own process group (`detached`), so a timeout/abort group-kills the whole tree (`script`/`setsid`/reparented orphans included), and the call settles on the process's **exit** plus a bounded drain grace — never on pipe EOF, so an fd-holding orphan can't hang it. This fixes the original hang and protects the verifier's long `exec` too.
  - **Background processes.** `Bash({ run_in_background: true })` returns a `processId` immediately; `bash_output` reads incremental output (with a cursor); `kill_bash` group-kills it. For dev servers, watchers, long builds. The Bash default timeout is also raised 60s → **5 min** (agent-overridable via `timeout`), kept independent from the verifier's 30-min cap.
  - **Interactive tmux sessions.** A new `TerminalSession` port (tmux-backed) + `session_start`/`session_send`/`session_read`/`session_kill`/`session_list` — drive a TUI/REPL/ssh, capture its screen, and `tmux attach` to the same pane. Feature-detected: no tmux ⇒ a graceful, model-readable failure.
  - **Visibility + teardown.** Background output surfaces live via a new `bg_output` event (same `RunContext` sink path as `llm_retry`); on app exit, all background procs and tmux sessions are group-killed so nothing is orphaned.

### Patch Changes

- f2d8f12: llm retries: clamp `Retry-After` and make the backoff visible — a rate-limit can no longer silently hang the turn.

  Two bugs compounded into a "frozen TUI for hours" symptom: the opencode gateway answers a daily-quota 429 with `Retry-After` = seconds-until-the-midnight-UTC reset (often 10+ hours), and `retryableLlm` (a) honored that verbatim — `Effect.sleep` for ~13h — and (b) reported retries only via `Effect.logWarning`, which the TUI routes to the file log, never the event stream. So the agent parked for half a day with the loader still spinning `thinking`, no error, no indication.

  - **Clamp.** A server wait is honored only up to a 60s ceiling; a longer one is treated as a quota/outage wall and **not retried** — the error surfaces immediately so you can switch models (`:model`) instead of staring at a hang. Exponential backoff is unchanged (1s→2s→4s, capped). The clamp decision is a pure, unit-tested function (`planDelay` / `parseRetryAfter`).
  - **Visibility.** Each backoff now emits an `llm_retry` event (new `AgentHooks.onLlmRetry` + `AgentEvent` variant), threaded from the provider adapter to the UI via a `RunContext` FiberRef sink (the adapter runs below the loop's hooks), and inherited by the sub-agent fleet. The TUI renders `provider HTTP 429 — retrying in 8s (attempt 1/3)` live. The hard failure, if retries exhaust, still arrives as the existing red error line.

- 77557f7: delegation: a _broad_ investigation now hands off to the research fleet instead of grinding through it serially in the master session. `# When to delegate`'s "do the investigating yourself" fast path gains an explicit exception, and a new `# Investigating & researching` prompt section (emitted only when a `research-coordinator` is in the roster) draws the read-side line the way `# Writing code` draws the write-side one: a focused lookup (one file/function/named thing) stays on the root, but the moment an answer means reading across many files or several areas at once — orienting in an unfamiliar codebase, mapping how modules connect, tracing a flow end-to-end, auditing multiple areas — it fans out parallel read-only researchers and synthesizes one sourced answer. Reading never conflicts, so the fan-out is pure speed-up and keeps the root's context clean. Fixes the recurring "the initial research that could be sped up by the swarm always runs in the master session instead" complaint. Prompt-only — the model still decides; this just makes the broad/focused split explicit. Covered by a new `researchDelegation` eval suite (natural prompts, deterministic trajectory scoring: broad → fans out with `minSpawns`, narrow → stays direct).
