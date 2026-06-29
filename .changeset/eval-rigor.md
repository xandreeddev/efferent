---
"@xandreed/sdk-core": minor
"@xandreed/sdk-adapters": minor
"@xandreed/evals": minor
---

eval rigor: determinism, multi-sample defaults, a regression gate, judge calibration, dataset files, and a coverage map.

The eval framework already had a strong statistical core (paired cluster-bootstrap CIs, Cohen's d, pass@k/pass^k, a committable baseline) — but it was undermined by weak defaults and missing data-engineering discipline. This closes six gaps:

- **Determinism** — a `samplingTemperature`/`samplingSeed` on `Settings`, threaded to the provider call (the opencode adapter sends them in its request body; Google/OpenAI/Anthropic via their config). Eval runs pin temperature **0 + a seed** by default (both the `--config` and bare paths), so a measured delta is the change, not sampling noise.
- **Rigor by default** — the runner now runs **N=3 samples** per case by default (was 1), so a bare `bun run eval` reports mean ± stdev + pass@k/pass^k, not a single draw. `--samples 1` opts out; a suite's own `samples` still wins. (The framework library keeps its conservative default of 1.)
- **Regression gate** — `bun run eval --compare <baseline>` now FAILS on a statistically significant regression (paired bootstrap CI excluding 0, Bonferroni-corrected — `regressionVerdict`), not just prints it. A `.github/workflows/evals.yml` runs the gate on labeled PRs / manual dispatch (secret-guarded, cost-gated).
- **Judge calibration** — the binary κ/TPR/TNR harness gains **continuous-score metrics** (MAE/RMSE/bias/Pearson/Spearman) + a **length-bias probe**, run over an adversarial human-labeled golden set (length traps, brevity, fabricated citation, confident-falsehood). `bun run eval --judge-agreement` reports both; `--strict` gates on it.
- **Dataset files** — versioned, Schema-validated dataset JSON with `tags`/`difficulty` stratification metadata (`loadDataset`), carried onto the `eval.case` span; `tool-selection` migrated as the template.
- **Coverage map** — `coverage.ts` maps every coding tool to the suite(s) that exercise it; `coverage.test.ts` fails if a new tool is added without a coverage decision (the gap the background/tmux tools fell through). Adds a `background-shell` behavioral eval for the new `run_in_background`/`bash_output`/`kill_bash` tools.
