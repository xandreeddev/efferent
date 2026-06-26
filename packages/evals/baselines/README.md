# Committed eval baselines

A **baseline** is a dated, git-stamped snapshot of a quality-eval run, committed
here so a later run can be compared against it — the answer to *"did this change
actually help?"*. Ad-hoc runs go to `packages/evals/results/` (gitignored);
the reference snapshots live here, in git.

## Generate a baseline

The eval runs the **real** agent loop, so it needs a working, credited provider.
Keys are read from the **environment** when set (`EnvAuthStore` — CI path), else
from `~/.efferent/auth.json` (`LocalAuthStore` — local path). Use a DISTINCT
`--code` model so the code-delegation routing is actually exercised.

```bash
# opencode (cheap gateway, distinct tiers) — export your key so the env path is used:
OPENCODE_API_KEY=<your-key> bun run eval quality \
  --main opencode:kimi-k2.6 \
  --code opencode:deepseek-v4-pro \
  --fast opencode:deepseek-v4-flash \
  --samples 3 \
  --save packages/evals/baselines/$(date +%F)-quality.json \
  --label "baseline"
```

Then commit the produced JSON. `--samples 3` runs each scenario 3× and records
mean ± stdev so the baseline carries its own noise floor.

## Compare a later run against it

```bash
OPENCODE_API_KEY=<your-key> bun run eval quality \
  --main opencode:kimi-k2.6 --code opencode:deepseek-v4-pro --fast opencode:deepseek-v4-flash \
  --compare packages/evals/baselines/2026-06-25-quality.json
```

The report prints, per suite, the mean delta + a **bootstrap 95% CI** of the
paired per-case delta and a verdict: `✔ better` / `✘ worse` (CI excludes 0) or
`~ noise`. Significant-and-positive is the bar a change must clear.

## Model comparison (matrix)

```bash
# does having a code tier help at all? (no-tier vs deepseek-tier)
bun run eval quality --config packages/evals/dataset/configs/code-tier.json

# which model should back the code tier? (general+fast held constant, code varied)
# code-tier choice only moves CODE quality, so filter to the coding scenarios:
QUALITY_FILTER="bug-fix,feature,refactor" \
  bun run eval quality --config packages/evals/dataset/configs/code-model-matrix.json --samples 3
```

Each `--config` is an array of `RunConfig`; the run prints a per-config scorecard
plus a comparison of every config against the **first** (the comparison baseline),
with the paired-delta bootstrap CI + a `✔ sig. / ✘ sig. / ~ noise` verdict.

> **Finding (2026-06-26, N=3 — `code-model-matrix.json`, deepseek-v4-pro vs glm-5.1
> vs qwen3.7-max vs minimax-m3, kimi general).** All four are **quality-equivalent**
> on the golden coding scenarios — every delta is `~ noise` (CI includes 0). These
> tasks (one-line bug fix, add a pure function, two-file rename) saturate at ~1.0 for
> any competent coder, so the suite can only separate code models on **cost/latency**:
> `deepseek-v4-pro` is the leanest (incumbent — keep it), `minimax-m3` ties it,
> `qwen3.7-max` costs ~40% more tokens for no quality gain. **To rank coders on
> quality, add harder scenarios** (the `repo-tasks` / `whole-task` suites: real
> `bun test`, multi-file, trickier logic) — the current golden set can't discriminate.

## Committed baselines

| file | what it captures |
|------|------------------|
| `2026-06-25-quality.json` | **before** — the untuned `# Writing code` policy. Coding scenarios route to the code tier 0% of the time (the root edits directly on general); read-only QA correct. Overall 0.82. |
| `2026-06-26-quality.json` | **after** — the tuned hard-rule delegation prompt + the multi-file judge fix (the rubric judge now sees every read-back file, not just `expect.file`, so the rename's `use.ts` is graded). Coding routing reliably hits the code tier; QA unchanged. Overall 0.99, Δ +0.17 over the 06-25 baseline (95% CI [0.05,0.29] → significant). |

> **Read routing as a rate, not a constant.** Code-tier delegation is prompt-driven, so it has real run-to-run variance — at N=5 the coding scenarios measured ~0.8–1.0 routing across separate runs. The `2026-06-26` snapshot happened to land at 1.0 on every coding case, so its per-case stdev reads 0.00, which **understates** that variance. A later run dipping to ~0.8 on a single coding scenario is within noise, not a regression — trust the `--compare` bootstrap-CI verdict (`✔ better` / `✘ worse` / `~ noise`) over a raw per-case delta. Re-run with `--samples 5+` when you need a tighter read.
