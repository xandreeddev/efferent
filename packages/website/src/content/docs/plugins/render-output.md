---
title: Component output
description: Admit and durably commit exact component proposals through UiOutput and the render_component toolkit.
pluginId: "@xandreed/plugin-render/output"
---

`uiOutputPlugin` provides `UiOutput` and `UiOutputTools` for publishing one
complete component with an exact approved release. Use it when model output
must pass host validation and receive a durable revision and journal cursor
before a client sees it.

The host controls the component catalogue, renderer, evidence lookup and
authorization. A proposal supplies data, not executable UI code.

## Install and compose

```sh
bun add @xandreed/plugin-render
```

```ts
import { Agent } from "@xandreed/sdk"
import {
  UiOutputAdmission,
  UiOutputContext,
  UiOutputJournal,
  uiOutputPlugin,
} from "@xandreed/plugin-render"

const plugins = [
  { plugin: uiOutputPlugin, options: { maxBytes: 32_768 } },
]

const definition = Agent.define({
  plugins,
  turnServices: [UiOutputAdmission, UiOutputJournal, UiOutputContext],
})
```

This fragment declares services the host must supply for each turn. Merge
it with a complete memory, registry and loop graph, including any model
service declarations; see [Getting started](/docs/getting-started/). Build
the definition in an Effect scope and supply the actual adapters through
the turn's service context.

## Expose the toolkit explicitly

The plugin is session-scoped and activates per turn. `UiOutputTools`
contains `uiOutputToolkit`, an Effect AI toolkit with `render_component`.
The host supplies handlers with `UiOutputHandlersLive` and incorporates it
into its tool composition. It is not a core capability automatically listed
by tool discovery, and it does not replace domain tools.

`UiOutputContext` supplies the thread, run, message, principal and fence.
These are host-authorized values; the model cannot choose another identity.
The `@xandreed/plugin-render/output` subpath exports this output API alone.

## Admission and durable commit

`UiOutput.emit` decodes the proposal, enforces its encoded byte limit, then
calls admission before touching the journal. `UiOutputAdmission` must verify
the exact release, prop schema, evidence ids and permissions, failing closed.
`UiRelease` includes component/version, renderer release, layout version,
definition hash and design-token hash. Resolve no field through a latest alias.

`UiOutputJournal.commit` must transactionally check ownership and fence,
deduplicate `operationId`, and persist both the immutable revision and its
journal/outbox record before returning a receipt. Reusing an operation id
with different content must fail. A retry of identical content may reuse it.

The tool returns failures as data. Clients should consume committed journal
records, not stream unadmitted proposals. The plugin starts no server and
installs no browser renderer; Node 24 and Bun hosts choose their transports.

## Related guides

- [Render feed](/docs/plugins/render-feed/) for committed client delivery.
- [Render surfaces](/docs/plugins/render-surface/) for complete versioned snapshots.
- [Events guide](/docs/guides/events/) for host journal and transport composition.
- [Conformance](/docs/concepts/conformance/) for port-contract testing.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-render/output` · Version **0.18.0** · Plugin API **3** · Scope **session**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ui/Output`, `efferent/ui/OutputTools` |
| Requires | `efferent/ui/OutputAdmission`, `efferent/ui/OutputJournal`, `efferent/ui/OutputContext` |
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
