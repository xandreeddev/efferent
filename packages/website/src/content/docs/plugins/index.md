---
title: Choose your plugins
description: Build an agent from first-party plugins for models, sessions, context, long-term knowledge, tools and rendering.
---

Each exported first-party plugin has its own guide in the sidebar, with
setup, examples, dependencies and a
configuration reference generated from its exported schema.

Start with [Getting started](/docs/getting-started/) for a complete agent.
For the relationship between stored conversations, model input and persistent
knowledge, read [Context, memory and the journal](/docs/concepts/context-journal/).
The [five-turn playback](/docs/guides/memory-walkthrough/) shows the actual
state changes and model requests of one composed assistant.

## Pick the parts your agent needs

| Capability | Plugins | What they do |
| --- | --- | --- |
| Model and execution | [Models](/docs/plugins/models/), [step loop](/docs/plugins/agent-loop-steps/), [discovery](/docs/plugins/tool-discovery/), [tasks](/docs/plugins/tasks/) | Supply models, run the agent loop, select tools and delegate background work. |
| Session storage | [File sessions](/docs/plugins/session-files/), [file log](/docs/plugins/session-files-log/), [SQLite sessions](/docs/plugins/session-sqlite/), [SQLite log](/docs/plugins/session-sqlite-log/), [sessions](/docs/plugins/sessions/) | Persist the journal, admit turns and expose session lifecycle and inbox operations. |
| Active model context | [Window](/docs/plugins/memory-window/), [summary](/docs/plugins/memory-summary/), [digest](/docs/plugins/memory-digest/) | Select conversation history and compact model-visible content. |
| Long-term knowledge | [PostgreSQL knowledge store](/docs/plugins/knowledge-postgres/), [memory](/docs/plugins/memory/), [capture](/docs/plugins/memory-capture/), [RAG](/docs/plugins/rag/) | Learn evidence-backed facts and relationships, capture acknowledged turns and retrieve document passages. |
| Workspace access | [Local system](/docs/plugins/workspace-local/), [images](/docs/plugins/workspace-images/), [skills](/docs/plugins/workspace-skills/), [tools](/docs/plugins/workspace-tools/) | Connect the host filesystem and shell, resize images, load skills and expose file tools. |
| Presentation and telemetry | [Surface](/docs/plugins/render-surface/), [feed](/docs/plugins/render-feed/), [output](/docs/plugins/render-output/), [telemetry](/docs/plugins/telemetry/) | Render turn events, publish feeds and collect usage, traces and metrics. |

Several definitions live in one npm package. For example,
`@xandreed/plugin-session-files` exports both the combined session-store plugin
and a log-only plugin. Install the package once and choose the definition that
fits your composition.

## Compose a working graph

Pass plugins to `Agent.define({ plugins })`. Use a plugin directly for its
defaults, or an entry containing `plugin` and `options` for configuration.
Options merge over defaults and are validated through the plugin's schema.

The runtime checks required services and scopes when building the graph.
The service contract on each plugin page lists its requirements, providers,
optional dependencies and contributions. Supply a required service through a
compatible plugin, a host layer or declared turn services, as appropriate to
the [SDK's composition rules](/docs/concepts/harness/).

A typical conversation agent combines a model, a step loop, discovery,
durable sessions and one active-context strategy. Choose either window or
summary memory as the `ConversationMemory` provider. Digest support and
long-term memory serve additional roles; the
[journal walkthrough](/docs/concepts/context-journal/) explains their interaction.

Session-scoped plugins need session-scoped services for the turn in which
they run. Keep scopes alive for background workers and streaming consumers.
When supplying services directly, use the package's documented `Live` layers
and compose with `stackPlugins` where contributions must be retained.

## Supported runtimes and infrastructure

Most plugins support Node 24 and Bun. The models plugin needs Node 24.5 or
newer when used on Node; SQLite session storage uses Bun's SQLite API. Local
workspace adapters target Linux and macOS. The file session store needs atomic
renames and exclusive hard links on its backing filesystem.

Native knowledge storage needs PostgreSQL with pgvector. The host supplies an
embedding service, and extraction or graph reasoning uses a utility language
model. The native knowledge guides explain database provisioning and matching
embedding-space identities.

For the complete machine-generated service and option listing, use the
[plugin reference](/docs/concepts/plugin-reference/).
