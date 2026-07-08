---
title: social — the drafter
description: The weakest oracle gets the strongest harness — draft-only tools, deterministic policy gates at two chokepoints, and a human between every draft and the network.
---

social finds posts worth a genuinely useful technical reply and drafts them —
into a **human review queue**, never onto the network. Of the four agents it
has the weakest validation oracle ("is this reply good?" has no deterministic
answer), so per the [harness doctrine](/docs/concepts/harness) it gets the
most structural distrust:

1. **The model cannot post.** Its only write tool is `write_draft` — a local
   markdown file. Posting exists solely inside the review queue's approve
   path.
2. **A human approves every engagement.** `[a]pprove` / `[e]dit` /
   `[d]iscard` — and replies never graduate to auto-post, permanently.
3. **Deterministic policy gates run at BOTH chokepoints** — inside
   `write_draft` (rejections return to the model with every finding) and
   again on approve, after any human edit: dedup against the ledger, daily
   and per-author caps with cooldowns, banned content, length with t.co
   weighting, a link allowlist, and a thread-context rule — a reply must
   have actually read its thread.

```bash
bun run social test     # supervised scan: search → evaluate → gated drafts
bun run social review   # the human queue
bun run social daemon   # scheduled scans
```

## The ledger is the memory

`posts/ledger.jsonl` — append-only, one row per lifecycle event (drafted,
gate-rejected, posted, discarded) with content and findings. Dedup consults
the ledger forever: a discarded draft's target never re-engages. **Policy is
data** (`posts/policy.json` over conservative defaults) — loosening a cap is
a reviewed edit, never a prompt change.
