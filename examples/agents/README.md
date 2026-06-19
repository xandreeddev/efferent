# Example agent roles

Git-shareable agent **roles** for efferent. A role is a markdown file with
frontmatter (`name`, `description`, optional `model` and `tools` allowlist) and
a body that becomes the role's system-prompt instructions. Drop one in
`<workspace>/.efferent/agents/` (or `~/.efferent/agents/`) and it's discovered at
startup — selectable by the model via `run_agent({ agent: "<name>", … })` and by
you via the TUI `:spawn <agent> <folder> <task>`.

```
---
name: reviewer
description: one line shown in the prompt + pickers
model: anthropic:claude-opus-4-8     # optional — omit to inherit the session model
tools: read_file, grep, glob, ls     # optional allowlist — omit for all base tools
---
<system-prompt body>
```

Install one from a repo (no npm — just git, via the Http port):

```
:agents add github:xandreeddev/agent/examples/agents/reviewer.md
# or a whole directory:
:agents add github:xandreeddev/agent/examples/agents
```

Imported files land in `<cwd>/.efferent/agents/` and apply on the next launch.
