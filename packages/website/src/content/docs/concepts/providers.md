---
title: Plugin configuration
description: Replace services and configure every capability through a validated graph.
---



Base names are `efferent.config.json` and `efferent.config.ts`; having both in
one directory is an error. Global bases live in `~/.efferent/`. TypeScript
exports a default configuration and may export `plugins: Plugin[]` containing
local definitions. JSON resolves `use: "./my-plugin.ts"` or an installed package.
Only trusted configuration modules should be loaded: TypeScript executes code.

The merge order is preset, global base, workspace base, selected profile,
`.efferent/overrides.json`, then invocation. Plugin entries merge by instance
`id`; options merge by key. Changing `use` replaces the prior instance options.
Profile maps and bindings merge by key. An unknown profile is an error.

`config explain` reports source layers and selected providers, redacting common
credential keys. `plugin inspect ID` emits the plugin schema. `plugin add PACKAGE`
installs into `~/.efferent/plugins` with install scripts disabled, validates the
graph, then writes the workspace override. Removing a required provider fails
validation until its dependants are changed too.

`harness.reconfigure(config)` validates and stages the next graph before making
it available. Idle sessions refresh; active sessions refresh before their next
turn. A changed runtime graph returns `restart-required`. The CLI saves the
configuration and tells the user to restart. Source TypeScript is never rewritten
by the terminal editor.


See the [SDK guide](/docs/concepts/harness) for plugin authoring and lifecycle.
