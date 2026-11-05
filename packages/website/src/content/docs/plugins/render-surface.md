---
title: Render surfaces
description: Publish versioned component snapshots over a host-provided store and admission policy.
pluginId: "@xandreed/plugin-render/surface"
---

`renderSurfacePlugin` provides `Render`, the host-facing service for
versioned surfaces. Use it when a run prepares a changing page or canvas
whose nodes need durable, deduplicated publication and explicit completion.

It handles surface state and publication. The host owns storage, component
admission and the client renderer.

## Install and configure

```sh
bun add @xandreed/plugin-render
```

```ts
import type { Context } from "effect"
import { Agent } from "@xandreed/sdk"
import {
  RenderStore,
  UiOutputAdmission,
  renderSurfacePlugin,
} from "@xandreed/plugin-render"

declare const hostServices: Context.Context<RenderStore | UiOutputAdmission>

const plugins = [
  { plugin: renderSurfacePlugin, options: { maxBytes: 32_768 } },
]

const definition = Agent.define({ plugins, services: hostServices })
```

This fragment assumes real host adapters in `hostServices`. Add it to the
complete memory, tool registry and loop graph from
[Getting started](/docs/getting-started/), and build the definition in an
Effect scope. It does not implement storage or start an HTTP server.

## Host contracts

The runtime-scoped plugin requires `RenderStore` and `UiOutputAdmission`.
The host opens a surface with its authorized scope and a `fork` function
that keeps background preparations within the host's unit of work.

Admission validates each exact component release, its props, evidence and
permissions before writes. `maxBytes` limits encoded component proposals;
the default is 32 KiB, with an allowed range of 1–128 KiB.

The store must enforce ownership and fences transactionally. A stale fence
must fail; plans must use the next generation and must not reopen a frozen
surface. Commits deduplicate `operationId` and reject reuse with different
content. Records must remain separated by thread, principal and surface.
`MemoryRenderStoreLive` is available for ephemeral use; durable storage is
the host's responsibility. Test adapters with `renderSurfaceConformance`.

## Publication and lifecycle

Publishing identical content does not open another generation. It can fill
nodes an earlier attempt left unfinished before completing that version.
A planning conflict triggers one re-hydration and retry; another conflict
fails. Use the exported operation/version id helpers rather than joining ids.

`prepare` consumes snapshots through the host's background runner;
`settled` waits for preparations already started. Freezing prevents later
plans for the message, while filling an already declared placeholder remains
allowed. The host controls when work and its scope close.

This package runs on Node 24 and Bun. Publishing a surface does not serve
browser code or deliver frames by itself: expose committed journal data
through a feed and a host transport when clients need updates.

## Related guides

- [Render feed](/docs/plugins/render-feed/) for replay and live delivery.
- [Component output](/docs/plugins/render-output/) for the model-facing tool.
- [Events guide](/docs/guides/events/) for journal and HTTP composition.
- [Conformance](/docs/concepts/conformance/) for adapter contract testing.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-render/surface` · Version **0.17.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/render/Render` |
| Requires | `efferent/render/Store`, `efferent/ui/OutputAdmission` |
| Uses when available | none |
| Contributes | none |

### Default options

```json
{
  "maxBytes": 32768
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
    "maxBytes": {
      "type": "integer",
      "minimum": 1024,
      "maximum": 131072
    }
  },
  "required": [
    "maxBytes"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
