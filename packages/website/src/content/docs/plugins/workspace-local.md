---
title: Local filesystem and shell
description: Provide the host machine's FileSystem and Bash services for workspace plugins on Node and Bun.
pluginId: "@xandreed/plugin-workspace/local"
---

`localSystemPlugin` connects an agent to the local disk and shell. Use it
when workspace tools, directory skills or image conversion should operate
on the same machine as the host process.

It provides services, not model tools. Add the
[workspace tools plugin](/docs/plugins/workspace-tools/) to expose file
operations to the model, or supply your own capabilities over these ports.

## Install and configure

```sh
bun add @xandreed/plugin-workspace
```

```ts
import { Agent } from "@xandreed/sdk"
import { localSystemPlugin } from "@xandreed/plugin-workspace"

const plugins = [
  {
    plugin: localSystemPlugin,
    options: { shell: "bash", killBackground: true, exitGraceMs: 500 },
  },
]

const definition = Agent.define({ plugins, workspace: "/srv/project" })
```

This is a composition fragment: merge `plugins` into the complete agent
graph from [Getting started](/docs/getting-started/), including its memory,
tool registry and loop. Build `definition` in an Effect scope. The host
still supplies sessions and the model when running turns.

## Requirements and lifetime

The plugin has no service dependencies. It builds `FileSystem` and `Bash`
once per agent definition, for all turns using that runtime.

It supports Node 24 and Bun on Linux and macOS. Paths, process groups and
shell lookup follow POSIX conventions; Windows is not supported. The shell
is resolved once against the parent environment's `PATH`. A missing shell
fails activation: choose `shell: "sh"` explicitly if Bash is unavailable.

`parentEnv: null` uses the process environment as the command environment's
base. Workspace tools filter that base through their own environment policy.
With `killBackground: true`, commands do not leave background children
running after they exit. Timeout and interruption always kill the process
group. `exitGraceMs` bounds waiting for output pipes after process exit.

## Files are separate from session storage

The filesystem contains live workspace bytes. A session journal contains
recorded interactions, including tool inputs, returned results and their
views; it does not snapshot the workspace directory. Reading a file does
not by itself register or chunk that source file for RAG. A memory strategy
may separately retain observations from the turn.

Writes, edits and shell commands change the actual machine. Forking or
replaying a session does not roll those changes back or create an isolated
copy. Rereading a path observes its current contents, which may differ from
the earlier tool result. Use host isolation or version control when needed.

File-tool confinement is a guardrail against mistakes, not a sandbox:
`bash` is unconfined, and a path may change between checking and use. The
workspace tools' builtin `grep` is not time-bounded; ripgrep uses Bash with
a configured deadline.

## Related guides

- [Workspace tools](/docs/plugins/workspace-tools/) for grants and output limits.
- [Directory skills](/docs/plugins/workspace-skills/) and [image fitting](/docs/plugins/workspace-images/).
- [Context and journal](/docs/concepts/context-journal/) for recorded evidence and model context.
- [File-backed sessions](/docs/plugins/session-files/) for conversation persistence, separate from workspace files.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-workspace/local` · Version **0.19.2** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/FileSystem`, `@xandreed/core/Bash` |
| Requires | none |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "shell": "bash",
  "killBackground": true,
  "exitGraceMs": 500,
  "parentEnv": null
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "shell": {
      "type": "string",
      "minLength": 1
    },
    "killBackground": {
      "type": "boolean"
    },
    "exitGraceMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 60000
    },
    "parentEnv": {
      "anyOf": [
        {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "shell",
    "killBackground",
    "exitGraceMs",
    "parentEnv"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
