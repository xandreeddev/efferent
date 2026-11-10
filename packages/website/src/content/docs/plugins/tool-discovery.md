---
title: Tool discovery and skills
description: Register contributed tools and skills, activate them per turn and enforce call policies.
pluginId: "@xandreed/plugin-tool-discovery"
---

`toolDiscoveryPlugin` turns contributed capabilities into the agent's
`ToolRegistry`. It manages tool availability for each turn and checks
permissions, policy, budgets and concurrency before entering a handler.

## When to use it

Use this plugin when an agent has application tools or loadable skills.
Define those tools, views and skills as capabilities in your host or in
capability plugins. The registry consumes those definitions; it does not
create workspace access or grant application permissions by itself.

## Install and configure

```sh
npm install effect @xandreed/plugin-tool-discovery
```

```ts
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"

const plugins = [
  {
    plugin: toolDiscoveryPlugin,
    options: {
      grants: [],
      loadSkill: true,
      maxCallsPerRun: 40,
      maxSkillLoadsPerRun: 4,
      readConcurrency: 4,
    },
  },
]
```

This fragment supplies one entry for `Agent.define`'s `plugins` array.
Add host definitions through `capabilities`, or compose plugins contributing
`Capabilities`. Complete the graph with conversation memory, sessions,
[the step loop](/docs/plugins/agent-loop-steps/) and your model configuration.
Unspecified options retain the plugin defaults.

## Skills and activation

With `loadSkill: true`, the plugin contributes the skill catalogue prompt
section and provides `load_skill` and `read_skill_reference`. Loading a skill
activates its tools and instructions for that turn. An optional host matcher
can seed activation before model steps begin.

The active set grows during a turn; starting another turn opens a fresh
registry session. Always-on skills do not appear in the loadable catalogue:
put their guidance in tool descriptions or a contributed prompt section.
They are active from each turn's start, so `read_skill_reference` serves
their references without a `load_skill`; the catalogue section lists those
references under its own heading.

## Policies and limits

`grants` is the fallback when the turn supplies no `PermissionGrants`.
Activation does not override grants or the host's `ActionPolicy`. Every
registered tool's required services are checked when the registry opens;
missing services fail before handlers can start.

Despite its legacy name, top-level `maxCallsPerRun` caps admitted calls
across the whole turn, including multiple loop runs. Per-tool limits in
`toolPolicy` have different scope: their call caps and failure breakers are
per loop run, while configured tool concurrency permits span turns sharing
the registry.

Read-only calls share `readConcurrency` permits. A write excludes the
registry's readers and writers. These gates constrain declared tool
behavior; a host still owns the actual permissions of its implementation.

## Results and lifecycle

Refused calls return structured failure data to the model and emit a
`tool.refused` event. Accepted handlers have start/completion events, with
the start flushed before handler execution. A broken journal or turn writer
remains a turn failure rather than being presented as a normal tool result.

The runtime-scoped registry works on Node and Bun. Definitions are registered
once; availability, captured turn services and per-turn budgets are opened
for each turn. The plugin contributes its catalogue capability alongside the
host's other capabilities.

## Related guides

- [Step loop](/docs/plugins/agent-loop-steps/)
- [Background task tools](/docs/plugins/tasks/)
- [Plugin composition](/docs/concepts/architecture/)
- [SDK and capabilities](/docs/concepts/harness/)

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-tool-discovery` · Version **0.20.1** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ToolRegistry` |
| Requires | `efferent/Capabilities` |
| Uses when available | none |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "grants": [],
  "loadSkill": true,
  "maxCallsPerRun": 64,
  "maxSkillLoadsPerRun": 4,
  "readConcurrency": 4,
  "matcherTimeoutMs": 3000,
  "catalogVersion": "1",
  "catalogOrder": 900
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
    "grants": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "loadSkill": {
      "type": "boolean"
    },
    "maxCallsPerRun": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000
    },
    "maxSkillLoadsPerRun": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100
    },
    "readConcurrency": {
      "type": "integer",
      "minimum": 1,
      "maximum": 32
    },
    "matcherTimeoutMs": {
      "type": "integer",
      "minimum": 50,
      "maximum": 60000
    },
    "catalogVersion": {
      "type": "string",
      "minLength": 1
    },
    "catalogOrder": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "toolPolicy": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "concurrency": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1024
          },
          "maxCallsPerRun": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1000000
          },
          "breakAfter": {
            "type": "integer",
            "minimum": 1,
            "maximum": 1000000
          },
          "breakOn": {
            "type": "string",
            "enum": [
              "defects",
              "failures"
            ]
          }
        },
        "additionalProperties": true
      }
    }
  },
  "required": [
    "grants",
    "loadSkill",
    "maxCallsPerRun",
    "maxSkillLoadsPerRun",
    "readConcurrency",
    "matcherTimeoutMs",
    "catalogVersion",
    "catalogOrder"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
