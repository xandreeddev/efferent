---
title: Skills & instruction files
description: Drop markdown files in .efferent/skills/ — names inject into the system prompt, bodies lazy-load on demand.
sidebar:
  label: Skills
  order: 7
---

Skills let you ship reusable procedures to the agent **without changing code**. They're plain markdown
files discovered at startup.

## The file format

```markdown
---
name: release-checklist
description: Steps to cut a release safely.
---

(the detailed procedure the agent follows when this skill is relevant)
```

Drop these in `.efferent/skills/*.md`. The loader (`loadSkills(cwd, homeDir)`) walks `cwd → parents →
~/.efferent/skills/`; closer-to-cwd shadows farther on name collisions.

## How they reach the model

At startup, every skill's **name + description** is injected into the system prompt under a `# Skills`
section — cheap, always present. The **body** is lazy-loaded only when relevant, via a `read_skill({ name })`
tool call. So you can ship many skills without bloating every prompt.

Failures are silent by design — a missing directory or malformed frontmatter is skipped, never breaking
the agent. Instruction files (`AGENT.md`) are discovered the same way, from cwd up to home.
