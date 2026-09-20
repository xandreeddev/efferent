---
title: Smith
description: The direct coding preset for the composable Efferent harness.
---

# Smith

`bun run efferent` opens Smith, the coding preset. It composes the first-party
model, loop, tool, policy, context, memory, session, MCP and telemetry plugins.

Use `/plugins` to edit options, `/model provider:model` to select a model,
`/login provider` for keys or subscription authorization, `/plan` for read-only tools, `/code` for coding,
`/context` to inspect context, `/changes` for the diff and `/sessions` to resume.

Enter sends, Shift+Enter inserts a newline, Ctrl+P opens commands and Escape
interrupts. Text entered during a run is queued as steering input.

Use `/spec idea` to draft with read-only tools, `/lock` to approve the draft,
and `/forge` to implement under Foundry gates. The workflow is a plugin and
delegates to your configured coding loop. It records drafts, locks, gate reports
and outcomes in the durable session. Host gate execution asks for approval.

The historical workflow driver remains `bun run smith:workflow` for old specs.

See the [SDK guide](/docs/concepts/harness) for composition and policy.
