# @xandreed/evals

## 0.2.4

### Patch Changes

- Updated dependencies [590ee3d]
- Updated dependencies [590ee3d]
- Updated dependencies [590ee3d]
- Updated dependencies [f563406]
- Updated dependencies [590ee3d]
  - @xandreed/sdk-core@0.6.0
  - @xandreed/sdk-adapters@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [b8bc864]
  - @xandreed/sdk-core@0.5.1
  - @xandreed/sdk-adapters@0.4.2

## 0.2.2

### Patch Changes

- e6eeb32: Make the swarm verify its own work before delivering, instead of shipping non-compiling code.

  The multi-agent fleet could report a coding task "done" on code that didn't even type-check: the project's own conventions (`AGENT.md`, e.g. "run the project's checks") only reached the ROOT prompt, never the sub-agents that write code; the specialists' instructions made verification optional ("run the checks you can"); and the independent Opus verifier ran read-only (`--permission-mode plan`) so it structurally couldn't run a build, rubber-stamping a prose summary.

  - **Sub-agents inherit the project's conventions.** The pre-rendered instruction files (`AGENT.md` / `CONSTRAINTS.md`) now thread into every spawned sub-agent's prompt, so a coder learns _this_ project's build/verify command and hard rules — the general mechanism (à la injecting the repo's guidance into every agent), project-specific content, no hardcoded command.
  - **"Done" means verified working.** The sub-agent return contract and the specialist/coordinator/architect prompts now require running the project's own checks and fixing failures before returning; the architect must actually run the checks for a `SOUND` verdict.
  - **The verifier can actually verify.** The Opus deliverable gate now runs the repo's read-only checks (Bash allowed, edits denied) instead of judging prose in read-only mode, and the per-coordinator gate aggregates its whole subtree's changed files so a nested writer is seen as code, not prose.
  - **A new `swarm-compile` eval** type-checks the fleet's produced code in-process (`runScenario`'s `typecheck` option), the discriminator `bun test` can't provide.

- Updated dependencies [e6eeb32]
  - @xandreed/sdk-core@0.5.0
  - @xandreed/sdk-adapters@0.4.1

## 0.2.1

### Patch Changes

- 14027e4: fix(verifier): structured (provider-enforced) verdicts — no more "could not parse a verdict"; plus a non-vacuous research-read-only guard.

  A live run hit `⚠ verifier UNAVAILABLE — work NOT verified: could not parse a deliverable verdict`. claude had answered fine (43–56s, three times) — the failure was the **extractor**: the gate ran the `claude` CLI (`--output-format json`, a free-text answer) and scraped the verdict with a greedy `/\{[\s\S]*\}/`. An Opus assessment of CODE is full of braces, so the greedy span swallowed the prose into an unparseable blob. The CLI has no schema-enforced output mode, so _some_ parsing was unavoidable on that path.

  - **Structured verdicts (the real fix).** A new `StructuredVerifierLive` judges with Opus via `generateObject` and a Schema — a **provider-enforced** `{ verdict, assessment, reasons }`. A parse error is structurally impossible. Independence is preserved by a controlled validator system prompt (no project narrative) + a pinned model (`EFFERENT_VERIFY_MODEL`, default `anthropic:claude-opus-4-8`); a code gate embeds the changed-file contents in the prompt to check against ground truth. **Prose feedback is preserved, not lost** — `assessment` is a first-class field that leads the `reasons` fed back to the retry loop. Fail-soft as before (any error → `VerifierError` → caller falls back to the architect). The old `claude`-CLI verifier (`ClaudeHeadlessVerifierLive`) is removed.
  - **Research read-only guard, de-vacuumed.** The `researchReadOnly` eval scorer scored 1 whenever the fleet wrote nothing — which is trivially true when the root never delegated (the live run's actual behavior), a false pass. It now scores 1 only when the fleet ran AND wrote nothing; a no-delegation run scores 0 with a clear detail, so the read-only property is never claimed without being exercised.
  - **Deterministic Fix-3 wiring test.** `constrainToReadOnly` was unit-tested, but the `researchSubtree` flag → handler path wasn't. New tests drive the real `run_agent` handler: with `researchSubtree` set, `agent:"coordinator"` is refused (`ResearchStaysReadOnly`); without it, the same spawn proceeds — proving the flag is what gates it.

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
  - @xandreed/sdk-adapters@0.4.0

## 0.2.0

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
  - @xandreed/sdk-adapters@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [434194b]
- Updated dependencies [f03483e]
- Updated dependencies [f03483e]
  - @xandreed/sdk-core@0.3.0
  - @xandreed/sdk-adapters@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [b10f2b9]
- Updated dependencies [f2d8f12]
- Updated dependencies [5f01464]
- Updated dependencies [3dc24ae]
- Updated dependencies [6b612ed]
  - @xandreed/sdk-core@0.2.0
  - @xandreed/sdk-adapters@0.2.0
