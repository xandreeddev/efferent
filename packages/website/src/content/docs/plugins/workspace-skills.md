---
title: Skills from directories
description: Load SKILL.md instructions and references into an agent's capability catalogue with explicit limits.
pluginId: "@xandreed/plugin-workspace/skills"
---

`skillsDirectoryPlugin` reads directories of `SKILL.md` files and contributes
their skills as one capability. Use it for project procedures and reference
material that tool discovery can list and load on demand.

It reads instructions and references; it does not execute a skill's scripts
or automatically create tools from those files.

## Install and configure

```sh
bun add @xandreed/plugin-workspace
```

```ts
import { Agent } from "@xandreed/sdk"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import {
  localSystemPlugin,
  skillsDirectoryPlugin,
} from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,
  {
    plugin: skillsDirectoryPlugin,
    options: {
      roots: [".agents/skills"],
      required: true,
      strict: true,
      idPrefix: "project.",
    },
  },
  toolDiscoveryPlugin,
]

const definition = Agent.define({ plugins, workspace: "/srv/project" })
```

Add these entries to the complete memory, registry and loop graph in
[Getting started](/docs/getting-started/). Build the definition in an Effect
scope; the host supplies sessions and model services for its turns.

## File layout and discovery

Each `SKILL.md` defines a skill; other text files in its directory become
references addressed by their relative paths. Nested skills own their own
files. Frontmatter needs a `description` or `summary`; `id` or `name`
identifies the skill, with a directory-derived fallback.

The plugin requires `FileSystem`. Relative roots resolve against
`SessionEnvironment.workspace` when available, otherwise the process working
directory. `localSystemPlugin` supplies a local filesystem on Node 24 and
Bun on POSIX hosts; a custom filesystem can supply the same port.

Tool discovery exposes `load_skill` and `read_skill_reference`. By default,
`tools: "ignore"` treats file skills as instructions and references only.
With `tools: "declared"`, every named tool must already be registered or
agent definition fails. A skill declaration does not grant its permissions.

## Loading and failure behavior

Skills are loaded once per `Agent.define`, not watched continuously. Rebuild
the agent to observe changed files. Use one instance with several `roots`:
the capability and always-on prompt section have fixed ids.

The first root wins an id clash; `idPrefix` avoids collisions with other
capabilities. Missing roots are skipped unless `required` is true. `strict`
turns file issues into `skills.files` failures; otherwise issues are logged
and the affected skill or reference is left out.

`maxSkills` bounds all roots together; `maxFiles` and `maxBytes` apply per
root. Oversized references are left unread and do not count toward the text
byte limit. Exceeding collection limits fails with `skills.limit`.
`alwaysSection` includes always-on instructions in a static prompt section,
because discovery activates those skills without listing their instructions.
Their references are listed by discovery's catalogue, not in that section.

## Related guides

- [Local system](/docs/plugins/workspace-local/) for the filesystem adapter.
- [Tool discovery](/docs/plugins/tool-discovery/) for catalogue and activation.
- [Context and journal](/docs/concepts/context-journal/) for prompt sections and recorded context.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-workspace/skills` · Version **0.19.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | none |
| Requires | `@xandreed/core/FileSystem` |
| Uses when available | `efferent/SessionEnvironment` |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "roots": [
    ".agents/skills"
  ],
  "required": false,
  "strict": false,
  "tools": "ignore",
  "idPrefix": "",
  "maxReferenceBytes": 65536,
  "maxSkills": 200,
  "maxFiles": 2000,
  "maxBytes": 8388608,
  "alwaysSection": true,
  "sectionOrder": 850
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
    "roots": {
      "type": "array",
      "items": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": {
      "type": "boolean"
    },
    "strict": {
      "type": "boolean"
    },
    "tools": {
      "type": "string",
      "enum": [
        "declared",
        "ignore"
      ]
    },
    "idPrefix": {
      "type": "string",
      "description": "Put before every skill id; no whitespace."
    },
    "maxReferenceBytes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 16777216
    },
    "maxSkills": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000
    },
    "maxFiles": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000000
    },
    "maxBytes": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1073741824
    },
    "alwaysSection": {
      "type": "boolean"
    },
    "sectionOrder": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "roots",
    "required",
    "strict",
    "tools",
    "idPrefix",
    "maxReferenceBytes",
    "maxSkills",
    "maxFiles",
    "maxBytes",
    "alwaysSection",
    "sectionOrder"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
