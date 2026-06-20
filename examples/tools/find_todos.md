---
name: find_todos
description: List TODO/FIXME/HACK comments under a directory
type: shell
command: bash -lc 'grep -rnE "TODO|FIXME|HACK" ${dir} || echo "none found"'
params: dir: directory to scan (e.g. src)
timeout: 20
---
A declarative shell tool: `run_tool({ name: "find_todos", args: '{"dir":"src"}' })`.
Param values are shell-escaped before substitution; the command runs through the
same bash gate (allowBash + the approval prompt) as the built-in Bash tool.
