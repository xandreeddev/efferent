---
title: The harness doctrine
description: Agent = Model + Harness. Validation and looping are enforced in deterministic code; the gate declares victory, never the model.
---

Every agent in this repo is built to four sentences:

> **Agent = Model + Harness.** Validation and looping are **enforced in
> deterministic code, never advisory**. The **gate declares victory**, not the
> model. **Validation-oracle strength drives harness investment.**

## What that means in practice

**The model proposes; the harness disposes.** A capable model with tools will
happily announce success. Nothing in this codebase takes its word: smith's
forge run is accepted only when the gate pipeline (typecheck, tests, the
spec's own named checks) exits green; math grades every answer server-side
with exact rational arithmetic; canvas rejects any page that fails the UI
gates and hands the findings back as data; social's drafts cannot reach X
without a human keypress.

**Enforced, not advisory.** Prompting a model to "make sure the tests pass"
is advisory. Running the tests in a deterministic gate whose failure re-enters
the loop as the next brief is enforcement. The difference is structural: an
advisory rule degrades with model mood; an enforced rule cannot.

**Oracle strength drives investment.** The stronger your validation oracle,
the more autonomy the agent earns:

| Agent | Oracle | Harness consequence |
| --- | --- | --- |
| smith | typecheck + tests + spec checks (strong) | full forge autonomy, bounded attempts |
| math | exact grading against the item's own key (strong) | instant server grading, no model round-trip |
| canvas | deterministic UI gates (medium) | one output channel, every render gated |
| social | none worth trusting (weak) | draft-only tools, human approval, policy gates at two chokepoints |

**Failures are data.** A malformed tool call, a rejected render, a gate
finding — each returns to the model as structured feedback in the same run.
The loop's job is to make the next attempt better-informed, not to hide that
the last one failed.
