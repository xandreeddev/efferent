---
title: Workspace tools
description: Give an agent bounded file and shell tools with explicit grants, path policies and recorded result views.
pluginId: "@xandreed/plugin-workspace/tools"
---

`workspaceToolsPlugin` contributes `read`, `ls`, `find`, `grep`, `write`,
`edit` and, when Bash is available, `bash`. Use it when the model should
inspect or change a workspace through the host's filesystem and shell ports.

## Install and compose

```sh
bun add @xandreed/plugin-workspace @xandreed/plugin-tool-discovery
```

```ts
import { Agent } from "@xandreed/sdk"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,
  {
    plugin: workspaceToolsPlugin,
    options: {
      always: ["read", "edit"],
      workspaceAccess: "write",
      roots: [{ path: "/srv/reference", access: "read" }],
      bashInheritEnv: false,
    },
  },
  { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write"] } },
]

const definition = Agent.define({ plugins, workspace: "/srv/project" })
```

Merge this fragment with the memory and loop entries from
[Getting started](/docs/getting-started/) and build it in an Effect scope.
The host supplies sessions and the model for turns. `Agent.define.workspace`
supplies `SessionEnvironment`; `FileSystem` is required, while `Bash` and
`ImageResizer` are optional. The local adapter supports Node 24 and Bun on POSIX.

## Permissions and path policy

The read skill is active initially. `write` and `edit` require `fs.write`;
`bash` requires `shell.exec`, which the example does not grant. Making an
edit or shell skill always active without its grant fails the turn.

With `confine: true`, resolved paths must fall inside the workspace or an
extra root. The longest real root determines write access; `protect` globs
add write refusals. These checks are a guardrail against model mistakes,
not a sandbox: Bash is unconfined, and paths can change between check and use.
`confine: false` disables the roots and read-only policy.

## File bytes, tool results and model context

`read` refuses files over `maxFileBytes` before loading them (32 MiB by
default). For an allowed text file it loads the bytes, then returns only a
window: by default up to 2000 lines or 50 KiB. `next` advances to the next
line. A first line longer than the byte window is clipped; changing the
offset cannot recover the omitted remainder of that line. Filter large
files or long lines with a suitably authorized shell command instead.

The journal keeps the returned result and its write-time view, not a hidden
copy of unread or omitted bytes. `read` renders text with line information;
its compact view is a short path/range note. Later context compaction or a
digest can change what the model sees, without changing the recorded result
or restoring content the tool never returned.

`write` changes the file and returns a path/byte-count receipt; its input
contains the submitted content. `edit` returns a bounded diff for hosts but
renders a short replacement summary to the model. Neither returns the whole
resulting file automatically. Read the changed region to inspect it.

`bash` returns an output tail and optional spill-file path. Defaults keep
2000 lines or 50 KiB in the result, with up to 32 MiB in a spill file and
the newest 50 spill files retained. Live `tool.progress` is transient.
The spill file remains a filesystem artifact; its path is not its contents.

Forking or replaying a session does not revert file edits or shell effects.
Rereads observe current disk state. Memory may retain turn observations;
reading a source file does not by itself ingest or synchronize that file
for RAG. Source ingestion is a separate retrieval operation.

## Search and lifecycle

The capability is built once per agent; paths and turn services are resolved
per call. Per-file locks serialize its writes across sessions sharing it.
Builtin `grep` runs synchronous regular expressions and is not time-bounded.
`grepEngine: "auto"` probes ripgrep once on the local filesystem/shell pair;
explicit ripgrep needs `rg` and uses `grepTimeoutMs`. Both engines bound
returned matches and refuse multiline patterns.

## Related guides

- [Workspace behavior](/docs/concepts/workspace/) for limits, edits and environment policy.
- [Context and journal](/docs/concepts/context-journal/) and [file-backed sessions](/docs/plugins/session-files/).
- [Image fitting](/docs/plugins/workspace-images/) and [directory skills](/docs/plugins/workspace-skills/).

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-workspace/tools` · Version **0.19.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | none |
| Requires | `@xandreed/core/FileSystem`, `efferent/SessionEnvironment` |
| Uses when available | `@xandreed/core/Bash`, `@xandreed/core/ImageResizer` |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "tools": [
    "read",
    "write",
    "edit",
    "ls",
    "find",
    "grep",
    "bash"
  ],
  "always": [
    "read"
  ],
  "confine": true,
  "workspaceAccess": "write",
  "roots": [],
  "protect": [
    ".git/**",
    ".efferent/**"
  ],
  "exclude": [
    "node_modules",
    ".git",
    ".efferent"
  ],
  "maxLines": 2000,
  "maxBytes": 51200,
  "lsEntries": 500,
  "findResults": 1000,
  "grepMatches": 100,
  "grepLineChars": 500,
  "grepEngine": "auto",
  "grepTimeoutMs": 30000,
  "grepIgnoreFiles": false,
  "maxFileBytes": 33554432,
  "readImages": true,
  "imageMaxSide": 8000,
  "fuzzyEdit": true,
  "bashTimeoutMs": 120000,
  "bashMaxTimeoutMs": 600000,
  "bashEnv": {},
  "bashInheritEnv": false,
  "bashEnvAllow": [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_*",
    "TERM",
    "SHELL",
    "TMPDIR",
    "TZ"
  ],
  "bashSessionEnv": false,
  "spillDir": ".efferent/runtime/tool-output",
  "spillKeep": 50,
  "progressMs": 250,
  "environmentSection": true,
  "sectionOrder": 800
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
    "tools": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "read",
          "write",
          "edit",
          "ls",
          "find",
          "grep",
          "bash"
        ]
      }
    },
    "always": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "read",
          "edit",
          "shell"
        ]
      }
    },
    "confine": {
      "type": "boolean"
    },
    "workspaceAccess": {
      "type": "string",
      "enum": [
        "read",
        "write"
      ]
    },
    "roots": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string",
            "minLength": 1
          },
          "access": {
            "type": "string",
            "enum": [
              "read",
              "write"
            ]
          }
        },
        "required": [
          "path",
          "access"
        ],
        "additionalProperties": true
      }
    },
    "protect": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "exclude": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "maxLines": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100000
    },
    "maxBytes": {
      "type": "integer",
      "minimum": 1024,
      "maximum": 10485760
    },
    "lsEntries": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100000
    },
    "findResults": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100000
    },
    "grepMatches": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    },
    "grepLineChars": {
      "type": "integer",
      "minimum": 16,
      "maximum": 100000
    },
    "grepEngine": {
      "type": "string",
      "enum": [
        "auto",
        "ripgrep",
        "builtin"
      ]
    },
    "grepTimeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "grepIgnoreFiles": {
      "type": "boolean"
    },
    "maxFileBytes": {
      "type": "integer",
      "minimum": 1024,
      "maximum": 1073741824
    },
    "readImages": {
      "type": "boolean"
    },
    "imageMaxSide": {
      "type": "integer",
      "minimum": 64,
      "maximum": 8000
    },
    "fuzzyEdit": {
      "type": "boolean"
    },
    "bashTimeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "bashMaxTimeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "bashEnv": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "bashInheritEnv": {
      "type": "boolean"
    },
    "bashEnvAllow": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "bashSessionEnv": {
      "type": "boolean"
    },
    "spillDir": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "spillKeep": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    },
    "progressMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 60000
    },
    "environmentSection": {
      "type": "boolean"
    },
    "sectionOrder": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "tools",
    "always",
    "confine",
    "workspaceAccess",
    "roots",
    "protect",
    "exclude",
    "maxLines",
    "maxBytes",
    "lsEntries",
    "findResults",
    "grepMatches",
    "grepLineChars",
    "grepEngine",
    "grepTimeoutMs",
    "grepIgnoreFiles",
    "maxFileBytes",
    "readImages",
    "imageMaxSide",
    "fuzzyEdit",
    "bashTimeoutMs",
    "bashMaxTimeoutMs",
    "bashEnv",
    "bashInheritEnv",
    "bashEnvAllow",
    "bashSessionEnv",
    "spillDir",
    "spillKeep",
    "progressMs",
    "environmentSection",
    "sectionOrder"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
