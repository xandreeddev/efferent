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
bun run eval quality --config packages/evals/dataset/configs/code-tier.json
```

Runs the golden set across each config (e.g. no-code-tier vs deepseek-code-tier)
and prints the per-config scorecard + comparison — "which model should back the
code tier?".

> Note: the first real baseline is pending a credited provider on this machine
> (`google` is out of credits; the opencode/anthropic/openai creds in
> `auth.json` weren't resolving through the eval auth path). Export
> `OPENCODE_API_KEY` (above) to bypass that, or re-`:login` opencode in the TUI
> to rewrite `auth.json` in the current format.
