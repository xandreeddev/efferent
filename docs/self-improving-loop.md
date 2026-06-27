# The Self-Improving Loop

> Status: **implemented** (core loop shipped — `efferent distill`). Origin: the Movez article
> *"The Self-Improving Loop: a 300-agent swarm on Kimi K2.6, verified by Opus 4.8"* — a 10-step
> playbook for a swarm that **compounds**: every run leaves behind a reusable skill + a constraint
> that stops the next run repeating today's mistake. *"The engine learns. The closer keeps it
> honest."* This doc is the design **and** the as-built map; the literature-grounded improvements
> over the article are in *Prior art* below.
>
> **What shipped** (`bun run typecheck` + 820 unit tests green; live-verified):
> - **The online swarm loop (validate → learn → retry)** — the coordinator
>   (`cli/usecases/teamAgents.ts`) runs the Kimi swarm, the Kimi architect reviews each piece, then
>   the **independent Opus gate** validates the whole deliverable via `verify_with_gate` →
>   `Verifier.gate`; on `needs_work` it learns (`note_constraint`) + retries until `sound` or the
>   `maxLoopAttempts` cap. **Automatic** for substantial tasks (`autoLoop`, default on); **fail-soft**
>   (no `claude` → fall back to the architect). *Live-verified: Opus returns `sound` for a truthful
>   deliverable, `needs_work` with a concrete reason when the summary lies about the code, and a
>   `VerifierError` (→ fallback) when `claude` is absent.*
> - **Reflector** — `distill()` / `runDistillation()` (`sdk-core/usecases/distill.ts`), fast tier.
>   Fires **automatically at each turn boundary** (`autoDistill`, default on, `cli/actions/submit.ts`)
>   + the `efferent distill` CLI for backlog mining. *Live: `distill` eval passes 100%.*
> - **Verifier** — `Verifier` port (`sdk-core/ports/Verifier.ts`, two methods: `refute` learnings
>   fail-closed, `gate` deliverables fail-soft) + `ClaudeHeadlessVerifierLive`
>   (`sdk-adapters/src/verifier/claudeHeadless.ts`): Opus via `claude -p` in the repo dir.
> - **Curator** — `persistArtifact()` (`sdk-core/usecases/persistArtifact.ts`): deterministic
>   delta-item merge, never a wholesale rewrite.
> - **Loader** — `.efferent/CONSTRAINTS.md` auto-discovered into a `# Constraints` prompt section
>   (`cli/usecases/discoverInstructionFiles.ts`). *Skills/constraints load at runtime — verified.*
> - **Settings** — `autoLoop` / `autoDistill` (default on), `maxLoopAttempts` (default 3).
> - **Evals/tests** — `distill` suite + the gate adapter path (`claudeHeadless.test.ts`, stub Shell)
>   + the fail-closed/threshold orchestration + the delta-merge.
>
> **Designed-not-built**: a daemon-integrated scheduled distill, the helpful/harmful counter
> feedback, embedding dedup + the SkillOps maintenance pass, and dedicated `gate_*`/`distill_*` TUI
> event variants (today the gate/learn steps surface as the coordinator's `verify_with_gate` /
> `note_constraint` tool pills + a `learned N lessons` rail line).

## How to use it

**It's automatic — there's nothing to invoke.** Two behaviors run on by default:

1. **The swarm loop** (`autoLoop`, default on). When you give the agent a task substantial enough
   that it delegates to the fleet, the coordinator runs the Kimi swarm, the architect reviews each
   piece, then the **Opus gate** validates the whole deliverable and the coordinator **learns +
   retries** until it passes (or hits `maxLoopAttempts`, default 3). You watch it happen in the TUI:
   the coordinator's `verify_with_gate` / `note_constraint` calls show as tool pills, and a learned
   rule lands in `.efferent/CONSTRAINTS.md`.
2. **Turn-end distillation** (`autoDistill`, default on). After each finished turn the runtime
   mines the conversation in the background for reusable skills/constraints, Opus-verifies them, and
   saves the survivors under `.efferent/` — you see a `learned N lessons for next time: …` line.
   Those auto-load into the next run (skills/memory as prompt index, constraints as `# Constraints`).

**Prerequisites.** The swarm + miner need a logged-in provider (`:login`, Kimi by default). The Opus
gate needs the **`claude` CLI on your PATH**, logged into Claude Code — that's the cheap-subscription
path. **Without `claude` it's fail-soft**: the gate reports unavailable and the coordinator falls
back to the architect's verdict, so your task never blocks; you just don't get the Opus sign-off.

**Knobs** (`:set …`, or `config.json`):
- `autoLoop on|off` — the Opus gate + retry (off → the old single architect cycle). *Applies next launch.*
- `autoDistill on|off` — turn-end learning (off → use `efferent distill` manually). *Applies live.*
- `maxLoopAttempts <1-10>` — gate rounds before delivering what it has (1 = gate once, no retry).
- Env: `EFFERENT_CLAUDE_BIN` (default `claude`), `EFFERENT_VERIFY_MODEL` (default **pinned**
  `claude-opus-4-8`; set `opus` if the id is unknown), `EFFERENT_VERIFY_ARGS` (default
  `--permission-mode plan`, read-only).
- **Clean-room.** The gate runs in an isolated sandbox cwd under a CONTROLLED validator `CLAUDE.md`
  (not the project's `AGENT.md`), reaching the repo READ-ONLY via `--add-dir` ONLY for code-related
  checks (a `project`-scoped learning, or a deliverable with file changes) — a general rule or a
  prose deliverable is judged on its own merits. **Airtight:** `HOME` points at the sandbox with ONLY
  claude's credentials (`~/.claude/.credentials.json`) copied in — it authenticates but loads NO
  global `CLAUDE.md`/memory/config (verified: inherited context drops to ~nothing); a keychain-only
  setup falls back to HOME-intact (the sandbox cwd still excludes the project narrative). The
  independence matters most for Phase 2, where the gate validates an edit to the agent's OWN instructions.

**Manual / backlog mining.** Mine past conversations from the DB on demand:
```
efferent distill --dry-run --limit 5        # show what it WOULD learn (cheap miner only, no claude)
efferent distill --since 2026-06-20         # mine + Opus-verify + save the survivors
efferent distill --conversation <id|prefix> # just one conversation
```

## The one idea worth stealing

efferent already **is** the thing the article tells you to build by hand:

- a **swarm on Kimi** — Kimi (via the opencode gateway) is the default provider, and the sub-agent
  fleet + context tree (`buildScopeRuntime.ts`, `agentBus.ts`) is the parallel-agent substrate;
- a **persistent record of every run** — `ConversationStore` (messages, checkpoints) +
  `ContextTreeStore` (`AgentContextNode`: `returnSummary`, `filesChanged`, `usage`, `status`,
  `workspaceRef`);
- a **background scheduler** — the cron daemon (`modes/daemon.ts`, `usecases/schedule.ts`,
  `JobController.submitJob`).

So the article's "run 300 agents" half is **already shipped**. What efferent is missing is the
**compounding** half — the part the article is actually about:

> "The swarm that ran your task yesterday should be smarter than the one running it today."

Right now efferent's runtime is amnesiac between conversations. Each run starts from the same
system prompt it had on run #1. **Nothing is left behind.** Skills exist
(`.efferent/skills/*.md`) but are **strictly hand-authored — there is no programmatic write
path** (`loadSkills.ts` reads, `read_skill` reads, nothing writes). Memory exists
(`.efferent/memory/*.md`) and *does* have a write path (the `remember` tool,
`codingToolkit.ts:1045`), but only the agent-in-the-loop writes it, in the moment — never mined
from a finished run, never independently verified.

**The proposal:** close the loop. As the daemon runs real tasks, mine each finished conversation
for candidate learnings (cheap engine — Kimi/`fast` role), put every candidate through a single
**Opus verify gate** that can only *refute*, and persist the survivors as skills / memory /
constraints that the **next** run inherits automatically. Because everything is already in the DB,
the same machine can **replay months of past conversations** and distill them retroactively.

The verify gate runs **Opus via the real `claude` Claude Code headless CLI** — that is the
sanctioned path to the Opus *subscription* rate (an API key would be billed per-token); it's also
the cleanest "independent grader," a separate process the engine can't influence, exactly the
`JudgeModel`-is-separate-from-`LanguageModel` principle the evals already encode.

## Prior art — the best version improves on the article

The Movez article is a good *playbook* but a naive *design*. The 2023–2026 literature on
self-improving agents fixes three real flaws, and we adopt the fixes:

- **ACE — Agentic Context Engineering** (Stanford / UC Berkeley / SambaNova, Oct 2025,
  [arXiv:2510.04618](https://arxiv.org/abs/2510.04618)). Treats the evolving context as a
  *playbook* maintained by three roles — **Generator** (does the task), **Reflector** (distills
  lessons from the trace), **Curator** (merges lessons as **delta items** via *deterministic,
  non-LLM* logic). Its central warning is **context collapse**: when an LLM is asked to *rewrite*
  an accumulated context, it compresses it into a short, generic summary and loses information
  (their measured example: 18,282 tokens at 66.7% accuracy → **122 tokens at 57.1%** after one
  monolithic rewrite). The fix is **incremental delta updates** — each item is a bullet with a
  stable id + helpful/harmful counters + content; new ids are appended, existing ones updated in
  place, then de-duplicated by embedding ("grow-and-refine"). **The article's step 6 — "save the
  whole workflow as a Skill" — is exactly the monolithic move ACE proves is harmful.**
- **AWM — Agent Workflow Memory** (ICML 2025, [arXiv:2409.07429](https://arxiv.org/abs/2409.07429)).
  Induces reusable workflows from past trajectories. Its lesson: *"the routine, not the raw log"* —
  **abstract** run-specific values (paths, ids, the exact filename) into templated variables and
  keep the reusable sub-routine; induce at **fine granularity**, and **gate on success** (only
  successful trajectories become skills). Offline (mine a corpus once) **and** online (induce after
  each task) — we want both.
- **SkillOps** (2026, [arXiv:2605.13716](https://arxiv.org/abs/2605.13716)). A growing library
  accrues *skill technical debt*. Track **Utility** (fraction of recent tasks that actually used a
  skill), **Redundancy** (near-duplicates), **Failure-Risk** (empirical failure rate). Maintenance
  ops: `merge`, `retire`, `repair`. Retention rule: `retire(s)` only when `utility(s) < θ` **and** a
  duplicate exists — never lose unique functionality.
- **Reflexion** ([arXiv:2303.11366](https://arxiv.org/abs/2303.11366)) + **Voyager**
  ([arXiv:2305.16291](https://arxiv.org/abs/2305.16291)). Store *failures* as verbal lessons
  (→ our constraints), and retrieve a skill library by relevance, not by dumping it wholesale.

**Net: keep the article's thesis** (cheap engine learns, one expensive model closes, persist only
survivors) **but build the disciplined version:**

1. **Three roles, and the merge is deterministic.** Reflector (cheap/Kimi) extracts lessons →
   Verifier (Opus, the gate) refutes → **Curator (non-LLM code) merges delta items**. No LLM ever
   rewrites a library file wholesale — that's the ACE context-collapse rule, and it doubles as our
   prompt-cache-safety rule.
2. **Artifacts are delta items, not monolithic dumps.** A constraint/skill is a bullet with a
   stable id + helpful/harmful counters + abstracted content. Append/update-in-place; dedup by
   similarity. Skills abstract the run-specific specifics away (AWM).
3. **The verifier is evidence-grounded, not text-only.** `claude -p` runs **in the repo dir**, so
   Opus reads the real files / greps / runs the cited test to refute against ground truth — strictly
   stronger than the article's text check *and* than the evals' current `llmJudge`.
4. **Library maintenance is a first-class pass** (SkillOps-lite): utility counters, retire-when-
   duplicate, dedup — so the compounding library stays healthy instead of rotting.

## The 10 steps → efferent surfaces

| # | Article step | efferent today | Gap |
|---|---|---|---|
| 1 | Write a spec, not a prompt | delegation policy + `update_plan` tool | — (prompt discipline) |
| 2 | Read the decomposition plan first | the coordinator drafts a plan; `:tree` shows the fleet | — |
| 3 | Let it be wasteful (parallel waves) | the fleet fans out; shared token pool bounds spend | — |
| 4 | Demand real files, not chat | `write_file`/`edit_file`; `filesChanged` recorded per node | — |
| 5 | **Point the honest model at the output, ask what's wrong** | `llmJudge` scorer + separate `JudgeModel` exist **in evals only** | **the verify gate isn't in the runtime** |
| 6 | **Save the workflow as a Skill** | skills are **read-only** | **no skill write path** |
| 7 | Feed your documents in as knowledge | `read_file`, memory | — (covered by 6's write path) |
| 8 | **Turn verify feedback into a permanent rule** (`CONSTRAINTS.md`) | nothing auto-loads constraints | **no constraints loader** |
| 9 | Replay the skill — cost collapses | skills/memory inject into the prompt | — (works once 6/8 land) |
| 10 | **Promote the loop to a background agent** | cron daemon + `schedule.ts` | **no standing "distill" job** |

The gaps are exactly four: **(5) the verify gate**, **(6) the skill write path**, **(8) the
constraints loader**, **(10) the distill job**. Everything else already exists.

## Architecture — three use-cases + one port, all composing existing substrate

On-thesis: this is Effect services and colocated evals, not a bolt-on. New code lives in
`sdk-core/usecases/` (pure, over ports) with one new port and adapters at the edge.

### 1. `Distiller` — the Reflector (cheap engine: Kimi / `fast` role)

`distill.ts` (`sdk-core/usecases/`). The ACE **Reflector**: read a finished conversation
(`ConversationStore.list(id)`) and/or its context-tree subtree
(`ContextTreeStore.listTree` → `status` + `returnSummary` + `filesChanged` + the failing→passing
transitions) and distill lessons. Calls `UtilityLlm.complete(prompt, { role: "fast" })` — the cheap
tier, Kimi by default — to propose:

```ts
type Candidate = {
  kind: "skill" | "memory" | "constraint"
  name: string
  description: string
  body: string
  evidence: { conversationId: string; positions: number[]; diff?: string }
}
```

Three rules from the literature shape the prompt:

- **Abstract the routine, not the raw log** (AWM). The body must abstract this-run-specific paths,
  ids, and filenames into the *general* procedure — *"when X, do Y"*, not *"I edited
  `src/foo/bar.ts` line 42."* A skill that only describes one file is useless next run.
- **Gate skills on success; gate constraints on failure** (AWM + Reflexion). A `skill` is only
  proposed from a run that actually *succeeded* (node `status: "ok"`, tests green). A `constraint`
  is the opposite — a *lesson from a failure* (a mistake the run made and recovered from), so it
  never recurs.
- **Fine granularity.** One candidate = one reusable lesson, not the whole 40-step run.

`evidence` is the load-bearing field: **pointers into the real record** (message positions, the
actual diff, the test that went red→green) so the closer can *check against ground truth*, not
trust. This single use-case covers article steps 6 (workflow→skill), 7 (document→skill), and 8
(feedback→constraint): a candidate is just *whatever a run leaves behind worth keeping*.

### 2. `Verifier` — the closer (Opus via `claude -p`, the single gate)

New port `ports/Verifier.ts`:

```ts
refute(candidate: Candidate): Effect<Verdict, VerifierError>
// Verdict = { accept: boolean; score: number; reason: string }
```

Default adapter `ClaudeHeadlessVerifierLive` shells out through the **existing `Shell` port**
(`Shell.exec`, `shell/local.ts` Bun.spawn — already used for the Bash tool), **with `cwd` set to
the repo**:

```
claude -p <refute-prompt> --output-format json --model opus
```

**This is the upgrade the article misses.** Because `claude` runs *in the repo directory*, Opus
isn't a text-only judge — it's a full agent that can **read the files the candidate references,
grep for the pattern, and run the cited test** to refute against ground truth. So "is this lesson
actually true?" is *checked*, not opined. Strictly stronger than the article's text-only
verification **and** than the evals' current text-only `llmJudge`. (Restrict it to read-only tools
in the verify invocation — it inspects, it doesn't edit.)

Parse the JSON envelope's `result`, then the `{accept, score, reason}` inside it (reuse the evals'
tolerant `extractJson`/`parseJudge`, `scorers.ts:59`). The prompt is **refute, not praise**
(article step 5 — *"its only job is to refute"*). Rubric, reject-by-default:

1. **True** — does the evidence actually support the claim?
2. **General** — a reusable rule, not a one-off about this exact file/line?
3. **Non-redundant** — not already covered by an existing skill/memory/constraint?
4. **Safe** — no secrets, no `$HOME` paths, **no real-name correlators** (this tree's OPSEC rule), no destructive instruction?
5. **Preventive** — would it have stopped a real mistake this run made?

`accept` iff `score ≥ threshold` **and** no hard-fail on (4). The whole point is **fail-closed**:
no verifier, ambiguous verdict, or unparseable output ⇒ the candidate is **dropped, never
persisted** — *"stop garbage from getting saved as a skill."*

**Why shell out instead of efferent's own Anthropic-OAuth path** (which already exists —
`providers.ts:209`, `anthropicOAuthTransform`, `prependClaudeCode`): (a) the **subscription rate**
is the sanctioned Claude-Code-headless path, not the per-token API; (b) **independence** — the
closer should be a process the engine can't bias (fresh Opus context, no efferent system prompt,
no shared cache). Fallback chain when `claude` isn't on PATH: in-process OAuth Opus as a
`JudgeModel` (still Opus, efferent's client) → else **skip-persist** (never save unverified).

### 3. `Persister` — the Curator (deterministic, non-LLM merge)

The ACE **Curator**, and it is *pure code* — **no LLM rewrites a library file.** That's the
context-collapse rule (an LLM asked to fold a file into itself compresses away the detail) and the
prompt-cache rule (a wholesale rewrite invalidates the prefix) in one. Generalize the existing
`remember` write path (`codingToolkit.ts:1045` — `slugify` + frontmatter + append-not-clobber,
serialized on the `writeGate`) into `persistArtifact(displayRoot, candidate)`, writing **delta
items**:

- `constraint` → append/update a **bullet** in `.efferent/CONSTRAINTS.md`. Each line is a delta
  item: `- [<id>] (✓<helpful> ✗<harmful>) <rule>`. New id → append; existing id → update its
  counters/text in place. Never regenerate the file.
- `skill` → `.efferent/skills/<slug>.md` (frontmatter `name` + `description` + `source: distilled` +
  `evidence` + `helpful`/`harmful` counters; body = the abstracted procedure) — **the first
  programmatic skill write path**, closing gap (6).
- `memory` → `.efferent/memory/<slug>.md` (reuse `remember` verbatim).

**Grow-and-refine** (ACE): on a name/near-duplicate collision, don't blind-append — `merge` (keep
one, sum counters) per SkillOps. Dedup is similarity-based (keyword/shingle for v1 — embeddings are
a later substrate efferent doesn't have yet). A genuinely conflicting skill is routed back through
the verifier as a **supersede** decision.

### 3b. Maintenance — keep the library healthy (SkillOps-lite)

A periodic `prune` pass (its own CLI flag / a weekly cron): for each library item compute
**Utility** (was it read/retrieved in the last N runs — `read_skill` calls are already telemetry
spans, so stamp a usage counter) and **Failure-Risk** (did runs that loaded it tend to fail?).
Retention rule, straight from SkillOps: `retire(s)` **iff** `utility(s) < θ` **and** a duplicate
exists — low-value items go only when nothing unique is lost. The helpful/harmful counters on each
delta item are the substrate; wiring the increments to real run outcomes is the follow-up, but the
*format carries the counters from day one* so the data accrues.

### 4. The loader half — make the deposit actually compound

The deposit only compounds if it's **auto-loaded into the next run**. Skills
(`renderSkillsSection`, `coder.ts`) and memory (`renderMemorySection`, `sections.ts`) already
inject. The one missing loader: **constraints**. Add `loadConstraints(cwd, homeDir)` (mirror
`loadMemory`/`loadSkills` discovery: cwd → parents → `~/.efferent`) reading `.efferent/CONSTRAINTS.md`,
injected as a `# Constraints` section **at the top** of the system prompt (hard rules outrank
skills) — the article's *"loaded automatically at the start of every session."* This is the
cheapest, highest-leverage new piece: it's how *"the drift Opus flagged on run #1 becomes a hard
rule on run #2."*

## Mining the backlog — the DB is the unfair advantage

You don't only distill at conversation-end. Everything is in the DB, so you can **replay the
backlog**. New verb:

```
efferent distill [--since <date>] [--conversation <id>] [--dry-run]
```

`ConversationStore.listByWorkspace(cwd)` → roster → for each (or since a date) →
`list(id)` → Distiller → Verifier → Persister. `--dry-run` prints candidates + verdicts **without
writing** — review what the loop wants to learn before it touches the library. This is where the
cheap/expensive split pays off literally: the **miner runs on Kimi over the whole backlog** (cheap
volume — *"let it be wasteful"*); **Opus only fires on the surviving candidates** (the expensive
gate, kept small).

## Promote to a background agent (step 10)

A standing scheduled `distill` job on the cron daemon: nightly, distill the day's conversations,
fail-closed verify, persist survivors, and emit a `needs_human` `AgentEvent` for any candidate the
verifier rejected *with high confidence that the run actually shipped the mistake* — surfaced in
the TUI "decisions need you" roster (`DecisionsBar`). *"The only human left in the loop is the
question you set and the decision you make on the answer."*

## Eval the gate (the wedge: verify the verifier)

This subsystem is itself eval-able, which is the whole point of colocated evals. New suites in
`packages/evals/src/suites/`:

- `distill-skill.eval.ts` — given a known-good conversation, does the Distiller extract the
  expected skill? (`includesAll` over the body.)
- **`verify-gate.eval.ts`** — the critical one. Feed the Verifier a mix of **good** candidates
  (should accept) and **poisoned** ones (wrong / redundant / unsafe — should reject); score the
  gate's precision/recall. This is where you A/B Opus-via-`claude`-headless vs in-process OAuth
  Opus vs a cheaper judge, through the existing `--judge` / `RunConfig` config injection.

## Build status (as shipped)

- **Phase 0 — constraints loader ✅.** `.efferent/CONSTRAINTS.md` auto-discovered through the
  instruction-file channel (`discoverInstructionFiles.ts`, `kind: "constraints"`) → rendered as a
  distinct `# Constraints` section ahead of `# Instructions`. Zero `coderPrompt` signature churn,
  active in every threaded path (TUI / daemon / submit / rpc).
- **Phase 1 — distiller + dry-run ✅.** `distill()` on the `fast` role; `efferent distill --dry-run`
  mines real past conversations from the DB with no gate and no writes. Verified end-to-end.
- **Phase 2 — verifier + persister ✅.** `Verifier` port + `ClaudeHeadlessVerifierLive` (Opus via
  `claude -p`, in the repo dir, fail-closed) + `persistArtifact` delta-merge. `runDistillation`
  wires Reflector → Verifier → Curator; `efferent distill` (no `--dry-run`) runs the full loop.
- **Phase 4 — eval ✅.** A fast-tier `distill` suite scores the Reflector's discrimination
  (extracts a lesson when there is one, stays quiet when there isn't). Unit tests cover the pure
  pieces: `parseCandidates`, `renderTranscript`, the delta-merge (`persistArtifact.test.ts`), the
  fail-closed/threshold/dry-run orchestration (stub `Verifier`), and the verdict parsing
  (`claudeHeadless.test.ts`).

### Phase 3 — scheduling (step 10): partially shipped, by OS cron

`efferent distill` is a non-interactive command, so "promote to a background agent" is just a
crontab line today: `0 3 * * * cd /repo && efferent distill --since $(date -d yesterday +%F)`.
A first-class daemon-integrated nightly job (emitting `needs_human` for high-confidence rejects the
run actually shipped) is the remaining piece — the cron substrate (`schedule.ts`, `daemon.ts`,
`JobController.submitJob`) exists, but distill is a pipeline, not an agent turn, so it needs its own
job kind rather than riding the agent-prompt cron path.

## Convergence + run-over-run learning (2026-06-27)

The first cut closed the loop *as a command* (`efferent distill`) but in practice the fleet was a
one-off: distillation fired only in `efferent code`, the research fleet had no Opus validation at
all, the distiller couldn't even represent a "converge faster" lesson, and nothing hard-stopped a
researcher that over-fetched (a 2-item question burned **69 web_fetches** and never converged). Five
changes make the fleet actually learn to converge, and compound it:

- **B — deterministic convergence brake ✅.** A per-sub-agent web-lookup counter
  (`Settings.subAgentFetchBudget`, default 15, threaded `RunContext` → `ScopeBinding` →
  `makeCodingHandlers`): past the cap `web_fetch`/`search_web` refuse with a model-readable "report
  now", which `failureMode:return` turns into a graceful in-turn signal. The root coder is exempt.
  Plus a tightened research-coordinator prompt (right-size the fan-out). Live: the same task that ran
  to 69 fetches now lands at ~27 and delivers.
- **A — the loop closes on EVERY run path ✅.** `runAutoDistill` (core) is fired from the daemon
  (`inProcess.finishTurn`, which never distilled) and headless print/json (`headlessDistill.ts`,
  awaited + bounded), not just `efferent code`. A `learned` `AgentEvent` surfaces persisted lessons
  on every path.
- **C — learn the convergence lesson ✅.** Two sources, both folded into `runAutoDistill`: a
  **deterministic fleet-efficiency gate** (`efficiencyGate.ts` — reads the persisted context tree; if
  the fleet over-worked the run it persists a canonical `fleet-research-budget` constraint, no LLM,
  trustworthy by construction → no Opus gate; catches the runaway the per-worker cap can't: too MANY
  workers), and a **broadened distiller** (the miner + the Opus refute gate now admit
  process/efficiency lessons, judged on whether following the rule improves the next run).
- **D — the Opus gate reaches the research fleet ✅.** `researchCoordinatorAgent(opts)` mirrors the
  coding `coordinatorAgent`: `autoLoop` adds `verify_with_gate` + `note_constraint` and a
  VALIDATE→LEARN→RETRY phase before REPORT. `buildGatePrompt` branches — a research deliverable is
  PROSE (no files), so Opus judges the answer (addresses the task, well-sourced, honest) instead of
  reading changed files.
- **E — evals prove it ✅.** `research-efficiency` suite budgets fetches/tokens/spawns from the
  fleet-wide `ScenarioRun.trajectory` (the 69-fetch runaway scores ~0 where `swarm` scored it 1.0);
  `loopClosure.test.ts` proves the loop CLOSES deterministically (gate → `persistArtifact` →
  `discoverInstructionFiles` → `# Constraints` in the next run's prompt).

## Scope, corrections, and meta-prompts (2026-06-27)

Make the loop "learn as we go for whatever task" — across projects, from your corrections,
including the agent's own operating instructions. Every learning now carries **`scope`**
(`global | project`) and **`source`** (`user | inferred`), classified by the miner:

- **Scope routing.** `persistArtifact` writes a `global` learning under `~/.efferent/` and a
  `project` one under `<repo>/.efferent/` (the new `globalRoot` arg, threaded as `homedir()`).
  The read side was ALREADY global-aware (`loadSkills`/`loadMemory`/`discoverInstructionFiles`
  walk `cwd → parents → ~/.efferent`), so a general rule (Effect/style/language) learned in one
  project is now inherited by every project; a project-specific one stays local.
- **User corrections bypass the gate.** A rule you STATE ("use `const` not `let`", "no try/catch in
  the domain") is marked `source:"user"` (USER turns are tagged in the transcript + the miner is
  told to always capture them) and persisted DIRECTLY — no Opus refutation. The human is the
  authority; the bypass is the same "trustworthy by construction" the deterministic efficiency gate
  uses. Inferred lessons still pass the gate, fail-closed. So you state a correction once and never
  repeat it. *Bypass is additive deposits only (constraint/skill/memory).*
- **Meta-prompts — the loop edits its own operating instructions.** A new `process` learning kind
  (a rule about HOW to work — plan first, check assumptions, right-size the fleet) is filed in a
  loadable **operating-guidance overlay** `.efferent/prompts/coder.md`, discovered by the instruction
  channel and rendered as a high-priority `# Operating guidance` section (above `# Constraints`).
  Editable by hand AND by the loop — but a `process` learning **always passes the Opus gate** (the
  user-bypass NEVER applies; changing the agent's own instructions is high-stakes), and the edit is a
  deterministic delta bullet (append/update by id — ACE-safe, no LLM rewrite). The built-in
  `coderPrompt` stays the floor; the overlay is bounded by the instruction budget.

## Not yet wired (named, so it's not mistaken for done)

- **Counter feedback.** The delta-item `helpful`/`harmful` counters are written (`✓0 ✗0`) but
  nothing increments them yet — that needs a `read_skill`/retrieval → outcome signal. The format
  carries them from day one so the data can accrue once the signal is wired.
- **Embedding dedup + maintenance pass.** Dedup is name/exact-id only today; the SkillOps-lite
  `retire`/`merge` pass (utility + redundancy + failure-risk) and similarity dedup are designed
  (§3b) but unbuilt — they need an embedding substrate efferent doesn't have yet.
- **The verify gate as an eval.** The gate needs the `claude` binary (not a provider key), so it
  can't run in the key-gated eval harness; the orchestration around it (fail-closed, threshold) is
  unit-tested with a stub instead.

## Risks & guardrails (the article hand-waves these)

- **Garbage-in is worse than nothing.** A confidently-wrong skill poisons *every* future run. Hence
  fail-closed, the `verify-gate` eval, and `--dry-run` review before the first scheduled run.
- **Library bloat / contradiction.** Skills that sprawl or conflict. The verifier can double as a
  periodic prune/merge pass over the library itself. Named, deferred.
- **Cache invalidation.** Auto-writing skills/constraints changes the system-prompt prefix →
  invalidates the provider cache. That's fine (a deliberate, infrequent prefix rebuild, exactly
  like `:handoff`), **as long as distillation runs at a boundary** (nightly / conversation-end),
  never mid-session. See the compaction doc's *"one deliberate prefix rebuild"* rule.
- **Claude headless availability & limits.** `claude` may be absent; the subscription is
  rate-limited. Hence the fallback chain and keeping Opus on the *small* surviving set only.
- **OPSEC (build-in-public).** Distilled artifacts are written from real conversations and **skills
  are committable** (`.efferent/.gitignore` covers auth/config/db, not `skills/`). The verifier's
  "Safe" check is non-optional: never persist secrets, `$HOME` paths, or real-name correlators.

## Why this is on-thesis

Effect services (`Distiller` / `Verifier` / `Persister` as use-cases + a port) · colocated evals
that *verify the verifier* · the loop living **inside** the runtime, not in a LangGraph DAG on the
side. It rides a live trend (the Kimi self-improving-loop discourse) while leading with the
artifact — the diff, not the opinion. The post writes itself: *"I wired a self-improving loop into
my agent runtime. Kimi does the work and the learning; Opus is the one gate that keeps the skill
library honest; and because everything's in the DB, I can replay months of conversations and
distill them retroactively."*
