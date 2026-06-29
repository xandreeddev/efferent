# @xandreed/sdk-core

## 0.4.0

### Minor Changes

- 05f3ddc: eval rigor: determinism, multi-sample defaults, a regression gate, judge calibration, dataset files, and a coverage map.

  The eval framework already had a strong statistical core (paired cluster-bootstrap CIs, Cohen's d, pass@k/pass^k, a committable baseline) — but it was undermined by weak defaults and missing data-engineering discipline. This closes six gaps:

  - **Determinism** — a `samplingTemperature`/`samplingSeed` on `Settings`, threaded to the provider call (the opencode adapter sends them in its request body; Google/OpenAI/Anthropic via their config). Eval runs pin temperature **0 + a seed** by default (both the `--config` and bare paths), so a measured delta is the change, not sampling noise.
  - **Rigor by default** — the runner now runs **N=3 samples** per case by default (was 1), so a bare `bun run eval` reports mean ± stdev + pass@k/pass^k, not a single draw. `--samples 1` opts out; a suite's own `samples` still wins. (The framework library keeps its conservative default of 1.)
  - **Regression gate** — `bun run eval --compare <baseline>` now FAILS on a statistically significant regression (paired bootstrap CI excluding 0, Bonferroni-corrected — `regressionVerdict`), not just prints it. A `.github/workflows/evals.yml` runs the gate on labeled PRs / manual dispatch (secret-guarded, cost-gated).
  - **Judge calibration** — the binary κ/TPR/TNR harness gains **continuous-score metrics** (MAE/RMSE/bias/Pearson/Spearman) + a **length-bias probe**, run over an adversarial human-labeled golden set (length traps, brevity, fabricated citation, confident-falsehood). `bun run eval --judge-agreement` reports both; `--strict` gates on it.
  - **Dataset files** — versioned, Schema-validated dataset JSON with `tags`/`difficulty` stratification metadata (`loadDataset`), carried onto the `eval.case` span; `tool-selection` migrated as the template.
  - **Coverage map** — `coverage.ts` maps every coding tool to the suite(s) that exercise it; `coverage.test.ts` fails if a new tool is added without a coverage decision (the gap the background/tmux tools fell through). Adds a `background-shell` behavioral eval for the new `run_in_background`/`bash_output`/`kill_bash` tools.

## 0.3.0

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

## 0.2.0

### Minor Changes

- 3dc24ae: shell: background processes + tmux interactive sessions, on a process-group-correct foundation.

  The `Shell` port was one-shot only (`exec` — blocking, pipes, no TTY), so nothing could outlive a tool call and an interactive program had no way to run. A research run that tried to "observe a TUI live" hacked `script -q -c '<tui>'` and hung the turn for 41 minutes: `exec` killed only the direct child on timeout, then blocked on `readAll` of a pipe a reparented orphan still held.

  - **Foundation — process-group correctness (`shell/local.ts`).** Commands now spawn in their own process group (`detached`), so a timeout/abort group-kills the whole tree (`script`/`setsid`/reparented orphans included), and the call settles on the process's **exit** plus a bounded drain grace — never on pipe EOF, so an fd-holding orphan can't hang it. This fixes the original hang and protects the verifier's long `exec` too.
  - **Background processes.** `Bash({ run_in_background: true })` returns a `processId` immediately; `bash_output` reads incremental output (with a cursor); `kill_bash` group-kills it. For dev servers, watchers, long builds. The Bash default timeout is also raised 60s → **5 min** (agent-overridable via `timeout`), kept independent from the verifier's 30-min cap.
  - **Interactive tmux sessions.** A new `TerminalSession` port (tmux-backed) + `session_start`/`session_send`/`session_read`/`session_kill`/`session_list` — drive a TUI/REPL/ssh, capture its screen, and `tmux attach` to the same pane. Feature-detected: no tmux ⇒ a graceful, model-readable failure.
  - **Visibility + teardown.** Background output surfaces live via a new `bg_output` event (same `RunContext` sink path as `llm_retry`); on app exit, all background procs and tmux sessions are group-killed so nothing is orphaned.

### Patch Changes

- b10f2b9: distiller: route a user-stated **process** rule (a how-to-work lesson like "plan before a multi-step task") to `kind:"process"` instead of defaulting to `constraint`.

  The miner prompt's Rule 5 hardcoded every user correction as a `constraint`, so a working-method rule the human stated was mis-filed (it belongs in the operating-guidance overlay, not `CONSTRAINTS.md`). The prompt now classifies kind by **subject** — a code/domain rule → `constraint`, a working-method rule (plan, verify, sequence, delegate) → `process` — even when a user states it.

  Measured on the fast tier (`deepseek-v4-flash`, 5 samples/case): user-stated process-routing accuracy **0.20 → 1.00**, with constraint routing unchanged (no domain rule leaks into `process`).

- f2d8f12: llm retries: clamp `Retry-After` and make the backoff visible — a rate-limit can no longer silently hang the turn.

  Two bugs compounded into a "frozen TUI for hours" symptom: the opencode gateway answers a daily-quota 429 with `Retry-After` = seconds-until-the-midnight-UTC reset (often 10+ hours), and `retryableLlm` (a) honored that verbatim — `Effect.sleep` for ~13h — and (b) reported retries only via `Effect.logWarning`, which the TUI routes to the file log, never the event stream. So the agent parked for half a day with the loader still spinning `thinking`, no error, no indication.

  - **Clamp.** A server wait is honored only up to a 60s ceiling; a longer one is treated as a quota/outage wall and **not retried** — the error surfaces immediately so you can switch models (`:model`) instead of staring at a hang. Exponential backoff is unchanged (1s→2s→4s, capped). The clamp decision is a pure, unit-tested function (`planDelay` / `parseRetryAfter`).
  - **Visibility.** Each backoff now emits an `llm_retry` event (new `AgentHooks.onLlmRetry` + `AgentEvent` variant), threaded from the provider adapter to the UI via a `RunContext` FiberRef sink (the adapter runs below the loop's hooks), and inherited by the sub-agent fleet. The TUI renders `provider HTTP 429 — retrying in 8s (attempt 1/3)` live. The hard failure, if retries exhaust, still arrives as the existing red error line.
