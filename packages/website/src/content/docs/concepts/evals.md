---
title: Evals — scenario packs
description: Ordered steps over real agent worlds, deterministic evidence checks, and committed baselines compared by default.
---

`@xandreed/scenarios` sits at the top of the package graph — the only package
allowed to import the agents — and treats each agent's definition-of-done as
what it really is: **a full scenario**, not a one-shot input/output pair.

## The shape

A pack is a list of scenarios; a scenario is **ordered steps** over a real
agent world — boot the workspace TUI, type an idea, `:lock`, `:forge`, read
the dashboard — and **deterministic evidence checks** over three sources the
framework captures as data:

- the **event trail** (the session ledger, in order),
- the **persisted conversation** (the same SQLite trail the TUI resumes from),
- the **workspace** (files the run actually wrote).

"After the lock, the spec file's status is `locked`" and "the forge events
follow the lock event" are one-line checks, not hand audits of a database.

## Baselines by default

Every pack has a **committed baseline** compared on every run — foundry's
ratchet UX applied to agent quality. `bun run scenarios` (and CI) fails on
regression without anyone remembering a flag. The **scripted twins** — the
same scenarios driven by scripted models — run key-free in CI; live-keyed
runs use the same packs against real providers.

## Honest limits

Scripted twins validate the harness, the folds, and the wiring — they cannot
catch a live-provider defect (a response-shape change, a field the gateway
renamed) or rendering under real load. Those classes are covered by the
frame-level TUI battery (the real renderer, headless) and by live smoke runs;
when a live bug ships anyway, the rule is: reproduce it, fix it, and land the
regression at whichever layer would have caught it first.
