# @xandreed/sdk-adapters

## 0.5.0

### Minor Changes

- e624b8b: BREAKING — the old self-improving harness is excised (the `docs/agents/` R1
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
- 590ee3d: The one gate: persisted, bounded, honest — and the learning loop's counters finally move.

  Every gate round now lands in a `gate_verdicts` audit table (sqlite 0011 / pg 0015) — verdict, reasons, files, advisory flag, duration, and, for `unavailable`, the verifier's error text. The forensic "claude exited 1 after 2s ×3 → silent bypass" class is traceable after the fact, and `ConversationStore.listGateVerdicts` answers "was this actually verified?".

  The gate is bounded now: the verifier subprocess default drops 30 → 10 minutes, `maxLoopAttempts` defaults to 2 (one retry — each retry re-runs the whole fleet), and a 15-minute wall clock caps the whole gate phase (persisting a budget-exhausted row instead of spinning). The settle-before-judging wait flips the other way: the old ~30s ceiling judged still-RUNNING fleets mid-flight (and the retry then spawned a duplicate fleet beside the live one); with every run now guaranteed to reach a terminal status, settle waits properly (5s polls, a ~10-min never-hit backstop).

  Scheduled (cron) runs stop being gate-free: `submitJob`'s scheduled path runs a one-shot gate over the spawned deliverable, persists the verdict, and folds a `needs_work`/`blocked` into a `partial` outcome — no retry loop (nobody is watching to steer one), but never silent.

  Reinforcement is wired: re-learning an existing constraint bumps its ✓ (the miner + gate re-surfacing it IS the signal it keeps mattering), and the gate prompt now lists the loaded CONSTRAINTS.md ids so a violated one is cited by id in the verdict (`constraintsViolated`) and gets its ✗ bumped. Before this every persisted constraint sat at `(✓0 ✗0)` forever — the "self-improving" loop had never once reinforced a lesson.

- 590ee3d: One terminal path + an honest outcome vocabulary for every agent run.

  Every run (root turn or spawned node, any exit shape) now funnels through ONE idempotent, infallible terminal path — `finalizeRun`: durable `recordReturn` (terminal-once at the store: only a `running` row closes, so a racing sweeper can't overwrite the first outcome) → `bus.complete` (parent inbox + waiter wake) → the `subagent_end` event. Abnormal exits (interrupt, watchdog stall, crash) can no longer skip the terminal event — the gap that made dead agents look alive in every UI surface.

  The status vocabulary is honest now: `running | ok | partial | error | killed` plus a typed `stopReason` (`budget` / `step-cap` / `degenerate-loop` / `stall` / `interrupt(by: human|parent|shutdown|deadline)` / `provider` / `error`), persisted on the node (new `stop_reason` column, sqlite migration 0010 / pg 0014) and carried on `subagent_end`/`agent_end` (`outcome`/`reason`, schema-optional so stale daemon/client pairs still decode; the legacy `ok` boolean stays). Budget/step-cap stops were previously recorded as plain `ok` 25× in the run forensics; they are `partial` now — usable but incomplete, and `wait_for_agents` tells the orchestrator exactly that. A step-capped or breaker-stopped ROOT turn also reports `partial` instead of shipping its mid-thought last sentence as a success, and the gate no longer ships a wholly-failed fleet as "advisory success" (a majority error/killed fleet with no files stops non-advisory).

  Spawned runs are **supervised fibers**: `bus.forkSupervised` replaces `forkDaemon(...catchAll(() => void))` (which discarded every exit), and `bus.shutdown()` — wired into TUI, print, json, rpc, and daemon teardown — interrupts and AWAITS the fleet so each run records `killed(shutdown)` before the process exits; no more rows stranded `running` forever. Interrupt APIs stamp WHO killed a run (`human`/`parent`/`shutdown`/`deadline`) so the persisted reason says so.

  Headless modes are exit-code honest: print/json exit 1 when the run itself failed (error event, root error/killed), 0-with-stderr-notes for partial results, failed sub-agents on a delivered run, and gate degradation; rpc's resolve payload carries `outcome`. `agent_end` no longer ships the full `messages` array on the wire (zero consumers, megabytes per turn on SSE).

- f563406: Survive provider outages like Claude Code: the patient retry ladder, empty-response rejection, and no-lost-work persistence.

  The July 2 forensics: the opencode gateway melted for ~2.5h (429s, 503s, silent 120s hangs). A fleet finished all 7 audits — then the root's synthesis turn burned its 3 fast retries (4×120s timeouts, ~8 min) and died, so the deliverable was never shown; a manual node resume died the same way and lost its 2 completed turns; and two agents "completed" on HTTP-200-empty responses (`turn N: unknown · 0 tok`), recording mid-thought sentences as deliverables.

  Four fixes:

  - **The patient ladder** (`retryableLlm`): after the fast retries, a transient failure keeps retrying on slow rungs (15s → 30s → 60s…) bounded by the run's `interactionPolicy` — interactive 30 min (visible "provider down 6m — retrying" in the rail/health; Esc cancels), headless 10 min, bare calls (evals) unchanged. Helper tiers (titles, digests, approval judge, web search) use `retryableLlmFast` so a garnish can never park a turn.
  - **Empty responses are errors**: the router rejects a response with no text, no tool call, no reasoning as a transient failure that rides the same ladder, instead of fake-completing the turn.
  - **Failover on exhausted transients**: `withFailover` now also fires when the ladder runs dry (provider genuinely down) — one shot on the configured fallback selection, loudly annotated.
  - **No lost work**: spawned/resumed sub-agent runs persist their tail incrementally per turn (`onTail`), so a run that dies mid-flight keeps every completed turn. Timeout errors name the `provider:model`.

- 590ee3d: Provider-defect taxonomy + role-scoped failover: the runtime now understands WHY a model call died and heals what it can.

  New shared classifier (`classifyProviderError` → `transient | quota | config | auth | model`) gives a typed home to every anonymous node-killer from the run forensics: opencode `CreditsError: Insufficient balance`, weekly/daily usage limits, the multi-hour daily-quota `Retry-After` (now `quota`, never slept on), kimi's `invalid thinking` 400 and provider-endpoint 404s (`config`), credential rejections (`auth`), and undecodable model output (`model`). `retryableLlm` consumes the same taxonomy for its transient decision — one classification, two consumers.

  On a **persistent** defect (`quota`/`config`) the router now fails over ONCE to a human-configured selection instead of dying: the code role falls back to the run's pinned general model, the general role to the new `Settings.fallbackModel` (unset ⇒ no failover). Loud by construction — the notice rides the retry sink into the rail/node log/health suffix, spans carry `llm.failover.*`, and a `[failover: … → … after quota]` annotation is folded into the run's terminal outcome notes. `auth` never fails over (credentials are the human's — surfaces with the `:login` hint); `transient` still retries in place; `model` stays with the loop's corrective recovery. A running agent still never picks its own model.

### Patch Changes

- 590ee3d: Stop the fleet bleeding: one gate tier, scoped interrupts, work-preserving watchdog, kimi thinking fix, uniform LLM timeouts.

  Run forensics over ten days of fleet runs (376 sub-agent nodes, 29% error rate — 56% on the worst day) traced most failures to five mechanisms, all fixed here:

  - **The per-coordinator gate tier is deleted.** A lead's structural gate ran settle polls plus a `claude -p` Opus subprocess (30-min cap) inside the sub-agent stall watchdog's 180s no-progress window, with no progress stamps — so finished leads were routinely killed mid-gate and recorded `[stalled]`, discarding completed, test-green work. Gating is now ONE tier, at the root (`driveLoop`), judging the aggregate deliverable; `isLead` and the lead-gate block are gone, and `gateOnce` is a pure decision requiring only `Verifier`.
  - **The exit finalizer preserves produced work.** An interrupted/stalled run keeps its last assistant text, `filesChanged`, and usage instead of an empty `[stalled]`/`[interrupted]` error; a stall AFTER text is recorded as ok-with-note (the work survives, the caveat is attached).
  - **Fleet kills are subtree-scoped.** New `AgentBus.interruptSubtree(parentKey)`: the headless deadline and Esc in the in-process TUI now interrupt only THAT run's descendants — `interruptAll` (which killed every fleet on the bus, 13/13 nodes `[interrupted]` in one forensic run) is reserved for process teardown. The headless fleet deadline default rises 6 → 20 minutes.
  - **Kimi K2.7+ thinking 400 fixed.** Those models reject `thinking: { type: "disabled" }` outright; thinking-mode "off" now omits the param for them (K2.6/DeepSeek keep the explicit disable).
  - **Every LLM request is time-bounded.** The router wraps `generateText`/`generateObject` in a 120s fiber-level timeout (the official Google/OpenAI/Anthropic paths had none), classified transient so it retries — a silently hung socket can no longer park the root turn forever.
  - **Distill runs once per run.** `gateOnce` no longer mines the conversation on `needs_work`; the turn-boundary distill is the single invocation.
  - The in-process TUI driver now wires `onBusEvent`, so bus-published events (inter-agent messages, and the upcoming health stream) reach its event queue at all.

- Updated dependencies [e624b8b]
- Updated dependencies [590ee3d]
- Updated dependencies [590ee3d]
- Updated dependencies [590ee3d]
- Updated dependencies [f563406]
- Updated dependencies [590ee3d]
- Updated dependencies [64efbfb]
- Updated dependencies [604c0ec]
- Updated dependencies [6a2b3f6]
- Updated dependencies [64efbfb]
  - @xandreed/sdk-core@0.6.0

## 0.4.2

### Patch Changes

- Updated dependencies [b8bc864]
  - @xandreed/sdk-core@0.5.1

## 0.4.1

### Patch Changes

- e6eeb32: Make the swarm verify its own work before delivering, instead of shipping non-compiling code.

  The multi-agent fleet could report a coding task "done" on code that didn't even type-check: the project's own conventions (`AGENT.md`, e.g. "run the project's checks") only reached the ROOT prompt, never the sub-agents that write code; the specialists' instructions made verification optional ("run the checks you can"); and the independent Opus verifier ran read-only (`--permission-mode plan`) so it structurally couldn't run a build, rubber-stamping a prose summary.

  - **Sub-agents inherit the project's conventions.** The pre-rendered instruction files (`AGENT.md` / `CONSTRAINTS.md`) now thread into every spawned sub-agent's prompt, so a coder learns _this_ project's build/verify command and hard rules — the general mechanism (à la injecting the repo's guidance into every agent), project-specific content, no hardcoded command.
  - **"Done" means verified working.** The sub-agent return contract and the specialist/coordinator/architect prompts now require running the project's own checks and fixing failures before returning; the architect must actually run the checks for a `SOUND` verdict.
  - **The verifier can actually verify.** The Opus deliverable gate now runs the repo's read-only checks (Bash allowed, edits denied) instead of judging prose in read-only mode, and the per-coordinator gate aggregates its whole subtree's changed files so a nested writer is seen as code, not prose.
  - **A new `swarm-compile` eval** type-checks the fleet's produced code in-process (`runScenario`'s `typecheck` option), the discriminator `bun test` can't provide.

- Updated dependencies [e6eeb32]
  - @xandreed/sdk-core@0.5.0

## 0.4.0

### Minor Changes

- 14027e4: fix(verifier): structured (provider-enforced) verdicts — no more "could not parse a verdict"; plus a non-vacuous research-read-only guard.

  A live run hit `⚠ verifier UNAVAILABLE — work NOT verified: could not parse a deliverable verdict`. claude had answered fine (43–56s, three times) — the failure was the **extractor**: the gate ran the `claude` CLI (`--output-format json`, a free-text answer) and scraped the verdict with a greedy `/\{[\s\S]*\}/`. An Opus assessment of CODE is full of braces, so the greedy span swallowed the prose into an unparseable blob. The CLI has no schema-enforced output mode, so _some_ parsing was unavoidable on that path.

  - **Structured verdicts (the real fix).** A new `StructuredVerifierLive` judges with Opus via `generateObject` and a Schema — a **provider-enforced** `{ verdict, assessment, reasons }`. A parse error is structurally impossible. Independence is preserved by a controlled validator system prompt (no project narrative) + a pinned model (`EFFERENT_VERIFY_MODEL`, default `anthropic:claude-opus-4-8`); a code gate embeds the changed-file contents in the prompt to check against ground truth. **Prose feedback is preserved, not lost** — `assessment` is a first-class field that leads the `reasons` fed back to the retry loop. Fail-soft as before (any error → `VerifierError` → caller falls back to the architect). The old `claude`-CLI verifier (`ClaudeHeadlessVerifierLive`) is removed.
  - **Research read-only guard, de-vacuumed.** The `researchReadOnly` eval scorer scored 1 whenever the fleet wrote nothing — which is trivially true when the root never delegated (the live run's actual behavior), a false pass. It now scores 1 only when the fleet ran AND wrote nothing; a no-delegation run scores 0 with a clear detail, so the read-only property is never claimed without being exercised.
  - **Deterministic Fix-3 wiring test.** `constrainToReadOnly` was unit-tested, but the `researchSubtree` flag → handler path wasn't. New tests drive the real `run_agent` handler: with `researchSubtree` set, `agent:"coordinator"` is refused (`ResearchStaysReadOnly`); without it, the same spawn proceeds — proving the flag is what gates it.

### Patch Changes

- 9df3e4d: fix(verifier): revert to the Claude Code (`claude -p`) gate with a robust parse — no more "verifier UNAVAILABLE".

  The verify gate fell open ("⚠ verifier UNAVAILABLE — work NOT verified") on a live headless run. #88 had swapped the `claude -p` subprocess verifier for `StructuredVerifierLive`, which calls the **Anthropic API** via `generateObject` on a pinned `anthropic:claude-opus-4-8`. That is wrong for a headless opencode setup: it's not the engine's model, the opencode provider has no `generateObject` at all, and Anthropic's `generateObject` is a _forced tool call + client-side decode_ — Anthropic treats the schema as a hint, not a contract. Opus returned `reasons: ""` (string), the strict `Schema.Array(Schema.String)` decode rejected it, and the gate surfaced `unavailable` → the work shipped unverified.

  - **Restore `ClaudeHeadlessVerifierLive`** — an INDEPENDENT Opus referee run via the real `claude` Claude Code CLI in a clean-room sandbox (verified empirically: with `HOME=<sandbox>` + a controlled cwd, **no project/global `CLAUDE.md`/`AGENT.md` leaks into the judgment, even with `--add-dir`**). Provider-agnostic of the engine's model; uses the Claude subscription rate. Re-wired in `main.ts` (needs only `Shell`); `StructuredVerifierLive` removed.
  - **Robust parse (the reason #88 dropped the CC verifier).** The old greedy `/\{[\s\S]*\}/` grabbed first-brace-to-last and broke on a brace-heavy Opus assessment. New shared `extractJsonObjects` (sdk-core) does a string-aware **balanced-brace scan**, returning objects last-first so the trailing verdict wins past pages of code-laden prose. The verdict schema is **tolerant** (`reasons` accepts an array, a bare string, or missing — the exact `reasons: ""` shape that broke the structured verifier). A present-but-unparseable reply degrades to `needs_work` (**fail-closed**, re-check the work) via a keyword fallback — `unavailable` now means only its true cause: `claude` absent, a non-zero exit, or no output.

  Verified live: the real `claude` gate returns a parsed `sound` for a well-sourced answer and `needs_work` (with concrete reasons) for a vague one — no decode failure, no "unavailable". Guarded by unit tests for the brace-heavy and `reasons:""` cases that the old tests never covered.

- 916c43f: fix(swarm): a hung sub-agent no longer strands the fleet "checking for agents that never ran" — three layered recoveries + the degenerate-loop breaker that wasted the run.

  A real `efferent code` run looked completely dead: the root spawned a sub-agent (`run_agent` → `{ status: "running" }`), then looped `wait_for_agents` forever while the node sat `running` with **zero** turns. Root cause was two compounding failures, both fixed:

  - **The spawned sub-agent's first model call silently stalled** (a gateway connection that returns no bytes and no error). Nothing caught it: the exit finalizer only fires when the fiber EXITS (a parked fiber hasn't), and the mid-session sweeper only flips a node whose fiber is no longer on the bus (a parked fiber still is). So the node stranded `running` for up to ~20 min while the parent's `wait_for_agents` looped blind. Now a **stall watchdog** races every spawned run: no progress (no turn start, tool result, narration, or LLM retry) for `SUBAGENT_STALL_DEADLINE_MS` (180s) → interrupt → record a clear `STALL_NOTE` error → notify the parent, which unblocks. Retries count as progress, so a call weathering a transient overload is never killed; a tiny injected deadline unit-tests it without a real wait.
  - **The per-request LLM timeout was 5 min** — far too long for a backgrounded run with nothing on screen. Cut to **2 min** (`LLM_REQUEST_TIMEOUT_MS`, all four custom adapters), below the watchdog deadline, so a stalled connect aborts → retries (visible) before the watchdog has to kill the run.
  - **The root burned ~30 turns calling the same tool** (`list_scheduled_jobs`, identical args, identical empty result) before doing anything — saturating the gateway and wasting the run. A **degenerate-repeat circuit breaker** in the agent loop (mirroring the existing malformed-output breaker) detects an identical call+result signature repeating: it nudges once, then force-stops. Pollable tools (`wait_for_agents`, `bash_output`) and calls that return new info each time never trip it.

  Guarded by deterministic tests that run in CI (`bun test`): the watchdog kills a hung sub-agent and records the stall (and does NOT kill a healthy one); the breaker stops a same-call/same-result spin (and does NOT stop a legitimate poll or a progressing loop); the request timeout is pinned at 2 min, below the watchdog deadline.

- Updated dependencies [d4405b2]
- Updated dependencies [f9f20ed]
- Updated dependencies [870d1f1]
- Updated dependencies [ea310fc]
- Updated dependencies [9df3e4d]
- Updated dependencies [a171060]
- Updated dependencies [916c43f]
- Updated dependencies [1146133]
- Updated dependencies [14027e4]
  - @xandreed/sdk-core@0.4.1

## 0.3.0

### Minor Changes

- 05f3ddc: eval rigor: determinism, multi-sample defaults, a regression gate, judge calibration, dataset files, and a coverage map.

  The eval framework already had a strong statistical core (paired cluster-bootstrap CIs, Cohen's d, pass@k/pass^k, a committable baseline) — but it was undermined by weak defaults and missing data-engineering discipline. This closes six gaps:

  - **Determinism** — a `samplingTemperature`/`samplingSeed` on `Settings`, threaded to the provider call (the opencode adapter sends them in its request body; Google/OpenAI/Anthropic via their config). Eval runs pin temperature **0 + a seed** by default (both the `--config` and bare paths), so a measured delta is the change, not sampling noise.
  - **Rigor by default** — the runner now runs **N=3 samples** per case by default (was 1), so a bare `bun run eval` reports mean ± stdev + pass@k/pass^k, not a single draw. `--samples 1` opts out; a suite's own `samples` still wins. (The framework library keeps its conservative default of 1.)
  - **Regression gate** — `bun run eval --compare <baseline>` now FAILS on a statistically significant regression (paired bootstrap CI excluding 0, Bonferroni-corrected — `regressionVerdict`), not just prints it. A `.github/workflows/evals.yml` runs the gate on labeled PRs / manual dispatch (secret-guarded, cost-gated).
  - **Judge calibration** — the binary κ/TPR/TNR harness gains **continuous-score metrics** (MAE/RMSE/bias/Pearson/Spearman) + a **length-bias probe**, run over an adversarial human-labeled golden set (length traps, brevity, fabricated citation, confident-falsehood). `bun run eval --judge-agreement` reports both; `--strict` gates on it.
  - **Dataset files** — versioned, Schema-validated dataset JSON with `tags`/`difficulty` stratification metadata (`loadDataset`), carried onto the `eval.case` span; `tool-selection` migrated as the template.
  - **Coverage map** — `coverage.ts` maps every coding tool to the suite(s) that exercise it; `coverage.test.ts` fails if a new tool is added without a coverage decision (the gap the background/tmux tools fell through). Adds a `background-shell` behavioral eval for the new `run_in_background`/`bash_output`/`kill_bash` tools.

### Patch Changes

- Updated dependencies [05f3ddc]
  - @xandreed/sdk-core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [434194b]
- Updated dependencies [f03483e]
- Updated dependencies [f03483e]
  - @xandreed/sdk-core@0.3.0

## 0.2.0

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

- 5f01464: settings: a stray `null` on an optional field (e.g. `codeModel: null`) no longer discards the ENTIRE config.

  The settings schema accepts `string | undefined`, never `null`, so a single null field failed validation and the loader dropped the whole local config — silently falling back to global defaults. In practice this disabled the configured code tier (so coding never delegated — the "fleet never fires" report) and reset every other setting (the "everything is deepseek" report). The loader now treats a top-level `null` as "unset", so one cleared field can't nuke the rest.

- 6b612ed: verify gate: don't cut off a slow Opus review. The clean-room `claude` deliverable/learning gate had a hard 3-minute timeout, so a real multi-file review hit `ShellTimeout` and returned `unavailable` — and the self-improving loop can't validate → can't iterate. The cap is now 30 minutes (override with `EFFERENT_VERIFY_TIMEOUT_MS`), and the gate logs its model, repo-access, isolation, and **duration**, plus a clear actionable reason on timeout/failure (surfaced to the model as the gate's `reasons`, not just a bare tag).
- Updated dependencies [b10f2b9]
- Updated dependencies [f2d8f12]
- Updated dependencies [3dc24ae]
  - @xandreed/sdk-core@0.2.0
