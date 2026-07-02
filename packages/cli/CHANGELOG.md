# efferent

## 0.6.1

### Patch Changes

- b8bc864: Research/prose swarm deliverables are now delivered-with-notes instead of fail-closed-looping to death.

  The mandatory Opus gate treated a research/analysis deliverable (a report — no files changed) exactly like non-compiling code: a `needs_work` verdict re-ran the **entire fleet** with the reviewer's reasons, up to `maxLoopAttempts` (3), then stopped. For research there's no code "solution" to fix — the report _is_ the deliverable, and a `needs_work` is the reviewer's opinion, not a hard failure. The result was a research run that got pushed back 3×, re-ran the whole fleet each time (minutes + tokens), and ended feeling like it "died" with nothing clean delivered.

  Now, in the single shared gate decision (`gateOnce`), a deliverable that changed **no files** delivers immediately **with the reviewer's notes attached** (a new `advisory` flag on the `gate` event) and **never** enters the retry-to-cap loop. The fail-closed retry-to-cap is reserved for **file-changing (code)** deliverables, which genuinely either build or don't. One change covers both the root aggregate gate and the per-coordinator (research-coordinator) gate. The TUI renders an advisory verdict as `⚑ verifier notes (delivered)` rather than a red `✗ NEEDS WORK`. (Bonus: a coding fleet that lands _no_ edits is likewise delivered-with-notes rather than re-run — don't loop a fleet that isn't landing changes.)

## 0.6.0

### Minor Changes

- e6eeb32: Make the swarm verify its own work before delivering, instead of shipping non-compiling code.

  The multi-agent fleet could report a coding task "done" on code that didn't even type-check: the project's own conventions (`AGENT.md`, e.g. "run the project's checks") only reached the ROOT prompt, never the sub-agents that write code; the specialists' instructions made verification optional ("run the checks you can"); and the independent Opus verifier ran read-only (`--permission-mode plan`) so it structurally couldn't run a build, rubber-stamping a prose summary.

  - **Sub-agents inherit the project's conventions.** The pre-rendered instruction files (`AGENT.md` / `CONSTRAINTS.md`) now thread into every spawned sub-agent's prompt, so a coder learns _this_ project's build/verify command and hard rules — the general mechanism (à la injecting the repo's guidance into every agent), project-specific content, no hardcoded command.
  - **"Done" means verified working.** The sub-agent return contract and the specialist/coordinator/architect prompts now require running the project's own checks and fixing failures before returning; the architect must actually run the checks for a `SOUND` verdict.
  - **The verifier can actually verify.** The Opus deliverable gate now runs the repo's read-only checks (Bash allowed, edits denied) instead of judging prose in read-only mode, and the per-coordinator gate aggregates its whole subtree's changed files so a nested writer is seen as code, not prose.
  - **A new `swarm-compile` eval** type-checks the fleet's produced code in-process (`runScenario`'s `typecheck` option), the discriminator `bun test` can't provide.

## 0.5.1

### Patch Changes

- d4405b2: fix(prompts): orchestrator fan-out discipline — decompose once, gather by looping, never re-spawn on an early wait

  The live failure spawned **9 overlapping leads** for one 6-part mission (deep-dive → "produce report" → 3× investigate → quick-read → 3× read of the same files) and kept adding more whenever a gather came back with agents still running. The proximate cause (a busy-returning `wait_for_agents`) is fixed separately; this hardens the orchestrator prompt so the behaviour can't recur on a weak model.

  - **Decompose ONCE, don't pre-split.** A broad job goes to ONE lead — the coordinator / research-coordinator decompose and fan out their own workers — instead of the root spawning several leads for the same objective. Split across leads only when the request has genuinely separate parts, and spawn that set in a single turn.
  - **Gather by looping `wait_for_agents`; NEVER re-spawn to "unstick" a lead.** A return with `allDone: false` and leads still running is NORMAL — call it again; it is not a signal that anything is stuck or that more agents are needed. Re-delegating / status-messaging / spawning on an early return is the exact failure mode that floods the fleet.
  - **Harvest with `wait_for_agents`, not `send_message`.** A finished lead is gone from the bus; `send_message` only steers a still-running one (the live run hit `AgentNotRunning` trying to message a finished agent).

  Carried in both the orchestrator role prompt (`renderOrchestrateRole`) and the `wait_for_agents` tool description, so the rule reaches the model from both the system prompt and the tool schema. Guarded by a coder-prompt test.

- f9f20ed: fix(prompts): a sub-agent's prompt now lists only the tools it actually has — no more lying scaffold

  Every spawned sub-agent got ONE static `# Tools` block plus the full `# Sub-agents` spawn doctrine, the agent roster, and the `# Coordination` "Read the blackboard FIRST" nudge — regardless of its real toolkit. So the read-only **architect** was told it could `write_file`/`edit_file`/`run_agent`/`wait_for_agents`/`blackboard_post`, the **researcher** that it had `Bash`/`run_agent`, and every leaf coder got "how to run a fleet" + "read the blackboard first" for tools it doesn't have. The real per-role toolkit was computed separately (`roleToolEntries`) and never reconciled with the prompt text.

  - **Single source of truth.** New `renderToolsFor(toolNames)` (`sdk-core/prompts/toolList.ts`) renders the `# Tools` block from exactly the role's tool names, so a prompt can never advertise a tool the toolkit lacks. A coverage test asserts every tool the runtime can grant a sub-agent has a blurb (add a tool without one → CI fails). The spawn path passes `roleToolEntries(definition)` (or the generic set) straight through, so prompt and toolkit are derived from the same list.
  - **Capability-gated sections.** `# Sub-agents` + the agent roster render only for a role that can actually spawn (`run_agent`); `coordinationSection` is now a function gated on the role's real comms/`wait_for_agents` — a read-only reviewer gets none of it, a comms-only leaf gets the blackboard/message guidance but not the `wait_for_agents` loop, a lead gets all of it.
  - **`product` is read-only.** It was built with the `specialist()` factory, which handed it `write_file`/`edit_file`/`Bash` while its own body says "not to write feature code". It now carries read + comms only.

  Net: the architect's prompt drops from a toolset it can't use + full fleet doctrine to exactly its five read-only tools and nothing else. Guarded by tests (renderToolsFor coverage + drop-unknown; per-role prompt presence-by-capability; product read-only). No behavior change to the toolkits themselves — only the prompt text now matches them.

- 870d1f1: fix(fleet): a finished sibling no longer makes `wait_for_agents` busy-spin — and headless fleet completion stops false-tripping its deadline

  The orchestrator "digging in a loop" had a concrete proximate cause in the bus. `wait_for_agents` (and the headless fleet-completion waiter) gather over "everything I spawned" via `childrenOf`, which returns running **and** finished children. `awaitChange` then decided whether to block by checking a **level** — `watch.some(status !== "running")` — which is permanently true once any child has finished. So once the first sub-agent completed, every later no-ids gather returned in ~1s instead of blocking, and a forced orchestrator "resolved" the early return by spawning **more** overlapping agents (a 9-agent fan-out for a 6-part task, never converging). The loop breaker couldn't catch it because the calls were structurally varied.

  - **`awaitChange` now blocks on the transition, not the level.** It parks on the watched agents that are _still running_ and wakes when one of _those_ finishes (via the existing completion/wake deferreds) or when a message lands in the waiter's inbox — a finished child already arrives as inbox mail, so it's still harvested promptly, just no longer busy-returned. A no-ids gather with one sibling done and one running now blocks until real progress (proven deterministically; the old code returned in ~0 ms).
  - **`childrenOf`'s contract is honest again, plus a `runningChildrenOf` for fleet-idle detection.** `childrenOf` keeps reporting running + finished children (the gather needs the finished ones' summaries), and its doc now says so. The "is the fleet still working?" consumers — headless `runFleetToCompletion`/`waitFleetIdle` and the fleet-scoped interrupt — switch to the new `runningChildrenOf` (running only). This fixes a real headless bug: `length === 0` never fired once a lead finished (finished children lingered in `childrenOf`), so `--mode json`/`-p` busy-looped to the 6-minute deadline and forced a degraded FINALIZE synthesis instead of a clean gather.

  Guarded by tests in CI: the no-ids busy-spin regression (a finished sibling must NOT busy-return), a no-ids gather still waking the instant the last sibling finishes, and `runningChildrenOf` reaching length 0 when the fleet goes idle.

- ea310fc: fix(fleet): stamp stall-watchdog liveness at the START of each tool call, not just on completion

  The sub-agent stall watchdog (`SUBAGENT_STALL_DEADLINE_MS`, 180s) stamps progress on turn-start, tool _completion_, narration, and LLM retry. A turn's LLM phase (already bounded by the 120s request timeout, which retries and stamps) plus a long tool call can together exceed the deadline while each phase is individually fine — and because only `onAfterToolCall` stamped, the watchdog measured time-since-turn-start and could interrupt a working agent mid-tool.

  Bumping on `onBeforeToolCall` makes the watchdog measure time-since-the-last-step (turn boundary OR tool boundary), so a healthy agent whose work spans model time + tool time isn't killed for being busy. The guard still fires on a genuine hang (no turn, no tool start/finish, no retry within the deadline) — verified by the existing watchdog tests (a hung model is still interrupted; a healthy one is not).

  Note: a _single_ tool call that legitimately runs longer than the deadline (e.g. a multi-minute build) is not covered by this and remains a known limitation; pausing the watchdog for the duration of an in-flight tool is the larger follow-up. Incremental persistence of a running node's status/usage to the durable context tree (today it commits at finish; the live bus is already authoritative for the running fleet) is also deferred as an observability improvement.

- 9df3e4d: fix(verifier): revert to the Claude Code (`claude -p`) gate with a robust parse — no more "verifier UNAVAILABLE".

  The verify gate fell open ("⚠ verifier UNAVAILABLE — work NOT verified") on a live headless run. #88 had swapped the `claude -p` subprocess verifier for `StructuredVerifierLive`, which calls the **Anthropic API** via `generateObject` on a pinned `anthropic:claude-opus-4-8`. That is wrong for a headless opencode setup: it's not the engine's model, the opencode provider has no `generateObject` at all, and Anthropic's `generateObject` is a _forced tool call + client-side decode_ — Anthropic treats the schema as a hint, not a contract. Opus returned `reasons: ""` (string), the strict `Schema.Array(Schema.String)` decode rejected it, and the gate surfaced `unavailable` → the work shipped unverified.

  - **Restore `ClaudeHeadlessVerifierLive`** — an INDEPENDENT Opus referee run via the real `claude` Claude Code CLI in a clean-room sandbox (verified empirically: with `HOME=<sandbox>` + a controlled cwd, **no project/global `CLAUDE.md`/`AGENT.md` leaks into the judgment, even with `--add-dir`**). Provider-agnostic of the engine's model; uses the Claude subscription rate. Re-wired in `main.ts` (needs only `Shell`); `StructuredVerifierLive` removed.
  - **Robust parse (the reason #88 dropped the CC verifier).** The old greedy `/\{[\s\S]*\}/` grabbed first-brace-to-last and broke on a brace-heavy Opus assessment. New shared `extractJsonObjects` (sdk-core) does a string-aware **balanced-brace scan**, returning objects last-first so the trailing verdict wins past pages of code-laden prose. The verdict schema is **tolerant** (`reasons` accepts an array, a bare string, or missing — the exact `reasons: ""` shape that broke the structured verifier). A present-but-unparseable reply degrades to `needs_work` (**fail-closed**, re-check the work) via a keyword fallback — `unavailable` now means only its true cause: `claude` absent, a non-zero exit, or no output.

  Verified live: the real `claude` gate returns a parsed `sound` for a well-sourced answer and `needs_work` (with concrete reasons) for a vague one — no decode failure, no "unavailable". Guarded by unit tests for the brace-heavy and `reasons:""` cases that the old tests never covered.

- a171060: fix(root): the orchestrator root finally matches its toolkit — a dedicated delegate-first prompt, trimmed tools, and a loop breaker that catches the real spin.

  When a fleet lead is in the roster (the normal CLI), the root is a pure orchestrator with **no work tools** (#83 strips read/grep/edit/Bash as a mechanical guarantee that it delegates). But the prompt was never switched to match: it still advertised `read_file`/`grep`/`edit_file`, told the root to "read the workspace" and "Read the blackboard FIRST", then said "orchestrate, don't do the work". A weak model couldn't reconcile the contradiction, so on "investigate the codebase" it looped on the only tools it could execute — `list_scheduled_jobs`, `blackboard_read`, `update_plan` — and never delegated.

  - **Prompt ↔ toolkit alignment (the core fix).** `coderSystemPrompt` now branches on the SAME condition as the toolkit (`isOrchestrateMode`, a new shared helper used by both `coder.ts` and `buildScopeRuntime.ts`, so they can't drift). In orchestrate mode the root gets a lean `orchestratorSystemPrompt` that lists ONLY the tools it has and makes "delegate first" unmistakable — no work-tool advertising, no "read the blackboard FIRST". With no fleet present it falls back to the unchanged hands-on `directCoderSystemPrompt`.
  - **Trimmed the root's tools to four** — `run_agent`, `wait_for_agents`, `send_message`, `update_plan`. The scheduling tools (`schedule`/`list_scheduled_jobs`/`cancel_scheduled_job`) and blackboard tools (`blackboard_post`/`blackboard_read`) — the exact ones the model fixated on — are removed from the root (still available to sub-agents/the daemon).
  - **The loop breaker now catches the real spin.** It was defeated by `update_plan` (whose args change every turn). The signature is now keyed on RESULTS (not args) and counted as no-progress-over-the-run (a novel result resets the counter), so an interleaved `[list+blackboard] ↔ update_plan` spin trips once each signature has been seen.
  - **Evals fixed.** Three suites (`swarm`, `researchEfficiency`, `delegationDecision`) now opt into the fleet (`includeFleet: true`) — without it the lead is `UnknownAgent` and they scored 0. `delegationDecision` is reconciled to the orchestrator reality (coding → coordinator, investigation → research-coordinator, pure interaction → direct). And the `orchestratorPurityScore` "root didn't code" check — vacuously 1.0 now that the root _can't_ code — additionally requires a real delegation, so a root that loops on housekeeping scores 0.

  Guarded by tests that run in CI: the orchestrate prompt is asserted to list only the four tools and contain no work-tool / blackboard language; the breaker catches the interleaved spin; the purity scorer fails a no-delegation loop.

- 916c43f: fix(swarm): a hung sub-agent no longer strands the fleet "checking for agents that never ran" — three layered recoveries + the degenerate-loop breaker that wasted the run.

  A real `efferent code` run looked completely dead: the root spawned a sub-agent (`run_agent` → `{ status: "running" }`), then looped `wait_for_agents` forever while the node sat `running` with **zero** turns. Root cause was two compounding failures, both fixed:

  - **The spawned sub-agent's first model call silently stalled** (a gateway connection that returns no bytes and no error). Nothing caught it: the exit finalizer only fires when the fiber EXITS (a parked fiber hasn't), and the mid-session sweeper only flips a node whose fiber is no longer on the bus (a parked fiber still is). So the node stranded `running` for up to ~20 min while the parent's `wait_for_agents` looped blind. Now a **stall watchdog** races every spawned run: no progress (no turn start, tool result, narration, or LLM retry) for `SUBAGENT_STALL_DEADLINE_MS` (180s) → interrupt → record a clear `STALL_NOTE` error → notify the parent, which unblocks. Retries count as progress, so a call weathering a transient overload is never killed; a tiny injected deadline unit-tests it without a real wait.
  - **The per-request LLM timeout was 5 min** — far too long for a backgrounded run with nothing on screen. Cut to **2 min** (`LLM_REQUEST_TIMEOUT_MS`, all four custom adapters), below the watchdog deadline, so a stalled connect aborts → retries (visible) before the watchdog has to kill the run.
  - **The root burned ~30 turns calling the same tool** (`list_scheduled_jobs`, identical args, identical empty result) before doing anything — saturating the gateway and wasting the run. A **degenerate-repeat circuit breaker** in the agent loop (mirroring the existing malformed-output breaker) detects an identical call+result signature repeating: it nudges once, then force-stops. Pollable tools (`wait_for_agents`, `bash_output`) and calls that return new info each time never trip it.

  Guarded by deterministic tests that run in CI (`bun test`): the watchdog kills a hung sub-agent and records the stall (and does NOT kill a healthy one); the breaker stops a same-call/same-result spin (and does NOT stop a legitimate poll or a progressing loop); the request timeout is pinned at 2 min, below the watchdog deadline.

- 1146133: fix(budget): the sub-agent token budget no longer bills cached context at full price — and a research subtree can't bleed into implementation.

  A real run (`investigate … and propose a plan to fix`) exhausted the 4M per-turn pool on ~500K of actual work, then the research-coordinator did the "fix" itself on inline coders that starved. Investigation traced it to three compounding bugs:

  - **Accounting (root cause).** `usageCost = inputTokens + outputTokens` counted the _whole_ re-sent prompt every turn, including the cached prefix. The run's recorded usage was **97.7% cache reads** — and a multi-turn fleet re-sends its (byte-stable, cached) context every turn, so the pool drained ~8× faster than the provider actually bills. efferent's cache-prefix design was being _penalized_. Now cache reads are billed at `CACHE_READ_COST_FACTOR` (0.1×, matching provider pricing): `usageCost = (input − cacheRead) + cacheRead×0.1 + output`. A genuine runaway (new context/fetches/output) still trips the brake; only efficient cache reuse stops being taxed.
  - **Exhaustion message.** A drained pool told the model to _"do the remaining work yourself instead of spawning"_ — which collapsed an entire fleet onto the root/coordinator. It now says to wrap up, return the best partial result, and note remaining work for the caller to pick up in a fresh turn (with its own budget) — never to switch to doing it inline.
  - **Research role boundary.** A `research-coordinator` (read-only by design) could still spawn write-capable inline workers via `run_agent({ instructions, tools })` — or a bare `run_agent({ folder, task })`, which silently got the _full_ coding toolkit. A research subtree is now marked on `RunContext`, and every spawn inside it is constrained to read-only (mutating tools stripped; a bare spawn becomes a read-only research worker) and a code-`coordinator` spawn is refused — so "fix the findings" returns as a recommendation for the root to implement.

  The per-turn pool was already per-user-message (not per-conversation); the felt "ran out for the whole conversation" was the accounting bug exhausting the per-turn pool ~8× early.

- 14027e4: fix(verifier): structured (provider-enforced) verdicts — no more "could not parse a verdict"; plus a non-vacuous research-read-only guard.

  A live run hit `⚠ verifier UNAVAILABLE — work NOT verified: could not parse a deliverable verdict`. claude had answered fine (43–56s, three times) — the failure was the **extractor**: the gate ran the `claude` CLI (`--output-format json`, a free-text answer) and scraped the verdict with a greedy `/\{[\s\S]*\}/`. An Opus assessment of CODE is full of braces, so the greedy span swallowed the prose into an unparseable blob. The CLI has no schema-enforced output mode, so _some_ parsing was unavoidable on that path.

  - **Structured verdicts (the real fix).** A new `StructuredVerifierLive` judges with Opus via `generateObject` and a Schema — a **provider-enforced** `{ verdict, assessment, reasons }`. A parse error is structurally impossible. Independence is preserved by a controlled validator system prompt (no project narrative) + a pinned model (`EFFERENT_VERIFY_MODEL`, default `anthropic:claude-opus-4-8`); a code gate embeds the changed-file contents in the prompt to check against ground truth. **Prose feedback is preserved, not lost** — `assessment` is a first-class field that leads the `reasons` fed back to the retry loop. Fail-soft as before (any error → `VerifierError` → caller falls back to the architect). The old `claude`-CLI verifier (`ClaudeHeadlessVerifierLive`) is removed.
  - **Research read-only guard, de-vacuumed.** The `researchReadOnly` eval scorer scored 1 whenever the fleet wrote nothing — which is trivially true when the root never delegated (the live run's actual behavior), a false pass. It now scores 1 only when the fleet ran AND wrote nothing; a no-delegation run scores 0 with a clear detail, so the read-only property is never claimed without being exercised.
  - **Deterministic Fix-3 wiring test.** `constrainToReadOnly` was unit-tested, but the `researchSubtree` flag → handler path wasn't. New tests drive the real `run_agent` handler: with `researchSubtree` set, `agent:"coordinator"` is refused (`ResearchStaysReadOnly`); without it, the same spawn proceeds — proving the flag is what gates it.

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
