---
title: Workspace image fitting
description: Fit workspace images to model limits with an installed CLI converter while preserving source files.
pluginId: "@xandreed/plugin-workspace/images"
---

`imageResizerPlugin` provides the optional `ImageResizer` service used by
workspace `read`. Use it when images need smaller dimensions or fewer bytes
before being sent to an image-capable model.

The plugin runs an installed converter; it does not install ImageMagick,
libvips or another native dependency through npm.

## Install and compose

```sh
bun add @xandreed/plugin-workspace
```

```ts
import { Agent } from "@xandreed/sdk"
import {
  imageResizerPlugin,
  localSystemPlugin,
  workspaceToolsPlugin,
} from "@xandreed/plugin-workspace"

const plugins = [
  localSystemPlugin,
  { plugin: imageResizerPlugin, options: { tool: "auto", timeoutMs: 30_000 } },
  { plugin: workspaceToolsPlugin, options: { imageMaxSide: 1568 } },
]

const definition = Agent.define({ plugins, workspace: "/srv/project" })
```

Merge this fragment into an agent with memory, a tool registry and a loop;
[Getting started](/docs/getting-started/) supplies that graph. Build it in an
Effect scope and supply the normal session and model services for turns.
`workspace` supplies the workspace tools' session environment.

## Requirements and activation

The converter requires `FileSystem` and `Bash` addressing the same file
tree. `localSystemPlugin` supplies that pair on Node 24 or Bun on Linux and
macOS. A remote filesystem needs a matching remote shell, not a local shell
that happens to expose the same path spelling.

`tool: "auto"` probes once, in the order `magick`, `convert`, `vips`
(`vipsthumbnail`), then `sips`. An explicit tool selects that backend.
Activation fails with `images.unavailable` when no selected converter can
run. The service is runtime-scoped, so add it before workspace tools are
activated; their image support is selected at activation.

## Limits and returned images

`imageMaxSide` belongs to `workspaceToolsPlugin`, accepts 64–8000 pixels,
and applies when a resizer is present. Without one, ordinary image reads
retain their existing acceptance and rejection limits.

`maxFileBytes` still refuses an oversized file before reading or conversion.
`maxSourcePixels` rejects a declared source canvas before a converter
decodes it. `timeoutMs` bounds the complete fit, including its attempts.
Output is checked against the framework's image limits again before use.

The source stays untouched, including in read-only roots. Temporary
directories use mode `0700`, files use `0600`, and cleanup follows success,
failure or interruption. `tempDir` must be an existing absolute POSIX
directory; `null` uses Bash's `TMPDIR`, then `/tmp`.

When fitting is needed, only the fitted bytes are returned and stored, with
original dimensions and byte counts as metadata. GIF and WebP conversion
uses the first frame.
For text-only routes, set `readImages: false` on workspace tools instead;
that reports images as binary files and avoids storing unseen image bytes.

Converters have the shell's authority. File-tool confinement is a guardrail,
not a sandbox; Bash is unconfined. The related tools' `grep` stops at
`grepTimeoutMs` with either engine: ripgrep runs with that deadline, and the
builtin engine runs regular expressions in a worker it terminates there.

## Related guides

- [Local system](/docs/plugins/workspace-local/) for filesystem and shell services.
- [Workspace tools](/docs/plugins/workspace-tools/) for `read` and its limits.
- [Provider images](/docs/concepts/providers/#images) for model-side image support.
- [Context and journal](/docs/concepts/context-journal/) for image evidence and context projection.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-workspace/images` · Version **0.19.2** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/ImageResizer` |
| Requires | `@xandreed/core/FileSystem`, `@xandreed/core/Bash` |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "tool": "auto",
  "tempDir": null,
  "timeoutMs": 30000,
  "maxSourcePixels": 100000000
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
    "tool": {
      "type": "string",
      "enum": [
        "auto",
        "magick",
        "convert",
        "vips",
        "sips"
      ]
    },
    "tempDir": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    },
    "timeoutMs": {
      "type": "integer",
      "minimum": 1,
      "maximum": 600000
    },
    "maxSourcePixels": {
      "type": "integer",
      "minimum": 1,
      "maximum": 1000000000
    }
  },
  "required": [
    "tool",
    "tempDir",
    "timeoutMs",
    "maxSourcePixels"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
